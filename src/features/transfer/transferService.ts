import type { OneDriveService, GraphDriveItem } from '../../services/graph/oneDriveService';
import type { GoogleDrive } from '../../services/google/googleDrive';
import type { TransferJob, TransferCheckpoint, TransferStore } from './transferRepository';
import { downloadChunk, waitForRetry } from './transferNetwork';
import type { TransferTiming } from './transferTiming';
export interface CopyEntry { item: GraphDriveItem; parentId: string; path: string }
export const COPY_CONCURRENCY = 3;
/** Stable priority groups; only retain the visible rows, even for huge jobs. */
export function visibleCopyEntries(entries: CopyEntry[], states: ReadonlyMap<string, { done: boolean; status: string }>, limit = 500): CopyEntry[] {
  const groups: CopyEntry[][] = [[], [], [], []];
  for (const entry of entries) {
    const state = states.get(entry.item.id);
    const priority = state?.done ? 3 : state?.status === 'กำลังคัดลอก' ? 0 : state?.status === 'พักไว้' ? 1 : 2;
    if (groups[priority].length < limit) groups[priority].push(entry);
  }
  return groups.flat().slice(0, limit);
}
async function downloadMetadata(graph: OneDriveService, id: string, signal: AbortSignal): Promise<GraphDriveItem> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await graph.getDownloadItem(id, AbortSignal.any([signal, AbortSignal.timeout(180000)])); }
    catch (error) {
      signal.throwIfAborted();
      const transient = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' ||
        error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 500;
      if (!transient || attempt >= 4) throw error;
      await waitForRetry(1000 * 2 ** attempt, signal);
    }
  }
}
export async function planCopy(graph: OneDriveService, sourceId: string, signal: AbortSignal): Promise<CopyEntry[]> {
  const entries: CopyEntry[] = [];
  const queue = [{ id: sourceId, path: '' }];
  const visited = new Set<string>([sourceId]);
  for (let index = 0; index < queue.length; index++) {
    const folder = queue[index];
    let page = folder.id === 'root' ? await graph.listDriveRootChildren(signal) : await graph.listDriveItemChildren(folder.id, signal);
    for (;;) {
      for (const item of page.value) {
        const path = folder.path ? `${folder.path}/${item.name}` : item.name;
        if (!item.folder && !item.file) throw new Error(`ไม่รองรับรายการนี้: ${path}`);
        if (visited.has(item.id)) throw new Error(`พบรายการซ้ำในต้นทาง: ${path}`);
        visited.add(item.id);
        if (item.file && (!Number.isSafeInteger(item.size) || item.size! < 0)) throw new Error(`อ่านขนาดไฟล์ไม่ได้: ${path}`);
        entries.push({ item, parentId: folder.id, path });
        if (item.folder) queue.push({ id: item.id, path });
      }
      if (!page['@odata.nextLink']) break;
      page = await graph.listChildrenPage(page['@odata.nextLink'], signal);
    }
  }
  return entries;
}
export async function resumeCopy(job: TransferJob, microsoftAccountId: string, graph: OneDriveService, google: GoogleDrive, store: TransferStore, signal: AbortSignal, update: (checkpoint: TransferCheckpoint, status: string) => void, updateTiming: (timing: TransferTiming) => void = () => {}): Promise<void> {
  if (!store.timing || !store.saveTiming) return resumeCopyWorkers(job, microsoftAccountId, graph, google, store, signal, update);
  const previous = new Map((await store.checkpoints(job.id)).map(state => [state.sourceId, { ...state }]));
  const files = new Set(job.entries.filter(entry => entry.item.file).map(entry => entry.item.id));
  const base = await store.timing(job.id) ?? { jobId: job.id, trackedFrom: Date.now(), activeMs: 0, transferredBytes: 0, completedFiles: 0, updatedAt: Date.now() };
  const started = performance.now();
  const cancel = new AbortController();
  let gainedBytes = 0; let gainedFiles = 0; let complete = false;
  let timingError: unknown;
  let persistence = Promise.resolve();
  const snapshot = (): TransferTiming => ({ ...base, activeMs: base.activeMs + Math.max(0, performance.now() - started), transferredBytes: base.transferredBytes + Math.max(0, gainedBytes), completedFiles: base.completedFiles + Math.max(0, gainedFiles), updatedAt: Date.now(), finishedAt: complete ? Date.now() : undefined });
  const persist = () => {
    const value = snapshot(); updateTiming(value);
    persistence = persistence.then(() => store.saveTiming!(value)).catch(error => { timingError ??= error; cancel.abort(); });
  };
  persist(); await persistence;
  if (timingError) throw timingError;
  const timer = setInterval(persist, 5000);
  try {
    await resumeCopyWorkers(job, microsoftAccountId, graph, google, store, AbortSignal.any([signal, cancel.signal]), (state, status) => {
      const old = previous.get(state.sourceId);
      if (files.has(state.sourceId)) { gainedBytes += state.bytes - (old?.bytes ?? 0); gainedFiles += Number(state.done) - Number(old?.done ?? false); }
      previous.set(state.sourceId, { ...state });
      update(state, status); updateTiming(snapshot());
    });
    complete = true;
  } catch (error) { throw timingError ?? error; }
  finally { clearInterval(timer); persist(); await persistence; if (timingError) throw timingError; }
}
async function resumeCopyWorkers(job: TransferJob, microsoftAccountId: string, graph: OneDriveService, google: GoogleDrive, store: TransferStore, signal: AbortSignal, update: (checkpoint: TransferCheckpoint, status: string) => void): Promise<void> {
  const siblings = new AbortController();
  signal = AbortSignal.any([signal, siblings.signal]);
  signal.throwIfAborted();
  if (microsoftAccountId !== job.microsoftAccountId) throw new Error('ต้องเชื่อมต่อ OneDrive บัญชีเดิมของงานนี้');
  if ((await google.identity()).id !== job.googleAccountId) throw new Error('ต้องเชื่อมต่อ Google บัญชีเดิมของงานนี้');
  const states = new Map((await store.checkpoints(job.id)).map(state => [state.sourceId, state]));
  const save = async (state: TransferCheckpoint, status: string) => {
    await store.saveCheckpoint(state);
    states.set(state.sourceId, state); update(state, status);
  };
  const allocate = async (sourceId: string): Promise<TransferCheckpoint> => {
    const existing = states.get(sourceId);
    if (existing) return existing;
    const state = { jobId: job.id, sourceId, destinationId: await google.generateId(signal), bytes: 0, done: false };
    // Fixed Google IDs are committed BEFORE any remote creation, including the root.
    await save(state, 'รอคัดลอก'); return state;
  };
  const root = await allocate(job.source.id);
  await google.ensureFolder(root.destinationId, job.copyName, job.target.id, `${job.id}:root`, signal);
  if (!root.done) { root.done = true; await save(root, 'สำเร็จ'); }
  const copy = async ({ item, parentId }: CopyEntry) => {
    signal.throwIfAborted();
    const state = await allocate(item.id);
    if (state.done) { update(state, 'สำเร็จ'); return; }
    update(state, 'กำลังคัดลอก');
    const parent = states.get(parentId);
    if (!parent?.done) throw new Error('ยังไม่มีโฟลเดอร์ปลายทางสำหรับรายการนี้');
    try {
      if (item.folder) {
        await google.ensureFolder(state.destinationId, item.name, parent.destinationId, `${job.id}:${item.id}`, signal);
      } else {
        // Reuse the just-validated metadata for the first read; later chunks/retries refresh it.
        let initial: GraphDriveItem | undefined = await downloadMetadata(graph, item.id, signal);
        if (initial.size !== item.size || initial.lastModifiedDateTime !== item.lastModifiedDateTime) throw new Error(`ไฟล์ต้นทางเปลี่ยน: ${item.name} งานพักไว้`);
        const read = async (start: number, end: number): Promise<Blob> => {
          // OneDrive download URLs are short-lived; refresh metadata for every chunk/retry.
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            const fresh = initial ?? await downloadMetadata(graph, item.id, signal);
            initial = undefined;
            if (fresh.size !== item.size || fresh.lastModifiedDateTime !== item.lastModifiedDateTime) throw new Error(`ไฟล์ต้นทางเปลี่ยน: ${item.name} งานพักไว้`);
            const url = fresh['@microsoft.graph.downloadUrl'];
            if (!url) throw new Error(`OneDrive ไม่ส่ง URL ดาวน์โหลดสำหรับ ${item.name} แม้ขอ metadata เต็มแล้ว`);
            try { return await downloadChunk(url, start, end, item.size!, signal); }
            catch (error) {
              signal.throwIfAborted();
              if (attempt >= 4) throw error;
              await waitForRetry(1000 * 2 ** attempt, signal);
            }
          }
        };
        // Validate even empty files and files whose upload session is already complete.
        await google.upload(state.destinationId, item.name, parent.destinationId, `${job.id}:${item.id}`, item.size!, item.file?.mimeType ?? 'application/octet-stream', read, signal,
          { url: state.uploadUrl, bytes: state.bytes }, async progress => {
            state.uploadUrl = progress.url; state.bytes = progress.bytes;
            await save(state, 'กำลังคัดลอก');
          });
      }
      state.done = true; state.uploadUrl = undefined; state.bytes = item.file ? item.size! : 0;
      await save(state, 'สำเร็จ');
    } catch (error) { update(state, 'พักไว้'); throw error; }
  };
  // Parents must exist before any child starts. File chunks stay sequential per session.
  for (const entry of job.entries) if (entry.item.folder) await copy(entry);
  const files = job.entries.filter(entry => entry.item.file && !states.get(entry.item.id)?.done);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    try {
      while (next < files.length) {
        signal.throwIfAborted();
        await copy(files[next++]);
      }
    } catch (error) {
      if (!failed) { failed = true; failure = error; siblings.abort(); }
      throw error;
    }
  };
  // Drain every worker before releasing the cross-tab lock or allowing resume.
  await Promise.allSettled(Array.from({ length: Math.min(COPY_CONCURRENCY, files.length) }, worker));
  if (failed) throw failure;
  signal.throwIfAborted();
}

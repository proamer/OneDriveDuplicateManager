import type { OneDriveService, GraphDriveItem } from '../../services/graph/oneDriveService';
import type { GoogleDrive } from '../../services/google/googleDrive';
import type { TransferJob, TransferCheckpoint, TransferStore } from './transferRepository';
import { downloadChunk, waitForRetry } from './transferNetwork';
export interface CopyEntry { item: GraphDriveItem; parentId: string; path: string }
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
export async function resumeCopy(job: TransferJob, microsoftAccountId: string, graph: OneDriveService, google: GoogleDrive, store: TransferStore, signal: AbortSignal, update: (checkpoint: TransferCheckpoint, status: string) => void): Promise<void> {
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
  for (const { item, parentId } of job.entries) {
    signal.throwIfAborted();
    const state = await allocate(item.id);
    if (state.done) { update(state, 'สำเร็จ'); continue; }
    update(state, 'กำลังคัดลอก');
    const parent = states.get(parentId);
    if (!parent?.done) throw new Error('ยังไม่มีโฟลเดอร์ปลายทางสำหรับรายการนี้');
    try {
      if (item.folder) {
        await google.ensureFolder(state.destinationId, item.name, parent.destinationId, `${job.id}:${item.id}`, signal);
      } else {
        const read = async (start: number, end: number): Promise<Blob> => {
          // OneDrive download URLs are short-lived; refresh metadata for every chunk/retry.
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            const fresh = await downloadMetadata(graph, item.id, signal);
            if (fresh.size !== item.size || fresh.lastModifiedDateTime !== item.lastModifiedDateTime) throw new Error(`ไฟล์ต้นทางเปลี่ยน: ${item.name} งานพักไว้`);
            const url = fresh['@microsoft.graph.downloadUrl'];
            if (!url) throw new Error('ไม่มี URL ดาวน์โหลดไฟล์นี้');
            try { return await downloadChunk(url, start, end, item.size!, signal); }
            catch (error) {
              signal.throwIfAborted();
              if (attempt >= 4) throw error;
              await waitForRetry(1000 * 2 ** attempt, signal);
            }
          }
        };
        // Validate even empty files and files whose upload session is already complete.
        const fresh = await downloadMetadata(graph, item.id, signal);
        if (fresh.size !== item.size || fresh.lastModifiedDateTime !== item.lastModifiedDateTime) throw new Error(`ไฟล์ต้นทางเปลี่ยน: ${item.name} งานพักไว้`);
        await google.upload(state.destinationId, item.name, parent.destinationId, `${job.id}:${item.id}`, item.size!, item.file?.mimeType ?? 'application/octet-stream', read, signal,
          { url: state.uploadUrl, bytes: state.bytes }, async progress => {
            state.uploadUrl = progress.url; state.bytes = progress.bytes;
            await save(state, 'กำลังคัดลอก');
          });
      }
      state.done = true; state.uploadUrl = undefined; state.bytes = item.file ? item.size! : 0;
      await save(state, 'สำเร็จ');
    } catch (error) { update(state, 'พักไว้'); throw error; }
  }
}

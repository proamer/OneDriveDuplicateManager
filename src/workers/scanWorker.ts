import { createGraphClient, type TokenSource } from '../services/graph/graphClient';
import { createOneDriveService, type GraphDriveItem } from '../services/graph/oneDriveService';
import { fileRepository } from '../services/db/fileRepository';
import { scanSessionRepository } from '../services/db/scanSessionRepository';
import {
  type FileRecord,
  type ScanFrontierFolder,
  type ScanSession,
  type ScanWorkerRequest,
  type ScanWorkerResponse,
} from '../features/scanner/scanTypes';
import { joinPath } from '../utils/pathUtils';
import { messageOf } from '../utils/errorMessage';

const post = (message: ScanWorkerResponse) => self.postMessage(message);

let cancelled = false;
let accessToken: string | null = null;
const abortController = new AbortController();

// Token refresh bridge: the worker cannot run MSAL, so it asks the main thread.
let tokenRequestSeq = 0;
const tokenWaiters = new Map<number, (token: string | null) => void>();

function requestFreshToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = ++tokenRequestSeq;
    tokenWaiters.set(requestId, resolve);
    post({ type: 'needToken', requestId });
  });
}

const tokens: TokenSource = {
  get: async () => accessToken,
  refresh: async () => {
    accessToken = await requestFreshToken();
    return accessToken;
  },
};

let throttleMessage = '';
const graph = createOneDriveService(
  createGraphClient(tokens, {
    onThrottle: (seconds) => {
      throttleMessage = `Microsoft Graph throttled the scan — waiting ${seconds}s before retrying.`;
    },
  }),
);

self.onmessage = (event: MessageEvent<ScanWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'start') {
    accessToken = message.accessToken;
    void runScan(message.sessionId, message.resume, message.roots);
  } else if (message.type === 'cancel') {
    cancelled = true;
    abortController.abort();
  } else if (message.type === 'token') {
    tokenWaiters.get(message.requestId)?.(message.accessToken);
    tokenWaiters.delete(message.requestId);
  }
};

async function runScan(
  sessionId: string,
  resume: boolean,
  roots: ScanFrontierFolder[] | null,
): Promise<void> {
  const session = await scanSessionRepository.get(sessionId);
  if (!session) {
    post({ type: 'error', error: 'Scan session not found.' });
    return;
  }

  // Breadth-first walk of the folder tree. The queue head is processed next;
  // it is only removed once the folder is fully scanned, so a crash mid-folder
  // resumes by reprocessing that folder (writes are keyed by item id, so re-runs
  // are idempotent).
  const scoped = !!roots && roots.length > 0;
  let queue: ScanFrontierFolder[] = scoped ? [...roots] : [{ itemId: null, path: '/' }];
  let scopePaths: string[] | null = scoped ? roots.map((root) => root.path) : null;
  let itemsSeen = 0;
  let imagesFound = 0;
  let foldersScanned = 0;
  let totalBytes = 0;

  if (resume) {
    const checkpoint = await scanSessionRepository.getCheckpoint();
    if (checkpoint && checkpoint.sessionId === sessionId && checkpoint.queue.length > 0) {
      queue = checkpoint.queue;
      scopePaths = checkpoint.scopePaths;
      itemsSeen = checkpoint.itemsSeen;
      imagesFound = checkpoint.imagesFound;
      foldersScanned = checkpoint.foldersScanned;
      totalBytes = checkpoint.totalBytes;
    }
  }

  const saveCheckpoint = () =>
    scanSessionRepository.saveCheckpoint({
      sessionId,
      queue,
      scopePaths,
      itemsSeen,
      imagesFound,
      foldersScanned,
      totalBytes,
      updatedAt: new Date().toISOString(),
    });

  const postProgress = (currentPath: string) => {
    post({
      type: 'progress',
      progress: {
        itemsSeen,
        imagesFound,
        foldersScanned,
        currentPath,
        message: throttleMessage || `Scanning ${currentPath}`,
      },
    });
    throttleMessage = '';
  };

  const finishSession = async (status: ScanSession['status'], error: string | null): Promise<ScanSession> => {
    const finished: ScanSession = {
      ...session,
      status,
      finishedAt: new Date().toISOString(),
      itemsSeen,
      filesScanned: imagesFound,
      foldersScanned,
      totalBytes,
      error,
    };
    await scanSessionRepository.put(finished);
    return finished;
  };

  try {
    // Breadth-first walk of the folder tree via /children (200 items per page).
    while (queue.length > 0 && !cancelled) {
      const folder = queue[0];
      foldersScanned++;
      postProgress(folder.path);

      // Subfolders are staged locally and only committed to the persisted queue
      // once the whole folder is done, so a crash mid-folder never loses them.
      const discovered: Array<{ itemId: string | null; path: string }> = [];

      let page =
        folder.itemId === null
          ? await graph.listDriveRootChildren(abortController.signal)
          : await graph.listDriveItemChildren(folder.itemId, abortController.signal);

      for (;;) {
        if (cancelled) break;
        const records: FileRecord[] = [];
        for (const item of page.value) {
          itemsSeen++;
          if (item.folder) {
            discovered.push({ itemId: item.id, path: joinPath(folder.path, item.name) });
            continue;
          }
          // Index every file (not just images) — any file type can have exact
          // duplicates. Items without a file facet (e.g. OneNote, bundles) are skipped.
          if (!item.file) continue;
          const record = toFileRecord(item, folder.path, sessionId);
          if (record) {
            records.push(record);
            imagesFound++;
            totalBytes += record.size;
          }
        }
        if (records.length > 0) await fileRepository.upsertMany(records);
        postProgress(folder.path);

        const nextLink = page['@odata.nextLink'];
        if (!nextLink) break;
        page = await graph.listChildrenPage(nextLink, abortController.signal);
      }

      if (cancelled) break;

      // Folder finished: drop it from the frontier, append its subfolders, and
      // checkpoint so a later resume continues from exactly here.
      queue = [...queue.slice(1), ...discovered];
      await saveCheckpoint();
    }

    if (cancelled) {
      // Keep the checkpoint so the user can resume the cancelled scan later.
      const finished = await finishSession('cancelled', null);
      await scanSessionRepository.setLastFinished(sessionId);
      post({ type: 'done', session: finished });
      return;
    }

    // Scan completed — records inside the scanned scope that this session did not
    // touch belong to files that no longer exist in OneDrive. A scoped scan must
    // only purge within its scope; results from other folders are kept.
    if (scopePaths) {
      await fileRepository.purgeNotInSessionUnder(sessionId, scopePaths);
    } else {
      await fileRepository.purgeNotInSession(sessionId);
    }
    await scanSessionRepository.clearCheckpoint();
    const finished = await finishSession('completed', null);
    await scanSessionRepository.setLastFinished(sessionId);
    post({ type: 'done', session: finished });
  } catch (e) {
    if (cancelled) {
      const finished = await finishSession('cancelled', null);
      await scanSessionRepository.setLastFinished(sessionId);
      post({ type: 'done', session: finished });
      return;
    }
    // Leave the checkpoint in place so the scan can resume from the last
    // completed folder instead of starting over.
    const error = messageOf(e);
    await finishSession('failed', error);
    post({ type: 'error', error });
  }
}

function toFileRecord(item: GraphDriveItem, parentPath: string, scanSessionId: string): FileRecord | null {
  if (!item.id || !item.name) return null;
  const hashes = item.file?.hashes ?? {};
  return {
    id: item.id,
    driveId: item.parentReference?.driveId ?? '',
    itemId: item.id,
    name: item.name,
    path: parentPath,
    size: item.size ?? 0,
    mimeType: item.file?.mimeType ?? '',
    quickXorHash: hashes.quickXorHash ?? null,
    sha1Hash: hashes.sha1Hash ?? null,
    sha256Hash: hashes.sha256Hash ?? null,
    width: item.image?.width ?? null,
    height: item.image?.height ?? null,
    createdDateTime: item.createdDateTime ?? '',
    lastModifiedDateTime: item.lastModifiedDateTime ?? '',
    thumbnailUrl: item.thumbnails?.[0]?.medium?.url ?? null,
    webUrl: item.webUrl ?? null,
    scanSessionId,
    status: 'active',
  };
}

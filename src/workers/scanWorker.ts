import { createGraphClient, type TokenSource } from '../services/graph/graphClient';
import { createOneDriveService, type GraphDriveItem } from '../services/graph/oneDriveService';
import { fileRepository } from '../services/db/fileRepository';
import { scanSessionRepository } from '../services/db/scanSessionRepository';
import {
  IMAGE_MIME_TYPES,
  type FileRecord,
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
    void runScan(message.sessionId);
  } else if (message.type === 'cancel') {
    cancelled = true;
    abortController.abort();
  } else if (message.type === 'token') {
    tokenWaiters.get(message.requestId)?.(message.accessToken);
    tokenWaiters.delete(message.requestId);
  }
};

async function runScan(sessionId: string): Promise<void> {
  const session = await scanSessionRepository.get(sessionId);
  if (!session) {
    post({ type: 'error', error: 'Scan session not found.' });
    return;
  }

  let itemsSeen = 0;
  let imagesFound = 0;
  let foldersScanned = 0;
  let totalBytes = 0;

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
    const queue: Array<{ itemId: string | null; path: string }> = [{ itemId: null, path: '/' }];

    while (queue.length > 0 && !cancelled) {
      const folder = queue.shift()!;
      foldersScanned++;
      postProgress(folder.path);

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
            queue.push({ itemId: item.id, path: joinPath(folder.path, item.name) });
            continue;
          }
          const mimeType = item.file?.mimeType ?? '';
          if (!IMAGE_MIME_TYPES.has(mimeType)) continue;
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
    }

    if (cancelled) {
      const finished = await finishSession('cancelled', null);
      await scanSessionRepository.setLastFinished(sessionId);
      post({ type: 'done', session: finished });
      return;
    }

    // Full scan completed — records not touched by this session belong to files
    // that no longer exist in OneDrive.
    await fileRepository.purgeNotInSession(sessionId);
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

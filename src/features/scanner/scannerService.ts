import { useSyncExternalStore } from 'react';
import type {
  ScanProgress,
  ScanSession,
  ScanWorkerRequest,
  ScanWorkerResponse,
} from './scanTypes';
import type {
  DuplicateWorkerRequest,
  DuplicateWorkerResponse,
} from '../duplicates/duplicateTypes';
import { scanSessionRepository } from '../../services/db/scanSessionRepository';

export type ScanPhase = 'idle' | 'scanning' | 'grouping' | 'completed' | 'error';

export interface ScannerState {
  phase: ScanPhase;
  sessionId: string | null;
  progress: ScanProgress;
  /** The finished scan session (also set when cancelled — partial results are kept). */
  session: ScanSession | null;
  groupsFound: number;
  duplicateFiles: number;
  wastedBytes: number;
  error: string | null;
  /** An interrupted scan can be resumed from its last checkpoint. */
  resumable: boolean;
  /** Progress captured in the resumable checkpoint, for display. */
  resumeInfo: { imagesFound: number; foldersScanned: number } | null;
}

const INITIAL_PROGRESS: ScanProgress = {
  itemsSeen: 0,
  imagesFound: 0,
  foldersScanned: 0,
  currentPath: '',
  message: '',
};

const INITIAL_STATE: ScannerState = {
  phase: 'idle',
  sessionId: null,
  progress: INITIAL_PROGRESS,
  session: null,
  groupsFound: 0,
  duplicateFiles: 0,
  wastedBytes: 0,
  error: null,
  resumable: false,
  resumeInfo: null,
};

// Module-level singleton so an in-flight scan survives route changes.
let state: ScannerState = INITIAL_STATE;
let scanWorker: Worker | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<ScannerState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export const scannerService = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): ScannerState {
    return state;
  },

  isBusy(): boolean {
    return state.phase === 'scanning' || state.phase === 'grouping';
  },

  /** Reads the persisted checkpoint (if any) and exposes whether a scan can be resumed. */
  async checkResumable(): Promise<boolean> {
    const checkpoint = await scanSessionRepository.getCheckpoint();
    const resumable = !!checkpoint && checkpoint.queue.length > 0;
    setState({
      resumable,
      resumeInfo:
        resumable && checkpoint
          ? { imagesFound: checkpoint.imagesFound, foldersScanned: checkpoint.foldersScanned }
          : null,
    });
    return resumable;
  },

  async start(
    getAccessToken: () => Promise<string | null>,
    options: { resume?: boolean } = {},
  ): Promise<void> {
    if (scannerService.isBusy()) return;

    let token: string | null = null;
    try {
      token = await getAccessToken();
    } catch {
      token = null;
    }
    if (!token) {
      setState({ phase: 'error', error: 'Could not get an access token. Sign in again and retry.' });
      return;
    }

    const checkpoint = await scanSessionRepository.getCheckpoint();
    const resume = options.resume === true && !!checkpoint && checkpoint.queue.length > 0;

    let sessionId: string;
    if (resume && checkpoint) {
      sessionId = checkpoint.sessionId;
      setState({
        phase: 'scanning',
        sessionId,
        progress: {
          itemsSeen: checkpoint.itemsSeen,
          imagesFound: checkpoint.imagesFound,
          foldersScanned: checkpoint.foldersScanned,
          currentPath: '',
          message: 'Resuming scan…',
        },
        session: null,
        groupsFound: 0,
        duplicateFiles: 0,
        wastedBytes: 0,
        error: null,
        resumable: false,
        resumeInfo: null,
      });
    } else {
      // Fresh scan: drop any stale checkpoint so we start from the drive root.
      if (checkpoint) await scanSessionRepository.clearCheckpoint();
      const session: ScanSession = {
        id: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        itemsSeen: 0,
        filesScanned: 0,
        foldersScanned: 0,
        totalBytes: 0,
        error: null,
      };
      await scanSessionRepository.put(session);
      sessionId = session.id;

      setState({
        phase: 'scanning',
        sessionId,
        progress: INITIAL_PROGRESS,
        session: null,
        groupsFound: 0,
        duplicateFiles: 0,
        wastedBytes: 0,
        error: null,
        resumable: false,
        resumeInfo: null,
      });
    }

    const worker = new Worker(new URL('../../workers/scanWorker.ts', import.meta.url), { type: 'module' });
    scanWorker = worker;

    worker.onmessage = (event: MessageEvent<ScanWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case 'progress':
          setState({ progress: message.progress });
          break;
        case 'needToken':
          getAccessToken()
            .catch(() => null)
            .then((fresh) => {
              worker.postMessage({
                type: 'token',
                requestId: message.requestId,
                accessToken: fresh,
              } satisfies ScanWorkerRequest);
            });
          break;
        case 'done':
          worker.terminate();
          scanWorker = null;
          setState({ session: message.session });
          startGrouping(message.session);
          break;
        case 'error':
          worker.terminate();
          scanWorker = null;
          setState({ phase: 'error', error: message.error });
          void scannerService.checkResumable();
          break;
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      scanWorker = null;
      setState({ phase: 'error', error: event.message || 'Scan worker crashed.' });
      void scannerService.checkResumable();
    };

    worker.postMessage({ type: 'start', sessionId, resume, accessToken: token } satisfies ScanWorkerRequest);
  },

  cancel(): void {
    scanWorker?.postMessage({ type: 'cancel' } satisfies ScanWorkerRequest);
    if (state.phase === 'scanning') {
      setState({ progress: { ...state.progress, message: 'Cancelling scan…' } });
    }
  },

  reset(): void {
    if (!scannerService.isBusy()) setState(INITIAL_STATE);
  },
};

function startGrouping(session: ScanSession): void {
  if (session.filesScanned === 0) {
    setState({ phase: 'completed', groupsFound: 0, duplicateFiles: 0, wastedBytes: 0 });
    void scannerService.checkResumable();
    return;
  }

  setState({ phase: 'grouping', progress: { ...state.progress, message: 'Analyzing duplicates…' } });
  const worker = new Worker(new URL('../../workers/duplicateWorker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent<DuplicateWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'progress') {
      setState({ progress: { ...state.progress, message: message.message } });
    } else if (message.type === 'done') {
      worker.terminate();
      setState({
        phase: 'completed',
        groupsFound: message.groupsFound,
        duplicateFiles: message.duplicateFiles,
        wastedBytes: message.wastedBytes,
      });
      // A cancelled scan keeps its checkpoint, so it can still be resumed.
      void scannerService.checkResumable();
    } else {
      worker.terminate();
      setState({ phase: 'error', error: message.error });
    }
  };
  worker.onerror = (event) => {
    worker.terminate();
    setState({ phase: 'error', error: event.message || 'Duplicate analysis worker crashed.' });
  };

  worker.postMessage({ type: 'group', scanSessionId: session.id } satisfies DuplicateWorkerRequest);
}

export function useScannerState(): ScannerState {
  return useSyncExternalStore(scannerService.subscribe, scannerService.getState);
}

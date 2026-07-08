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

  async start(getAccessToken: () => Promise<string | null>): Promise<void> {
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

    setState({
      phase: 'scanning',
      sessionId: session.id,
      progress: INITIAL_PROGRESS,
      session: null,
      groupsFound: 0,
      duplicateFiles: 0,
      wastedBytes: 0,
      error: null,
    });

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
          break;
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      scanWorker = null;
      setState({ phase: 'error', error: event.message || 'Scan worker crashed.' });
    };

    worker.postMessage({ type: 'start', sessionId: session.id, accessToken: token } satisfies ScanWorkerRequest);
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

import type { ScanCheckpoint, ScanSession } from '../../features/scanner/scanTypes';
import { STORE, dbGet, dbGetAll, dbPut, getSetting, removeSetting, setSetting } from './indexedDb';

const LAST_SESSION_KEY = 'lastScanSessionId';
const CHECKPOINT_KEY = 'scanCheckpoint';

export const scanSessionRepository = {
  put(session: ScanSession): Promise<void> {
    return dbPut(STORE.scanSessions, session);
  },

  get(id: string): Promise<ScanSession | undefined> {
    return dbGet<ScanSession>(STORE.scanSessions, id);
  },

  async getAll(): Promise<ScanSession[]> {
    const sessions = await dbGetAll<ScanSession>(STORE.scanSessions);
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  async getLastFinished(): Promise<ScanSession | undefined> {
    const id = await getSetting<string>(LAST_SESSION_KEY);
    return id ? dbGet<ScanSession>(STORE.scanSessions, id) : undefined;
  },

  setLastFinished(id: string): Promise<void> {
    return setSetting(LAST_SESSION_KEY, id);
  },

  /** Walk state for resuming an interrupted scan. Written after each folder completes. */
  saveCheckpoint(checkpoint: ScanCheckpoint): Promise<void> {
    return setSetting(CHECKPOINT_KEY, checkpoint);
  },

  getCheckpoint(): Promise<ScanCheckpoint | undefined> {
    return getSetting<ScanCheckpoint>(CHECKPOINT_KEY);
  },

  clearCheckpoint(): Promise<void> {
    return removeSetting(CHECKPOINT_KEY);
  },
};

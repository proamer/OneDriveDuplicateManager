import type { FileRecord, FileStatus } from '../../features/scanner/scanTypes';
import { STORE, dbBulkPut, dbCount, dbDeleteWhere, dbGet, dbGetAllByIndex, dbPut } from './indexedDb';

export const fileRepository = {
  upsertMany(files: FileRecord[]): Promise<void> {
    return dbBulkPut(STORE.files, files);
  },

  get(id: string): Promise<FileRecord | undefined> {
    return dbGet<FileRecord>(STORE.files, id);
  },

  async getMany(ids: string[]): Promise<FileRecord[]> {
    const records = await Promise.all(ids.map((id) => dbGet<FileRecord>(STORE.files, id)));
    return records.filter((record): record is FileRecord => record !== undefined);
  },

  getBySession(scanSessionId: string): Promise<FileRecord[]> {
    return dbGetAllByIndex<FileRecord>(STORE.files, 'byScanSession', scanSessionId);
  },

  async setStatus(id: string, status: FileStatus): Promise<void> {
    const record = await dbGet<FileRecord>(STORE.files, id);
    if (record) await dbPut(STORE.files, { ...record, status });
  },

  async setThumbnail(id: string, thumbnailUrl: string): Promise<void> {
    const record = await dbGet<FileRecord>(STORE.files, id);
    if (record) await dbPut(STORE.files, { ...record, thumbnailUrl });
  },

  count(): Promise<number> {
    return dbCount(STORE.files);
  },

  /** Removes records for files no longer present in OneDrive (not seen by a completed scan). */
  purgeNotInSession(scanSessionId: string): Promise<number> {
    return dbDeleteWhere<FileRecord>(STORE.files, (file) => file.scanSessionId !== scanSessionId);
  },
};

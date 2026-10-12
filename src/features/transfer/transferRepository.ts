import type { CopyEntry } from './transferService';
import type { FolderChoice } from './CloudFolderBrowser';
import type { TransferTiming } from './transferTiming';

export interface TransferJob {
  id: string;
  createdAt: string;
  microsoftAccountId: string;
  googleAccountId: string;
  googleEmail: string;
  source: FolderChoice;
  target: FolderChoice;
  copyName: string;
  entries: CopyEntry[];
}
export interface TransferCheckpoint {
  jobId: string;
  sourceId: string;
  destinationId: string;
  bytes: number;
  done: boolean;
  uploadUrl?: string;
}
export interface TransferStore {
  checkpoints(jobId: string): Promise<TransferCheckpoint[]>;
  saveCheckpoint(checkpoint: TransferCheckpoint): Promise<void>;
  timing?(jobId: string): Promise<TransferTiming | undefined>;
  saveTiming?(timing: TransferTiming): Promise<void>;
}

// Separate from scan caches: clearing the scanner's data must not discard a copy job.
const DATABASE = 'onedrive-google-copy';
let connection: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('checkpoints')) {
        const store = db.createObjectStore('checkpoints', { keyPath: ['jobId', 'sourceId'] });
        store.createIndex('job', 'jobId');
      }
      if (!db.objectStoreNames.contains('timings')) db.createObjectStore('timings', { keyPath: 'jobId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('ปิดแท็บอื่นของแอปก่อนเปิดข้อมูลงาน')); };
  });
}
async function transaction<T>(name: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = action(tx.objectStore(name));
      // Await commit, not just request success. Quota failures can happen at commit.
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error ?? new Error('บันทึกงานไม่สำเร็จ'));
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('พื้นที่เก็บสถานะในเบราว์เซอร์เต็ม งานพักไว้ก่อน กรุณาเพิ่มพื้นที่โดยไม่ลบข้อมูลเว็บไซต์นี้');
    }
    throw error;
  }
}
export const transferRepository: TransferStore & {
  jobs(): Promise<TransferJob[]>;
  saveJob(job: TransferJob): Promise<void>;
} = {
  jobs: () => transaction('jobs', 'readonly', store => store.getAll()),
  saveJob: async job => { await transaction('jobs', 'readwrite', store => store.put(job)); },
  checkpoints: jobId => transaction('checkpoints', 'readonly', store => store.index('job').getAll(jobId)),
  saveCheckpoint: async checkpoint => { await transaction('checkpoints', 'readwrite', store => store.put(checkpoint)); },
  timing: jobId => transaction('timings', 'readonly', store => store.get(jobId)),
  saveTiming: async timing => { await transaction('timings', 'readwrite', store => store.put(timing)); },
};

export async function checkMetadataSpace(entries: CopyEntry[]): Promise<void> {
  if (!navigator.storage?.estimate) return;
  const { quota, usage } = await navigator.storage.estimate();
  // Only metadata is stored; reserve headroom for checkpoints and IndexedDB overhead.
  const metadataBytes = new Blob([JSON.stringify(entries)]).size;
  const needed = metadataBytes * 4 + entries.length * 2048 + 5 * 1024 * 1024;
  if (quota !== undefined && usage !== undefined && quota - usage < needed) {
    throw new Error('พื้นที่เบราว์เซอร์เหลือไม่พอสำหรับบันทึกรายการงาน เพิ่มพื้นที่ก่อนเริ่มคัดลอก');
  }
}

const DB_NAME = 'onedrive-duplicate-cleaner';
const DB_VERSION = 1;

export const STORE = {
  files: 'files',
  duplicateGroups: 'duplicateGroups',
  duplicateGroupItems: 'duplicateGroupItems',
  scanSessions: 'scanSessions',
  deleteJobs: 'deleteJobs',
  ignoreList: 'ignoreList',
  appSettings: 'appSettings',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

/** Works from both the main thread and Web Workers (each context opens its own connection). */
export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE.files)) {
          const files = db.createObjectStore(STORE.files, { keyPath: 'id' });
          files.createIndex('byScanSession', 'scanSessionId');
        }
        if (!db.objectStoreNames.contains(STORE.duplicateGroups)) {
          db.createObjectStore(STORE.duplicateGroups, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.duplicateGroupItems)) {
          const items = db.createObjectStore(STORE.duplicateGroupItems, { keyPath: 'id' });
          items.createIndex('byGroup', 'groupId');
          items.createIndex('byFile', 'fileId');
        }
        if (!db.objectStoreNames.contains(STORE.scanSessions)) {
          db.createObjectStore(STORE.scanSessions, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.deleteJobs)) {
          db.createObjectStore(STORE.deleteJobs, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.ignoreList)) {
          db.createObjectStore(STORE.ignoreList, { keyPath: 'groupKey' });
        }
        if (!db.objectStoreNames.contains(STORE.appSettings)) {
          db.createObjectStore(STORE.appSettings, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        // Another tab upgrading the schema needs us to release the connection.
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Runs `fn` inside a transaction. `fn` must only await IndexedDB requests from the
 * same transaction — awaiting anything else (fetch, timers) auto-commits the transaction.
 */
async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const result = await fn(tx.objectStore(name));
  await done;
  return result;
}

export function dbGet<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore(name, 'readonly', (store) => requestToPromise(store.get(key) as IDBRequest<T | undefined>));
}

export function dbGetAll<T>(name: StoreName): Promise<T[]> {
  return withStore(name, 'readonly', (store) => requestToPromise(store.getAll() as IDBRequest<T[]>));
}

export function dbGetAllByIndex<T>(name: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  return withStore(name, 'readonly', (store) =>
    requestToPromise(store.index(index).getAll(key) as IDBRequest<T[]>),
  );
}

export function dbPut<T>(name: StoreName, value: T): Promise<void> {
  return withStore(name, 'readwrite', (store) => {
    store.put(value as unknown as object);
  });
}

export function dbBulkPut<T>(name: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return withStore(name, 'readwrite', (store) => {
    for (const value of values) store.put(value as unknown as object);
  });
}

export function dbDelete(name: StoreName, key: IDBValidKey): Promise<void> {
  return withStore(name, 'readwrite', (store) => {
    store.delete(key);
  });
}

export function dbBulkDelete(name: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return withStore(name, 'readwrite', (store) => {
    for (const key of keys) store.delete(key);
  });
}

export function dbClear(name: StoreName): Promise<void> {
  return withStore(name, 'readwrite', (store) => {
    store.clear();
  });
}

export function dbCount(name: StoreName): Promise<number> {
  return withStore(name, 'readonly', (store) => requestToPromise(store.count()));
}

/** Cursor-based filtered delete — memory-safe for large stores. Returns deleted count. */
export function dbDeleteWhere<T>(name: StoreName, predicate: (value: T) => boolean): Promise<number> {
  return withStore(
    name,
    'readwrite',
    (store) =>
      new Promise<number>((resolve, reject) => {
        let deleted = 0;
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve(deleted);
            return;
          }
          if (predicate(cursor.value as T)) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
      }),
  );
}

interface SettingRecord<T> {
  key: string;
  value: T;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const record = await dbGet<SettingRecord<T>>(STORE.appSettings, key);
  return record?.value;
}

export function setSetting<T>(key: string, value: T): Promise<void> {
  return dbPut(STORE.appSettings, { key, value } satisfies SettingRecord<T>);
}

export async function clearAllData(): Promise<void> {
  for (const name of Object.values(STORE)) {
    await dbClear(name);
  }
}

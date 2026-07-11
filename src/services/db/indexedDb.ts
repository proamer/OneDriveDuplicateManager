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
        const db = request.result;
        // Another tab upgrading the schema needs us to release the connection.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        // iOS Safari quietly drops IndexedDB connections when the tab is
        // backgrounded or a Web Worker is suspended (common during a long scan
        // with throttling waits). Forget the dead handle so the next call
        // reopens instead of failing on a stale connection.
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Drops the cached connection (closing it if possible) so the next call reopens fresh. */
function invalidateConnection(): void {
  const pending = dbPromise;
  dbPromise = null;
  void pending?.then((db) => db.close()).catch(() => undefined);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Transient transaction failures (stale connection after a suspend) are retried this many times. */
const MAX_TX_ATTEMPTS = 4;

/**
 * QuotaExceededError means the browser is out of storage — retrying cannot help,
 * so surface it. Everything else is treated as a transient connection hiccup.
 */
function isTransientDbError(error: unknown): boolean {
  return !(error instanceof DOMException && error.name === 'QuotaExceededError');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` inside a transaction. `fn` must only await IndexedDB requests from the
 * same transaction — awaiting anything else (fetch, timers) auto-commits the transaction.
 *
 * IndexedDB transactions are atomic, so a failed attempt commits nothing and is safe to
 * retry: on failure we drop the (possibly dead) connection and reopen a fresh one.
 */
async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt++) {
    try {
      const db = await openDb();
      // db.transaction() throws synchronously (InvalidStateError) on a closing connection.
      const tx = db.transaction(name, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
      const result = await fn(tx.objectStore(name));
      await done;
      return result;
    } catch (error) {
      lastError = error;
      invalidateConnection();
      if (!isTransientDbError(error) || attempt === MAX_TX_ATTEMPTS - 1) break;
      await delay(100 * 2 ** attempt);
    }
  }
  throw lastError;
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

/** Keys are deleted in chunks this size so no single transaction runs too long on iOS Safari. */
const DELETE_BATCH_SIZE = 500;

/**
 * Filtered delete for large stores. Collects matching keys in a read-only pass, then deletes
 * them in small batches — one giant readwrite transaction over tens of thousands of records
 * is a common failure point on iOS Safari. Returns the deleted count.
 */
export async function dbDeleteWhere<T>(
  name: StoreName,
  predicate: (value: T) => boolean,
): Promise<number> {
  const keys = await withStore(
    name,
    'readonly',
    (store) =>
      new Promise<IDBValidKey[]>((resolve, reject) => {
        const matched: IDBValidKey[] = [];
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve(matched);
            return;
          }
          if (predicate(cursor.value as T)) matched.push(cursor.primaryKey);
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
      }),
  );

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    await dbBulkDelete(name, keys.slice(i, i + DELETE_BATCH_SIZE));
  }
  return keys.length;
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

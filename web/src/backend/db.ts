/** Minimal IndexedDB key-value helper (one database, a few object stores). */

const DB_NAME = 'rapidraw-web';
const DB_VERSION = 1;
export type StoreName = 'kv' | 'sidecars' | 'handles' | 'thumbs';
const STORES: StoreName[] = ['kv', 'sidecars', 'handles', 'thumbs'];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

// In-memory fallback when IndexedDB is unavailable (private mode, blocked storage).
const memory = new Map<string, any>();

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (!db) return reject(new Error('no-idb'));
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function get<T = any>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    return await run<T>(store, 'readonly', (s) => s.get(key));
  } catch {
    return memory.get(`${store}:${key}`);
  }
}

export async function set(store: StoreName, key: string, value: any): Promise<void> {
  try {
    await run(store, 'readwrite', (s) => s.put(value, key));
  } catch {
    memory.set(`${store}:${key}`, value);
  }
}

export async function del(store: StoreName, key: string): Promise<void> {
  try {
    await run(store, 'readwrite', (s) => s.delete(key));
  } catch {
    memory.delete(`${store}:${key}`);
  }
}

export async function clear(store: StoreName): Promise<void> {
  try {
    await run(store, 'readwrite', (s) => s.clear());
  } catch {
    for (const k of [...memory.keys()]) if (k.startsWith(`${store}:`)) memory.delete(k);
  }
}

export async function keys(store: StoreName): Promise<string[]> {
  try {
    return (await run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys())).map(String);
  } catch {
    return [...memory.keys()].filter((k) => k.startsWith(`${store}:`)).map((k) => k.slice(store.length + 1));
  }
}

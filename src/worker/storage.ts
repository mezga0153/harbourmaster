import type { SaveData } from '../sim/world';

const DB_NAME = 'harbourmaster';
const STORE = 'saves';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          reject(req.error);
          db.close();
        };
      }),
  );
}

export function loadSave(slot = 'autosave'): Promise<SaveData | undefined> {
  return run('readonly', (s) => s.get(slot));
}

export function writeSave(data: SaveData, slot = 'autosave'): Promise<IDBValidKey> {
  return run('readwrite', (s) => s.put(data, slot));
}

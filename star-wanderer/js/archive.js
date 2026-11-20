/* A very small local archive. IndexedDB only; nothing leaves the browser. */

const DB_NAME = 'star-wanderer';
const DB_VERSION = 1;
const STORE = 'records';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

export async function add(record) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.add(record);
    r.onsuccess = () => resolve(record);
    r.onerror = () => reject(r.error);
  });
}

export async function list() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => {
      const rows = r.result || [];
      rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      resolve(rows);
    };
    r.onerror = () => reject(r.error);
  });
}

export async function remove(id) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function clear() {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const r = store.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

/**
 * IndexedDB schema v1.
 *
 * Observed Suno clip identity is a UUID. Curation is a separate store so
 * re-index never clobbers user annotations.
 */

export const DB_NAME = "suno-library-ff";
export const SCHEMA_VERSION = 1;

/** @type {IDBDatabase | null} */
let dbPromiseCache = null;

export function openDb() {
  if (dbPromiseCache) return dbPromiseCache;

  dbPromiseCache = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      migrate(db, oldVersion, SCHEMA_VERSION);
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromiseCache;
}

/**
 * @param {IDBDatabase} db
 * @param {number} from
 * @param {number} to
 */
function migrate(db, from, to) {
  if (from < 1 && to >= 1) {
    const clips = db.createObjectStore("clips", { keyPath: "id" });
    clips.createIndex("created_at", "created_at");
    clips.createIndex("title", "title");
    clips.createIndex("model_name", "model_name");
    clips.createIndex("status", "status");

    db.createObjectStore("curation", { keyPath: "clip_id" });

    const edges = db.createObjectStore("edges", { keyPath: "id" });
    edges.createIndex("parent_id", "parent_id");
    edges.createIndex("child_id", "child_id");

    db.createObjectStore("playlists", { keyPath: "id" });
    db.createObjectStore("sync_state", { keyPath: "key" });
  }
}

/**
 * @param {string} storeName
 * @param {"readonly" | "readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest} fn
 */
export async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putClip(clip) {
  return withStore("clips", "readwrite", (s) => s.put(clip));
}

export async function putClips(clips) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("clips", "readwrite");
    const store = tx.objectStore("clips");
    for (const clip of clips) store.put(clip);
    tx.oncomplete = () => resolve(clips.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function countClips() {
  return withStore("clips", "readonly", (s) => s.count());
}

export async function getSyncState(key) {
  return withStore("sync_state", "readonly", (s) => s.get(key));
}

export async function setSyncState(key, value) {
  return withStore("sync_state", "readwrite", (s) =>
    s.put({ key, ...value, updated_at: new Date().toISOString() })
  );
}

export async function getClip(id) {
  return withStore("clips", "readonly", (s) => s.get(id));
}

export async function getCuration(clipId) {
  return withStore("curation", "readonly", (s) => s.get(clipId));
}

export async function getAllClips() {
  return withStore("clips", "readonly", (s) => s.getAll());
}

export async function listClips(limit = 50) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("clips", "readonly");
    const index = tx.objectStore("clips").index("created_at");
    const req = index.openCursor(null, "prev");
    const out = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

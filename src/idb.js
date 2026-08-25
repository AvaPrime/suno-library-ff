/**
 * IndexedDB schema v1.
 *
 * Observed Suno clip identity is a UUID. Curation is a separate store so
 * re-index never clobbers user annotations. Edges are derived on insert
 * from clip lineage (cover / extend / mashup / infill).
 */

import { edgesFromClip, lineageFromRaw } from "./lineage.js";

export const DB_NAME = "suno-library-ff";
export const SCHEMA_VERSION = 1;

/** @type {Promise<IDBDatabase> | null} */
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
    clips.createIndex("parent_id", "parent_id");

    db.createObjectStore("curation", { keyPath: "clip_id" });

    const edges = db.createObjectStore("edges", { keyPath: "id" });
    edges.createIndex("parent_id", "parent_id");
    edges.createIndex("child_id", "child_id");
    edges.createIndex("kind", "kind");

    db.createObjectStore("playlists", { keyPath: "id" });
    db.createObjectStore("sync_state", { keyPath: "key" });
  }
}

/**
 * Existing v1 DBs may lack later indexes. Create them in place.
 * @param {IDBDatabase} db
 */
function ensureIndexes(db) {
  // Indexes can only be created in versionchange. If this DB was
  // created before parent_id/kind indexes, queries fall back to scans
  // via getAll + filter in listChildren / listParents.
  return db;
}

/**
 * @param {string} storeName
 * @param {"readonly" | "readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest} fn
 */
export async function withStore(storeName, mode, fn) {
  const db = await openDb();
  ensureIndexes(db);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function writeClipAndEdges(clipStore, edgeStore, clip) {
  clipStore.put(clip);
  for (const edge of edgesFromClip(clip)) {
    edgeStore.put(edge);
  }
}

export async function putClip(clip) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["clips", "edges"], "readwrite");
    writeClipAndEdges(tx.objectStore("clips"), tx.objectStore("edges"), clip);
    tx.oncomplete = () => resolve(clip.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function putClips(clips) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["clips", "edges"], "readwrite");
    const clipStore = tx.objectStore("clips");
    const edgeStore = tx.objectStore("edges");
    for (const clip of clips) writeClipAndEdges(clipStore, edgeStore, clip);
    tx.oncomplete = () => resolve(clips.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function countClips() {
  return withStore("clips", "readonly", (s) => s.count());
}

export async function countEdges() {
  return withStore("edges", "readonly", (s) => s.count());
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

export async function getAllEdges() {
  return withStore("edges", "readonly", (s) => s.getAll());
}

/**
 * Re-read parent pointers from stored `raw` and rewrite edges.
 * Fixes indexes built before cover_clip_id was normalized.
 */
export async function rebuildLineage() {
  const clips = await getAllClips();
  const patched = clips.map((clip) => {
    const source = clip.raw && typeof clip.raw === "object" ? clip.raw : clip;
    const lineage = lineageFromRaw(source);
    return {
      ...clip,
      parent_id: lineage.parent_id,
      parent_kind: lineage.kind,
      extra_parents: lineage.extra_parents,
    };
  });
  await putClips(patched);
  return {
    clips: patched.length,
    edges: patched.reduce((n, clip) => n + edgesFromClip(clip).length, 0),
  };
}

export async function listChildren(parentId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("edges", "readonly");
    const store = tx.objectStore("edges");
    if (store.indexNames.contains("parent_id")) {
      const req = store.index("parent_id").getAll(String(parentId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      return;
    }
    const req = store.getAll();
    req.onsuccess = () => {
      resolve((req.result || []).filter((e) => e.parent_id === String(parentId)));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listParents(childId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("edges", "readonly");
    const store = tx.objectStore("edges");
    if (store.indexNames.contains("child_id")) {
      const req = store.index("child_id").getAll(String(childId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      return;
    }
    const req = store.getAll();
    req.onsuccess = () => {
      resolve((req.result || []).filter((e) => e.child_id === String(childId)));
    };
    req.onerror = () => reject(req.error);
  });
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

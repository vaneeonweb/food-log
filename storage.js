// storage.js — durable local store (IndexedDB).
//
// Entries are written here the instant you confirm them, before any network is
// involved (PLAN.md §Phase 3: capture must work offline). Each entry carries a
// `synced` flag; the Drive sync engine (step 2) pushes everything still false.
// Nothing here ever depends on a connection.

const DB_NAME = "foodlog";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("entries")) {
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
        store.createIndex("synced", "synced", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction("entries", mode);
    const store = t.objectStore("entries");
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Dirty-date queue (localStorage): which days changed since the last Drive push.
// Any add/edit/delete marks its date dirty; the sync flush rewrites those whole
// day-files and clears them. This is what makes deletes and edits propagate.
function markDirty(date) {
  const s = new Set(JSON.parse(localStorage.getItem("dirtyDates") || "[]"));
  s.add(date);
  localStorage.setItem("dirtyDates", JSON.stringify([...s]));
}
function getDirtyDates() {
  return JSON.parse(localStorage.getItem("dirtyDates") || "[]");
}
function clearDirty(date) {
  const s = new Set(JSON.parse(localStorage.getItem("dirtyDates") || "[]"));
  s.delete(date);
  localStorage.setItem("dirtyDates", JSON.stringify([...s]));
}

async function addEntry(entry) {
  const db = await openDB();
  await tx(db, "readwrite", (store) => store.put(entry));
  markDirty(entry.date);
}

async function getAllEntries() {
  const db = await openDB();
  return tx(db, "readonly", (store) => new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}

async function getEntriesByDate(date) {
  const db = await openDB();
  return tx(db, "readonly", (store) => new Promise((res, rej) => {
    const req = store.index("date").getAll(date);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  }));
}

async function deleteEntry(id, date) {
  const db = await openDB();
  await tx(db, "readwrite", (store) => store.delete(id));
  if (date) markDirty(date);
}

window.Store = { addEntry, getAllEntries, getEntriesByDate, deleteEntry, markDirty, getDirtyDates, clearDirty };

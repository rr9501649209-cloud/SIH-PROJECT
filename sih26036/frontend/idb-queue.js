// frontend/idb-queue.js
//
// This is what makes the Officer console actually offline-capable rather
// than just claiming to be: if a verification is recorded with no network,
// it's written here (IndexedDB, not memory) so it survives a page reload
// or the officer's phone dying mid-shift, then drained automatically the
// moment the browser fires an 'online' event. Server-side idempotency via
// clientSubmissionId (see backend/server.ts) makes replaying this queue
// safe even if a sync partially completed before a connection drop.

const DB_NAME = 'setu-offline';
const DB_VERSION = 1;
const STORE = 'outbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientSubmissionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueSubmission(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateQueuedSubmission(record) {
  return queueSubmission(record);
}

async function getQueuedSubmissions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removeQueuedSubmission(clientSubmissionId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(clientSubmissionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

window.offlineQueue = {
  queueSubmission,
  updateQueuedSubmission,
  getQueuedSubmissions,
  removeQueuedSubmission,
};

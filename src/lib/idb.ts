import type { TextVocabCache, VocabCacheEntry } from "./library";

const DB_NAME = "chinese-reader";
const DB_VERSION = 2;

export const STORE_VOCAB_CACHE = "vocab_cache";
export const STORE_SESSIONS = "sessions";
export const STORE_VOCAB_QUEUE = "vocab_queue";
export const STORE_TEXT_META = "text_meta";

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        db.createObjectStore(STORE_VOCAB_CACHE, { keyPath: "term" });
      }
      if (oldVersion < 2) {
        // sessions: keyPath = local_id (uuid).
        // status: "in_progress" | "completed_pending_upload" | "uploaded"
        const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: "local_id" });
        sessions.createIndex("status", "status");
        sessions.createIndex("text_id", "text_id");

        // vocab_queue: keyPath = auto-incremented id. one row per change.
        const vocabQueue = db.createObjectStore(STORE_VOCAB_QUEUE, {
          keyPath: "id",
          autoIncrement: true,
        });
        vocabQueue.createIndex("status_in_idb", "status_in_idb");
        vocabQueue.createIndex("changed_at", "changed_at");

        // text_meta: keyPath = text_id. tracks last_cached_at etc.
        db.createObjectStore(STORE_TEXT_META, { keyPath: "text_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

// ── Vocab cache ────────────────────────────────────────────────────────

export async function ingestTextVocabCache(cache: TextVocabCache): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_CACHE, "readwrite");
  const store = tx.objectStore(STORE_VOCAB_CACHE);
  for (const e of cache.words) store.put(e);
  for (const e of cache.characters) store.put(e);
  await txDone(tx);
  db.close();
}

export async function lookupOffline(term: string): Promise<VocabCacheEntry | null> {
  const db = await openDb();
  const result = await new Promise<VocabCacheEntry | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_VOCAB_CACHE, "readonly")
      .objectStore(STORE_VOCAB_CACHE)
      .get(term);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

// ── Session lifecycle ──────────────────────────────────────────────────

export interface LocalSession {
  local_id: string;
  text_id: number;
  started_at: number;       // ms epoch
  finished_at: number | null;
  status: "in_progress" | "completed_pending_upload" | "uploaded";
  duration_seconds?: number;
  characters_per_minute?: number;
  known_characters_count?: number;
  text_known_char_percentage?: number;
  auto_marked_characters?: number;
  auto_marked_words?: number;
  source?: "in_app" | "offline";
}

export async function saveSession(session: LocalSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  tx.objectStore(STORE_SESSIONS).put(session);
  await txDone(tx);
  db.close();
}

export async function getSession(localId: string): Promise<LocalSession | null> {
  const db = await openDb();
  const result = await new Promise<LocalSession | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_SESSIONS, "readonly")
      .objectStore(STORE_SESSIONS)
      .get(localId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function getInProgressSessionForText(
  textId: number,
): Promise<LocalSession | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db
      .transaction(STORE_SESSIONS, "readonly")
      .objectStore(STORE_SESSIONS)
      .index("text_id");
    const req = idx.openCursor(IDBKeyRange.only(textId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const session = cursor.value as LocalSession;
        if (session.status === "in_progress") {
          db.close();
          resolve(session);
          return;
        }
        cursor.continue();
      } else {
        db.close();
        resolve(null);
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function listPendingSessions(): Promise<LocalSession[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db
      .transaction(STORE_SESSIONS, "readonly")
      .objectStore(STORE_SESSIONS)
      .index("status");
    const req = idx.getAll(IDBKeyRange.only("completed_pending_upload"));
    req.onsuccess = () => {
      db.close();
      resolve(req.result as LocalSession[]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

// ── Vocab queue ────────────────────────────────────────────────────────

export interface VocabChange {
  id?: number;
  word: string;
  word_type: "word" | "character";
  status: "known" | "learning" | "removed";
  changed_at: number; // ms epoch
  status_in_idb: "pending" | "uploaded";
}

export async function enqueueVocabChange(
  change: Omit<VocabChange, "id" | "status_in_idb">,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_QUEUE, "readwrite");
  tx.objectStore(STORE_VOCAB_QUEUE).put({ ...change, status_in_idb: "pending" });
  await txDone(tx);
  db.close();
}

export async function listPendingVocabChanges(): Promise<VocabChange[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const idx = db
      .transaction(STORE_VOCAB_QUEUE, "readonly")
      .objectStore(STORE_VOCAB_QUEUE)
      .index("status_in_idb");
    const req = idx.getAll(IDBKeyRange.only("pending"));
    req.onsuccess = () => {
      db.close();
      resolve(req.result as VocabChange[]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function markVocabChangesUploaded(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_VOCAB_QUEUE, "readwrite");
  const store = tx.objectStore(STORE_VOCAB_QUEUE);
  for (const id of ids) {
    const getReq = store.get(id);
    await new Promise<void>((res, rej) => {
      getReq.onsuccess = () => {
        if (getReq.result) {
          getReq.result.status_in_idb = "uploaded";
          store.put(getReq.result);
        }
        res();
      };
      getReq.onerror = () => rej(getReq.error);
    });
  }
  await txDone(tx);
  db.close();
}

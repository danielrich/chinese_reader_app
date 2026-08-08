import type { Text, TextSegment, TextSummary, TextVocabCache, VocabCacheEntry } from "./library";

const DB_NAME = "chinese-reader";
const DB_VERSION = 5;
const OFFLINE_BUNDLE_SCHEMA_VERSION = 1;

export const STORE_VOCAB_CACHE = "vocab_cache";
export const STORE_SESSIONS = "sessions";
export const STORE_VOCAB_QUEUE = "vocab_queue";
export const STORE_TEXT_META = "text_meta";
export const STORE_NAV_CACHE = "nav_cache";
export const STORE_TEXT_CACHE = "text_cache";
export const STORE_TEXT_SEGMENTS = "text_segments";
export const STORE_OFFLINE_BUNDLES = "offline_text_bundles";

export type OfflineTextBundleStatus = "missing" | "partial" | "complete";

export interface OfflineTextBundle {
  text: Text;
  segments: TextSegment[];
  vocab: TextVocabCache;
  summary: TextSummary;
}

interface OfflineTextBundleMarker {
  text_id: number;
  schema_version: number;
  status: "complete";
  downloaded_at: number;
  segment_count: number;
  vocab_entry_count: number;
  vocab_terms: string[];
  summary: TextSummary;
}

export interface CacheMetadata {
  text_id: string | number;
  last_cached_at?: number;
  text_cached_at?: number;
  segments_cached_at?: number;
  vocab_cached_at?: number;
  nav_cached_at?: number;
  analysis_cached_at?: number;
  text_count?: number;
  shelf_count?: number;
  complete_text_count?: number;
}

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
      if (oldVersion < 3) {
        // nav_cache: keyPath = key (arbitrary string). persists shelf tree and text lists for offline navigation.
        db.createObjectStore(STORE_NAV_CACHE, { keyPath: "key" });
      }
      if (oldVersion < 4) {
        // Full text records and server-generated segmentation for offline reading.
        db.createObjectStore(STORE_TEXT_CACHE, { keyPath: "id" });
        db.createObjectStore(STORE_TEXT_SEGMENTS, { keyPath: "text_id" });
      }
      if (oldVersion < 5) {
        db.createObjectStore(STORE_OFFLINE_BUNDLES, { keyPath: "text_id" });
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

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function shelfMetaKey(shelfId: number): string {
  return `shelf:${shelfId}`;
}

function touchMeta(meta: CacheMetadata, fields: Partial<CacheMetadata>): CacheMetadata {
  const now = Date.now();
  return {
    ...meta,
    ...fields,
    last_cached_at: now,
  };
}

function bundleCompleteMetaFields(now = Date.now()): Partial<CacheMetadata> {
  return {
    text_cached_at: now,
    segments_cached_at: now,
    vocab_cached_at: now,
  };
}

async function updateMeta(
  key: string | number,
  fields: Partial<CacheMetadata>,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_TEXT_META, "readwrite");
  const store = tx.objectStore(STORE_TEXT_META);
  const getReq = store.get(key);
  const existing = await new Promise<CacheMetadata | null>((resolve, reject) => {
    getReq.onsuccess = () => resolve(getReq.result ?? null);
    getReq.onerror = () => reject(getReq.error);
  });
  store.put(touchMeta(existing ?? { text_id: key as string }, fields));
  await txDone(tx);
  db.close();
}

export async function getCacheMetadata(key: string | number): Promise<CacheMetadata | null> {
  const db = await openDb();
  const result = await new Promise<CacheMetadata | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_TEXT_META, "readonly")
      .objectStore(STORE_TEXT_META)
      .get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function getShelfCacheMetadata(shelfId: number): Promise<CacheMetadata | null> {
  return getCacheMetadata(shelfMetaKey(shelfId));
}

export async function getTextCacheMetadata(textId: number): Promise<CacheMetadata | null> {
  return getCacheMetadata(textId);
}

export async function listTextCacheMetadata(textIds: number[]): Promise<Map<number, CacheMetadata>> {
  const entries = await Promise.all(
    textIds.map(async (id) => [id, await getTextCacheMetadata(id)] as const),
  );
  return new Map(
    entries
      .filter((entry): entry is readonly [number, CacheMetadata] => entry[1] !== null)
      .map(([id, meta]) => [id, meta]),
  );
}

export async function listOfflineTextBundleStatuses(
  textIds: number[],
): Promise<Map<number, OfflineTextBundleStatus>> {
  const entries = await Promise.all(
    textIds.map(async (id) => [id, await getOfflineTextBundleStatus(id)] as const),
  );
  return new Map(entries);
}

export async function markShelfNavCached(
  shelfId: number,
  textCount: number,
  shelfCount: number,
): Promise<void> {
  await updateMeta(shelfMetaKey(shelfId), {
    nav_cached_at: Date.now(),
    text_count: textCount,
    shelf_count: shelfCount,
  });
}

export async function markShelfAnalysisCached(shelfId: number): Promise<void> {
  await updateMeta(shelfMetaKey(shelfId), {
    analysis_cached_at: Date.now(),
  });
}

export async function markShelfOfflineCacheComplete(
  shelfId: number,
  textCount: number,
  shelfCount: number,
  completeTextCount: number,
): Promise<void> {
  const now = Date.now();
  await updateMeta(shelfMetaKey(shelfId), {
    nav_cached_at: now,
    analysis_cached_at: now,
    text_count: textCount,
    shelf_count: shelfCount,
    complete_text_count: completeTextCount,
  });
}

export async function markShelfOfflineCacheVerified(
  shelfId: number,
  textCount: number,
  shelfCount: number,
  expectedTextIds: number[],
): Promise<void> {
  const statuses = await listOfflineTextBundleStatuses(expectedTextIds);
  const completeTextCount = expectedTextIds.filter((id) => statuses.get(id) === "complete").length;
  const now = Date.now();
  await updateMeta(shelfMetaKey(shelfId), {
    nav_cached_at: now,
    analysis_cached_at: now,
    text_count: textCount,
    shelf_count: shelfCount,
    complete_text_count: completeTextCount,
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
  await updateMeta(cache.text_id, { vocab_cached_at: Date.now() });
}

export async function saveOfflineTextBundle(bundle: OfflineTextBundle): Promise<void> {
  const db = await openDb();
  const now = Date.now();
  const vocabTerms = Array.from(new Set([
    ...bundle.vocab.words.map((entry) => entry.term),
    ...bundle.vocab.characters.map((entry) => entry.term),
  ]));
  const tx = db.transaction(
    [
      STORE_TEXT_CACHE,
      STORE_TEXT_SEGMENTS,
      STORE_VOCAB_CACHE,
      STORE_TEXT_META,
      STORE_OFFLINE_BUNDLES,
    ],
    "readwrite",
  );
  const vocabStore = tx.objectStore(STORE_VOCAB_CACHE);
  for (const entry of bundle.vocab.words) vocabStore.put(entry);
  for (const entry of bundle.vocab.characters) vocabStore.put(entry);

  tx.objectStore(STORE_TEXT_CACHE).put({ ...bundle.text, cached_at: now });
  tx.objectStore(STORE_TEXT_SEGMENTS).put({
    text_id: bundle.text.id,
    segments: bundle.segments,
    cached_at: now,
  });

  tx.objectStore(STORE_TEXT_META).put(
    touchMeta({ text_id: bundle.text.id }, bundleCompleteMetaFields(now)),
  );

  const marker: OfflineTextBundleMarker = {
    text_id: bundle.text.id,
    schema_version: OFFLINE_BUNDLE_SCHEMA_VERSION,
    status: "complete",
    downloaded_at: now,
    segment_count: bundle.segments.length,
    vocab_entry_count: vocabTerms.length,
    vocab_terms: vocabTerms,
    summary: bundle.summary,
  };
  tx.objectStore(STORE_OFFLINE_BUNDLES).put(marker);

  await txDone(tx);
  db.close();

  const status = await getOfflineTextBundleStatus(bundle.text.id);
  if (status !== "complete") {
    throw new Error(`Offline bundle validation failed for text ${bundle.text.id}: ${status}`);
  }
}

export async function getOfflineTextBundleStatus(textId: number): Promise<OfflineTextBundleStatus> {
  const db = await openDb();
  const tx = db.transaction(
    [STORE_TEXT_CACHE, STORE_TEXT_SEGMENTS, STORE_VOCAB_CACHE, STORE_TEXT_META, STORE_OFFLINE_BUNDLES],
    "readonly",
  );

  const [marker, text, segments, meta] = await Promise.all([
    requestAsPromise<OfflineTextBundleMarker | undefined>(
      tx.objectStore(STORE_OFFLINE_BUNDLES).get(textId),
    ),
    requestAsPromise<Text | undefined>(tx.objectStore(STORE_TEXT_CACHE).get(textId)),
    requestAsPromise<{ text_id: number; segments: TextSegment[] } | undefined>(
      tx.objectStore(STORE_TEXT_SEGMENTS).get(textId),
    ),
    requestAsPromise<CacheMetadata | undefined>(tx.objectStore(STORE_TEXT_META).get(textId)),
  ]);
  await txDone(tx);

  const hasAnyLocalData = Boolean(marker || text || segments || meta);
  if (!hasAnyLocalData) {
    db.close();
    return "missing";
  }
  const vocabTerms = marker?.vocab_terms ?? [];
  const vocabEntries = await Promise.all(
    vocabTerms.map((term) => requestAsPromise<VocabCacheEntry | undefined>(
      db.transaction(STORE_VOCAB_CACHE, "readonly").objectStore(STORE_VOCAB_CACHE).get(term),
    )),
  );
  db.close();
  if (
    marker?.status === "complete" &&
    marker.schema_version === OFFLINE_BUNDLE_SCHEMA_VERSION &&
    text &&
    marker.summary?.id === textId &&
    segments?.segments?.length === marker.segment_count &&
    marker.vocab_entry_count === vocabTerms.length &&
    vocabEntries.every(Boolean) &&
    meta?.text_cached_at &&
    meta.segments_cached_at &&
    meta.vocab_cached_at
  ) {
    return "complete";
  }
  return "partial";
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
  character_count?: number; // stored at start to compute CPM locally
  paused_at?: number | null;
  duration_seconds?: number;
  characters_per_minute?: number;
  known_characters_count?: number;
  text_known_char_percentage?: number;
  text_known_word_percentage?: number;
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

export async function deleteSession(localId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  tx.objectStore(STORE_SESSIONS).delete(localId);
  await txDone(tx);
  db.close();
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

// ── Nav cache ──────────────────────────────────────────────────────────

export async function saveNavCache(key: string, data: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAV_CACHE, "readwrite");
  tx.objectStore(STORE_NAV_CACHE).put({ key, data });
  await txDone(tx);
  db.close();
}

export async function getNavCache<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const result = await new Promise<{ key: string; data: T } | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_NAV_CACHE, "readonly")
      .objectStore(STORE_NAV_CACHE)
      .get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result ? result.data : null;
}

// ── Text cache ─────────────────────────────────────────────────────────

export async function saveTextCache(text: Text): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_TEXT_CACHE, "readwrite");
  tx.objectStore(STORE_TEXT_CACHE).put({ ...text, cached_at: Date.now() });
  await txDone(tx);
  db.close();
  await updateMeta(text.id, { text_cached_at: Date.now() });
}

export async function getTextCache(id: number): Promise<Text | null> {
  const db = await openDb();
  const result = await new Promise<(Text & { cached_at?: number }) | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_TEXT_CACHE, "readonly")
      .objectStore(STORE_TEXT_CACHE)
      .get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!result) return null;
  const { cached_at: _cachedAt, ...text } = result;
  return text;
}

export async function saveTextSegments(textId: number, segments: TextSegment[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_TEXT_SEGMENTS, "readwrite");
  tx.objectStore(STORE_TEXT_SEGMENTS).put({
    text_id: textId,
    segments,
    cached_at: Date.now(),
  });
  await txDone(tx);
  db.close();
  await updateMeta(textId, { segments_cached_at: Date.now() });
}

export async function getTextSegments(textId: number): Promise<TextSegment[] | null> {
  const db = await openDb();
  const result = await new Promise<{ text_id: number; segments: TextSegment[]; cached_at: number } | null>((resolve, reject) => {
    const req = db
      .transaction(STORE_TEXT_SEGMENTS, "readonly")
      .objectStore(STORE_TEXT_SEGMENTS)
      .get(textId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result ? result.segments : null;
}

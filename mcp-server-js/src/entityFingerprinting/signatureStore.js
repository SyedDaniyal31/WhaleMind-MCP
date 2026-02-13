/**
 * DB-backed signature storage. Persists fingerprints for learning and lookup.
 * Default: file-based JSON store; swap for real DB by implementing same interface.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = join(__dirname, "../../.data/fingerprint_signatures.json");
const MAX_ENTRIES_PER_ADDRESS = 5;
const MAX_TOTAL_ENTRIES = 50000;

let memoryStore = new Map();
let storePath = null;
let dirty = false;

function ensureObject(o) {
  if (o == null || typeof o !== "object" || Array.isArray(o)) return {};
  return JSON.parse(JSON.stringify(o));
}

/**
 * Load store from file. Non-blocking; call at startup or lazily.
 */
export async function loadStore(path = DEFAULT_STORE_PATH) {
  storePath = path;
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.entries === "object") {
      memoryStore = new Map(Object.entries(data.entries));
    }
  } catch (e) {
    if (e?.code !== "ENOENT") console.error("[FingerprintStore] load", e?.message || e);
  }
  return memoryStore;
}

/**
 * Persist in-memory store to file. Debounce in production.
 */
export async function saveStore() {
  if (!storePath) storePath = DEFAULT_STORE_PATH;
  try {
    const dir = dirname(storePath);
    await mkdir(dir, { recursive: true });
    const entries = Object.fromEntries(memoryStore);
    await writeFile(storePath, JSON.stringify({ entries, updated: new Date().toISOString() }, null, 0), "utf-8");
  } catch (e) {
    console.error("[FingerprintStore] save", e?.message || e);
  }
  dirty = false;
}

/**
 * Record a fingerprint for address. Append-only style for learning; keep last N per address.
 */
export async function recordSignature(address, payload) {
  const key = String(address).toLowerCase();
  const entry = {
    entity_type: payload.entity_type,
    confidence_score: payload.confidence_score,
    supporting_signals: Array.isArray(payload.supporting_signals) ? payload.supporting_signals : [],
    entity_cluster_id: payload.entity_cluster_id ?? null,
    scores: ensureObject(payload.scores),
    at: new Date().toISOString(),
  };
  let list = memoryStore.get(key) || [];
  list = [entry, ...list].slice(0, MAX_ENTRIES_PER_ADDRESS);
  memoryStore.set(key, list);
  if (memoryStore.size > MAX_TOTAL_ENTRIES) {
    const keys = [...memoryStore.keys()];
    for (let i = 0; i < keys.length - MAX_TOTAL_ENTRIES; i++) memoryStore.delete(keys[i]);
  }
  dirty = true;
  return entry;
}

/**
 * Get last recorded signatures for address.
 */
export function getSignatures(address) {
  const key = String(address).toLowerCase();
  return memoryStore.get(key) || [];
}

/**
 * Flush to disk if dirty. Call periodically or on shutdown.
 */
export async function flush() {
  if (dirty) await saveStore();
}

export function setStorePath(path) {
  storePath = path;
}

export function getStorePath() {
  return storePath;
}

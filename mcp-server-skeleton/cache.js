/**
 * In-memory TTL cache + request deduplication.
 * Same key returns same promise while in-flight; then cached result for TTL.
 * Non-blocking; safe for cold start.
 */

const DEFAULT_TTL_MS = 60_000; // 60s
const MAX_ENTRIES = 10_000;

const store = new Map();
const expires = new Map();
const inFlight = new Map();
const keyOrder = [];

function prune() {
  const now = Date.now();
  while (keyOrder.length > 0 && (store.size > MAX_ENTRIES || (expires.get(keyOrder[0]) || 0) < now)) {
    const k = keyOrder.shift();
    store.delete(k);
    expires.delete(k);
  }
}

/**
 * @param {string} key
 * @param {number} [ttlMs]
 * @returns {Promise<unknown> | null} Cached promise result or null
 */
export function get(key, ttlMs = DEFAULT_TTL_MS) {
  const exp = expires.get(key);
  if (exp != null && Date.now() < exp) return store.get(key);
  if (exp != null) {
    store.delete(key);
    expires.delete(key);
  }
  return null;
}

/**
 * @param {string} key
 * @param {Promise<unknown>} value
 * @param {number} [ttlMs]
 */
export function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (!store.has(key)) keyOrder.push(key);
  store.set(key, value);
  expires.set(key, Date.now() + ttlMs);
  prune();
}

/**
 * Deduplication: run fn once per key; concurrent callers share the same promise.
 * @param {string} key
 * @param {() => Promise<unknown>} fn
 * @param {number} [ttlMs]
 * @returns {Promise<unknown>}
 */
export async function getOrSet(key, fn, ttlMs = DEFAULT_TTL_MS) {
  const cached = get(key, ttlMs);
  if (cached !== null) return cached;

  let promise = inFlight.get(key);
  if (promise) return promise;

  promise = fn()
    .then((result) => {
      set(key, Promise.resolve(result), ttlMs);
      inFlight.delete(key);
      return result;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * Cache key for tools/call: deterministic string from method + params.
 */
export function cacheKey(method, params) {
  const p = params != null && typeof params === "object" ? params : {};
  return `${method}:${JSON.stringify(p)}`;
}

export function clear() {
  store.clear();
  expires.clear();
  inFlight.clear();
  keyOrder.length = 0;
}

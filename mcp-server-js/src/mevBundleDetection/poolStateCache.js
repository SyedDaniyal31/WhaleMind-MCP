/**
 * In-memory cache for historical pool state (e.g. reserve snapshots).
 * Key: blockNumber or "blockNumber-poolAddress". Used by profit/sandwich heuristics if needed.
 * Does not fetch data; caller must populate. Async-safe for read/write.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

const cache = new Map();
const timestamps = new Map();
let order = [];

function prune() {
  const now = Date.now();
  const ttl = DEFAULT_TTL_MS;
  while (order.length > 0 && (cache.size > MAX_ENTRIES || (timestamps.get(order[0]) || 0) < now - ttl)) {
    const key = order.shift();
    cache.delete(key);
    timestamps.delete(key);
  }
}

/**
 * @param {string} key - e.g. "blockNumber" or "blockNumber-poolAddress"
 * @param {*} value - any serializable state
 */
export function setPoolState(key, value) {
  if (!key) return;
  if (!cache.has(key)) order.push(key);
  cache.set(key, value);
  timestamps.set(key, Date.now());
  prune();
}

/**
 * @param {string} key
 * @returns {*|undefined}
 */
export function getPoolState(key) {
  return cache.get(key);
}

/**
 * @param {number} blockNumber
 * @param {string} poolAddress
 * @param {*} state
 */
export function setBlockPoolState(blockNumber, poolAddress, state) {
  const k = `${blockNumber}-${(poolAddress || "").toLowerCase()}`;
  setPoolState(k, state);
}

/**
 * @param {number} blockNumber
 * @param {string} poolAddress
 * @returns {*|undefined}
 */
export function getBlockPoolState(blockNumber, poolAddress) {
  return getPoolState(`${blockNumber}-${(poolAddress || "").toLowerCase()}`);
}

export function clearPoolStateCache() {
  cache.clear();
  timestamps.clear();
  order = [];
}

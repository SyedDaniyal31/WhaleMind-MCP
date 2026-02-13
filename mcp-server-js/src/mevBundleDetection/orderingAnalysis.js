/**
 * Intra-block ordering analysis.
 * Detects consecutive txs that interact with same pools/contracts and occur adjacently.
 * Does not modify any external state; pure heuristic scoring.
 */

const ADJACENCY_WINDOW = 5;
const SAME_CONTRACT_WEIGHT = 0.6;
const CONSECUTIVE_WEIGHT = 0.4;

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

/**
 * Extract contract/pool addresses touched by a tx (to, and from logs if present).
 */
function touchedAddresses(tx) {
  const set = new Set();
  if (tx.to) set.add(low(tx.to));
  if (tx.from) set.add(low(tx.from));
  const logs = tx.logs || tx.tokenTransfers || [];
  for (const log of logs) {
    if (log.address) set.add(low(log.address));
    if (log.to) set.add(low(log.to));
    if (log.from) set.add(low(log.from));
  }
  return set;
}

/**
 * Compute adjacency score for a sequence of transactions in block order.
 * @param {Array<{ hash?: string, from?: string, to?: string, logs?: Array, tokenTransfers?: Array }>} txs - Ordered block txs
 * @param {number} [startIndex] - Start of candidate bundle
 * @param {number} [endIndex] - End (inclusive) of candidate bundle
 * @returns {{ adjacency_score: number, same_contract_pairs: number, consecutive_count: number }}
 */
export function analyzeOrdering(txs, startIndex = 0, endIndex = Math.min(ADJACENCY_WINDOW, (txs || []).length - 1)) {
  const list = txs || [];
  if (list.length < 2) {
    return { adjacency_score: 0, same_contract_pairs: 0, consecutive_count: 0 };
  }
  const start = Math.max(0, startIndex);
  const end = Math.min(list.length - 1, Math.max(start, endIndex));
  const slice = list.slice(start, end + 1);
  let sameContractPairs = 0;
  let consecutiveCount = 0;
  const addresses = slice.map(touchedAddresses);
  for (let i = 0; i < addresses.length - 1; i++) {
    const a = addresses[i];
    const b = addresses[i + 1];
    const overlap = [...a].filter((x) => b.has(x)).length;
    if (overlap > 0) sameContractPairs += 1;
    consecutiveCount += 1;
  }
  const maxPairs = Math.max(1, slice.length - 1);
  const sameContractScore = sameContractPairs / maxPairs;
  const consecutiveScore = consecutiveCount / Math.max(1, slice.length - 1);
  const adjacency_score = Math.min(
    1,
    SAME_CONTRACT_WEIGHT * sameContractScore + CONSECUTIVE_WEIGHT * Math.min(1, consecutiveCount / 4)
  );
  return {
    adjacency_score: Math.round(adjacency_score * 100) / 100,
    same_contract_pairs: sameContractPairs,
    consecutive_count: consecutiveCount,
  };
}

/**
 * Find candidate bundle windows (consecutive txs touching same contracts).
 * @param {Array} txs - Block txs in order
 * @param {number} minSize - Min txs in bundle
 * @param {number} maxSize - Max txs in window
 */
export function findCandidateWindows(txs, minSize = 2, maxSize = 15) {
  const list = txs || [];
  const windows = [];
  for (let i = 0; i < list.length; i++) {
    for (let len = minSize; len <= maxSize && i + len <= list.length; len++) {
      const slice = list.slice(i, i + len);
      const result = analyzeOrdering(list, i, i + len - 1);
      if (result.adjacency_score > 0) {
        windows.push({ startIndex: i, endIndex: i + len - 1, ...result, txs: slice });
      }
    }
  }
  return windows.sort((a, b) => b.adjacency_score - a.adjacency_score).slice(0, 20);
}

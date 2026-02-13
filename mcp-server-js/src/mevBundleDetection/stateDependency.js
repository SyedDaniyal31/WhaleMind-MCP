/**
 * State dependency detection.
 * Heuristic: Tx B likely relies on price/liquidity change from Tx A if they share
 * same pool/contract and ordering is A then B; removing A would invalidate B's profit logic.
 * Pure heuristics; no execution simulation.
 */

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

function touchedAddresses(tx) {
  const set = new Set();
  if (tx.to) set.add(low(tx.to));
  if (tx.from) set.add(low(tx.from));
  (tx.logs || tx.tokenTransfers || []).forEach((log) => {
    if (log.address) set.add(low(log.address));
    if (log.to) set.add(low(log.to));
    if (log.from) set.add(low(log.from));
  });
  return set;
}

/**
 * Compute state_dependency_score for a sequence [start..end].
 * High when later txs touch same contracts as earlier ones (suggesting dependency on state change).
 */
export function computeStateDependency(txs, startIndex, endIndex) {
  const list = txs || [];
  if (list.length < 2 || endIndex <= startIndex) {
    return { state_dependency_score: 0, dependency_pairs: 0 };
  }
  const slice = list.slice(startIndex, endIndex + 1);
  let dependencyPairs = 0;
  const contractSets = slice.map(touchedAddresses);
  for (let i = 0; i < contractSets.length - 1; i++) {
    for (let j = i + 1; j < contractSets.length; j++) {
      const a = contractSets[i];
      const b = contractSets[j];
      const overlap = [...a].filter((x) => b.has(x)).length;
      if (overlap > 0) dependencyPairs += 1;
    }
  }
  const maxPairs = (slice.length * (slice.length - 1)) / 2 || 1;
  const state_dependency_score = Math.min(1, (dependencyPairs / maxPairs) * 1.5);
  return {
    state_dependency_score: Math.round(state_dependency_score * 100) / 100,
    dependency_pairs: dependencyPairs,
  };
}

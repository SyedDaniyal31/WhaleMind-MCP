/**
 * Sandwich pattern recognition.
 * Detect front-run → victim → back-run: same token pair, same DEX pool, price impact reversal.
 * Heuristic only; uses ordering and contract/token overlap.
 */

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

function touchedTokens(tx) {
  const tokens = new Set();
  (tx.logs || tx.tokenTransfers || []).forEach((log) => {
    if (log.address) tokens.add(low(log.address));
    if (log.contractAddress) tokens.add(low(log.contractAddress));
    if (log.tokenAddress) tokens.add(low(log.tokenAddress));
  });
  return tokens;
}

function touchedContracts(tx) {
  const set = new Set();
  if (tx.to) set.add(low(tx.to));
  (tx.logs || tx.tokenTransfers || []).forEach((log) => {
    if (log.address) set.add(low(log.address));
  });
  return set;
}

/**
 * Sandwich confidence for a 3-tx window [i, i+1, i+2]: front-run, victim, back-run.
 */
function sandwichConfidenceAt(txs, i) {
  const list = txs || [];
  if (i + 2 >= list.length) return 0;
  const front = list[i];
  const victim = list[i + 1];
  const back = list[i + 2];
  const tokensFront = touchedTokens(front);
  const tokensVictim = touchedTokens(victim);
  const tokensBack = touchedTokens(back);
  const contractsFront = touchedContracts(front);
  const contractsVictim = touchedContracts(victim);
  const contractsBack = touchedContracts(back);
  const tokenOverlap = tokensFront.size && tokensVictim.size && tokensBack.size
    ? ([...tokensFront].filter((t) => tokensVictim.has(t) && tokensBack.has(t))).length
    : 0;
  const contractOverlap = [...contractsFront].filter((c) => contractsVictim.has(c) && contractsBack.has(c)).length;
  const samePool = contractOverlap >= 1;
  const samePair = tokenOverlap >= 1;
  if (!samePool && !samePair) return 0;
  let confidence = 0.3;
  if (samePool) confidence += 0.35;
  if (samePair) confidence += 0.35;
  const sameSender = low(front.from) === low(back.from);
  if (sameSender) confidence += 0.2;
  return Math.min(1, confidence);
}

/**
 * Scan block for best sandwich window; return max sandwich_confidence and window.
 */
export function detectSandwich(txs, startIndex = 0, endIndex = (txs || []).length - 1) {
  const list = txs || [];
  let best = 0;
  let bestStart = -1;
  for (let i = startIndex; i <= endIndex - 2; i++) {
    const c = sandwichConfidenceAt(list, i);
    if (c > best) {
      best = c;
      bestStart = i;
    }
  }
  return {
    sandwich_confidence: Math.round(best * 100) / 100,
    sandwich_start_index: bestStart,
    sandwich_end_index: bestStart >= 0 ? bestStart + 2 : -1,
  };
}

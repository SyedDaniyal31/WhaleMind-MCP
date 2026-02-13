/**
 * Gas pattern analysis.
 * Flags: identical priority fees, low variance gas in group, below-market gas (private relay hint).
 */

const WEI_PER_GWEI = 1e9;

function toGwei(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val / WEI_PER_GWEI;
  const s = String(val);
  if (s.startsWith("0x")) return Number(BigInt(s)) / WEI_PER_GWEI;
  return Number(s) / WEI_PER_GWEI || 0;
}

/**
 * Compute gas_pattern_score for a slice of txs.
 * High when: identical or near-identical priority fees, low variance in gas used, or unusually low gas (relay hint).
 */
export function analyzeGasPattern(txs, startIndex, endIndex, blockBaseFeePerGasGwei = 30) {
  const list = txs || [];
  const slice = list.slice(Math.max(0, startIndex), Math.min(list.length, endIndex + 1));
  if (slice.length < 2) {
    return { gas_pattern_score: 0, identical_priority_count: 0, variance_score: 0 };
  }

  const priorityFees = slice.map((tx) => {
    const maxPriority = tx.maxPriorityFeePerGas ?? tx.gasPrice;
    return toGwei(maxPriority);
  }).filter((g) => g > 0);
  const gasUsed = slice.map((tx) => Number(tx.gasUsed) || 0).filter((g) => g > 0);

  let identicalPriorityCount = 0;
  const toleranceGwei = 0.1;
  for (let i = 0; i < priorityFees.length; i++) {
    for (let j = i + 1; j < priorityFees.length; j++) {
      if (Math.abs(priorityFees[i] - priorityFees[j]) < toleranceGwei) identicalPriorityCount++;
    }
  }
  const maxIdenticalPairs = (priorityFees.length * (priorityFees.length - 1)) / 2 || 1;
  const identicalScore = Math.min(1, (identicalPriorityCount / maxIdenticalPairs) * 2);

  let varianceScore = 0;
  if (gasUsed.length >= 2) {
    const mean = gasUsed.reduce((a, b) => a + b, 0) / gasUsed.length;
    const variance = gasUsed.reduce((s, g) => s + (g - mean) ** 2, 0) / gasUsed.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    varianceScore = cv < 0.5 ? 0.8 : cv < 1 ? 0.5 : 0.2;
  }

  const avgPriority = priorityFees.length
    ? priorityFees.reduce((a, b) => a + b, 0) / priorityFees.length
    : 0;
  const belowMarketScore = blockBaseFeePerGasGwei > 0 && avgPriority > 0 && avgPriority < blockBaseFeePerGasGwei * 0.5 ? 0.7 : 0;

  const gas_pattern_score = Math.min(
    1,
    0.4 * identicalScore + 0.4 * varianceScore + 0.2 * belowMarketScore
  );
  return {
    gas_pattern_score: Math.round(gas_pattern_score * 100) / 100,
    identical_priority_count: identicalPriorityCount,
    variance_score: Math.round(varianceScore * 100) / 100,
  };
}

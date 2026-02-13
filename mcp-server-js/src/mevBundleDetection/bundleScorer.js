/**
 * Bundle scorer: combines ordering, state dependency, gas, profit, sandwich into
 * bundle_confidence_score and bundle_type (sandwich | arbitrage | backrun | liquidation).
 */

import { analyzeOrdering, findCandidateWindows } from "./orderingAnalysis.js";
import { computeStateDependency } from "./stateDependency.js";
import { analyzeGasPattern } from "./gasPatternAnalysis.js";
import { computeProfitFlow } from "./profitFlowVerification.js";
import { detectSandwich } from "./sandwichRecognition.js";

const BUNDLE_TYPES = ["sandwich", "arbitrage", "backrun", "liquidation"];

const WEIGHTS = {
  adjacency: 0.2,
  state_dependency: 0.2,
  gas_pattern: 0.15,
  profit: 0.25,
  sandwich: 0.2,
};

/**
 * Classify bundle type from component scores and sandwich signal.
 */
function inferBundleType(scores, sandwichConfidence) {
  if (sandwichConfidence >= 0.5) return "sandwich";
  if (scores.profit >= 0.5 && scores.state_dependency >= 0.4 && scores.adjacency >= 0.4) return "arbitrage";
  if (scores.adjacency >= 0.5 && scores.state_dependency >= 0.5 && scores.profit >= 0.3) return "backrun";
  if (scores.state_dependency >= 0.6 && scores.gas_pattern >= 0.4) return "liquidation";
  if (scores.profit >= 0.4) return "arbitrage";
  if (scores.adjacency >= 0.5) return "backrun";
  return "arbitrage";
}

/**
 * Score a single candidate window [startIndex..endIndex].
 */
export function scoreBundleWindow(txs, startIndex, endIndex, options = {}) {
  const blockBaseFeeGwei = options.blockBaseFeePerGasGwei ?? 30;
  const ordering = analyzeOrdering(txs, startIndex, endIndex);
  const stateDep = computeStateDependency(txs, startIndex, endIndex);
  const gas = analyzeGasPattern(txs, startIndex, endIndex, blockBaseFeeGwei);
  const profit = computeProfitFlow(txs, startIndex, endIndex);
  const sandwich = detectSandwich(txs, startIndex, endIndex);

  const adjacency_score = ordering.adjacency_score;
  const state_dependency_score = stateDep.state_dependency_score;
  const gas_pattern_score = gas.gas_pattern_score;
  const profit_score = profit.profit_score;
  const sandwich_confidence = sandwich.sandwich_confidence;

  const bundle_confidence_score = Math.min(
    1,
    WEIGHTS.adjacency * adjacency_score +
      WEIGHTS.state_dependency * state_dependency_score +
      WEIGHTS.gas_pattern * gas_pattern_score +
      WEIGHTS.profit * profit_score +
      WEIGHTS.sandwich * sandwich_confidence
  );

  const bundle_type = inferBundleType(
    {
      adjacency: adjacency_score,
      state_dependency: state_dependency_score,
      gas_pattern: gas_pattern_score,
      profit: profit_score,
    },
    sandwich_confidence
  );

  return {
    bundle_confidence_score: Math.round(bundle_confidence_score * 100) / 100,
    bundle_type,
    adjacency_score,
    state_dependency_score: state_dependency_score,
    gas_pattern_score,
    profit_score,
    sandwich_confidence,
    startIndex,
    endIndex,
    txCount: endIndex - startIndex + 1,
    hashes: (txs || []).slice(startIndex, endIndex + 1).map((t) => t.hash || t.transactionHash).filter(Boolean),
  };
}

/**
 * Analyze full block: find candidate windows, score each, return best and all above threshold.
 */
export function scoreBlockBundles(txs, options = {}) {
  const list = txs || [];
  const minConfidence = options.minConfidence ?? 0.35;
  const maxCandidates = options.maxCandidates ?? 15;
  const windows = findCandidateWindows(list, 2, options.maxBundleSize ?? 12);
  const results = [];
  const seen = new Set();
  for (const w of windows.slice(0, maxCandidates)) {
    const key = `${w.startIndex}-${w.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scored = scoreBundleWindow(list, w.startIndex, w.endIndex, options);
    if (scored.bundle_confidence_score >= minConfidence) {
      results.push(scored);
    }
  }
  results.sort((a, b) => b.bundle_confidence_score - a.bundle_confidence_score);
  const best = results[0] || null;
  return {
    best,
    bundles: results,
    blockTxCount: list.length,
  };
}

export { BUNDLE_TYPES };

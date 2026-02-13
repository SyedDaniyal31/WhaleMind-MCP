/**
 * MEV Bundle Detection — standalone module.
 * Integrates with Tier-S++ without modifying wallet scoring. Async, block-level, heuristic + probabilistic.
 *
 * Integration: call analyzeBlock(blockPayload) when you have block tx data. Wallet pipeline is unchanged.
 */

import { scoreBlockBundles, scoreBundleWindow, BUNDLE_TYPES } from "./bundleScorer.js";
import * as poolStateCache from "./poolStateCache.js";

const LOG_PREFIX = "[MEV-Bundle]";

function log(level, msg, data) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(LOG_PREFIX, msg, data != null ? data : "");
}

/**
 * Normalize block payload from various sources (Etherscan block txlist, etc.).
 * Expects: { transactions: Array, number?: number, baseFeePerGas?: string|number }
 * Each tx: hash|transactionHash, from, to, value, blockNumber, timeStamp, gasPrice, gasUsed, maxFeePerGas?, maxPriorityFeePerGas?, logs?, tokenTransfers?, input?
 */
function normalizeBlockPayload(payload) {
  const txs = payload?.transactions ?? payload?.txs ?? payload ?? [];
  const list = Array.isArray(txs) ? txs : [];
  const blockNumber = payload?.number ?? payload?.blockNumber ?? list[0]?.blockNumber;
  let baseFeePerGas = payload?.baseFeePerGas ?? list[0]?.baseFeePerGas;
  if (baseFeePerGas != null && typeof baseFeePerGas === "string" && baseFeePerGas.startsWith("0x")) {
    baseFeePerGas = Number(BigInt(baseFeePerGas)) / 1e9;
  } else if (typeof baseFeePerGas === "number") {
    baseFeePerGas = baseFeePerGas / 1e9;
  } else {
    baseFeePerGas = 30;
  }
  return {
    transactions: list.map((t) => ({
      ...t,
      hash: t.hash ?? t.transactionHash,
      blockNumber: t.blockNumber ?? blockNumber,
    })),
    number: blockNumber,
    baseFeePerGasGwei: typeof baseFeePerGas === "number" ? baseFeePerGas : 30,
  };
}

/**
 * Analyze a single block for MEV bundles. Async to avoid blocking wallet pipeline.
 * @param {Object} blockPayload - { transactions, number?, baseFeePerGas? } or array of txs
 * @param {Object} [options] - { minConfidence, maxCandidates, maxBundleSize, blockBaseFeePerGasGwei }
 * @returns {Promise<{ blockNumber: number|undefined, bundles: Array, best: Object|null, blockTxCount: number }>}
 */
export async function analyzeBlock(blockPayload, options = {}) {
  const normalized = normalizeBlockPayload(blockPayload);
  const { transactions, number: blockNumber, baseFeePerGasGwei } = normalized;
  const opts = { ...options, blockBaseFeePerGasGwei };
  const result = scoreBlockBundles(transactions, opts);
  const { best, bundles, blockTxCount } = result;

  if (best && best.bundle_confidence_score >= (options.minConfidence ?? 0.35)) {
    log(
      "info",
      `Block ${blockNumber ?? "?"} MEV bundle detected`,
      {
        bundle_type: best.bundle_type,
        bundle_confidence_score: best.bundle_confidence_score,
        txCount: best.txCount,
        hashes: best.hashes?.slice(0, 3),
      }
    );
  }

  return {
    blockNumber,
    bundles,
    best,
    blockTxCount,
  };
}

/**
 * Synchronous variant for when you already have ordered txs and want no async overhead.
 */
export function analyzeBlockSync(blockPayload, options = {}) {
  const normalized = normalizeBlockPayload(blockPayload);
  const result = scoreBlockBundles(normalized.transactions, {
    ...options,
    blockBaseFeePerGasGwei: normalized.baseFeePerGasGwei,
  });
  if (result.best && result.best.bundle_confidence_score >= (options.minConfidence ?? 0.35)) {
    log("info", `Block ${normalized.number ?? "?"} MEV bundle`, {
      bundle_type: result.best.bundle_type,
      bundle_confidence_score: result.best.bundle_confidence_score,
    });
  }
  return {
    blockNumber: normalized.number,
    ...result,
  };
}

/**
 * Score a single window (for custom integration).
 */
export function scoreWindow(txs, startIndex, endIndex, options = {}) {
  return scoreBundleWindow(txs, startIndex, endIndex, options);
}

/**
 * Integration hook: call from your block processor without touching wallet scoring.
 * Example: onBlock(block) { mevBundleDetection.analyzeBlock(block).then(r => store(r)); }
 */
export const integration = {
  analyzeBlock,
  analyzeBlockSync,
  scoreWindow,
  BUNDLE_TYPES,
  poolStateCache,
};

export { BUNDLE_TYPES, scoreBlockBundles, scoreBundleWindow };
export default integration;

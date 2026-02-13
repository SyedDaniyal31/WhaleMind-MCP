/**
 * Entity Fingerprinting — enrichment layer on top of Tier-S++.
 * Tags wallets and clusters by behavioral/interaction signatures.
 * Non-blocking, modular, DB-backed signature storage, learn-from-new-patterns.
 */

import { computeFingerprint, FINGERPRINT_ENTITY_TYPES } from "./fingerprintScorer.js";
import * as signatureStore from "./signatureStore.js";

const LOG_PREFIX = "[EntityFingerprint]";

function log(level, msg, data) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(LOG_PREFIX, msg, data != null ? data : "");
}

/**
 * Fingerprint a wallet from Tier-S++ outputs. Async, non-blocking.
 * @param {Object} params
 * @param {Object} params.features - from extractFeatures()
 * @param {Object} params.classification - from classifyEntity()
 * @param {Object} params.clusterData - from buildClusterData()
 * @param {Array} [params.txs] - raw txs (for exchange/bridge/router signatures)
 * @param {string} params.address - wallet address
 * @param {Object} [params.coordination] - from detectCoordination()
 * @param {boolean} [params.recordToStore=true] - persist for learning
 * @returns {Promise<{ entity_type, confidence_score, supporting_signals, scores, entity_cluster_id }>}
 */
export async function fingerprintWallet(params) {
  const {
    features,
    classification,
    clusterData,
    txs = [],
    address,
    coordination = null,
    recordToStore = true,
  } = params || {};

  if (!address) {
    return {
      entity_type: "Unknown",
      confidence_score: 0,
      supporting_signals: [],
      scores: {},
      entity_cluster_id: null,
    };
  }

  const result = computeFingerprint(
    features,
    classification,
    clusterData,
    txs,
    address,
    coordination
  );

  if (recordToStore && result.entity_type !== "Unknown" && result.confidence_score >= 0.35) {
    try {
      await signatureStore.recordSignature(address, {
        entity_type: result.entity_type,
        confidence_score: result.confidence_score,
        supporting_signals: result.supporting_signals,
        entity_cluster_id: result.entity_cluster_id,
        scores: result.scores,
      });
    } catch (e) {
      log("warn", "recordSignature failed", e?.message);
    }
  }

  return result;
}

/**
 * Load persisted signatures (e.g. at startup). Optional.
 */
export async function loadSignatureStore(path) {
  return signatureStore.loadStore(path);
}

/**
 * Flush signature store to disk. Call periodically or on shutdown.
 */
export async function flushSignatureStore() {
  return signatureStore.flush();
}

/**
 * Get last recorded fingerprints for an address (from store).
 */
export function getStoredSignatures(address) {
  return signatureStore.getSignatures(address);
}

/**
 * Integration: call after Tier-S++ pipeline; merge fingerprint into report or use standalone.
 * Does not modify classification or wallet scoring.
 */
export function enrichReportWithFingerprint(report, fingerprint) {
  if (!report || !fingerprint) return report;
  return {
    ...report,
    entity_fingerprint: {
      entity_type: fingerprint.entity_type,
      confidence_score: fingerprint.confidence_score,
      supporting_signals: fingerprint.supporting_signals || [],
      entity_cluster_id: fingerprint.entity_cluster_id ?? null,
      scores: fingerprint.scores || {},
    },
  };
}

export { computeFingerprint, FINGERPRINT_ENTITY_TYPES };
export { assignEntityClusterId } from "./clusteringLayer.js";
export default {
  fingerprintWallet,
  loadSignatureStore,
  flushSignatureStore,
  getStoredSignatures,
  enrichReportWithFingerprint,
  FINGERPRINT_ENTITY_TYPES,
};

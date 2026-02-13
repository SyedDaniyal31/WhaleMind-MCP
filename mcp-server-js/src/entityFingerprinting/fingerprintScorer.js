/**
 * Combines all signature scores into entity_type, confidence_score, supporting_signals[].
 * Enrichment layer on top of Tier-S++ (does not replace classification).
 */

import { computeExchangeSignature } from "./signatures/exchangeSignature.js";
import { computeMevSearcherSignature } from "./signatures/mevSearcherSignature.js";
import { computeBridgeSignature } from "./signatures/bridgeSignature.js";
import { computeFundWhaleSignature } from "./signatures/fundWhaleSignature.js";
import { computeSmartMoneySignature } from "./signatures/smartMoneySignature.js";
import { computeProtocolRouterSignature } from "./signatures/protocolRouterSignature.js";
import { assignEntityClusterId } from "./clusteringLayer.js";

export const FINGERPRINT_ENTITY_TYPES = [
  "Centralized Exchange",
  "MEV Searcher",
  "Bridge",
  "Protocol Router",
  "Fund / Whale",
  "Smart Money",
  "Unknown",
];

const TYPE_TO_SCORE_KEY = {
  "Centralized Exchange": "exchange_confidence_score",
  "MEV Searcher": "mev_searcher_score",
  Bridge: "bridge_score",
  "Protocol Router": "protocol_router_score",
  "Fund / Whale": "fund_score",
  "Smart Money": "smart_money_score",
};

const MIN_CONFIDENCE_FOR_LABEL = 0.35;
const GAP_FOR_OVERRIDE = 0.15;

/**
 * Compute fingerprint from features, classification, clusterData, txs, address.
 * Returns entity_type, confidence_score, supporting_signals[], scores, entity_cluster_id.
 */
export function computeFingerprint(features, classification, clusterData, txs, address, coordination = null) {
  const coord = coordination || {};
  const exchange = computeExchangeSignature(features, txs, address);
  const mev = computeMevSearcherSignature(features);
  const bridge = computeBridgeSignature(features, txs, address);
  const fund = computeFundWhaleSignature(features);
  const smart = computeSmartMoneySignature(features, classification);
  const router = computeProtocolRouterSignature(features, txs, address);

  const scores = {
    exchange_confidence_score: exchange.exchange_confidence_score,
    mev_searcher_score: mev.mev_searcher_score,
    bridge_score: bridge.bridge_score,
    protocol_router_score: router.protocol_router_score,
    fund_score: fund.fund_score,
    smart_money_score: smart.smart_money_score,
  };

  const typeOrder = [
    "Centralized Exchange",
    "MEV Searcher",
    "Bridge",
    "Protocol Router",
    "Fund / Whale",
    "Smart Money",
  ];
  const ranked = typeOrder
    .map((type) => ({ type, score: scores[TYPE_TO_SCORE_KEY[type]] ?? 0 }))
    .filter((r) => r.score >= MIN_CONFIDENCE_FOR_LABEL)
    .sort((a, b) => b.score - a.score);

  const first = ranked[0];
  const second = ranked[1];
  const gap = first && second ? first.score - second.score : 1;
  const entity_type =
    first && first.score >= MIN_CONFIDENCE_FOR_LABEL && (gap >= GAP_FOR_OVERRIDE || !second)
      ? first.type
      : "Unknown";

  const signalLists = {
    "Centralized Exchange": exchange.signals,
    "MEV Searcher": mev.signals,
    Bridge: bridge.signals,
    "Protocol Router": router.signals,
    "Fund / Whale": fund.signals,
    "Smart Money": smart.signals,
  };
  const supporting_signals = entity_type !== "Unknown" ? signalLists[entity_type] || [] : [];

  const confidence_score =
    entity_type !== "Unknown" ? Math.min(1, Math.round((first?.score ?? 0) * 100) / 100) : 0;

  const clusterResult = assignEntityClusterId(address, clusterData, features, coord);
  const entity_cluster_id = clusterResult.entity_cluster_id ?? null;

  return {
    entity_type,
    confidence_score,
    supporting_signals,
    scores,
    entity_cluster_id,
    cluster_size: clusterResult.cluster_size,
    related_wallets: clusterResult.related_wallets || [],
  };
}

/**
 * Clustering layer: behavioral similarity, counterparty overlap, temporal correlation.
 * Assigns entity_cluster_id. Enriches existing cluster_data from Tier-S++.
 */

import { createHash } from "node:crypto";

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

/**
 * Compute a stable entity_cluster_id from behavioral + counterparty + temporal signals.
 * Uses existing cluster_id when present; otherwise derives from features + related_wallets.
 */
export function assignEntityClusterId(address, clusterData, features, coordination) {
  const existingId = clusterData?.cluster_id ?? null;
  const related = clusterData?.related_wallets || [];
  const clusterSize = clusterData?.cluster_size ?? 0;
  const act = features?.activity_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  const temporalSignals = coordination?.temporalSignals || [];
  const sharedCp = coordination?.sharedCounterpartySignals || [];

  if (existingId && clusterSize >= 2) {
    return {
      entity_cluster_id: existingId,
      cluster_size: clusterSize,
      related_wallets: related,
      signals: ["tier_s_cluster"],
    };
  }

  const components = [
    low(address),
    (net.unique_counterparties ?? 0).toString(),
    (net.top_5_counterparty_share ?? 0).toFixed(2),
    (beh.dex_interaction_ratio ?? 0).toFixed(2),
    (beh.cex_interaction_ratio ?? 0).toFixed(2),
    (tem.burst_activity_score ?? 0).toFixed(2),
    (act.avg_tx_per_day ?? 0).toFixed(2),
    ...related.slice(0, 5).map(low),
    ...temporalSignals.slice(0, 3),
    ...sharedCp.slice(0, 3),
  ];
  const seed = components.join("|");
  const entity_cluster_id = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return {
    entity_cluster_id,
    cluster_size: clusterSize,
    related_wallets: related,
    signals: ["behavioral_counterparty_derived"],
  };
}

/**
 * Phase 4 — Clustering (hardened).
 * Never assign cluster_id if only 1 wallet observed or only 1 funding source.
 * Cluster only if ≥2 strong signals. Exclude contracts from related_wallets.
 */

import { createHash } from "node:crypto";
import { isKnownContract } from "./knownLabels.js";

/**
 * Build cluster_data. Conservative: cluster_id only when ≥2 strong signals and (≥2 connected wallets or ≥2 funding sources).
 */
export function buildClusterData(address, fundingAnalysis, coordination) {
  const connected = coordination?.connectedWallets || [];
  const funders = fundingAnalysis?.funders || [];
  const funderCount = Array.isArray(funders) ? funders.length : 0;

  const strongSignals = [];
  if ((fundingAnalysis?.signals || []).includes("shared_funding_cex_bridge")) {
    strongSignals.push("shared_funding_source");
  }
  if (funderCount >= 2) {
    strongSignals.push("multiple_funding_sources");
  }
  if ((coordination?.temporalSignals || []).includes("temporal_burst")) {
    strongSignals.push("repeated_temporal_sync");
  }
  for (const s of coordination?.sharedCounterpartySignals || []) {
    strongSignals.push(s);
  }
  const uniqueSignals = [...new Set(strongSignals)];

  const connectedFiltered = connected.filter((addr) => !isKnownContract(addr));
  const clusterSize = connectedFiltered.length;

  if (clusterSize === 0 && uniqueSignals.length < 2) {
    return {
      cluster_id: null,
      cluster_size: 0,
      related_wallets: [],
      cluster_confidence: 0,
    };
  }

  if (clusterSize === 1 && funderCount <= 1 && uniqueSignals.length < 2) {
    return {
      cluster_id: null,
      cluster_size: clusterSize,
      related_wallets: [],
      cluster_confidence: 0,
    };
  }

  if (uniqueSignals.length < 2) {
    return {
      cluster_id: null,
      cluster_size: clusterSize,
      related_wallets: connectedFiltered.slice(0, 3),
      cluster_confidence: 0,
    };
  }

  let clusterId = null;
  let cluster_confidence = 0;

  if (connectedFiltered.length >= 2) {
    cluster_confidence = Math.min(0.9, 0.4 + connectedFiltered.length * 0.1 + uniqueSignals.length * 0.05);
    const seed = [address.toLowerCase(), ...connectedFiltered.map((a) => a.toLowerCase()).sort()].join("|");
    clusterId = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  } else if (connectedFiltered.length === 1 && uniqueSignals.length >= 2) {
    cluster_confidence = Math.min(0.5, 0.25 + uniqueSignals.length * 0.08);
    clusterId = createHash("sha256").update(`${address.toLowerCase()}|${uniqueSignals.sort().join("|")}`).digest("hex").slice(0, 16);
  } else if (connectedFiltered.length === 0 && uniqueSignals.length >= 2 && funderCount >= 2) {
    cluster_confidence = Math.min(0.4, 0.2 + uniqueSignals.length * 0.06);
    clusterId = createHash("sha256").update(`${address.toLowerCase()}|${uniqueSignals.sort().join("|")}`).digest("hex").slice(0, 16);
  }

  const related_wallets = connectedFiltered.slice(0, 3);

  return {
    cluster_id: clusterId,
    cluster_size: clusterSize,
    related_wallets,
    cluster_confidence: Math.round(cluster_confidence * 100) / 100,
  };
}

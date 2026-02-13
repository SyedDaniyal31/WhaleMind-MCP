/**
 * Bridge signature: repeated interaction with bridge contracts, cross-chain mirrored flows,
 * lock-mint / burn-release style patterns (heuristic via high bridge ratio + volume).
 */

import { KNOWN_BRIDGES } from "../../knownLabels.js";

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

export function computeBridgeSignature(features, txs, address) {
  const signals = [];
  const beh = features?.behavioral_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const bridgeRatio = n(beh.bridge_ratio);
  const cexBridgeRatio = n(beh.cex_interaction_ratio);
  const uniqueCp = n(net.unique_counterparties);
  const totalTxs = (txs || []).length;
  const lifetimeVolume = n(vol.lifetime_volume_eth);

  let bridgeTxCount = 0;
  const bridgeCounterparties = new Set();
  const addr = low(address);
  for (const tx of txs || []) {
    const to = low(tx.to);
    const from = low(tx.from);
    if ((from === addr || to === addr) && (KNOWN_BRIDGES.has(to) || KNOWN_BRIDGES.has(from))) {
      bridgeTxCount++;
      if (to) bridgeCounterparties.add(to);
      if (from) bridgeCounterparties.add(from);
    }
  }

  let score = 0;
  if (bridgeRatio >= 0.3) {
    score += 0.35;
    signals.push("high_bridge_ratio");
  } else if (bridgeRatio >= 0.1) {
    score += 0.2;
    signals.push("repeated_bridge_interaction");
  } else if (bridgeTxCount >= 3) {
    score += 0.15;
    signals.push("multiple_bridge_txs");
  }
  if (bridgeCounterparties.size >= 2) {
    score += 0.2;
    signals.push("multi_bridge_counterparties");
  }
  if (totalTxs >= 20 && bridgeTxCount >= 2 && lifetimeVolume > 10) {
    score += 0.15;
    signals.push("volume_via_bridges");
  }
  if (bridgeRatio > 0 && cexBridgeRatio < 0.5) {
    score += 0.1;
    signals.push("bridge_not_cex_dominant");
  }

  const bridge_score = Math.min(1, Math.round(score * 100) / 100);
  return { bridge_score, signals };
}

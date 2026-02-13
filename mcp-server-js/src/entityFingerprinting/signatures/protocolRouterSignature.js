/**
 * Protocol router signature: high contract/DEX interaction, many small routed txs,
 * aggregator-like behavior. Uses known DEX routers + contract call ratio.
 */

import { KNOWN_DEX_ROUTERS } from "../../knownLabels.js";

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

function low(addr) {
  return addr ? String(addr).toLowerCase() : "";
}

export function computeProtocolRouterSignature(features, txs, address) {
  const signals = [];
  const beh = features?.behavioral_metrics || {};
  const net = features?.network_metrics || {};
  const act = features?.activity_metrics || {};
  const contractCallRatio = n(beh.contract_call_ratio);
  const dexRatio = n(beh.dex_interaction_ratio);
  const uniqueCp = n(net.unique_counterparties);
  const totalTxs = (txs || []).length;
  const avgTxPerDay = n(act.avg_tx_per_day);
  const addr = low(address);

  let routerTxCount = 0;
  const routerSet = new Set();
  for (const tx of txs || []) {
    const to = low(tx.to);
    const from = low(tx.from);
    if ((from === addr || to === addr) && KNOWN_DEX_ROUTERS.has(to)) {
      routerTxCount++;
      routerSet.add(to);
    }
  }

  let score = 0;
  if (contractCallRatio >= 0.7) {
    score += 0.3;
    signals.push("high_contract_calls");
  } else if (contractCallRatio >= 0.5) {
    score += 0.15;
    signals.push("contract_heavy");
  }
  if (dexRatio >= 0.5 && totalTxs >= 50) {
    score += 0.25;
    signals.push("dex_router_usage");
  }
  if (routerTxCount >= 10 && routerSet.size >= 2) {
    score += 0.2;
    signals.push("multi_router_interaction");
  }
  if (uniqueCp >= 20 && avgTxPerDay > 2 && contractCallRatio > 0.4) {
    score += 0.15;
    signals.push("aggregator_like");
  }
  if (routerTxCount >= 5 && totalTxs >= 20) {
    score += 0.1;
    signals.push("routed_flow");
  }

  const protocol_router_score = Math.min(1, Math.round(score * 100) / 100);
  return { protocol_router_score, signals };
}

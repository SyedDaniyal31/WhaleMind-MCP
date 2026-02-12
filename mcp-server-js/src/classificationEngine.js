/**
 * Tier-S++ Layers 3–5 — Entity scoring, contradiction filters, attribution decision.
 * Uses Layer 2 behavioral scores; applies contradiction filters, negative scoring,
 * entity rules (CEX 4+/6, MEV 4+/6, Fund 3+/5, Whale fallback), and decision bands.
 */

import { computeBehavioralScores } from "./behavioralLayer.js";

const WEI_PER_ETH = 1e18;

function toEth(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const s = String(val);
  if (s.startsWith("0x")) return Number(BigInt(s)) / WEI_PER_ETH;
  return Number(s) / WEI_PER_ETH || 0;
}

const ENTITY_TYPES = ["CEX Hot Wallet", "MEV Bot", "Fund / Institutional Whale", "Individual Whale", "Unknown"];

// ─── CEX Override (high priority) ───────────────────────────────────────────
const CEX_OVERRIDE_MIN_CP = 501;
const CEX_OVERRIDE_MIN_TXS = 1000;
const CEX_OVERRIDE_INFLOW_OUTFLOW_TOLERANCE = 0.1;
const CEX_OVERRIDE_MAX_REPEAT_RATIO = 0.05;
const CEX_OVERRIDE_MIN_CLUSTER_SIZE = 21;
const MEV_OVERRIDE_THRESHOLD = 0.85;

// ─── MEV require ALL (Layer 4) ─────────────────────────────────────────────
const MEV_SAME_BLOCK_MIN = 5;
const MEV_DEX_RATIO_MIN = 0.6;
const MEV_GAS_SPIKE_RATIO_MIN = 0.2;
const MEV_BURST_SCORE_MIN = 0.5;
const MEV_MAX_CP = 300;
const MEV_CAP_WHEN_NOT_ALL = 0.6;

// ─── Contradiction filters ────────────────────────────────────────────────
const CEX_VS_MEV_CP = 800;
const CEX_VS_MEV_FLOW_SYMMETRY = 0.8;
const MEV_CAP_WHEN_CEX_LIKE = 0.5;

// ─── Decision bands (Layer 5) ──────────────────────────────────────────────
const STRONG_TOP_MIN = 0.75;
const STRONG_GAP_MIN = 0.2;
const MODERATE_TOP_MIN = 0.6;
const MODERATE_GAP_MIN = 0.1;
const TOP_TWO_TIE_THRESHOLD = 0.1;

// ─── Entity rules: min counts ─────────────────────────────────────────────
const CEX_RULES_MIN = 4;
const MEV_RULES_MIN = 4;
const FUND_RULES_MIN = 3;

function n(v, def = 0) {
  return typeof v === "number" && !Number.isNaN(v) ? v : def;
}

/** Inflow ≈ outflow within 10% */
function inflowOutflowBalanced(totalIn, totalOut) {
  if (totalIn + totalOut === 0) return true;
  const min = Math.min(totalIn, totalOut);
  const max = Math.max(totalIn, totalOut);
  return max === 0 || min / max >= 1 - CEX_OVERRIDE_INFLOW_OUTFLOW_TOLERANCE;
}

/** Tier-S++ CEX entity rules: must satisfy 4+ of 6. */
function cexRuleCount(features, txs, context) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const totalTxs = (txs || []).length;
  const totalInEth = n(vol.total_in_eth);
  const totalOutEth = n(vol.total_out_eth);
  let count = 0;
  if (n(net.unique_counterparties) > 500) count++;
  if (totalTxs > 1000) count++;
  if (inflowOutflowBalanced(totalInEth, totalOutEth)) count++;
  if (n(beh.zero_balance_frequency) > 0.05) count++;
  if (n(net.top_5_counterparty_share) < 0.4 && n(net.unique_counterparties) > 100) count++;
  if (n(context.cluster_size) > 20) count++;
  return count;
}

/** Tier-S++ MEV entity rules: must satisfy 4+ of 6. */
function mevRuleCount(features) {
  const beh = features?.behavioral_metrics || {};
  const tem = features?.temporal_metrics || {};
  const net = features?.network_metrics || {};
  let count = 0;
  if (n(beh.same_block_max_txs) >= 5) count++;
  if (n(beh.dex_interaction_ratio) > 0.6) count++;
  if (n(beh.gas_spike_ratio) > 0.2) count++;
  if (n(tem.burst_activity_score) > 0.5) count++;
  if (n(net.unique_counterparties) < 300) count++;
  if (n(beh.same_block_multi_tx_count) >= 3) count++;
  return count;
}

/** Tier-S++ Fund entity rules: must satisfy 3+ of 5. */
function fundRuleCount(features) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const beh = features?.behavioral_metrics || {};
  let count = 0;
  if (n(vol.max_single_tx) >= 100) count++;
  if (n(act.avg_tx_per_day) < 2 && n(act.wallet_age_days) >= 90) count++;
  if (n(act.wallet_age_days) >= 180) count++;
  if (n(beh.dex_interaction_ratio) < 0.3) count++;
  if (n(beh.cex_volume_share) >= 0.1) count++;
  return count;
}

/**
 * Layer 4: Contradiction filters and negative scoring. Returns adjusted scores and contradiction penalty.
 */
function applyContradictionFilters(scores, features, context) {
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const beh = features?.behavioral_metrics || {};
  const act = features?.activity_metrics || {};
  const totalInEth = n(vol.total_in_eth);
  const totalOutEth = n(vol.total_out_eth);
  const flowSymmetry = totalInEth + totalOutEth > 0
    ? Math.min(totalInEth, totalOutEth) / Math.max(totalInEth, totalOutEth, 0.001)
    : 0;
  let cex = n(scores.cex_hub_score);
  let mev = n(scores.mev_score);
  let fund = n(scores.fund_score);
  let whale = n(scores.whale_score);
  let contradictionPenalty = 0;

  // CEX vs MEV: if cp > 800 and flow symmetry > 0.8 → cap MEV at 0.5
  if (n(net.unique_counterparties) > CEX_VS_MEV_CP && flowSymmetry > CEX_VS_MEV_FLOW_SYMMETRY) {
    mev = Math.min(mev, MEV_CAP_WHEN_CEX_LIKE);
    contradictionPenalty += 0.15;
  }

  // Fund vs CEX: if avg_tx large BUT tx_count very high → reduce Fund
  const totalTxs = (context.total_txs ?? 0) || Math.max(1, n(act.wallet_age_days) * n(act.avg_tx_per_day));
  if (n(vol.avg_tx_size) >= 50 && totalTxs > 500) {
    fund = Math.max(0, fund - 0.2);
    contradictionPenalty += 0.05;
  }

  // MEV vs Whale: long holding / low frequency → reduce MEV (proxy: wallet age high + low tx/day)
  if (n(act.wallet_age_days) >= 180 && n(act.avg_tx_per_day) < 1) {
    mev = Math.max(0, mev - 0.15);
  }

  // Negative scoring: when CEX-like, suppress MEV and Fund
  if (cex >= 0.6) {
    mev = Math.max(0, mev - 0.3);
    fund = Math.max(0, fund - 0.2);
  }
  if (mev >= 0.6) {
    fund = Math.max(0, fund - 0.1);
  }

  return {
    cex: Math.round(Math.max(0, Math.min(1, cex)) * 100) / 100,
    mev: Math.round(Math.max(0, Math.min(1, mev)) * 100) / 100,
    fund: Math.round(Math.max(0, Math.min(1, fund)) * 100) / 100,
    whale: Math.round(Math.max(0, Math.min(1, whale)) * 100) / 100,
    contradiction_penalty: Math.min(0.4, contradictionPenalty),
  };
}

/**
 * Layer 5: Attribution decision bands. Strong (top ≥0.75, gap ≥0.2), Moderate (top ≥0.6, gap ≥0.1), else Unknown.
 */
function attributionDecision(adjusted, ruleCounts) {
  const { cex, mev, fund, whale } = adjusted;
  const types = [
    { type: "CEX Hot Wallet", score: cex, rulesOk: ruleCounts.cex >= CEX_RULES_MIN },
    { type: "MEV Bot", score: mev, rulesOk: ruleCounts.mev >= MEV_RULES_MIN },
    { type: "Fund / Institutional Whale", score: fund, rulesOk: ruleCounts.fund >= FUND_RULES_MIN },
    { type: "Individual Whale", score: whale, rulesOk: true },
  ];
  // Cap entity score if rule count not met (except Whale as fallback)
  const capped = types.map((t) => ({
    ...t,
    score:
      t.type === "Individual Whale"
        ? t.score
        : t.type === "CEX Hot Wallet"
          ? (t.rulesOk ? t.score : Math.min(t.score, 0.5))
          : t.type === "MEV Bot"
            ? (t.rulesOk ? t.score : Math.min(t.score, 0.55))
            : t.type === "Fund / Institutional Whale"
              ? (t.rulesOk ? t.score : Math.min(t.score, 0.5))
              : t.score,
  }));
  const sorted = [...capped].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const second = sorted[1];
  const gap = second ? best.score - second.score : 1;

  if (best.score < 0.01) {
    return { entity_type: "Unknown", entity_score: 0, band: "none", gap };
  }
  if (second && gap <= TOP_TWO_TIE_THRESHOLD) {
    return { entity_type: "Unknown", entity_score: best.score, band: "ambiguous", gap };
  }
  if (best.score >= STRONG_TOP_MIN && gap >= STRONG_GAP_MIN) {
    return { entity_type: best.type, entity_score: best.score, band: "strong", gap };
  }
  if (best.score >= MODERATE_TOP_MIN && gap >= MODERATE_GAP_MIN) {
    return { entity_type: best.type, entity_score: best.score, band: "moderate", gap };
  }
  return { entity_type: "Unknown", entity_score: best.score, band: "weak", gap };
}

export function classifyEntity(features, txs, fundingAnalysis, context = {}) {
  const act = features?.activity_metrics || {};
  const vol = features?.volume_metrics || {};
  const net = features?.network_metrics || {};
  const totalTxs = (txs || []).length;
  const totalInEth = n(vol.total_in_eth);
  const totalOutEth = n(vol.total_out_eth);
  const uniqueCp = n(net.unique_counterparties);
  const repeatRatio = n(net.repeat_interaction_ratio, net.repeat_counterparty_ratio);
  const clusterSize = n(context.cluster_size);
  const fundingSourceCount = Array.isArray(fundingAnalysis?.funders) ? fundingAnalysis.funders.length : 0;

  const fullContext = {
    ...context,
    cluster_size: clusterSize,
    funding_source_count: fundingSourceCount,
    total_txs: totalTxs,
  };

  // ─── CEX Override (unchanged) ───────────────────────────────────────────
  const inflowOutflowOk = inflowOutflowBalanced(totalInEth, totalOutEth);
  const cexOverride =
    uniqueCp > CEX_OVERRIDE_MIN_CP &&
    totalTxs > CEX_OVERRIDE_MIN_TXS &&
    inflowOutflowOk &&
    repeatRatio < CEX_OVERRIDE_MAX_REPEAT_RATIO &&
    clusterSize > CEX_OVERRIDE_MIN_CLUSTER_SIZE;

  const behavioralScores = computeBehavioralScores(features, fullContext);
  const mevAllOk =
    n(features?.behavioral_metrics?.same_block_max_txs) >= MEV_SAME_BLOCK_MIN &&
    n(features?.behavioral_metrics?.dex_interaction_ratio) > MEV_DEX_RATIO_MIN &&
    n(features?.behavioral_metrics?.gas_spike_ratio) > MEV_GAS_SPIKE_RATIO_MIN &&
    n(features?.temporal_metrics?.burst_activity_score) > MEV_BURST_SCORE_MIN &&
    uniqueCp < MEV_MAX_CP;
  const privateRelayPatterns = false;

  if (cexOverride && !(behavioralScores.mev_score > MEV_OVERRIDE_THRESHOLD && privateRelayPatterns)) {
    return {
      entity_type: "CEX Hot Wallet",
      entity_score: 0.8,
      signals_used: ["cex_override_high_cp", "high_tx_count", "inflow_outflow_balanced", "low_repeat_ratio", "large_cluster"],
      all_scores: { "CEX Hot Wallet": 0.8, "MEV Bot": 0, "Fund / Institutional Whale": 0, "Individual Whale": 0, Unknown: 0 },
      contradiction_penalty: 0,
    };
  }

  // ─── Layer 4: Contradiction filters + negative scoring ───────────────────
  const adjusted = applyContradictionFilters(
    {
      cex_hub_score: behavioralScores.cex_hub_score,
      mev_score: behavioralScores.mev_score,
      fund_score: behavioralScores.fund_score,
      whale_score: behavioralScores.whale_score,
    },
    features,
    fullContext
  );

  // ─── Entity rule counts (4+/4+/3+) ───────────────────────────────────────
  const ruleCounts = {
    cex: cexRuleCount(features, txs, fullContext),
    mev: mevRuleCount(features),
    fund: fundRuleCount(features),
  };

  // ─── Layer 5: Decision bands ───────────────────────────────────────────────
  const decision = attributionDecision(
    { cex: adjusted.cex, mev: adjusted.mev, fund: adjusted.fund, whale: adjusted.whale },
    ruleCounts
  );

  const all_scores = {
    "CEX Hot Wallet": adjusted.cex,
    "MEV Bot": adjusted.mev,
    "Fund / Institutional Whale": adjusted.fund,
    "Individual Whale": adjusted.whale,
    Unknown: 0,
  };

  const signalsUsed = [];
  if (decision.entity_type !== "Unknown") {
    if (decision.band === "strong") signalsUsed.push("strong_attribution_band");
    if (decision.band === "moderate") signalsUsed.push("moderate_attribution_band");
    if (decision.entity_type === "CEX Hot Wallet") signalsUsed.push(`cex_rules_${ruleCounts.cex}_of_6`);
    if (decision.entity_type === "MEV Bot") signalsUsed.push(`mev_rules_${ruleCounts.mev}_of_6`, mevAllOk ? "mev_all_signals" : "mev_capped");
    if (decision.entity_type === "Fund / Institutional Whale") signalsUsed.push(`fund_rules_${ruleCounts.fund}_of_5`);
    if (decision.entity_type === "Individual Whale") signalsUsed.push("whale_fallback_non_hub");
  } else {
    if (decision.band === "ambiguous") signalsUsed.push("top_two_scores_within_0_1_prefer_unknown");
    else signalsUsed.push("insufficient_confidence_unknown");
  }

  return {
    entity_type: decision.entity_type,
    entity_score: Math.round(decision.entity_score * 100) / 100,
    signals_used: signalsUsed,
    all_scores: all_scores,
    contradiction_penalty: adjusted.contradiction_penalty,
  };
}

export { ENTITY_TYPES };

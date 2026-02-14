/**
 * WhaleMind MCP tools — Tier-S on-chain intelligence engine.
 * Feature extraction → classification → confidence → clustering → risk. Rule-based, explainable.
 */
import {
  analyzeFundingSources,
  detectCoordination,
} from "./intelligence.js";
import { extractFeatures } from "./featureExtraction.js";
import { classifyEntity } from "./classificationEngine.js";
import { computeConfidence } from "./confidenceEngine.js";
import { buildClusterData } from "./clustering.js";
import { computeRiskProfile } from "./riskScoring.js";
import { analyzeBlock } from "./mevBundleDetection/index.js";
import { fingerprintWallet } from "./entityFingerprinting/index.js";

const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";
const WEI_PER_ETH = 1e18;
const TIMEOUT_MS = 10000;
const INTERNAL_TX_LIMIT = 100;
const TX_PAGE_SIZE = 10000;
const SUSPICIOUS_ROUND_NUMBERS = [1000, 2000, 5000, 10000];
const STATISTICAL_SUFFICIENCY_DEFAULT = 8000;
const MAX_TX_PAGES = 50;

/** Ethereum address: 0x + exactly 40 hex chars. Use for validation and schema. */
export const ETH_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";
const ETH_ADDRESS_REGEX = new RegExp(ETH_ADDRESS_PATTERN);

export const TOOL_DEFINITIONS = [
  {
    name: "whale_intel_report",
    description:
      "Get a full on-chain intelligence report for ONE Ethereum wallet: entity type (CEX/MEV/Fund/Whale), risk, copy-trade signal, cluster, fingerprint. Use when the user asks to analyze, research, or label a single wallet. Does NOT compare wallets, does NOT return block-level MEV data, does NOT accept contract addresses as primary input. Example: address '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', limit 2000.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Single Ethereum wallet address. Must be 0x followed by exactly 40 hexadecimal characters (no spaces, checksum optional).",
          pattern: ETH_ADDRESS_PATTERN,
          examples: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"],
        },
        limit: {
          type: "integer",
          description: "Max number of transactions to fetch and analyze. Use 2000+ for strict CEX/MEV classification; 500 for faster response.",
          minimum: 1,
          maximum: 10000,
          default: 2000,
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description: "Tier-S whale intelligence: entity_type, confidence, cluster_data, risk_profile, feature_summary",
      properties: {
        address: { type: "string" },
        verdict: { type: "string" },
        confidence: { type: "number" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"] },
        total_txs: { type: "number" },
        total_in_eth: { type: "number" },
        total_out_eth: { type: "number" },
        unique_counterparties: { type: "number" },
        balance_wei: { type: ["string", "null"] },
        agent_summary: { type: "string" },
        first_seen_iso: { type: ["string", "null"] },
        last_seen_iso: { type: ["string", "null"] },
        entity_type: { type: "string" },
        confidence_score: { type: "number" },
        confidence_reasons: { type: "array", items: { type: "string" } },
        cluster_data: {
          type: "object",
          properties: {
            cluster_id: { type: ["string", "null"] },
            cluster_size: { type: "number" },
            related_wallets: { type: "array", items: { type: "string" } },
            cluster_confidence: { type: "number" },
          },
          required: ["cluster_id", "cluster_size", "related_wallets", "cluster_confidence"],
        },
        risk_profile: {
          type: "object",
          properties: {
            market_impact_risk: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } } },
            counterparty_risk: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } } },
            behavioral_risk: { type: "object", properties: { score: { type: "number" }, label: { type: "string" } } },
          },
          required: ["market_impact_risk", "counterparty_risk", "behavioral_risk"],
        },
        feature_summary: {
          type: "object",
          properties: {
            activity_metrics: { type: "object" },
            volume_metrics: { type: "object" },
            network_metrics: { type: "object" },
            behavioral_metrics: { type: "object" },
            temporal_metrics: { type: "object" },
          },
        },
        entity_cluster: {
          type: "object",
          properties: {
            cluster_id: { type: ["string", "null"] },
            confidence: { type: "number" },
            connected_wallets: { type: "array", items: { type: "string" } },
            signals_used: { type: "array", items: { type: "string" } },
          },
          required: ["cluster_id", "confidence", "connected_wallets", "signals_used"],
        },
        behavioral_profile: {
          type: "object",
          properties: {
            type: { type: "string" },
            confidence: { type: "number" },
            reasoning: { type: "array", items: { type: "string" } },
          },
          required: ["type", "confidence", "reasoning"],
        },
        entity_fingerprint: {
          type: "object",
          description: "Enrichment: entity tagging from behavioral/interaction signatures",
          properties: {
            entity_type: { type: "string" },
            confidence_score: { type: "number" },
            supporting_signals: { type: "array", items: { type: "string" } },
            entity_cluster_id: { type: ["string", "null"] },
            scores: { type: "object" },
          },
        },
        tx_fetch_summary: {
          type: "object",
          description: "Transaction fetch metadata: total_fetched, pages_fetched, truncated, sampled, full_history",
          properties: {
            total_fetched: { type: "number" },
            pages_fetched: { type: "number" },
            truncated: { type: "boolean" },
            sampled: { type: "boolean" },
            full_history: { type: "boolean" },
          },
          required: ["total_fetched", "pages_fetched", "truncated", "sampled", "full_history"],
        },
        data_coverage: {
          type: "object",
          description: "Data coverage: total_available_txs, fetched_txs, coverage_ratio, label, analysis_mode (full | sampled)",
          properties: {
            total_available_txs: { type: ["number", "null"] },
            fetched_txs: { type: "number" },
            coverage_ratio: { type: "number" },
            coverage_pct: { type: "number" },
            label: { type: "string" },
            analysis_mode: { type: "string", enum: ["full", "sampled"] },
            interpretation_note: { type: ["string", "null"] },
          },
          required: ["total_available_txs", "fetched_txs", "coverage_ratio", "coverage_pct", "label", "analysis_mode"],
        },
      },
      required: [
        "address",
        "risk_level",
        "copy_trade_signal",
        "total_txs",
        "total_in_eth",
        "total_out_eth",
        "unique_counterparties",
        "agent_summary",
        "entity_type",
        "confidence_score",
        "confidence_reasons",
        "cluster_data",
        "risk_profile",
        "feature_summary",
        "entity_cluster",
        "behavioral_profile",
        "tx_fetch_summary",
        "data_coverage",
      ],
    },
  },
  {
    name: "compare_whales",
    description:
      "Compare exactly 2 to 5 Ethereum wallets and return a ranking plus best_for_copy_trading. Use when the user asks to compare, rank, or choose between multiple wallets. Does NOT analyze a single wallet (use whale_intel_report). Does NOT detect MEV bundles. Example: addresses ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'].",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          description: "Exactly 2 to 5 wallet addresses. Each must be 0x + 40 hex characters.",
          items: { type: "string", pattern: ETH_ADDRESS_PATTERN },
          minItems: 2,
          maxItems: 5,
          examples: [["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"]],
        },
      },
      required: ["addresses"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        wallets: { type: "array", items: { type: "object" } },
        ranking: { type: "array", items: { type: "string" } },
        best_for_copy_trading: { type: ["string", "null"] },
        comparison_summary: { type: "string" },
      },
      required: ["wallets", "ranking", "best_for_copy_trading", "comparison_summary"],
    },
  },
  {
    name: "whale_risk_snapshot",
    description:
      "Get a quick risk level and copy-trade signal for ONE wallet (lightweight, fewer tx fetched). Use when the user only needs risk/signal without full entity or cluster details. Does NOT return entity_type, cluster_data, or fingerprint; for full report use whale_intel_report. Example: address '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Single Ethereum wallet address. Must be 0x followed by exactly 40 hexadecimal characters.",
          pattern: ETH_ADDRESS_PATTERN,
          examples: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
        },
      },
      required: ["address"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        copy_trade_signal: { type: "string", enum: ["STRONG_BUY", "BUY", "WATCH", "AVOID", "NEUTRAL"] },
        one_line_rationale: { type: "string" },
        agent_summary: { type: "string" },
      },
      required: ["address", "risk_level", "copy_trade_signal", "one_line_rationale", "agent_summary"],
    },
  },
  {
    name: "detect_mev_bundles",
    description:
      "Detect MEV bundles (sandwich, arbitrage, backrun, liquidation) in a single block. Use when the user asks about MEV in a block or block-level bundles. Provide EITHER block_number (fetch via Etherscan) OR a transactions array for that block. Does NOT analyze wallets; does NOT compare addresses. Example: block_number 19000000.",
    inputSchema: {
      type: "object",
      properties: {
        block_number: {
          type: "integer",
          description: "Ethereum mainnet block number. Used to fetch block transactions via Etherscan. Provide this OR transactions, not both required.",
          minimum: 0,
          examples: [19000000, 21000000],
        },
        transactions: {
          type: "array",
          description: "Pre-fetched block transactions (hash, from, to, value, gasUsed, gasPrice, logs). Use when you already have block tx data; otherwise use block_number.",
          items: { type: "object" },
        },
        min_confidence: {
          type: "number",
          description: "Minimum bundle confidence (0–1) to include in results. Default 0.35.",
          minimum: 0,
          maximum: 1,
          default: 0.35,
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        block_number: { type: ["number", "null"] },
        block_tx_count: { type: "number" },
        bundle_confidence_score: { type: ["number", "null"] },
        bundle_type: { type: ["string", "null"], enum: ["sandwich", "arbitrage", "backrun", "liquidation", null] },
        best_bundle: { type: ["object", "null"] },
        bundles: { type: "array", items: { type: "object" } },
        error: { type: ["string", "null"] },
      },
      required: ["block_number", "block_tx_count", "bundle_confidence_score", "bundle_type", "best_bundle", "bundles", "error"],
    },
  },
];

// ─── Input validation (zero-retry: actionable errors) ───────────────────────
const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Validate tool input before execution. Returns { valid, error, hint }.
 * Agent gets explicit, correctable messages instead of generic failures.
 */
export function validateToolInput(toolName, args) {
  const a = args != null && typeof args === "object" ? args : {};
  if (toolName === "whale_intel_report") {
    const address = typeof a.address === "string" ? a.address.trim() : "";
    if (!address) return { valid: false, error: "Missing required parameter: address.", hint: "Provide a single wallet address, e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" };
    if (!ETH_ADDRESS_REGEX.test(address)) return { valid: false, error: "Invalid address: must be 0x followed by exactly 40 hexadecimal characters (no spaces).", hint: "Example: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" };
    const limit = a.limit;
    if (limit != null && (typeof limit !== "number" || Number.isNaN(limit) || !Number.isInteger(limit) || limit < 1 || limit > 10000)) return { valid: false, error: "Invalid limit: must be an integer between 1 and 10000.", hint: "Use 2000 for strict classification, 500 for faster response." };
    return { valid: true };
  }
  if (toolName === "compare_whales") {
    const addresses = Array.isArray(a.addresses) ? a.addresses : [];
    if (addresses.length < 2) return { valid: false, error: "Need at least 2 addresses to compare.", hint: "Provide an array of 2 to 5 wallet addresses." };
    if (addresses.length > 5) return { valid: false, error: "Maximum 5 addresses allowed.", hint: "Provide an array of 2 to 5 wallet addresses." };
    for (let i = 0; i < addresses.length; i++) {
      const addr = String(addresses[i] ?? "").trim();
      if (!ETH_ADDRESS_REGEX.test(addr)) return { valid: false, error: `Invalid address at index ${i}: must be 0x + 40 hex characters.`, hint: "Each address must match 0x[a-fA-F0-9]{40}" };
    }
    return { valid: true };
  }
  if (toolName === "whale_risk_snapshot") {
    const address = typeof a.address === "string" ? a.address.trim() : "";
    if (!address) return { valid: false, error: "Missing required parameter: address.", hint: "Provide a single wallet address." };
    if (!ETH_ADDRESS_REGEX.test(address)) return { valid: false, error: "Invalid address: must be 0x followed by exactly 40 hexadecimal characters.", hint: "Example: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" };
    return { valid: true };
  }
  if (toolName === "detect_mev_bundles") {
    const hasBlock = typeof a.block_number === "number" && !Number.isNaN(a.block_number) && a.block_number >= 0;
    const hasTxs = Array.isArray(a.transactions) && a.transactions.length > 0;
    if (!hasBlock && !hasTxs) return { valid: false, error: "Provide either block_number (integer >= 0) or a non-empty transactions array.", hint: "Example: { \"block_number\": 19000000 } or { \"transactions\": [...] }" };
    if (hasBlock && (a.block_number < 0 || !Number.isInteger(a.block_number))) return { valid: false, error: "block_number must be a non-negative integer.", hint: "Example: 19000000" };
    const minC = a.min_confidence;
    if (minC != null && (typeof minC !== "number" || minC < 0 || minC > 1)) return { valid: false, error: "min_confidence must be a number between 0 and 1.", hint: "Omit or use 0.35" };
    return { valid: true };
  }
  return { valid: false, error: `Unknown tool: ${toolName}.`, hint: `Valid tools: ${[...KNOWN_TOOLS].join(", ")}` };
}

// ─── Response cache (low latency, avoid repeated on-chain calls) ───────────
const REPORT_CACHE_TTL_MS = 60_000;
const reportCache = new Map();

function reportCacheKey(address, limit) {
  return `${String(address || "").toLowerCase()}|${Number(limit) || 0}`;
}

function weiToEth(w) {
  try {
    return Number(BigInt(w || "0")) / WEI_PER_ETH;
  } catch {
    return 0;
  }
}

function getApiUrl() {
  return (process.env.WHALEMIND_API_URL || process.env.WHalemind_API_URL || "").replace(/\/$/, "");
}

function getEtherscanKey() {
  return process.env.ETHERSCAN_API_KEY || "";
}

/**
 * Single page of txlist from Etherscan. No truncation.
 */
async function fetchTxListPage(address, page, pageSize) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    page: String(page),
    offset: String(Math.min(pageSize, 10000)),
    sort: "desc",
    ...(getEtherscanKey() && { apikey: getEtherscanKey() }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (data?.status !== "1" || data?.message !== "OK") return [];
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    clearTimeout(t);
    if (e?.name !== "AbortError") console.error("[Etherscan txlist]", e?.message || e);
    return [];
  }
}

/**
 * Paginated fetch: keep requesting until API returns fewer than pageSize or we hit cap.
 * Tracks total, logs pages, detects suspicious round-number truncation, optional early stop (sampled).
 */
async function fetchAllTransactions(address, options = {}) {
  const maxTransactions = Math.min(
    Math.max(1, options.maxTransactions ?? 10000),
    10000 * MAX_TX_PAGES
  );
  const pageSize = Math.min(Math.max(1, options.pageSize ?? TX_PAGE_SIZE), 10000);
  const statisticalSufficiency = options.statisticalSufficiency ?? STATISTICAL_SUFFICIENCY_DEFAULT;
  const stopWhenSufficient = options.stopWhenSufficient === true;

  const all = [];
  let page = 1;
  let truncated = false;
  let sampled = false;
  let totalAvailableTxs = null;

  while (page <= MAX_TX_PAGES) {
    const chunk = await fetchTxListPage(address, page, pageSize);
    const n = chunk.length;
    all.push(...chunk);
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "test") {
      console.log(
        JSON.stringify({
          msg: "txlist page",
          address: address.slice(0, 10) + "…",
          page,
          pageCount: n,
          totalSoFar: all.length,
        })
      );
    }
    if (n < pageSize) break;
    if (all.length >= maxTransactions) {
      truncated = true;
      totalAvailableTxs = all.length;
      if (all.length > maxTransactions) all.length = maxTransactions;
      break;
    }
    if (stopWhenSufficient && all.length >= statisticalSufficiency) {
      sampled = true;
      break;
    }
    page += 1;
  }

  if (SUSPICIOUS_ROUND_NUMBERS.includes(all.length) && !truncated) {
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "test") {
      console.warn(
        JSON.stringify({
          msg: "suspicious round number: possible truncation",
          address: address.slice(0, 10) + "…",
          totalFetched: all.length,
          hint: "Consider paginating or increasing page size.",
        })
      );
    }
  }

  const full_history = !truncated && !sampled;
  const fetchSummary = {
    total_fetched: all.length,
    pages_fetched: page,
    truncated,
    sampled,
    full_history,
    total_available_txs: totalAvailableTxs != null ? totalAvailableTxs : (full_history ? all.length : null),
  };
  return { transactions: all, fetchSummary };
}

/**
 * Single-page fetch for lightweight use (compare_whales, whale_risk_snapshot). No pagination.
 */
async function fetchTransactions(address, limit = 20) {
  return fetchTxListPage(address, 1, Math.min(Math.max(1, limit), 10000));
}

/** Fetch block by number (Etherscan proxy). Returns { number, transactions, baseFeePerGas } or null. */
async function fetchBlockByNumber(blockNumber) {
  const hex = typeof blockNumber === "number" ? `0x${blockNumber.toString(16)}` : String(blockNumber);
  const params = new URLSearchParams({
    chainid: "1",
    module: "proxy",
    action: "eth_getBlockByNumber",
    tag: hex,
    boolean: "true",
    ...(getEtherscanKey() && { apikey: getEtherscanKey() }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (data?.error) return null;
    const block = data?.result;
    if (!block || !Array.isArray(block.transactions)) return null;
    const txs = block.transactions.map((tx) => {
      const toEthVal = (v) => (v != null && typeof v === "string" && v.startsWith("0x") ? Number(BigInt(v)) : Number(v) || 0);
      return {
        hash: tx.hash ?? tx.transactionHash,
        transactionHash: tx.hash ?? tx.transactionHash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gas: tx.gas,
        gasUsed: tx.gasUsed ?? tx.gas,
        gasPrice: tx.gasPrice,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        blockNumber: blockNumber ?? (tx.blockNumber != null ? (typeof tx.blockNumber === "string" && tx.blockNumber.startsWith("0x") ? Number(BigInt(tx.blockNumber)) : Number(tx.blockNumber)) : null),
        timeStamp: block.timestamp != null ? (typeof block.timestamp === "string" && block.timestamp.startsWith("0x") ? Number(BigInt(block.timestamp)) : Number(block.timestamp)) : null,
        input: tx.input,
        logs: tx.logs ?? [],
      };
    });
    const baseFee = block.baseFeePerGas != null && typeof block.baseFeePerGas === "string" && block.baseFeePerGas.startsWith("0x")
      ? Number(BigInt(block.baseFeePerGas)) / 1e9
      : 30;
    return { number: blockNumber, transactions: txs, baseFeePerGas: baseFee };
  } catch (e) {
    clearTimeout(t);
    if (e?.name !== "AbortError") console.error("[Etherscan block]", e?.message || e);
    return null;
  }
}

/** Internal transactions for clustering (connected wallets, funding). Single call, bounded. */
async function fetchInternalTransactions(address) {
  const params = new URLSearchParams({
    chainid: "1",
    module: "account",
    action: "txlistinternal",
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(Math.min(INTERNAL_TX_LIMIT, 1000)),
    sort: "desc",
    ...(getEtherscanKey() && { apikey: getEtherscanKey() }),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ETHERSCAN_BASE}?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    if (data?.status !== "1" || data?.message !== "OK") return [];
    return Array.isArray(data.result) ? data.result : [];
  } catch (e) {
    clearTimeout(t);
    if (e?.name !== "AbortError") console.error("[Etherscan internal]", e?.message || e);
    return [];
  }
}

function analyzeTransactions(txs, addr) {
  let inEth = 0,
    outEth = 0;
  const cp = new Set();
  const ts = [];
  const low = (addr || "").toLowerCase();
  for (const tx of txs) {
    const from = (tx.from || "").toLowerCase();
    const to = (tx.to || "").toLowerCase();
    const v = weiToEth(tx.value);
    if (tx.timeStamp != null) ts.push(parseInt(tx.timeStamp, 10));
    if (from === low) {
      outEth += v;
      if (to) cp.add(to);
    }
    if (to === low) {
      inEth += v;
      if (from) cp.add(from);
    }
  }
  const first = ts.length ? Math.min(...ts) : null;
  const last = ts.length ? Math.max(...ts) : null;
  return {
    total_txs: txs.length,
    total_in_eth: Math.round(inEth * 1e4) / 1e4,
    total_out_eth: Math.round(outEth * 1e4) / 1e4,
    unique_counterparties: cp.size,
    first_seen_iso: first != null ? new Date(first * 1000).toISOString() : null,
    last_seen_iso: last != null ? new Date(last * 1000).toISOString() : null,
  };
}

async function fetchWhaleMindAnalyze(addr) {
  const url = getApiUrl();
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ wallet: addr }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function fetchWhaleMindBalance(addr) {
  const url = getApiUrl();
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/wallet/${encodeURIComponent(addr)}/balance`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = res.ok ? await res.json() : null;
    return data?.balance_wei ?? null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

const VERDICT = {
  SMART_MONEY_ACCUMULATION: { risk: "LOW", signal: "STRONG_BUY", score: 90 },
  WHALE_DORMANT: { risk: "LOW", signal: "WATCH", score: 50 },
  NEUTRAL: { risk: "MEDIUM", signal: "NEUTRAL", score: 50 },
  EXCHANGE_ROTATION: { risk: "MEDIUM", signal: "WATCH", score: 35 },
  STEALTH_DISTRIBUTION: { risk: "HIGH", signal: "AVOID", score: 15 },
};

function fromVerdict(verdict, confidence) {
  const v = verdict || "NEUTRAL";
  const c = typeof confidence === "number" ? confidence : 0.5;
  const s = VERDICT[v] || VERDICT.NEUTRAL;
  let sig = s.signal;
  if (sig === "STRONG_BUY" && c < 0.7) sig = "BUY";
  return { risk_level: s.risk, copy_trade_signal: sig, smart_money_score: Math.round((s.score ?? 50) * c) };
}

function fromMetrics(m) {
  const net = (m.total_in_eth || 0) - (m.total_out_eth || 0);
  const flow = (m.total_in_eth || 0) + (m.total_out_eth || 0);
  const txs = m.total_txs || 0;
  const cps = m.unique_counterparties || 0;
  let risk = "MEDIUM",
    signal = "NEUTRAL",
    score = 50;
  if (txs >= 10 && net > 20 && flow > 50) {
    risk = "LOW";
    signal = "BUY";
    score = Math.min(85, 50 + Math.round(net / 10) + Math.min(txs, 20));
  } else if (txs >= 5 && net < -20) {
    risk = "HIGH";
    signal = "AVOID";
    score = Math.max(15, 50 - Math.round(Math.abs(net) / 10));
  } else if (txs >= 3 && cps >= 2) signal = "WATCH";
  return { risk_level: risk, copy_trade_signal: signal, smart_money_score: score };
}

function ensureObject(o) {
  if (o == null || typeof o !== "object" || Array.isArray(o)) return {};
  return JSON.parse(JSON.stringify(o));
}

/** Coerce to outputSchema types so structuredContent never fails validation (Context/disputes). */
function toNumber(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
function toStringOrNull(v) {
  if (v == null) return null;
  return String(v);
}

/**
 * Coerce a tool result to match outputSchema types exactly. Call before returning
 * structuredContent so responses never fail schema validation (avoid disputes).
 */
export function coerceToOutputSchema(toolName, data) {
  const d = ensureObject(data);
  if (toolName === "whale_intel_report") {
    const ec = d.entity_cluster && typeof d.entity_cluster === "object" ? d.entity_cluster : {};
    const bp = d.behavioral_profile && typeof d.behavioral_profile === "object" ? d.behavioral_profile : {};
    const cd = d.cluster_data && typeof d.cluster_data === "object" ? d.cluster_data : {};
    const rp = d.risk_profile && typeof d.risk_profile === "object" ? d.risk_profile : {};
    const fs = d.feature_summary && typeof d.feature_summary === "object" ? d.feature_summary : {};
    return {
      address: String(d.address ?? ""),
      ...(d.verdict != null && { verdict: String(d.verdict) }),
      ...(typeof d.confidence === "number" && !Number.isNaN(d.confidence) && { confidence: d.confidence }),
      risk_level: String(d.risk_level ?? "MEDIUM"),
      copy_trade_signal: String(d.copy_trade_signal ?? "NEUTRAL"),
      total_txs: toNumber(d.total_txs),
      total_in_eth: toNumber(d.total_in_eth),
      total_out_eth: toNumber(d.total_out_eth),
      unique_counterparties: toNumber(d.unique_counterparties),
      balance_wei: d.balance_wei == null ? null : String(d.balance_wei),
      agent_summary: String(d.agent_summary ?? ""),
      first_seen_iso: d.first_seen_iso == null ? null : String(d.first_seen_iso),
      last_seen_iso: d.last_seen_iso == null ? null : String(d.last_seen_iso),
      entity_type: String(d.entity_type ?? "Unknown"),
      confidence_score: toNumber(d.confidence_score),
      confidence_reasons: Array.isArray(d.confidence_reasons) ? d.confidence_reasons.map(String) : [],
      cluster_data: {
        cluster_id: cd.cluster_id == null ? null : String(cd.cluster_id),
        cluster_size: toNumber(cd.cluster_size),
        related_wallets: Array.isArray(cd.related_wallets) ? cd.related_wallets.map(String) : [],
        cluster_confidence: toNumber(cd.cluster_confidence),
      },
      risk_profile: {
        market_impact_risk: { score: toNumber(rp.market_impact_risk?.score), label: String(rp.market_impact_risk?.label ?? "MEDIUM") },
        counterparty_risk: { score: toNumber(rp.counterparty_risk?.score), label: String(rp.counterparty_risk?.label ?? "MEDIUM") },
        behavioral_risk: { score: toNumber(rp.behavioral_risk?.score), label: String(rp.behavioral_risk?.label ?? "MEDIUM") },
      },
      feature_summary: ensureObject(fs),
      entity_cluster: {
        cluster_id: ec.cluster_id == null ? null : String(ec.cluster_id),
        confidence: toNumber(ec.confidence),
        connected_wallets: Array.isArray(ec.connected_wallets) ? ec.connected_wallets.map(String) : [],
        signals_used: Array.isArray(ec.signals_used) ? ec.signals_used.map(String) : [],
      },
      behavioral_profile: {
        type: String(bp.type ?? "Unknown"),
        confidence: toNumber(bp.confidence),
        reasoning: Array.isArray(bp.reasoning) ? bp.reasoning.map(String) : [],
      },
      entity_fingerprint: (() => {
        const ef = d.entity_fingerprint && typeof d.entity_fingerprint === "object" ? d.entity_fingerprint : {};
        return {
          entity_type: String(ef.entity_type ?? "Unknown"),
          confidence_score: toNumber(ef.confidence_score),
          supporting_signals: Array.isArray(ef.supporting_signals) ? ef.supporting_signals.map(String) : [],
          entity_cluster_id: ef.entity_cluster_id != null ? String(ef.entity_cluster_id) : null,
          scores: ensureObject(ef.scores),
        };
      })(),
      tx_fetch_summary: (() => {
        const tf = d.tx_fetch_summary && typeof d.tx_fetch_summary === "object" ? d.tx_fetch_summary : {};
        return {
          total_fetched: toNumber(tf.total_fetched),
          pages_fetched: toNumber(tf.pages_fetched),
          truncated: Boolean(tf.truncated),
          sampled: Boolean(tf.sampled),
          full_history: Boolean(tf.full_history),
        };
      })(),
      data_coverage: (() => {
        const dc = d.data_coverage && typeof d.data_coverage === "object" ? d.data_coverage : {};
        return {
          total_available_txs: dc.total_available_txs != null ? toNumber(dc.total_available_txs) : null,
          fetched_txs: toNumber(dc.fetched_txs),
          coverage_ratio: toNumber(dc.coverage_ratio),
          coverage_pct: toNumber(dc.coverage_pct),
          label: String(dc.label ?? ""),
          analysis_mode: dc.analysis_mode === "sampled" ? "sampled" : "full",
          interpretation_note: dc.interpretation_note != null ? String(dc.interpretation_note) : null,
        };
      })(),
    };
  }
  if (toolName === "compare_whales") {
    const wallets = Array.isArray(d.wallets)
      ? d.wallets.map((w) => (w != null && typeof w === "object" ? ensureObject(w) : {}))
      : [];
    return {
      wallets,
      ranking: Array.isArray(d.ranking) ? d.ranking.map((x) => String(x)) : [],
      best_for_copy_trading: d.best_for_copy_trading == null ? null : String(d.best_for_copy_trading),
      comparison_summary: String(d.comparison_summary ?? ""),
    };
  }
  if (toolName === "whale_risk_snapshot") {
    return {
      address: String(d.address ?? ""),
      ...(d.verdict != null && { verdict: String(d.verdict) }),
      ...(typeof d.confidence === "number" && !Number.isNaN(d.confidence) && { confidence: d.confidence }),
      risk_level: String(d.risk_level ?? "MEDIUM"),
      copy_trade_signal: String(d.copy_trade_signal ?? "NEUTRAL"),
      one_line_rationale: String(d.one_line_rationale ?? ""),
      agent_summary: String(d.agent_summary ?? ""),
    };
  }
  if (toolName === "detect_mev_bundles") {
    const best = d.best_bundle && typeof d.best_bundle === "object" ? d.best_bundle : null;
    return {
      block_number: d.block_number != null ? toNumber(d.block_number) : null,
      block_tx_count: toNumber(d.block_tx_count),
      bundle_confidence_score: d.bundle_confidence_score != null ? toNumber(d.bundle_confidence_score) : null,
      bundle_type: d.bundle_type != null ? String(d.bundle_type) : null,
      best_bundle: best,
      bundles: Array.isArray(d.bundles) ? d.bundles : [],
      error: d.error != null ? String(d.error) : null,
    };
  }
  return d;
}

export async function runDetectMevBundles(args = {}) {
  const blockNumber = typeof args.block_number === "number" ? args.block_number : null;
  const transactions = Array.isArray(args.transactions) ? args.transactions : null;
  const minConfidence = typeof args.min_confidence === "number" ? args.min_confidence : 0.35;
  let payload;
  if (blockNumber != null) {
    payload = await fetchBlockByNumber(blockNumber);
    if (!payload) {
      return {
        block_number: blockNumber,
        block_tx_count: 0,
        bundle_confidence_score: null,
        bundle_type: null,
        best_bundle: null,
        bundles: [],
        error: "Failed to fetch block or no transactions",
      };
    }
    payload.baseFeePerGas = payload.baseFeePerGas ?? 30;
  } else if (transactions && transactions.length > 0) {
    payload = { transactions, number: args.block_number ?? null, baseFeePerGas: 30 };
  } else {
    return {
      block_number: null,
      block_tx_count: 0,
      bundle_confidence_score: null,
      bundle_type: null,
      best_bundle: null,
      bundles: [],
      error: "Provide block_number or transactions array",
    };
  }
  const result = await analyzeBlock(payload, { minConfidence });
  const best = result.best;
  return {
    block_number: result.blockNumber ?? payload.number ?? null,
    block_tx_count: result.blockTxCount ?? 0,
    bundle_confidence_score: best?.bundle_confidence_score ?? null,
    bundle_type: best?.bundle_type ?? null,
    best_bundle: best ?? null,
    bundles: result.bundles ?? [],
    error: null,
  };
}

export async function runWhaleIntelReport(addr, limit = 2000) {
  const key = reportCacheKey(addr, limit);
  const cached = reportCache.get(key);
  if (cached && Date.now() - cached.ts < REPORT_CACHE_TTL_MS) return cached.data;
  const [txFetch, internalTxs, analyze, balance] = await Promise.all([
    fetchAllTransactions(addr, {
      maxTransactions: limit,
      pageSize: TX_PAGE_SIZE,
      statisticalSufficiency: STATISTICAL_SUFFICIENCY_DEFAULT,
      stopWhenSufficient: true,
    }),
    fetchInternalTransactions(addr),
    getApiUrl() ? fetchWhaleMindAnalyze(addr) : null,
    getApiUrl() ? fetchWhaleMindBalance(addr) : null,
  ]);
  const txs = txFetch.transactions;
  const txFetchSummary = txFetch.fetchSummary;
  const fetchedTxs = txs.length;
  const totalAvailableTxs = txFetchSummary.total_available_txs ?? fetchedTxs;
  const coverageRatio =
    totalAvailableTxs != null && totalAvailableTxs > 0 ? Math.min(1, fetchedTxs / totalAvailableTxs) : 1;
  const analysisMode = txFetchSummary.full_history ? "full" : "sampled";
  const dataCoverageLabel =
    totalAvailableTxs != null && totalAvailableTxs > fetchedTxs
      ? `Analyzed ${fetchedTxs.toLocaleString()} of ${totalAvailableTxs.toLocaleString()} transactions (${(coverageRatio * 100).toFixed(1)}% sample)`
      : analysisMode === "sampled"
        ? `Analyzed ${fetchedTxs.toLocaleString()} transactions (statistical sample; total unknown)`
        : `Analyzed ${fetchedTxs.toLocaleString()} transactions (full history)`;
  const coveragePct =
    totalAvailableTxs != null && totalAvailableTxs > 0
      ? Math.round(coverageRatio * 1000) / 10
      : analysisMode === "full"
        ? 100
        : 0;

  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);

  const features = extractFeatures(txs, internalTxs, addr);
  const funding = analyzeFundingSources(txs, internalTxs, addr);
  const coordination = detectCoordination(txs, internalTxs, addr);

  const clusterData = buildClusterData(addr, funding, coordination);
  const classification = classifyEntity(features, txs, funding, {
    cluster_size: clusterData.cluster_size,
    funding_source_count: Array.isArray(funding?.funders) ? funding.funders.length : 0,
    address: addr,
  });
  const confidenceResult = computeConfidence(features, classification, {
    total_txs: m.total_txs,
    coverage_ratio: coverageRatio,
    analysis_mode: analysisMode,
  });
  const riskProfile = computeRiskProfile(features, classification, {
    confidence_score: confidenceResult.confidence_score,
  });

  const fingerprint = await fingerprintWallet({
    features,
    classification,
    clusterData,
    txs,
    address: addr,
    coordination,
    recordToStore: true,
  });

  const entityType = classification.entity_type || "Unknown";
  const fetchNote =
    analysisMode === "sampled"
      ? ` (${dataCoverageLabel})`
      : txFetchSummary.full_history
        ? " (full history)"
        : "";
  const summary =
    `Whale ${addr.slice(0, 10)}…: ${entityType}. ${v || "on-chain"}. ${i.copy_trade_signal}. ` +
    (analyze?.summary ? analyze.summary.slice(0, 80) + "…" : `${m.total_txs} txs${fetchNote}, ${m.unique_counterparties} counterparties; confidence ${confidenceResult.confidence_score}.`);

  const out = {
    address: String(addr ?? ""),
    risk_level: String(i.risk_level ?? "MEDIUM"),
    copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
    total_txs: toNumber(m.total_txs),
    total_in_eth: toNumber(m.total_in_eth),
    total_out_eth: toNumber(m.total_out_eth),
    unique_counterparties: toNumber(m.unique_counterparties),
    agent_summary: String(summary ?? ""),
    balance_wei: toStringOrNull(balance),
    first_seen_iso: toStringOrNull(m.first_seen_iso),
    last_seen_iso: toStringOrNull(m.last_seen_iso),
    entity_type: String(entityType),
    confidence_score: toNumber(confidenceResult.confidence_score),
    confidence_reasons: Array.isArray(confidenceResult.confidence_reasons) ? confidenceResult.confidence_reasons : [],
    cluster_data: {
      cluster_id: clusterData.cluster_id,
      cluster_size: toNumber(clusterData.cluster_size),
      related_wallets: Array.isArray(clusterData.related_wallets) ? clusterData.related_wallets : [],
      cluster_confidence: toNumber(clusterData.cluster_confidence),
    },
    risk_profile: {
      market_impact_risk: { score: toNumber(riskProfile.market_impact_risk?.score), label: String(riskProfile.market_impact_risk?.label ?? "MEDIUM") },
      counterparty_risk: { score: toNumber(riskProfile.counterparty_risk?.score), label: String(riskProfile.counterparty_risk?.label ?? "MEDIUM") },
      behavioral_risk: { score: toNumber(riskProfile.behavioral_risk?.score), label: String(riskProfile.behavioral_risk?.label ?? "MEDIUM") },
    },
    feature_summary: ensureObject(features),
    entity_cluster: {
      cluster_id: clusterData.cluster_id,
      confidence: toNumber(clusterData.cluster_confidence),
      connected_wallets: Array.isArray(clusterData.related_wallets) ? clusterData.related_wallets : [],
      signals_used: [],
    },
    behavioral_profile: {
      type: String(entityType),
      confidence: toNumber(confidenceResult.confidence_score),
      reasoning: Array.isArray(confidenceResult.confidence_reasons) ? confidenceResult.confidence_reasons : [],
    },
    entity_fingerprint: {
      entity_type: String(fingerprint?.entity_type ?? "Unknown"),
      confidence_score: toNumber(fingerprint?.confidence_score),
      supporting_signals: Array.isArray(fingerprint?.supporting_signals) ? fingerprint.supporting_signals : [],
      entity_cluster_id: fingerprint?.entity_cluster_id != null ? String(fingerprint.entity_cluster_id) : null,
      scores: ensureObject(fingerprint?.scores),
    },
    tx_fetch_summary: {
      total_fetched: txFetchSummary.total_fetched,
      pages_fetched: txFetchSummary.pages_fetched,
      truncated: txFetchSummary.truncated,
      sampled: txFetchSummary.sampled,
      full_history: txFetchSummary.full_history,
    },
    data_coverage: {
      total_available_txs: totalAvailableTxs,
      fetched_txs: fetchedTxs,
      coverage_ratio: coverageRatio,
      coverage_pct: coveragePct,
      label: dataCoverageLabel,
      analysis_mode: analysisMode,
      interpretation_note:
        analysisMode === "sampled"
          ? "Behavioral metrics reflect observed patterns in sampled transactions only (e.g. observed sweep behavior, sample-based intensity). Not absolute claims about full history."
          : null,
    },
  };
  if (v != null) out.verdict = String(v);
  if (typeof c === "number" && !Number.isNaN(c)) out.confidence = c;
  const result = ensureObject(out);
  reportCache.set(key, { data: result, ts: Date.now() });
  return result;
}

export async function runCompareWhales(addrs) {
  const results = await Promise.all(
    addrs.map(async (a) => {
      const txs = await fetchTransactions(a, 50);
      const m = analyzeTransactions(txs, a);
      const an = getApiUrl() ? await fetchWhaleMindAnalyze(a) : null;
      const v = an?.verdict;
      const c = an?.confidence;
      const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
      return {
        address: String(a ?? ""),
        ...(v != null && { verdict: String(v) }),
        ...(typeof c === "number" && !Number.isNaN(c) && { confidence: c }),
        smart_money_score: toNumber(i.smart_money_score),
        copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
        total_txs: toNumber(m.total_txs),
      };
    })
  );
  const by = [...results].sort((a, b) => b.smart_money_score - a.smart_money_score);
  const best = by[0]?.copy_trade_signal === "STRONG_BUY" || by[0]?.copy_trade_signal === "BUY" ? by[0].address : null;
  const cmp = best
    ? `Best for copy-trading: ${best.slice(0, 10)}… (score ${by[0]?.smart_money_score}).`
    : `Ranked: ${by.map((w) => `${w.address.slice(0, 8)}…=${w.smart_money_score}`).join(", ")}.`;
  return ensureObject({
    wallets: results,
    ranking: by.map((w) => String(w.address)),
    best_for_copy_trading: best != null ? String(best) : null,
    comparison_summary: String(cmp),
  });
}

export async function runWhaleRiskSnapshot(addr) {
  const [txs, analyze] = await Promise.all([
    fetchTransactions(addr, 30),
    getApiUrl() ? fetchWhaleMindAnalyze(addr) : null,
  ]);
  const m = analyzeTransactions(txs, addr);
  const v = analyze?.verdict;
  const c = analyze?.confidence;
  const i = v != null ? fromVerdict(v, c) : fromMetrics(m);
  const ln = v ? `${i.copy_trade_signal}: ${v}, confidence ${Math.round((c || 0) * 100)}%.` : `${i.copy_trade_signal}: risk ${i.risk_level}, on-chain metrics.`;
  const out = {
    address: String(addr ?? ""),
    risk_level: String(i.risk_level ?? "MEDIUM"),
    copy_trade_signal: String(i.copy_trade_signal ?? "NEUTRAL"),
    one_line_rationale: String(ln ?? ""),
    agent_summary: String(`${i.copy_trade_signal}: ${addr.slice(0, 10)}… — ${ln}`),
  };
  if (v != null) out.verdict = String(v);
  if (typeof c === "number" && !Number.isNaN(c)) out.confidence = c;
  return ensureObject(out);
}

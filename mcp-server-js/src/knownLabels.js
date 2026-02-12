/**
 * Smart labeling — known addresses for classification accuracy.
 * CEX, bridges, canonical contracts, DEX routers. All lowercase for lookup.
 * Rule-based; no fabricated data.
 */

function toSet(list) {
  return new Set(list.map((a) => String(a).toLowerCase()));
}

/** Major CEX hot / custody wallets (heuristic list; production could use API) */
export const KNOWN_CEX = toSet([
  "0x28c6c06298d514db089934071355e5743bf21d60",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d",
  "0x56eddb7aa87536c09ccc2793473599fd21a8d17a",
  "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8",
  "0xf977814e90da44bfa03b6295a0616a897441acec",
  "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503",
  "0x876eabf441b2ee5b5b0554fd502a8e0600950cfa",
  "0x1151314c646ce4e0efd76d1af4760ae66a9fe30f",
  "0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2",
]);

/** Bridge / cross-chain contracts */
export const KNOWN_BRIDGES = toSet([
  "0xc098b2a3aa256d2140208c3de6543aaef5cd3a94",
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf",
  "0xa0c68c638235ee32657e8f720a23cec1bfc77c77",
]);

/** CEX + bridges combined (for "known CEX/bridge" interaction) */
export const KNOWN_CEX_AND_BRIDGES = new Set([...KNOWN_CEX, ...KNOWN_BRIDGES]);

/** WETH (Wrapped Ether) mainnet */
export const WETH_CONTRACT = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2".toLowerCase();

/** USDT (Tether) mainnet */
export const USDT_CONTRACT = "0xdac17f958d2ee523a2206206994597c13d831ec7".toLowerCase();

/** Top DEX routers (for DEX interaction ratio and MEV signals) */
export const KNOWN_DEX_ROUTERS = toSet([
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
  "0xe592427a0aece92de3edee1f18e0157c05861564",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff",
  "0x1111111254eeb25477b68fb85ed929f73a960582",
  "0x111111125421ca6dc452d289314280a0f8842a65",
]);

export function isCex(addr) {
  return addr && KNOWN_CEX.has(String(addr).toLowerCase());
}

export function isBridge(addr) {
  return addr && KNOWN_BRIDGES.has(String(addr).toLowerCase());
}

export function isCexOrBridge(addr) {
  return addr && KNOWN_CEX_AND_BRIDGES.has(String(addr).toLowerCase());
}

export function isDexRouter(addr) {
  return addr && KNOWN_DEX_ROUTERS.has(String(addr).toLowerCase());
}

export function isWeth(addr) {
  return addr && String(addr).toLowerCase() === WETH_CONTRACT;
}

export function isUsdt(addr) {
  return addr && String(addr).toLowerCase() === USDT_CONTRACT;
}

/** True if address is a known contract (DEX, CEX, bridge, WETH, USDT). Used to exclude from related_wallets. */
export function isKnownContract(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  return KNOWN_CEX_AND_BRIDGES.has(a) || KNOWN_DEX_ROUTERS.has(a) || a === WETH_CONTRACT || a === USDT_CONTRACT;
}

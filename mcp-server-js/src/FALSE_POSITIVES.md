# Where False Positives Can Still Occur

This document lists remaining sources of false positives in the Tier-S intelligence pipeline. Use it to tighten thresholds or add guardrails.

---

## 1. Known labels (`knownLabels.js`)

| Risk | Cause |
|------|--------|
| **CEX misattribution** | A single deposit/withdrawal from a listed CEX address triggers `known_cex_interaction`. That address may be deprecated, a contract that only resembles CEX, or a one-off user transfer → CEX score +0.3. |
| **DEX = MEV** | Any tx to a DEX router counts toward `dex_interaction_ratio`. Aggregators (1inch, 0x) are used by normal users and power users, not only MEV → MEV score can inflate. |
| **Bridge = institutional** | Interacting with a bridge is used as a Fund/CEX signal; retail users also use bridges. |

**Mitigation:** Stricter CEX rules (e.g. require multiple CEX counterparties or CEX volume share). Exclude aggregator-only usage from “MEV” or require same-block + gas spike together.

---

## 2. Classification engine (`classificationEngine.js`)

| Entity type | False positive scenario |
|-------------|--------------------------|
| **CEX Hot Wallet** | Thresholds are lower than the earlier “strict” spec: `totalTxs > 500`, `uniqueCp > 100`, `same_block_multi_tx_count >= 2`, `roundNumber >= 5`, plus one known CEX interaction. A power user or market maker can hit these without being a CEX. |
| **MEV Bot** | `same_block_multi_tx_count >= 2` (e.g. approve + swap in one block); `dex_interaction_ratio >= 0.3` (normal DeFi user); `highGas` (1.5× own median) can be congestion; `burst_activity_score >= 0.3` can be an active trader. Active DeFi users can be labeled MEV. |
| **Fund / Institutional Whale** | `max_single_tx >= 100 && totalTxs <= 100`: one large OTC or NFT sale. `walletAgeDays > 180 && avg_tx_per_day < 1`: dormant wallet gets Fund score. `low_dex_ratio` is true for many non-DeFi wallets. |
| **Individual Whale** | Any wallet with 10–500 txs and no other type ≥ 0.4 gets a fixed 0.5 “Individual Whale” score; many in that range are not whales (e.g. bots, small traders). |

**Mitigation:** Reintroduce strict CEX gates (e.g. >1000 txs, >200 counterparties, >5000 ETH volume, >6 months). Require MEV to satisfy multiple signals (e.g. same-block + DEX dominance + gas spike). Raise Fund thresholds or require custody + low DEX together.

---

## 3. Clustering (`clustering.js`)

| Risk | Cause |
|------|--------|
| **Solo wallet has cluster** | `has_funding_sources` is true for any wallet that ever received from another address → `cluster_id` and `cluster_confidence` can be non-null for a single wallet. |
| **Contracts as “related”** | `connectedWallets` comes from internal txs (from/to this address). Contract creates or proxy calls add contract addresses; they are not necessarily the same entity. |
| **Temporal burst ≠ cluster** | `temporal_burst`: 3+ txs within 10 minutes. Can be one user doing several actions (e.g. approve, swap, transfer), not coordinated multi-wallet behavior. |

**Mitigation:** Only assign `cluster_id` when `connectedWallets.length >= 1` (or higher). Optionally exclude contract addresses from `related_wallets`. Treat temporal_burst as weak evidence unless combined with shared funding.

---

## 4. Risk scoring (`riskScoring.js`)

| Risk | Cause |
|------|--------|
| **Behavioral risk follows bad label** | If classification wrongly labels “MEV Bot”, `behavioral_risk` is set to 0.75 (HIGH). A misclassification is reinforced in the risk profile. |
| **Counterparty risk for focused wallets** | `uniqueCp < 5` → counterparty_risk 0.7. New or intentionally focused wallets (e.g. one DEX, one CEX) get HIGH counterparty risk even when by design. |

**Mitigation:** Cap behavioral_risk by confidence_score or require multiple MEV signals before applying the MEV risk bump. Soften counterparty_risk for wallets with moderate volume or age.

---

## 5. Confidence engine (`confidenceEngine.js`)

| Risk | Cause |
|------|--------|
| **“Strong signals” with weak evidence** | “Strong X signals detected” is added when `signals_used.length >= 2`. Two weak signals (e.g. round_number_transfers + batched_withdrawals at low thresholds) can still produce this message and higher confidence. |
| **Signal strength from low score** | `signal_strength = entity_score * 1.2`; at entity_score 0.5 we get 0.6. A wrong or borderline label can still yield non-trivial confidence. |

**Mitigation:** Require a minimum entity_score (e.g. 0.6) before adding “Strong X signals detected”. Cap confidence when entity_type is Unknown or entity_score is below a threshold.

---

## 6. Feature extraction (`featureExtraction.js`)

| Risk | Cause |
|------|--------|
| **Round-number transfers** | Any value within 0.001 ETH of an integer counts as round (e.g. 1.0, 2.0, 10.0). Many users send round numbers; not specific to CEX. |
| **Burst score** | `burst_activity_score` increases with number of txs in short windows; a few busy sessions can push it up and feed MEV scoring. |
| **Same-block multi-tx** | Any 2+ txs in the same block (e.g. approve + swap) count. Common for normal users; not uniquely MEV. |

**Mitigation:** Stricter round-number definition (e.g. “round” only for larger round amounts or more occurrences). Require same-block count ≥ 3 or combine with DEX dominance for MEV. Use burst score only in combination with other MEV signals.

---

## 7. Coordination detection (`intelligence.js` – `detectCoordination`)

| Risk | Cause |
|------|--------|
| **Small repeated counterparties** | `uniqueOut <= 5 && totalOut >= 3` → `small_repeated_counterparties`. A user with 3–5 main counterparties (e.g. one DEX, one CEX, one bridge) is flagged as cluster-like. |

**Mitigation:** Tighten to `uniqueOut <= 3` or require a minimum number of txs (e.g. totalOut >= 10) so casual users are not clustered.

---

## Summary

- **Entity type:** CEX/MEV/Fund/Individual can still fire on power users, DeFi users, or dormant wallets due to per-signal thresholds and no strict CEX gates.
- **Clustering:** Single wallets can get a cluster_id; internal-tx “related” addresses can be contracts; temporal burst is not proof of multi-entity coordination.
- **Risk:** Behavioral risk inherits classification errors; counterparty risk over-penalizes focused or new wallets.
- **Confidence:** Can be overstated when only a few weak signals exist or when entity_score is at the 0.5 boundary.
- **Labels:** One interaction with a known CEX/DEX/bridge address drives signals; lists can be outdated or too broad.

Prefer **Unknown** and lower confidence when in doubt; tighten thresholds and require multiple concurring signals for high-impact labels (CEX, MEV).

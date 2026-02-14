# MCP Zero-Shot Success Checklist

Use this checklist to keep agent usability high and retries low.

## 1. Tool Description Clarity
- [ ] Each tool has **one** clear purpose in the first sentence.
- [ ] Description states **when to use** (e.g. "Use when the user asks to analyze a single wallet").
- [ ] Description states **what the tool does NOT do** (e.g. "Does NOT compare wallets").
- [ ] 1–2 **example inputs** are included in the description or schema.

## 2. inputSchema Hardening
- [ ] **Required** fields are explicit; no ambiguous optional params that change behavior.
- [ ] **Types** are strict: `integer` for counts/block numbers, `string` for addresses.
- [ ] **Addresses** use `pattern: "^0x[a-fA-F0-9]{40}$"` and description mentions "0x + 40 hex characters".
- [ ] **Numeric bounds**: `minimum`/`maximum` for limit, block_number, min_confidence.
- [ ] **additionalProperties: false** to reject unknown keys and avoid agent confusion.
- [ ] **Examples** in schema for each required/commonly used field.

## 3. Output Consistency
- [ ] Every success response is **coerced** with `coerceToOutputSchema(toolName, data)`.
- [ ] Every **error** response uses the same tool's schema (via `errorResult(toolName, msg)` and coercion).
- [ ] **Deterministic** field names; no dynamic keys that change shape.
- [ ] **Same JSON shape** for a given tool every time (including errors).

## 4. Error Handling
- [ ] **validateToolInput(toolName, args)** runs before any tool execution.
- [ ] Errors are **explicit**: e.g. "Invalid address: must be 0x + 40 hex characters".
- [ ] Errors include an **actionable hint**: e.g. "Example: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".
- [ ] **No silent failures**: timeouts and exceptions return a clear message and structured error body.
- [ ] Unknown tool returns a message listing **valid tool names** so the agent can correct.

## 5. Performance
- [ ] **Response cache** for expensive tools (e.g. whale_intel_report by address+limit, TTL 60s).
- [ ] **No repeated on-chain calls** for the same (address, limit) within TTL.
- [ ] Validation is **sync** and fast before any async work.
- [ ] Cache key is **deterministic** (e.g. lowercase address + limit).

## 6. Retry Loop Prevention
- [ ] Tool **scope** is narrow: one purpose per tool so the agent doesn't guess.
- [ ] **Schema** is unambiguous: required vs optional and patterns are clear.
- [ ] **Default** tool for unknown `name` returns a valid schema (e.g. whale_intel_report) so clients don't break.
- [ ] **Limit** and **block_number** types are integers so agents don't send strings.

## Quick Reference: Valid Tools
- `whale_intel_report` — Full report for **one** wallet (address required, limit optional).
- `compare_whales` — Compare **2–5** wallets (addresses array required).
- `whale_risk_snapshot` — Quick risk/signal for **one** wallet (address required).
- `detect_mev_bundles` — MEV bundles in **one** block (block_number **or** transactions required).

## Address Format (all tools that take address)
- Must match: `0x` + exactly 40 hexadecimal characters.
- Regex: `^0x[a-fA-F0-9]{40}$`.
- No spaces; checksum optional.

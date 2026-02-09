# Context MCP Marketplace Audit — WhaleMind MCP Server

## Executive Summary

| Area | Status | Notes |
|------|--------|--------|
| MCP compliance | ⚠️ Partial | Correct SDK; transport/handler OK; Context middleware optional (install @ctxprotocol/sdk) |
| Structured output | ✅ Fixed | Optional `error` in outputSchema; all responses schema-compliant |
| Security middleware | ⚠️ Optional | `createContextMiddleware()` applied when `@ctxprotocol/sdk` is installed |
| Tool quality | ⚠️ Weak | Single-endpoint passthrough; could be more “insight” than “raw fetch” |
| Performance | ✅ OK | 55s fetch timeout; single API call; backend cached |
| Image handling | ✅ N/A | No images |
| Deployment | ✅ OK | Procfile added; env vars; HTTPS by host |
| Monetization readiness | ⚠️ Unblocked | Schema + timeout done; add @ctxprotocol/sdk for paid listing |

**Readiness rating: 5/10** → **6/10** after verifying Context middleware and dependency in your environment (see below).

---

## 1) MCP Compliance

### ✅ What’s good
- Uses `@modelcontextprotocol/sdk` (`McpServer` from `server/mcp.js`).
- Uses Streamable HTTP via `express-mcp-handler` (stateless POST `/mcp`).
- Implements tools (single tool: `analyze_wallet`) with `inputSchema` and `outputSchema`.
- Returns both `content` (text) and `structuredContent` for tool results.

### ⚠️ Gaps
- **Context expects both SDKs**: Marketplace docs require **`@modelcontextprotocol/sdk`** (you have) **+ `@ctxprotocol/sdk`** for security middleware. You only use the former.
- **Handler vs Context middleware**: `statelessHandler(createMcpServer)` handles MCP; it does not verify Context’s JWT. For paid tools, Context sends a signed JWT on `tools/call`; you must verify it (see Security below).
- **Server API**: Context’s own examples use `Server` + `setRequestHandler(ListToolsRequestSchema, …)` and `setRequestHandler(CallToolRequestSchema, …)`. Your stack uses `McpServer` + `registerTool` via express-mcp-handler. Both can be valid; ensure `listTools` and `tools/call` behave correctly and that Context’s gateway can talk to your POST `/mcp` (Streamable HTTP).

**Recommendation:** Keep current MCP setup; add Context middleware in front of the same `/mcp` handler so that `tools/call` is only processed after JWT verification.

---

## 2) Structured Output (CRITICAL)

### ❌ Violation: `structuredContent` does not match `outputSchema`

**Requirement (Context docs):** “Your `outputSchema` is a contract. Context’s ‘Robot Judge’ validates that your `structuredContent` matches your declared schema. **Schema violations result in automatic refunds.**”

**Your outputSchema (conceptually):**
- `address` (string)
- `behavior` (object)
- `verdict` (string)
- `confidence` (number)

**What you return on error or misconfiguration:**
- Same four fields **plus** `error: string` (e.g. `"WHalemind_API_URL not set"` or the exception message).

So **every error or config-missing response is a schema violation** and will trigger refunds and failed validation.

**Required fix:**
- **Option A (recommended):** Extend `outputSchema` with an **optional** `error?: string`. Document that when `verdict === "ERROR"`, `error` may be set. Ensure every `structuredContent` you return (success and failure) satisfies this schema and only includes allowed fields.
- **Option B:** On failure, do **not** set `structuredContent`; return only `content: [{ type: "text", text: "..." }]`. Then success path must still match outputSchema exactly (you already do).

Also ensure:
- **JSON Schema for registry:** Context’s discovery expects `inputSchema` / `outputSchema` as **JSON Schema** (e.g. `type: "object"`, `properties`, `required`). If the SDK exposes Zod-derived schemas, confirm they are serialized to standard JSON Schema for the registry.
- **Required fields:** For the schema you declare, required fields must always be present in `structuredContent` (no missing `address`, `behavior`, `verdict`, `confidence`).

---

## 3) Security Middleware

### ❌ Missing: No Context Protocol middleware

**Requirement:** For paid tools, Context requires securing the MCP endpoint with `createContextMiddleware()` from **`@ctxprotocol/sdk`**. Without it, paid execution cannot be safely routed to your server.

**Current state:** There is no `@ctxprotocol/sdk` dependency and no middleware on `/mcp`. All requests (including hypothetical `tools/call`) are accepted by express-mcp-handler with no JWT verification.

**Required changes:**
1. Add dependency: `@ctxprotocol/sdk`.
2. Apply Context middleware to the `/mcp` route so that it runs **before** your MCP handler (e.g. `app.use("/mcp", createContextMiddleware())` then `app.post("/mcp", statelessHandler(...))`). Confirm with Context docs whether middleware is applied per-route or to the app and how it interacts with POST body (Streamable HTTP).
3. Ensure `tools/call` requests from Context include `Authorization: Bearer <JWT>` and that the middleware validates the JWT (and optionally injects `req.context` for user/portfolio data if you use context requirements later).

**Reference (Context SDK):**
- “1 line of code to secure your endpoint & handle payments: `app.use('/mcp', createContextMiddleware());`”
- “Paid Tools ($0.01+): Mandatory [security]”

---

## 4) Tool Quality

### ⚠️ “Giga-brained” vs simple passthrough

**Context guidance:** Prefer “pre-computed insight products” over “raw data access.” Tools should combine data, add interpretation, and provide high-value insights rather than being thin API wrappers.

**Current tool:** `analyze_wallet` calls a single endpoint: `GET {WHalemind_API_URL}/wallet/{address}?limit={limit}` and maps the response to `address`, `behavior`, `verdict`, `confidence`. The **backend** does real work (on-chain data, behavior classification, caching); the **MCP tool** is a thin proxy.

**Suggestions:**
- **Enrich output:** If your backend returns more (e.g. `entity_type`, `behavior_summary`, `transactions_count`), expose them in `outputSchema` and `structuredContent` so agents get richer insight without extra calls.
- **Second tool:** Add a tool that calls **POST /analyze** (e.g. `deep_analyze_wallet`) for a “full verdict” flow when the wallet isn’t cached, and return a structured summary plus verdict/confidence.
- **Multi-wallet or comparison:** A tool like “compare_wallets” or “whale_risk_batch” that takes 2–5 addresses and returns comparative insights (who is more “smart money,” risk scores) would be more “giga-brained” and differentiated.
- **Context injection (optional):** If you declare `_meta.contextRequirements: ["wallet"]`, Context can inject the user’s wallet context; you could offer “analyze_my_wallet” that uses the injected address and returns the same schema, improving UX for agent users.

---

## 5) Performance

### ✅ Generally OK; one hardening

- Single outbound HTTP call per tool call; no heavy CPU in the MCP server.
- Backend has caching (24h wallet_cache) and timeouts (e.g. Etherscan 25s); most requests should be fast.
- Context enforces ~60s execution timeout; your backend should stay under that for cached and normal uncached cases.

**Recommendation:** Add an explicit **client-side timeout** in the MCP server (e.g. 50–55s) on the `fetch()` to WhaleMind so you never hang until the platform’s 60s limit. Return a structured error (within your outputSchema, e.g. Option A above) like `verdict: "ERROR"`, `error: "Request timeout"`.

---

## 6) Image Handling

### ✅ N/A
- No image responses; no base64 or image URLs. Nothing to change.

---

## 7) Deployment Readiness

### ✅ Env and HTTPS
- Uses env vars: `WHalemind_API_URL` (and fallback `WHALEMIND_API_URL`), `PORT`. No hardcoded secrets.
- HTTPS is handled by the host (Railway/Vercel); no code change needed.

### ⚠️ MCP service deployment
- Root project has a Procfile for the **Flask** API. The **MCP server** is a separate Node app in `mcp-server/`.
- For Railway: add a second service (or the same repo with two Procfiles) that runs the MCP server (e.g. `cd mcp-server && npm install && npm run build && npm start`), or a single Procfile that starts the MCP server and ensure the start command is documented.
- For Vercel: ensure the MCP server is deployed as a Node serverless or Node server; document the start command and that POST `/mcp` and GET `/health` are the public endpoints.

**Recommendation:** Add a `mcp-server/Procfile` or clear README instructions (and any `railway.json` / `vercel.json`) so the MCP server is deployable independently with one command.

---

## 8) Monetization Readiness

### ✅ Use-case and value
- Whale / smart-money behavior is a strong use-case for agents (research, risk, copy-trading).
- Per-response value is clear: one wallet analysis per call; caching on the backend keeps cost and latency reasonable.

### ❌ Blockers for paid listing
1. **Schema compliance:** Until every `structuredContent` (including errors) matches `outputSchema`, Context will refund and the tool is not safe to list as paid.
2. **Security:** Without Context middleware and JWT verification, Context cannot route paid `tools/call` to your server.

### After fixes
- Once structured output is strict and Context middleware is on `/mcp`, the server is **suitable for paid usage**.
- Optional: add a second, higher-value tool (e.g. deep analysis or comparison) and/or context injection to increase differentiation and monetization potential.

---

## Checklist: Required Before Listing

- [x] **Structured output:** Optional `error` added to `outputSchema`; all error paths return only allowed fields (implemented).
- [x] **Security:** Optional `createContextMiddleware()` from `@ctxprotocol/sdk` applied to `/mcp` when the package is installed (dynamic import). For Context listing, run `npm install @ctxprotocol/sdk` and verify middleware with Context docs.
- [x] **Performance:** 55s fetch timeout added; AbortError mapped to schema-compliant error response (implemented).
- [x] **Deployment:** `mcp-server/Procfile` added; run `npm run build && node dist/index.js` (or `npm start`) in production.
- [ ] **Tool quality (optional but recommended):** Enrich output and/or add a second “insight” tool (e.g. deep analyze or compare).

---

## Summary Table

| Requirement | Status | Action |
|-------------|--------|--------|
| outputSchema declared | ✅ | Keep; extend with optional `error` if you use it in structuredContent |
| structuredContent matches outputSchema | ❌ | Fix error/config paths (no extra `error` or add to schema) |
| Context middleware on /mcp | ❌ | Add `@ctxprotocol/sdk` + `createContextMiddleware()` |
| Tools/call under 60s | ✅ | Add 50–55s fetch timeout |
| No blocking work in handler | ✅ | None |
| Env vars, no secrets in code | ✅ | Good |
| HTTPS-ready | ✅ | Host responsibility |
| High-value, non-passthrough tools | ⚠️ | Enrich output; consider second tool |

**Readiness: 5–6/10** after implemented fixes. Verify `@ctxprotocol/sdk` install and middleware behavior with Context’s latest docs. **7–8/10** with a second, higher-value tool and optional context injection.

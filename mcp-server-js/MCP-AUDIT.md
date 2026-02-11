# MCP Server Audit & Fixes

## Issues Found

### 1. MCP Protocol
- **Batch initialize**: `isInitializeRequest(req.body)` failed for batch requests (array). Fixed with `isInitRequest()` that checks both single and batch.
- **Body passed to transport**: `req.body` could be undefined for empty POST; now using `body ?? {}` and passing explicitly.

### 2. Session Handling
- **Session lifecycle logging**: Added `[MCP] Session initialized` and `[MCP] Session closed` logs.
- **Transport cleanup**: `onclose` already removes from map; verified correct.

### 3. Error Handling
- **JSON parse errors**: Added global error handler for `SyntaxError`; returns JSON-RPC 2.0 parse error (code -32700).
- **Unhandled errors**: Returns JSON-RPC 2.0 internal error (code -32603).

### 4. Express
- **express.json limit**: Added `{ limit: "1mb" }` to prevent abuse.
- **Root route**: Added `GET /` redirect to `/health` for Railway health check flexibility.

### 5. Tool Compliance
- **structuredContent**: All tools return `content` + `structuredContent`; schema-compliant.
- **Error responses**: Error results include `structuredContent` matching `outputSchema`.

### 6. Docker
- **package-lock.json**: Required for `npm ci`. Ensure it exists before build.
- **.dockerignore**: Excludes `node_modules`, `.env`, `.git`; correct.

---

## Deployment Notes

### Railway
1. Set **Root Directory** = `mcp-server-js`
2. Set **Start Command** = `node server.js` (or use `railway.toml`)
3. **Health Check Path** = `/health`
4. **Environment**: `PORT` auto-set. Add `ETHERSCAN_API_KEY`, `WHALEMIND_API_URL` if needed.

### Docker
```bash
docker build -t whalemind-mcp .
docker run -p 3000:3000 -e PORT=3000 whalemind-mcp
```

### Local
```bash
npm install
npm start
```

---

## MCP Test Curl Examples

Replace `BASE_URL` with your deployed URL (e.g. `https://your-app.railway.app`) or `http://localhost:3000`.

### 1. Health (no MCP)
```bash
curl -s -X GET "$BASE_URL/health"
# Expected: {"status":"ok"}
```

### 2. Initialize (creates session)
```bash
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```
**Save the `mcp-session-id` from response headers** for subsequent requests.

### 3. Tools List (requires session)
```bash
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: YOUR_SESSION_ID_FROM_STEP_2" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### 4. Tools Call (requires session + Context JWT)
`tools/call` requires a valid JWT from the Context Platform. Plain curl will return `{"error":"Unauthorized"}`.

**Options:**
- **Local dev:** Set `SKIP_CONTEXT_AUTH=true` in `.env` to bypass auth (dev only!)
- **Production:** Test through [ctxprotocol.com](https://ctxprotocol.com) or the Context app

```bash
# With SKIP_CONTEXT_AUTH=true (local only):
curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: YOUR_SESSION_ID_FROM_STEP_2" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whale_risk_snapshot","arguments":{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}}}'
```

### 5. GET /mcp (info only)
```bash
curl -s -X GET "$BASE_URL/mcp"
# Expected: MCP endpoint — use POST
```

---

## Context Marketplace Notes

- **New/updated tools not appearing?** Go to ctxprotocol.com/developer/tools → My Tools → **Refresh Skills**
- **Unauthorized on tools/call?** Context requires a valid JWT. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

## Production Best Practices

1. **Always send `Accept: application/json, text/event-stream`** for MCP requests (MCP spec).
2. **Session order**: Initialize first, then tools/list and tools/call with `mcp-session-id`.
3. **Never set SKIP_CONTEXT_AUTH** in production — enables unpaid tool execution.
4. **Rate limiting**: Add `express-rate-limit` for production.
5. **Logging**: Use structured logs (e.g. Pino) in production.
6. **CORS**: Add CORS if needed for web clients.
7. **Timeout**: Tool calls already have 10s timeout on external APIs.
8. **package-lock.json**: Commit it; required for reproducible builds.

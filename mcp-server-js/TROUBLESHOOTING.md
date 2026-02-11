# Troubleshooting — Context Marketplace MCP Server

Common errors and solutions when building MCP servers for the Context Marketplace.

---

## Common Errors

### `{"error":"Unauthorized"}`

This is the most common error for new tool builders.

The `createContextMiddleware()` from `@ctxprotocol/sdk` verifies that requests come from the Context Platform with a valid JWT. Without this JWT, any call to `tools/call` will return `{"error":"Unauthorized"}`.

#### Why This Happens

| Cause | Explanation |
|-------|-------------|
| Missing JWT on tools/call | The middleware requires a JWT from the Context Platform for execution methods. |
| HTTP instead of HTTPS | Context Platform only connects to HTTPS endpoints. HTTP will silently fail. |
| Not registered on marketplace | Until you register at [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute), the platform won’t send requests to your server. |
| Wrong endpoint URL | The URL you registered doesn’t match your deployed server. |

---

## What You CAN Test Locally (No Auth Required)

These MCP methods work without authentication:

```bash
# Initialize session (no auth required)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'

# List tools (no auth required)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: YOUR-SESSION-ID-FROM-INITIALIZE" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

**Save the `mcp-session-id` from the initialize response headers** for the tools/list request.

---

## Testing tools/call Locally

The `tools/call` method requires a valid JWT from the Context Platform. Options for testing:

1. **Use SKIP_CONTEXT_AUTH (dev only)** — Set `SKIP_CONTEXT_AUTH=true` in `.env` to bypass JWT verification:
   ```bash
   SKIP_CONTEXT_AUTH=true npm start
   ```
   **Never use in production!** Without the middleware, anyone can call your tools for free.

2. **Test tool logic directly** — Write test files that call your tool handler functions directly, bypassing the MCP transport.

3. **Test on deployed server** — Deploy to HTTPS and test through the Context app.

---

## End-to-End Testing

For full end-to-end testing through the Context Platform:

1. Deploy to HTTPS — Use Railway, Vercel, or set up Caddy/nginx
2. Register on marketplace — Go to [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute)
3. Test through the Context app — Ask the agent to use your tool

---

## Tool Not Discovered

Your server is deployed but Context can’t find your tools.

### Checklist

- [ ] Health endpoint returns 200: `curl https://your-server.com/health`
- [ ] `initialize` works (see curl above)
- [ ] `tools/list` returns your tools (see curl above)
- [ ] URL is HTTPS (not HTTP)
- [ ] URL ends with `/mcp` (e.g. `https://your-server.com/mcp`)
- [ ] Tools have `outputSchema` defined (required by Context)

---

## New/Updated Tools Not Appearing

You deployed new endpoints but they’re not showing up in the marketplace.

### Solution

1. Go to [ctxprotocol.com/developer/tools](https://ctxprotocol.com/developer/tools) → **Developer Tools** → **My Tools**
2. Find your tool and click **Refresh Skills**
3. Context will re-call `listTools()` to discover your changes

### Also Consider

- Update your description if you added significant new functionality
- Verify deployment — check health endpoint, test `tools/list` via curl

---

## Server Won’t Start

### Node.js Version

```bash
node --version  # Must be 18+
```

### Missing Dependencies

```bash
npm install
```

### Module System

Ensure `package.json` has:

```json
{
  "type": "module"
}
```

### Railway Deployment Fails

- Check Railway logs for specific errors
- Ensure `package.json` has `"type": "module"`
- Set start command to: `node server.js`
- Verify health check path: `/health`

---

## Response Schema Validation Fails

If your tool responses don’t match your `outputSchema`, users can dispute them.

### Common Causes

```javascript
// ❌ Schema says number, response is string
outputSchema: { value: { type: "number" } }
structuredContent: { value: "42" }  // String, not number!

// ✅ Correct: Types match
outputSchema: { value: { type: "number" } }
structuredContent: { value: 42 }  // Number
```

### Solution

- Ensure all `structuredContent` fields match your `outputSchema` types exactly
- This server uses `filterToSchema()` to enforce schema compliance
- Test your responses before deploying

---

## MCP Security Model Reference

| MCP Method | Auth Required | Why |
|------------|---------------|-----|
| `initialize` | ❌ No | Session setup |
| `tools/list` | ❌ No | Discovery — agents need to see your schemas |
| `resources/list` | ❌ No | Discovery |
| `prompts/list` | ❌ No | Discovery |
| `tools/call` | ✅ Yes | Execution — costs money, runs your code |

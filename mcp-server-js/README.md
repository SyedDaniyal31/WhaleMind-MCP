# WhaleMind MCP Server

A standard MCP server that provides whale and smart-money intelligence for Ethereum wallets. This example follows the [Context Protocol SDK Blocknative pattern](https://github.com/ctxprotocol/sdk/tree/main/examples/server/blocknative-contributor).

> **Security**: Secured with Context Protocol request verification (`createContextMiddleware` from `@ctxprotocol/sdk`). Discovery (e.g. `tools/list`) is open; execution (`tools/call`) is protected.

## What Makes This Context Protocol Compliant?

Context requires `outputSchema` and `structuredContent` from the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema) for payment verification and dispute resolution.

1. **`outputSchema`** in tool definitions — Defines the structure of response data (JSON Schema in tool definitions).
2. **`structuredContent`** in responses — Machine-readable data that exactly matches the outputSchema (types must match: e.g. `number` not `"42"` to avoid disputes).

All responses are passed through `coerceToOutputSchema(toolName, data)` so numeric and string types always match the schema. Test responses against your schema before deploying.

```javascript
// Every tool returns (required by Context)
return {
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent: coerceToOutputSchema(toolName, data),  // types match outputSchema
};
```

## Features

- **Tools**:
  - `whale_intel_report`: Deep intelligence report for one Ethereum wallet. Returns risk level, copy-trade signal, transaction metrics, balance, and agent summary. Use for due diligence or “should I copy this whale?” decisions.
  - `compare_whales`: Compare 2–5 wallets and rank by smart-money score. Returns ranking, best_for_copy_trading, and comparison summary.
  - `whale_risk_snapshot`: Quick risk and copy-trade signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, and agent_summary.
- **Transport**: Streamable HTTP at `/mcp` (same as [Blocknative example](https://github.com/ctxprotocol/sdk/tree/main/examples/server/blocknative-contributor)). Compatible with Context, Claude, and other MCP clients.
- **Context middleware**: Uses `createContextMiddleware()` from `@ctxprotocol/sdk` on the `/mcp` route.
- **Optional API Keys**: Etherscan (optional, for rate limits); WhaleMind API URL (optional, for verdict/confidence and balance).

## Prerequisites

- **Node.js**: Version 20 or later
- **Etherscan API Key** (optional): For higher rate limits. Get one at [Etherscan](https://etherscan.io/apis).
- **WhaleMind API URL** (optional): When set, tools use your WhaleMind API for verdict, confidence, and balance.

## Installation

1. **Clone the repository** (or use the `mcp-server-js` folder):

   ```bash
   cd mcp-server-js
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Set environment variables** (optional):

   ```bash
   cp .env.example .env
   # Edit .env: ETHERSCAN_API_KEY, WHALEMIND_API_URL (optional)
   ```

## Usage

The server provides three tools, accessible via the MCP Streamable HTTP transport. You can run it locally, deploy to Railway, or register with Context Protocol.

### Running the server

1. **Development (with file watch)**:

   ```bash
   npm run dev
   ```

2. **Production**:

   ```bash
   npm start
   ```

   Server listens on `http://0.0.0.0:3000`. Health: `GET /health`. MCP: `POST /mcp`.

3. **Deploy to Railway** (Context / production):

   - New Project → Deploy from GitHub → select repo.
   - Set **Root Directory** to `mcp-server-js`.
   - Variables: `ETHERSCAN_API_KEY`, `WHALEMIND_API_URL` (optional).
   - MCP URL: `https://your-app.up.railway.app/mcp`

   See [REBUILD.md](./REBUILD.md) for deployment details.

### Tools

- **`whale_intel_report(address: string, limit?: number)`**  
  Full report for one wallet. Returns verdict (if WhaleMind API set), risk_level, copy_trade_signal, total_txs, total_in_eth, total_out_eth, unique_counterparties, balance_wei, agent_summary, and optional timestamps.

- **`compare_whales(addresses: string[])`**  
  Compare 2–5 addresses. Returns wallets (with verdict, smart_money_score, copy_trade_signal, total_txs), ranking, best_for_copy_trading, and comparison_summary.

- **`whale_risk_snapshot(address: string)`**  
  Quick signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, and agent_summary.

### Test tools/list (PowerShell)

```powershell
Invoke-RestMethod -Uri http://localhost:3000/mcp -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Project structure (v2 rebuild)

```
mcp-server-js/
├── src/
│   ├── server.js       # Express app, routes, CORS
│   ├── tools.js        # Tool definitions + execution
│   ├── mcpHandler.js   # MCP Server, transport, sessions
│   └── middleware/
│       └── auth.js     # Context JWT middleware
├── .env.example
├── package.json
├── Dockerfile
├── Procfile
├── railway.toml
└── README.md
```

See [REBUILD.md](./REBUILD.md) for full rebuild notes, root cause analysis, and curl tests.

## License

Same license as the parent WhaleMind MCP project.

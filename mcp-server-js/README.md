# WhaleMind MCP Server

An MCP server that provides whale and smart-money intelligence for Ethereum wallets, powered by Etherscan and an optional WhaleMind API. Context Protocol and Blocknative-style compliant.

![Node Version](https://img.shields.io/badge/node-18+-green)
![Status](https://img.shields.io/badge/status-active-brightgreen.svg)

## Features

- **Tools**:
  - `whale_intel_report`: Deep intelligence report for one Ethereum wallet. Returns risk level, copy-trade signal, transaction metrics, balance, and agent summary. Use for due diligence or “should I copy this whale?” decisions.
  - `compare_whales`: Compare 2–5 wallets and rank by smart-money score. Returns ranking, best_for_copy_trading, and comparison summary.
  - `whale_risk_snapshot`: Quick risk and copy-trade signal for one wallet. Returns risk_level, copy_trade_signal, one_line_rationale, and agent_summary.
- **Transport**: Streamable HTTP at `/mcp` (GET = info, POST = JSON-RPC). Compatible with Context Protocol, Claude, and other MCP clients.
- **Optional API Keys**: Works with Etherscan (optional key for higher rate limits) and optional WhaleMind API URL for verdict/confidence and balance.

## Prerequisites

- **Node.js**: Version 18 or later
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

   Server listens on `http://0.0.0.0:3000`. Health check: `GET /health` → `OK`. MCP endpoint: `POST /mcp`.

3. **Deploy to Railway** (Context / production):

   - New Project → Deploy from GitHub → select repo.
   - Set **Root Directory** to `mcp-server-js`.
   - Variables: `ETHERSCAN_API_KEY`, `WHALEMIND_API_URL` (optional).
   - MCP URL: `https://your-app.up.railway.app/mcp`

   See [RAILWAY-DEPLOY.md](./RAILWAY-DEPLOY.md) for step-by-step.

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

## Project structure (Blocknative-style)

```
mcp-server-js/
├── src/
│   ├── server.js      # MCP server + Express app
│   └── loadEnv.js     # Optional .env loading (dev only)
├── .env.example
├── package.json
├── Dockerfile
├── Procfile
├── railway.toml
└── README.md
```

## License

Same license as the parent WhaleMind MCP project.

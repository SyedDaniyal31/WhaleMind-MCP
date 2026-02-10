# WhaleMind MCP Server (Node.js)

Giga-brained MCP tools for whale/smart-money intelligence. Combines Etherscan + optional WhaleMind API, adds risk/copy-trade signals and multi-wallet comparison. Context marketplace–compatible.

## Endpoints

| Method | Path    | Description |
|--------|---------|-------------|
| GET    | /health | Health check (+ tool list) |
| POST   | /mcp    | MCP JSON-RPC (initialize, tools/list, tools/call) |

## Tools (marketplace-competitive)

### 1. `whale_intel_report`
**Deep due-diligence for one wallet.**  
- **Input:** `address`, `limit` (optional, default 50)  
- **Behavior:** Fetches Etherscan txs; optionally calls WhaleMind POST /analyze and GET /wallet/balance when `WHALEMIND_API_URL` is set.  
- **Output:** `verdict`, `confidence`, `entity_type`, `summary` (if API set), `risk_level`, `copy_trade_signal`, `total_txs`, `total_in_eth`, `total_out_eth`, `unique_counterparties`, `balance_wei`, `agent_summary`, timestamps.  
- **Use when:** Full report or “should I copy this whale?” with balance.

### 2. `compare_whales`
**Compare 2–5 wallets, rank by smart-money score.**  
- **Input:** `addresses` (array of 2–5 Ethereum addresses)  
- **Output:** `wallets` (with verdict, smart_money_score, copy_trade_signal, total_txs), `ranking`, `best_for_copy_trading`, `comparison_summary`.  
- **Use when:** User wants to choose the best whale to copy or compare several addresses.

### 3. `whale_risk_snapshot`
**Quick copy-trade signal for one wallet.**  
- **Input:** `address`  
- **Output:** `risk_level`, `copy_trade_signal`, `one_line_rationale`, `verdict`/`confidence` (if API), `agent_summary`.  
- **Use when:** Fast “should I copy this?” without full report.

## Setup

```bash
cd mcp-server-js
npm install
cp .env.example .env
# Set ETHERSCAN_API_KEY in .env (optional but recommended)
```

## Run

```bash
npm start
# or Railway: Procfile runs "node server.js"
```

## Env

- **PORT** — Server port (default 3010)
- **ETHERSCAN_API_KEY** — Optional; improves Etherscan rate limits
- **WHALEMIND_API_URL** or **WHalemind_API_URL** — Optional; when set, tools call your WhaleMind API for verdict/confidence/entity_type and balance. Without it, signals are derived from on-chain metrics only.

## Test tools/list

**PowerShell (recommended):**
```powershell
Invoke-RestMethod -Uri http://localhost:3010/mcp -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```
Response is SSE; the tool list is in the `data` payload. MCP clients parse this automatically.

**curl.exe from PowerShell** (use a variable so the JSON isn’t mangled):
```powershell
$body = '{"jsonrpc":"2.0","method":"tools/list","id":1}'
curl.exe -s -X POST http://localhost:3010/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d $body
```

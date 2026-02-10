# WhaleMind MCP Server (Node.js)

Giga-brained MCP tools for whale/smart-money intelligence. Combines Etherscan + optional WhaleMind API, adds risk/copy-trade signals and multi-wallet comparison. Context marketplace–compatible.

## Endpoints

| Method | Path    | Description |
|--------|---------|-------------|
| GET    | /health | Health check → `{ "status": "ok" }` |
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

- **PORT** — Server port (default 3000; Railway sets this)
- **HOST** — Bind address (default `0.0.0.0` for Railway)
- **ETHERSCAN_API_KEY** — Optional; improves Etherscan rate limits
- **WHALEMIND_API_URL** or **WHalemind_API_URL** — Optional; when set, tools call your WhaleMind API for verdict/confidence/entity_type and balance (e.g. `https://whalemind-mcp.up.railway.app`). Without it, signals are derived from on-chain metrics only.

## Deploy to Railway

1. In [Railway](https://railway.app): **New Project** → **Deploy from GitHub** → select this repo.
2. **Service settings** → set **Root Directory** to `mcp-server-js` (required — see below).
3. **Variables**: add
   - `ETHERSCAN_API_KEY` — your Etherscan API key (recommended)
   - `WHALEMIND_API_URL` — your Flask API URL (e.g. `https://whalemind-mcp.up.railway.app`)
4. **Deploy**. Railway will use the `Dockerfile` here (Node 20 image); start is `node server.js`.
5. **Settings** → **Networking** → **Generate Domain** to get a URL like `https://your-service.up.railway.app`.

**MCP endpoint for Context / clients:**  
`https://your-service.up.railway.app/mcp`

- Health: `GET https://your-service.up.railway.app/health` → `{ "status": "ok" }`

### If you see "npm: command not found" in deploy logs

The service is building from the **repo root** (Flask/Python) instead of this folder. Fix:

- Open the **web** (or this) service → **Settings** → **General**.
- Set **Root Directory** to exactly: `mcp-server-js`.
- Save and **Redeploy**. Railway will then build from this directory, use the Dockerfile (Node 20), and `node server.js` will run correctly.

## Test tools/list

**PowerShell (recommended):**
```powershell
Invoke-RestMethod -Uri http://localhost:3000/mcp -Method POST -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```
Response is SSE; the tool list is in the `data` payload. MCP clients parse this automatically.

**curl.exe from PowerShell** (use a variable so the JSON isn’t mangled):
```powershell
$body = '{"jsonrpc":"2.0","method":"tools/list","id":1}'
curl.exe -s -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d $body
```

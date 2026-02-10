# Deploy WhaleMind MCP Server on Railway — Step by Step

The build fails with **"COPY package.json ... failed"** when Railway uses the **wrong folder** as the build context. Follow one of the two methods below exactly.

---

## Method 1: Deploy from repo root (recommended — fewer settings)

Use the root Dockerfile so you **don’t** change Root Directory.

### Step 1: Create or open the project

1. Go to [railway.app](https://railway.app) and log in.
2. Click **New Project** (or open an existing project).
3. Choose **Deploy from GitHub repo**.
4. Select the repo: **SyedDaniyal31/WhaleMind-MCP** (or your fork). Authorize GitHub if asked.
5. Railway will add a **service** (it may be named "WhaleMind-MCP" or "web").

### Step 2: Use the root Dockerfile

1. Click your **service** (e.g. "Whalemind-MCP-Server" or "web").
2. Open the **Settings** tab.
3. Find **Build** (or **Build & deploy**).
4. Set **Root Directory** to **empty** (leave blank or `.`).  
   - If it’s set to `mcp-server-js`, clear it so the project root is used.
5. Set **Dockerfile Path** to: **`Dockerfile.mcp`**  
   - This file is in the repo root and copies from `mcp-server-js/`, so the build works from the root folder.
6. Save (or wait for auto-save).

### Step 3: Start command (optional but recommended)

1. In the same **Settings**, find **Deploy** (or **Start Command**).
2. Set **Start Command** to: **`node server.js`**  
   - Or leave blank; `Dockerfile.mcp` already uses `CMD ["node", "server.js"]`.

### Step 4: Variables (optional)

1. Open the **Variables** tab for the service.
2. Add:
   - **`ETHERSCAN_API_KEY`** = your Etherscan API key (recommended).
   - **`WHALEMIND_API_URL`** = `https://whalemind-mcp.up.railway.app` (optional; your Flask API URL).
3. Save. Railway will redeploy when you add variables.

### Step 5: Public URL

1. Open the **Settings** tab.
2. Go to **Networking** (or **Public Networking**).
3. Click **Generate Domain** (or **Add domain**).
4. Copy the URL, e.g. `https://web-production-xxxx.up.railway.app`.

### Step 6: Deploy and check

1. Go to **Deployments**. Trigger a deploy if needed: **Redeploy** from the latest deployment, or push a commit to GitHub.
2. Wait for **Build** and **Deploy** to finish (green checkmarks).
3. Test:
   - **Browser:** `https://<your-domain>/` → should show "MCP server running".
   - **Health:** `https://<your-domain>/health` → `{"status":"ok"}`.
4. **MCP endpoint for Context / clients:**  
   `https://<your-domain>/mcp` (POST only).

---

## Method 2: Deploy from the `mcp-server-js` folder

Use the Dockerfile **inside** `mcp-server-js` and set the build context to that folder.

### Step 1: Create or open the project

Same as Method 1 — **New Project** → **Deploy from GitHub** → select **WhaleMind-MCP**.

### Step 2: Set Root Directory to `mcp-server-js`

1. Click your service.
2. Open **Settings**.
3. Find **Root Directory** (under **Source** or **Build**).
4. Set it to exactly: **`mcp-server-js`** (no leading slash, no trailing slash).
5. Leave **Dockerfile Path** empty (Railway will use `mcp-server-js/Dockerfile`).
6. Save.

### Step 3: Start command

1. In **Settings** → **Deploy**, set **Start Command** to: **`node server.js`** (or leave blank to use the Dockerfile `CMD`).

### Step 4: Variables and domain

Same as Method 1 — add **Variables** (`ETHERSCAN_API_KEY`, `WHALEMIND_API_URL` if you want) and **Generate Domain** under **Networking**.

### Step 5: Deploy and check

Same as Method 1 — **Deployments** → wait for success, then test `/`, `/health`, and use `/mcp` as the MCP endpoint.

---

## Why the build was failing

- The error **`COPY package.json ... failed`** / **checksum ... "/package.json"** happens when:
  - The **Dockerfile** expects `package.json` in the current directory (e.g. `mcp-server-js/Dockerfile`), but
  - The **build context** is the **repo root**, where there is no `package.json` (only in `mcp-server-js/`).
- **Fix:**  
  - **Method 1:** Build from repo root and use **Dockerfile path = `Dockerfile.mcp`** (it copies `mcp-server-js/package.json` and `mcp-server-js/server.js`).  
  - **Method 2:** Set **Root Directory = `mcp-server-js`** so the context is that folder and `COPY package.json` finds the file.

---

## Deployment is active but the link times out (ERR_TIMED_OUT)

If the deployment is green but `https://your-app.up.railway.app/` or `/health` times out in the browser:

### 1. Confirm the domain is for this service

- In Railway, open **Settings** → **Networking** (or the **Variables** / service overview).
- Check which **service** the domain `whalemind-mcp-production.up.railway.app` is attached to (it’s listed under that service).
- Open **that same service** (the one that owns the domain), then **Deployments** → latest **Deploy logs**. You must see logs for the app that serves that URL.

### 2. Check deploy logs for the correct service

- In the service that has the domain, open **Deploy logs** (not Build logs).
- You should see: **`Listening on 0.0.0.0:XXXX (PORT=XXXX)`**.
- If you don’t see that line, the process isn’t starting (crash on startup). Look for errors or stack traces above it.
- If the logs keep repeating (restart loop), the app is crashing; fix the error shown in the logs.

### 3. Only one service should use the MCP Dockerfile

- If you have **two services** (e.g. one Flask, one MCP), the domain must point to the **MCP** service.
- The MCP service must use **Dockerfile path = `Dockerfile.mcp`** (or Root Directory = `mcp-server-js`) and **Start command = `node server.js`**.
- The other service (Flask) uses a different build and a different URL.

### 4. Cold start (free tier)

- On the free tier, the service can sleep. The first request after idle can take 30–60 seconds and may timeout in the browser.
- Wait 1–2 minutes, then try again. Or use **Observability** → **Logs** and trigger a request; if you see "Listening on 0.0.0.0" and then request logs, the app is up and the timeout was likely cold start.

### 5. Redeploy and test again

- **Deployments** → **Redeploy** on the latest deployment.
- After it’s active, open **Deploy logs** and confirm **`Listening on 0.0.0.0:...`**.
- Then open `https://your-domain/health` in the browser or run:  
  `Invoke-RestMethod -Uri "https://your-domain/health" -Method GET`

---

## Quick checklist

| Step | Method 1 (root) | Method 2 (subfolder) |
|------|------------------|----------------------|
| Root Directory | **Empty** (or `.`) | **`mcp-server-js`** |
| Dockerfile Path | **`Dockerfile.mcp`** | *(leave default)* |
| Start Command | `node server.js` (optional) | `node server.js` (optional) |
| Variables | ETHERSCAN_API_KEY, WHALEMIND_API_URL | Same |
| Generate Domain | Yes | Yes |

After deploy, your **MCP endpoint** is: **`https://<your-domain>/mcp`**.

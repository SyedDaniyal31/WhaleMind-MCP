# Deploy MCP server to Railway (fix "npm: command not found")

Your **web** service is building from the **repo root** (Flask app), so the container has no Node.js and `npm start` fails. Do this:

## 1. Set Root Directory (required)

1. In Railway, open your project and click the **web** service.
2. Go to **Settings** (or the gear icon).
3. Find **Root Directory** (under "General" or "Build").
4. Set it to exactly: **`mcp-server-js`** (no slash, no extra path).
5. Click **Save** or wait for it to auto-save.

## 2. Set Start Command (recommended)

So the container never runs `npm`, only `node`:

1. In the same **Settings** for the **web** service.
2. Find **Start Command** (under "Deploy" or "Deployment").
3. Set it to: **`node server.js`**
4. Remove any override that says `npm start` or leave it blank to use the Dockerfile default.

## 3. Redeploy

- **Deployments** → **Redeploy** the latest deployment, or push a new commit so Railway rebuilds.

After this, the service will build from `mcp-server-js` (using the Dockerfile with Node 20) and run `node server.js` — no `npm` in the run step.

## 4. Two apps in one repo?

- **Flask API** (api.py) → one Railway service with Root Directory **empty** or **`.`** (repo root).
- **MCP server** (this folder) → a **second** Railway service with Root Directory **`mcp-server-js`**.

If you only have one service and want the MCP server, set that service’s Root Directory to `mcp-server-js` as above.

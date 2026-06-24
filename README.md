# claude-cowork-mcp

A cloud-hosted **Claude-to-Claude "cowork" MCP server**. It exposes the Claude API as a set of MCP tools so any MCP client — [Littlebird AI](https://lilbird.co), another Claude agent, or any orchestrator — can call Claude directly. This enables real **AI-to-AI collaboration**: one model delegates research, critique, drafting, or distillation to another.

It speaks MCP over **SSE** (Server-Sent Events) and is built to deploy on [Render](https://render.com) free tier.

---

## What it does

The server registers **five tools**:

| Tool | Purpose | Default model |
|------|---------|---------------|
| `ask_claude` | Single-turn question → plain-text answer. Includes a recursion **depth guard** (rejects at depth ≥ 5) to stop runaway AI-to-AI loops. | `claude-haiku-3-5` |
| `run_claude_conversation` | Multi-turn call. Pass the full message history (must end with a `user` turn) → assistant reply. | `claude-sonnet-4-5` |
| `list_available_models` | Returns the model catalog with usage guidance. No params. | — |
| `cowork` | Delegate a task to Claude as a specialist (`researcher`, `critic`, `writer`, `devil's advocate`, `strategist`, …). | `claude-sonnet-4-5` |
| `distill` | Compress content into SUMMARY / KEY POINTS / ACTION ITEMS / INSIGHT. | `claude-haiku-3-5` |

Every tool is wrapped in `try/catch` and returns `isError: true` with a readable message on failure.

### Model catalog

| Model | Guidance |
|-------|----------|
| `claude-opus-4-8` | Most capable. Hardest reasoning, complex writing, high-stakes decisions. |
| `claude-sonnet-4-5` | Balanced. Best for cowork tasks, analysis, drafting, code. |
| `claude-haiku-3-5` | Fastest and cheapest. Simple lookups, summaries, classification. |

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | **Yes** | Anthropic API key ([console.anthropic.com](https://console.anthropic.com/)). |
| `AUTH_TOKEN` | Recommended | Bearer token securing `/sse` and `/messages`. **If unset, auth is skipped.** |
| `PORT` | No | Listen port. Defaults to `3000`; Render injects its own. |

Copy `.env.example` → `.env` for local development.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/sse` | Bearer | Open an SSE stream. One MCP server is created per connection. |
| `POST` | `/messages?sessionId=...` | Bearer | Deliver a client JSON-RPC message to an open stream. `404` if the session is unknown. |
| `GET`  | `/health` | Open | Liveness probe → `{ "status": "ok", "service": "claude-cowork-mcp", "models": [...] }`. |

---

## Run locally

```bash
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY and AUTH_TOKEN
npm start
```

Check it's alive:

```bash
curl http://localhost:3000/health
```

---

## Deploy to Render

This repo includes `render.yaml`, so Render can configure the service automatically (Blueprint), or you can set it up manually.

### Option A — Blueprint (recommended)

1. Push this folder to a GitHub repository.
2. In the [Render dashboard](https://dashboard.render.com/), click **New → Blueprint**.
3. Connect the GitHub repo. Render reads `render.yaml` and proposes a free web service.
4. When prompted, set the environment variables:
   - `ANTHROPIC_API_KEY` — your Anthropic key
   - `AUTH_TOKEN` — a long random secret
5. Click **Apply / Deploy**. Render runs `npm install` then `npm start`, and uses `/health` as the health check.

### Option B — Manual web service

1. Push this folder to GitHub.
2. **New → Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
   - **Plan:** Free
4. Add the env vars `ANTHROPIC_API_KEY` and `AUTH_TOKEN` under **Environment**.
5. **Create Web Service.**

After deploy, your base URL looks like `https://claude-cowork-mcp.onrender.com`. Verify:

```bash
curl https://claude-cowork-mcp.onrender.com/health
```

> ⚠️ **Render free tier spins down after inactivity.** The first request after an idle period can take **~50 seconds** while the service cold-starts. Subsequent requests are fast.

---

## Connecting to Littlebird

1. In Littlebird, go to **Settings → Integrations → Add MCP Server**.
2. **Server URL:** paste your Render URL with the SSE path:
   ```
   https://claude-cowork-mcp.onrender.com/sse
   ```
3. **Authorization header:** set
   ```
   Authorization: Bearer <AUTH_TOKEN>
   ```
   (use the exact `AUTH_TOKEN` value you configured on Render).
4. **OAuth / callback URL** (if requested by the connection flow):
   ```
   https://app.lilbird.co/mcp/oauth/callback
   ```
5. Save. Littlebird will open the SSE stream and discover the five tools above.

> Remember the free-tier cold start: the first connection after idle may take ~50 seconds before tools appear.

---

## How it works (architecture)

- **One `McpServer` per SSE connection.** `GET /sse` instantiates a fresh server, attaches an `SSEServerTransport`, stores it in a `Map<sessionId, transport>`, and connects.
- **Message routing.** `POST /messages?sessionId=...` looks the transport up by `sessionId` and hands the request to `transport.handlePostMessage(...)`. Unknown sessions get `404`.
- **Cleanup.** On `res.on("close")` the transport is removed from the Map.
- **No global body parser.** `express.json()` is intentionally *not* mounted, because `SSEServerTransport` reads the raw POST body itself.

---

## License

MIT

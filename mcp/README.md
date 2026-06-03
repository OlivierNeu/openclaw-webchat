# openclaw-webchat-mcp

A thin, dependency-light **MCP server + CLI** that proxy the openclaw-webchat
`/api/v1` observability surface using an `oc_live_` Bearer API key.

It speaks **HTTP only** — it imports nothing from the Convex app. Each tool maps
1:1 to a planned `/api/v1` route and to a single permission, which is enforced
**server-side** by the deployment (`requirePermission`). A scoped key (e.g. an
`observer`) therefore simply gets a `403` for routes it isn't allowed to call.

Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only.

## Configuration (environment)

| Variable                     | Required | Default                  | Meaning                                                  |
| ---------------------------- | -------- | ------------------------ | -------------------------------------------------------- |
| `OPENCLAW_WEBCHAT_API_BASE`  | no       | `http://127.0.0.1:3213`  | Deployment `.site` origin, **without** `/api/v1`.        |
| `OPENCLAW_WEBCHAT_API_KEY`   | **yes**  | —                        | The `oc_live_...` Bearer key.                            |

The `/api/v1` prefix is added internally; you point `API_BASE` at the bare
`.site` origin. The key is only ever sent in the `Authorization` header — never
in a URL/query string and never logged.

## Build

```bash
cd mcp
npm install
npm run build      # emits dist/ (with shebangs preserved)
```

Other scripts: `npm run typecheck`, `npm test`.

## Tools (MCP) / Commands (CLI)

| MCP tool         | CLI command                            | Route                       | Permission         | Increment |
| ---------------- | -------------------------------------- | --------------------------- | ------------------ | --------- |
| `health`         | `health`                               | `GET  /api/v1/health`       | none               | 1 (live)  |
| `list_traces`    | `traces`                               | `GET  /api/v1/traces`       | `traces.read`      | 1 (live)  |
| `get_kpi`        | `kpi`                                  | `GET  /api/v1/kpi`          | `kpi.read`         | 4         |
| `query_openclaw` | `query-openclaw`                       | `POST /api/v1/openclaw/query` | `openclaw.query` | 6         |
| `list_anomalies` | `anomalies`                            | `GET  /api/v1/anomalies`    | `anomalies.read`   | 6         |
| `report_anomaly` | `report-anomaly`                       | `POST /api/v1/anomalies`    | `anomalies.report` | 6         |

`health` and `list_traces` are live now (increment 1). The rest return their
API response once increments 4/6 land; until then the server surfaces the API's
own `404`/error gracefully instead of crashing.

## CLI usage

```bash
export OPENCLAW_WEBCHAT_API_BASE=http://127.0.0.1:3213
export OPENCLAW_WEBCHAT_API_KEY=oc_live_xxxxxxxxxxxx

# live now (increment 1)
node dist/cli.js health
node dist/cli.js traces --limit 20
node dist/cli.js traces --kind api.call --correlation-id abc123

# once increments 4/6 land
node dist/cli.js kpi --metric api.calls --since 2026-06-01T00:00
node dist/cli.js anomalies --limit 50 --status open
node dist/cli.js query-openclaw --prompt "summarize last run" --chat-id c1
node dist/cli.js report-anomaly --kind latency.spike --severity warn --message "p99 > 5s"
```

If installed/published, the same is available as the `openclaw-webchat` bin
(e.g. `openclaw-webchat traces --limit 20`).

## OpenClaw MCP wiring

Register the stdio server in `~/.openclaw/openclaw.json`. Because this package
is not published, run the built file directly:

```json
{
  "mcpServers": {
    "openclaw-webchat": {
      "command": "node",
      "args": ["/absolute/path/to/openclaw-webchat/mcp/dist/server.js"],
      "env": {
        "OPENCLAW_WEBCHAT_API_BASE": "http://127.0.0.1:3213",
        "OPENCLAW_WEBCHAT_API_KEY": "oc_live_..."
      }
    }
  }
}
```

After publishing to a registry, the `npx` form works too:

```json
{
  "mcpServers": {
    "openclaw-webchat": {
      "command": "npx",
      "args": ["-y", "openclaw-webchat-mcp"],
      "env": {
        "OPENCLAW_WEBCHAT_API_BASE": "https://<deployment>.convex.site",
        "OPENCLAW_WEBCHAT_API_KEY": "oc_live_..."
      }
    }
  }
}
```

## Security

- The API key lives in env only — never committed, never logged, never in a URL.
- Stdio transport avoids the DNS-rebinding surface of local HTTP MCP servers.
- Permission scoping is enforced by the deployment, not the client: a key that
  lacks a tool's permission gets a `403` that the tool surfaces as an error.

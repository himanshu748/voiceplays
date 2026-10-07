# voiceplays

[![CI](https://github.com/himanshu748/voiceplays/actions/workflows/ci.yml/badge.svg)](https://github.com/himanshu748/voiceplays/actions/workflows/ci.yml)

An Alexa+ MCP add-on that runs your saved rote procedures by voice. Ask for something in your own words, it finds the matching procedure, starts it in the background and tells you how it went when you ask. Procedures that need arguments are refused by name. Procedures not tagged read-only are off unless you enable them, and even then need a confirmation code on a second turn. It is a self-hosted MCP server on Streamable HTTP, protocol version 2025-11-25, with OAuth 2.0 client_credentials for Alexa+.

<!-- TODO(himanshu): add a short demo GIF or clip here (ask for a play by voice -> start -> ask for the result) -->

```
you ──voice──▶ Alexa+ ──MCP (Streamable HTTP, OAuth)──▶ voiceplays ──spawn──▶ rote play run <name>
                                  ◀── short spoken summary ── background job ◀──┘
```

## Run it

Needs Node 22.9+ (for `--env-file-if-exists`) and rote with at least one saved play (`rote play list`).

```bash
npm ci
export VOICEPLAYS_TOKEN=$(openssl rand -hex 32)
npm start
```

In a second terminal:

```bash
curl -s -X POST http://127.0.0.1:8787/mcp -H "Authorization: Bearer $VOICEPLAYS_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_procedure","arguments":{"phrase":"disk space"}}}'
```

Copy `.env.example` to `.env` to keep settings; `npm start` loads it.

| Variable | Default | Meaning |
|---|---|---|
| `VOICEPLAYS_TOKEN` | none | Static bearer token for local clients, 32+ chars |
| `VOICEPLAYS_CLIENT_ID`, `VOICEPLAYS_CLIENT_SECRET`, `PUBLIC_URL` | none | OAuth client_credentials for Alexa+; set all three |
| `VOICEPLAYS_ALLOW_WRITES` | empty | Comma-separated non-read-only plays allowed by voice (still need a confirmation code) |
| `VOICEPLAYS_APPROVED_REGISTRY` | empty | Registry plays you reviewed; only these get `--yes` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind address |
| `JOB_TIMEOUT_MS` | `900000` | A run past this is stopped with its whole process group |
| `MAX_RUNNING` | `3` | Concurrent plays |

At least one auth option is required, and the numeric settings must be positive integers; the server refuses to start otherwise.

## Test

```bash
npm test
```

Unit tests for speech cleanup and ranking, plus end-to-end MCP calls against a fake `rote` in `test/fixtures/`, so no real rote install or Alexa account is needed. CI runs them on every push and pull request.

## Tools

| Tool | What it does |
|---|---|
| `find_procedure(phrase)` | Up to three matches, ranked by name, then tags, then description |
| `start_procedure(name, confirmation?)` | Starts the play and returns at once |
| `procedure_result(name)` | Still running, finished with a spoken summary, failed, or stopped at the time limit |

Plays run 3s to several minutes, which no voice turn can wait for, so start and result are separate calls. A run past `JOB_TIMEOUT_MS` (15 minutes) is stopped along with every process it started.

## Safety limits

- **Auth on every request.** A static bearer token for local use, OAuth client_credentials for Alexa+. The server refuses to start without one.
- **Localhost by default** with Host header validation always on, so a web page cannot reach it through DNS rebinding.
- **Plays not tagged `effect-read-only` are refused** unless listed in `VOICEPLAYS_ALLOW_WRITES`. Listed ones return a four-digit code first and run only when it comes back within two minutes. The code forces a second turn; it cannot prove a person spoke, so the allowlist is the real limit.
- **Registry plays are refused** unless listed in `VOICEPLAYS_APPROVED_REGISTRY`. rote asks for approval before running them, and a voice turn cannot answer, so listing a play is your standing approval and the server passes `--yes` for it only.
- Plays with required parameters are refused by name.

## Alexa+ setup (not yet tested against Alexa+)

1. Expose the server over HTTPS, for example `cloudflared tunnel --url http://127.0.0.1:8787`.
2. Set `PUBLIC_URL` to that origin, plus `VOICEPLAYS_CLIENT_ID` and `VOICEPLAYS_CLIENT_SECRET` (`openssl rand -hex 32`).
3. Register `PUBLIC_URL/mcp` with the Alexa AI CLI, giving it the client ID and secret.

The server publishes `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, and issues one-hour tokens at `/oauth/token` for `grant_type=client_credentials`, scope `mcp:service`, `resource=PUBLIC_URL/mcp`. Issued tokens live in memory, so a restart makes Alexa+ fetch a new one.

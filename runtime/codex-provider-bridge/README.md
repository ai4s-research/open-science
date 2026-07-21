# Codex CLI provider bridge (experimental)

This optional local bridge lets the bundled OpenCode runtime use a signed-in
Codex CLI as its primary model while keeping OpenCode in charge of Open Science
sessions, skills, MCP servers, tools, and approvals.

```text
Open Science -> OpenCode -> OpenAI-compatible loopback API -> Codex App Server
                         <- dynamic tool calls          <-
```

This is intentionally different from the ACP runtime proposed in #14. ACP makes
Codex a separate agent runtime. This bridge makes Codex the reasoning provider
inside the existing OpenCode runtime, so OpenCode-only capabilities remain
available. See #28 for the direct `CodexRuntime` prototype.

## Requirements

- Node.js 20 or newer.
- A current `codex` CLI available on `PATH` and already authenticated.
- Open Science Desktop / OpenCode with custom OpenAI-compatible providers.

The bridge was protocol-checked and exercised end to end with Codex CLI 0.144.6.
It opts into the experimental App Server API because dynamic tools are not yet a
stable protocol surface.

## Start the bridge

macOS/Linux:

```bash
CODEX_BRIDGE_CWD="$PWD" \
CODEX_BRIDGE_API_KEY="choose-a-local-secret" \
node runtime/codex-provider-bridge/server.mjs
```

PowerShell:

```powershell
$env:CODEX_BRIDGE_CWD = (Get-Location).Path
$env:CODEX_BRIDGE_API_KEY = "choose-a-local-secret"
node runtime/codex-provider-bridge/server.mjs
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BRIDGE_PORT` | `17891` | Loopback HTTP port. |
| `CODEX_BRIDGE_CODEX` | `codex` | Codex executable or wrapper. |
| `CODEX_BRIDGE_MODEL` | Codex config default | Override the Codex model. |
| `CODEX_BRIDGE_TIMEOUT_MS` | `900000` | App Server request timeout. |
| `CODEX_BRIDGE_LOG` | unset | Optional metadata-only JSONL log path. |

`CODEX_BRIDGE_API_KEY` is optional, but setting it prevents other local
processes from making requests without the matching bearer token. The server is
always bound to `127.0.0.1`.

Check readiness:

```bash
curl -H "Authorization: Bearer choose-a-local-secret" \
  http://127.0.0.1:17891/health
```

## Configure Open Science

In **Settings -> Models -> Providers -> Custom endpoint**, enter:

- Name: `Codex CLI`
- Type: `OpenAI compatible`
- Base URL: `http://127.0.0.1:17891/v1`
- API key: the same value as `CODEX_BRIDGE_API_KEY`
- Model ID: `codex-cli`

Then select **Codex CLI** as the default model. The equivalent OpenCode fragment
is in [`opencode.example.json`](./opencode.example.json); merge it into the
existing app-private config instead of replacing unrelated providers, MCP
servers, permissions, or plugins.

## Safety model

Codex App Server runs with `sandbox: read-only` and `approvalPolicy: never`.
This combination prevents its built-in command/file tools from escaping into a
write path without an approval client. Actions that mutate files, run commands,
or access the network are presented to Codex as dynamic OpenCode tools and go
back through Open Science's existing approval policy.

Do not change the bridge to `workspace-write` plus `never`: that bypasses the
desktop's approval boundary for Codex built-in tools.

## What is translated

- OpenAI Chat Completions messages -> Codex `thread/start` + `turn/start`.
- OpenCode function tools -> experimental App Server `dynamicTools`.
- App Server `item/tool/call` -> Chat Completions `tool_calls`.
- OpenCode tool results -> `DynamicToolCallResponse`, resuming the same turn.
- Final agent messages -> normal or SSE Chat Completions responses.

## Known limitations

- App Server dynamic tools are experimental and can change between Codex
  releases. Generate the installed version's schemas with
  `codex app-server generate-json-schema --out <dir>` when updating the bridge.
- SSE responses are compatibility-framed after each Codex outcome; token deltas
  are not forwarded live yet.
- Token/cost accounting reports zero because this bridge does not currently map
  Codex usage notifications into OpenAI usage fields.
- Images are represented as transcript placeholders; binary image forwarding is
  not implemented.
- New model requests use ephemeral Codex threads. A thread remains live across
  the OpenCode tool-call loop, while ordinary conversation history is replayed
  from OpenCode on the next request.

## Verification

Run the dependency-free unit tests:

```bash
node --test runtime/codex-provider-bridge/server.test.mjs
```

For an authenticated end-to-end check, start the bridge and send a normal Chat
Completions request. Then repeat with one function tool and return its result in
a second request. A complete test should observe `finish_reason: tool_calls`
followed by the final Codex answer.

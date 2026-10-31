# packages/sdk

`OpenCodeClient` — the single boundary between the app and the agent runtime.

The UI never calls OpenCode directly. This package wraps the transport so the runtime
can change without touching the frontend:

- Talks to a running `opencode serve` (OpenCode 2) over its HTTP + SSE API (`/api/*`).
- Translates OpenCode 2's typed messages and `session.*` events into the app's own
  vocabulary — the `HistoryMessage` shape and a small event union (`text.updated`,
  `tool.updated`, `session.idle`, `error`, …) the UI upserts by part/call id — including
  OpenCode 2's tool renames (`shell` → `bash`, `subagent` → `task`).
- Keeps a folder's client to that folder's sessions on OpenCode 2's global event stream.
- Reads and writes OpenCode's config through a host-supplied `ConfigStore` (OpenCode 2 has
  no config-writing API).
- Pins the supported OpenCode version (`OPENCODE_VERSION`).

`mockServer.ts` provides an OpenCode 2 server for tests and local dev, its events copied
from a recorded stream. `apps/desktop/src/test/opencode-client.live.node.test.ts` runs the
client against a real OpenCode binary (set `OPENCODE_LIVE_BIN`).

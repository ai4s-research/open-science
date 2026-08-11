// This app's MCP connectors, handed to an ACP agent (#14).
//
// ACP takes MCP servers per SESSION; OpenCode keeps them in its global config.
// Without the translation below an ACP agent runs with no connectors at all —
// the science databases the user configured are invisible to it.
import { describe, expect, it } from "vitest";
import { AcpRuntime, toAcpMcpServers } from "@ai4s/sdk/acp";
import type { JsonRpcTransport } from "@ai4s/sdk/acp";
import type { McpConfig } from "@ai4s/sdk";
import type { McpServer } from "@agentclientprotocol/sdk";

/** Compile-time conformance against the OFFICIAL type — how the missing `env`
 *  was caught. Our mapping's output must be assignable to what an agent built
 *  on the reference SDK accepts, or `session/new` is refused on arrival. */
const _conforms: McpServer[] = toAcpMcpServers({
  local: { type: "local", command: ["/bin/tool"] },
  remote: { type: "remote", url: "https://x/mcp" },
});
void _conforms;

describe("OpenCode connectors → ACP mcpServers", () => {
  it("splits a local command into command + args and lists env as pairs", () => {
    expect(
      toAcpMcpServers({
        pubmed: {
          type: "local",
          command: ["/opt/app/bin/uvx", "science-mcp", "--stdio"],
          environment: { NCBI_API_KEY: "k" },
        },
      }),
    ).toEqual([
      {
        name: "pubmed",
        command: "/opt/app/bin/uvx",
        args: ["science-mcp", "--stdio"],
        env: [{ name: "NCBI_API_KEY", value: "k" }],
      },
    ]);
  });

  it("sends env even when there is none", () => {
    // The published schema has `env: z.array(...)` with no `.optional()`, so an
    // agent validating with the official SDK rejects `session/new` when the key
    // is missing — which is every connector that needs no environment.
    expect(toAcpMcpServers({ plain: { type: "local", command: ["/bin/tool"] } })).toEqual([
      { name: "plain", command: "/bin/tool", args: [], env: [] },
    ]);
  });

  it("keeps a disabled connector disabled, and drops what cannot be run", () => {
    // "Disabled" is the user's decision. An agent that cannot see OpenCode's
    // config would otherwise have the connector quietly switched back on.
    expect(
      toAcpMcpServers({
        off: { type: "local", command: ["x"], enabled: false },
        remoteOff: { type: "remote", url: "https://example.com/mcp", enabled: false },
        empty: { type: "local", command: [] },
        noUrl: { type: "remote", url: "" },
      }),
    ).toEqual([]);
    expect(toAcpMcpServers(undefined)).toEqual([]);
  });

  it("maps a remote connector onto the HTTP transport with its headers", () => {
    expect(
      toAcpMcpServers({
        api: { type: "remote", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer t" } },
      }),
    ).toEqual([
      {
        type: "http",
        name: "api",
        url: "https://api.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer t" }],
      },
    ]);
  });
});

/** An agent that records what it was asked, with the capabilities a test picks. */
function agentWith(mcpCapabilities: Record<string, boolean>) {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Set<(line: string) => void>();
  const transport: JsonRpcTransport = {
    send(line) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      sent.push(msg);
      const reply = (result: unknown) =>
        listeners.forEach((l) => l(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })));
      if (msg.method === "initialize")
        reply({ protocolVersion: 1, agentInfo: { name: "a" }, agentCapabilities: { mcpCapabilities } });
      if (msg.method === "session/new") reply({ sessionId: "s1" });
    },
    onLine(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onClose() {
      return () => {};
    },
    close() {},
  };
  return { transport, sent };
}

const SERVERS: McpConfig = { type: "local", command: ["/bin/tool"] };

describe("what reaches the agent", () => {
  it("sends stdio connectors to any agent, HTTP ones only where advertised", async () => {
    // Every agent MUST support stdio; HTTP and SSE are optional. Sending one an
    // agent never advertised is a protocol violation on our side, so it is
    // dropped rather than hopefully sent.
    for (const [caps, expected] of [
      [{}, ["local"]],
      [{ http: true }, ["local", "remote"]],
      [{ http: false }, ["local"]],
    ] as const) {
      const { transport, sent } = agentWith(caps);
      const runtime = new AcpRuntime({ transport, cwd: "/ws" });
      await runtime.connect();
      runtime.setMcpServers(
        toAcpMcpServers({ local: SERVERS, remote: { type: "remote", url: "https://x/mcp" } }),
      );
      await runtime.createSession();
      const created = sent.find((m) => m.method === "session/new");
      expect((created?.params as { mcpServers: Array<{ name: string }> }).mcpServers.map((s) => s.name)).toEqual(
        expected,
      );
    }
  });
});

// packages/sdk/src/runtime-def.ts
//
// A runtime definition is the *producer-facing* contract: what a runtime
// author writes to register a runtime. The *consumer-facing* contract stays
// `interface AgentRuntime` (what the UI/store holds). The two coexist — see
// RFC runtime-evolution.md §5.1 ("What stays").
//
// Today only the `opencode-http` transport is implemented; `acp-stdio` lands
// in Step 3. Adding a transport = extend this union + add an engine file.

export type TransportSpec =
  | { kind: "opencode-http"; baseUrl: string; directory?: string; password?: string }
  | {
      kind: "acp-stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      /** Working directory the ACP agent operates in. Passed to `session/new`
       *  as `cwd` (kimi-code 0.27 rejects session/new without it) and used as
       *  the child process's `cwd` if set. Defaults to process.cwd(). */
      cwd?: string;
    };

export type ResumeStrategy = "cli" | "stream-capture" | "acp-load";

export type RuntimeDef = {
  id: string;
  transport: TransportSpec;
  /** How sessions persist across reconnection. undefined = the runtime has no
   *  resumable sessions (each connect is fresh). OpenCode: undefined (server
   *  persists). ACP agents: "acp-load" (session/load). Stream agents: "cli"
   *  (daemon mints id) or "stream-capture" (read id from first event). */
  resumesSessionVia?: ResumeStrategy;
  /** Optional default model id ("provider/model"). */
  defaultModel?: string;
};

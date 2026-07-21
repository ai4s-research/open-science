// packages/sdk/src/defs/opencode.ts
import type { RuntimeDef } from "../runtime-def";

export interface OpenCodeDefOptions {
  baseUrl: string;
  directory?: string;
  password?: string;
  defaultModel?: string;
}

/** The bundled OpenCode runtime's definition. OpenCode persists sessions
 *  server-side (no client-side resume strategy needed). */
export function opencodeDef(opts: OpenCodeDefOptions): RuntimeDef {
  return {
    id: "opencode",
    transport: {
      kind: "opencode-http",
      baseUrl: opts.baseUrl,
      directory: opts.directory,
      password: opts.password,
    },
    resumesSessionVia: undefined,
    defaultModel: opts.defaultModel,
  };
}

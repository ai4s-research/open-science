/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import pkg from "./package.json";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": r("./src"),
      "@ai4s/shared": r("../../packages/shared/src/index.ts"),
      "@ai4s/sdk/mock-server": r("../../packages/sdk/src/mockServer.ts"),
      // Every ACP entry must precede the bare "@ai4s/sdk" prefix, which would
      // otherwise swallow them. `acp/stdio` (spawns an agent) and
      // `acp/serve-stdio` (IS the agent an editor spawns) are node-only;
      // nothing in the webview bundle may import either.
      "@ai4s/sdk/acp/serve-stdio": r("../../packages/sdk/src/acp/serve-stdio.ts"),
      "@ai4s/sdk/acp/stdio": r("../../packages/sdk/src/acp/stdio.ts"),
      "@ai4s/sdk/acp": r("../../packages/sdk/src/acp/index.ts"),
      "@ai4s/sdk": r("../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

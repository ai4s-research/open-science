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
      "@ai4s/sdk/node-runtime": r("../../packages/sdk/src/node-runtime.ts"),
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

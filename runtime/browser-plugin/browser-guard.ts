const BROWSER_TOOL_PREFIX = "open-science-browser_agent_browser_";

// Browser launch policy belongs to desktop Settings. Browser identity belongs
// to the current OpenCode conversation and is injected here after model-side
// schema validation, so prompts cannot select another conversation's browser.
const APP_OWNED_ARGUMENTS = [
  "allowedDomains",
  "session",
  "namespace",
  "restore",
  "restoreSave",
  "restoreCheckUrl",
  "restoreCheckText",
  "restoreCheckFn",
  "extraArgs",
  "headed",
  "webgpu",
] as const;

export function sanitizeBrowserToolArgs(tool: string, args: unknown): void {
  if (!tool.startsWith(BROWSER_TOOL_PREFIX) || !args || typeof args !== "object") return;
  const values = args as Record<string, unknown>;
  for (const key of APP_OWNED_ARGUMENTS) delete values[key];
}

export function browserLeaseSession(conversationID: string): string {
  const safe = conversationID.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  if (!safe) throw new Error("browser call has no conversation identity");
  return `osd-${safe}`;
}

export function applyBrowserLease(
  tool: string,
  args: unknown,
  conversationID: string,
): void {
  if (!tool.startsWith(BROWSER_TOOL_PREFIX) || !args || typeof args !== "object") return;
  sanitizeBrowserToolArgs(tool, args);
  const values = args as Record<string, unknown>;
  // `all` on the upstream close tool ignores the selected session. The proxy
  // also removes it from the schema; deleting it here is defense in depth.
  if (tool === `${BROWSER_TOOL_PREFIX}close`) delete values.all;
  values.session = browserLeaseSession(conversationID);
}

export const BrowserGuardPlugin = async () => ({
  "tool.execute.before": async (
    input: { tool: string; sessionID: string },
    output: { args: unknown },
  ) => {
    applyBrowserLease(input.tool, output.args, input.sessionID);
  },
});

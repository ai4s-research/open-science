// Where OpenCode's config is read and written. OpenCode 2 has no API that
// writes config — it watches its config file and applies an edit within a
// second — so the host does the writing: the desktop edits the file itself; a
// web client goes through the gateway, which redacts provider keys and lets
// only the default model change (keys and providers stay on the desktop).
import type { ConfigStore } from "@ai4s/sdk";
import { isTauri } from "./tauri";
import { gatewayOrigin, gatewayToken, isGatewayWeb } from "./webMode";

const desktop: ConfigStore = {
  async read() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Record<string, unknown>>("read_opencode_config");
  },
  async patch(patch) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("patch_opencode_config", { patch });
  },
};

const gateway: ConfigStore = {
  async read() {
    const res = await fetch(`${gatewayOrigin()}/v1/opencode-config`, { headers: authHeader() });
    if (!res.ok) throw new Error(await refusal(res));
    return (await res.json()) as Record<string, unknown>;
  },
  async patch(patch) {
    const res = await fetch(`${gatewayOrigin()}/v1/opencode-config`, {
      method: "PATCH",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await refusal(res));
  },
};

function authHeader(): Record<string, string> {
  const token = gatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The gateway's own reason for a refusal, when it gave one (#119). */
async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return `the gateway answered ${res.status}`;
}

/** This host's store, or none in browser dev (no file to write). */
export function configStore(): ConfigStore | undefined {
  return isGatewayWeb ? gateway : isTauri ? desktop : undefined;
}

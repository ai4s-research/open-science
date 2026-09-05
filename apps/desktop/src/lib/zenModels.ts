// Which OpenCode Zen models are still real.
//
// Zen is the built-in free provider, and its model list reaches the picker from
// the models.dev catalog by way of the runtime's /config/providers. That catalog
// is a superset of what the gateway serves: measured 2026-08-15, 29 of its 91
// zen entries — including 19 of the 25 `*-free` ones — are retired and answer
// `401 {"type":"ModelError","message":"Model <id> is not supported"}` on the
// first turn. The user could only discover that by sending a turn and reading a
// provider error, having already picked the model and typed a prompt.
//
// GET https://opencode.ai/zen/v1/models is the gateway's own serving list, and
// is a strict subset of the catalog (nothing it lists is missing from
// models.dev), so it can only ever remove entries — never invent one. Models it
// omits are marked unavailable and the pickers stop offering them.
//
// Fail-open is the rule throughout: an unreachable endpoint, an empty list, or a
// platform with no way to ask (plain browser dev) all mean "unknown", and every
// model stays selectable. Hiding models because the network blinked would be a
// far worse failure than showing one that turns out to be retired.

import type { OpenCodeClient, ProviderInfo } from "@ai4s/sdk";
import { isTauri, zenServedModelIds } from "./tauri";
import { isGatewayWeb, gatewayGet } from "./webMode";

/** Provider id of OpenCode Zen — its models.dev key, and what the runtime reports. */
export const ZEN_PROVIDER_ID = "opencode";

/** Re-ask this often; retirements are rare and the answer is stable. Failures
 *  are cached for the same window so an offline app asks once, not per open. */
const TTL_MS = 10 * 60 * 1000;

let cached: { at: number; served: Set<string> | null } | null = null;
let inFlight: Promise<Set<string> | null> | null = null;

/** Test seam: drop the cache so a case starts from a known state. */
export function resetZenModelCache(): void {
  cached = null;
  inFlight = null;
}

async function fetchServed(): Promise<Set<string> | null> {
  try {
    let ids: string[] = [];
    if (isTauri) {
      ids = await zenServedModelIds();
    } else if (isGatewayWeb) {
      const body = await gatewayGet<{ models?: string[] }>("/v1/zen-models");
      ids = body?.models ?? [];
    } else {
      // Plain browser (`pnpm dev`): the fetch would be blocked by CORS, and the
      // Rust side is not there to do it for us.
      return null;
    }
    // An empty list is indistinguishable from a broken answer, and acting on it
    // would empty the picker — treat it as unknown.
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/** Model ids Zen serves, or null when we could not find out. Cached; concurrent
 *  callers share one request. */
export async function zenServedModels(): Promise<Set<string> | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.served;
  inFlight ??= fetchServed().then((served) => {
    cached = { at: Date.now(), served };
    inFlight = null;
    return served;
  });
  return inFlight;
}

/**
 * Mark every Zen model the gateway no longer serves. Pure; other providers and
 * every model when `served` is null are returned untouched (`available` stays
 * undefined, which reads as available).
 */
export function markZenAvailability(
  providers: ProviderInfo[],
  served: Set<string> | null,
): ProviderInfo[] {
  if (!served) return providers;
  const zen = providers.find((provider) => provider.id === ZEN_PROVIDER_ID);
  // An answer that recognises none of the models the runtime reports is not a
  // retirement list, it is a wrong one — a changed response shape, a captive
  // portal, some future rename. Believing it would empty the picker, so treat
  // it the same as no answer at all.
  if (!zen || !zen.models.some((model) => served.has(model.id))) return providers;
  return providers.map((provider) =>
    provider.id !== ZEN_PROVIDER_ID
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            available: served.has(model.id),
          })),
        },
  );
}

/**
 * `listProviders`, with retired Zen models marked. Use this everywhere the
 * result reaches the UI; the raw call is fine for diagnostics. The availability
 * lookup runs concurrently with the provider read and can only fail open, so it
 * never turns a working catalog into an empty one.
 */
export async function listProvidersWithAvailability(
  client: Pick<OpenCodeClient, "listProviders">,
): Promise<ProviderInfo[]> {
  const [providers, served] = await Promise.all([client.listProviders(), zenServedModels()]);
  return markZenAvailability(providers, served);
}

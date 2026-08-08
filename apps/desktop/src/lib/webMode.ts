// Browser "gateway mode": the real desktop SPA, served BY the Remote Access
// gateway (src-tauri/src/gateway.rs) and running in a plain browser (phone / LAN
// / tunnel) instead of the Tauri webview. The gateway injects `window.__OS_WEB__`
// into index.html; the user pastes a bearer token once. Everything else is the
// identical desktop app talking to the gateway, which proxies OpenCode.
// See docs/rfc/remote-access-gateway.md.

const w = typeof window !== "undefined" ? (window as unknown as { __OS_WEB__?: boolean }) : undefined;

/** True when this build is running as the gateway-served web client. */
export const isGatewayWeb = w?.__OS_WEB__ === true;

const TOKEN_KEY = "os_gateway_token";

export function gatewayToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setGatewayToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode / disabled storage — token just won't persist */
  }
}

export function clearGatewayToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Same-origin gateway base (the page was served by it). */
export function gatewayOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** If the page was opened with a token in the URL (`#token=…`, or `?token=` as a
 *  fallback), store it and scrub it from the address bar. This lets a copied
 *  link auto-authenticate — no pasting the token. Using the hash keeps the token
 *  out of the request the server sees. Runs once, before the app boots. */
export function consumeUrlToken(): void {
  if (!isGatewayWeb || typeof window === "undefined") return;
  try {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
    const fromQuery = new URLSearchParams(window.location.search).get("token");
    const tok = (fromHash ?? fromQuery ?? "").trim();
    if (!tok) return;
    setGatewayToken(tok);
    // Drop the token from the visible URL / history so it isn't re-shared.
    window.history.replaceState(null, "", window.location.origin + window.location.pathname);
  } catch {
    /* ignore malformed URLs */
  }
}

// ---- re-auth on token invalidation -----------------------------------------
// When the token is rotated/revoked on the desktop, every gateway request 401s.
// A fetch guard catches those (same-origin) and drops the client back to the
// token gate, instead of silently looping on "connecting".

let unauthorizedHandler: (() => void) | null = null;

/** Register what to do when the gateway rejects the token (AppShell shows the
 *  gate). Pass null to clear. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

let guardInstalled = false;

/** Wrap window.fetch (once) so a 401 from the same-origin gateway clears the
 *  token and triggers re-auth. Must run BEFORE OpenCodeClient binds fetch. */
export function installGatewayAuthGuard(): void {
  if (guardInstalled || !isGatewayWeb || typeof window === "undefined") return;
  guardInstalled = true;
  const origin = gatewayOrigin();
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (res.status === 401) {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Only react to our own gateway (relative or same-origin), not third parties.
      if (!url || url.startsWith("/") || url.startsWith(origin)) {
        clearGatewayToken();
        unauthorizedHandler?.();
      }
    }
    return res;
  };
}

/** GET a gateway `/v1/...` path with the bearer token. Returns null when not in
 *  web mode; throws on a non-OK response. JSON is parsed, else text is returned. */
export async function gatewayGet<T>(path: string): Promise<T | null> {
  if (!isGatewayWeb) return null;
  const token = gatewayToken();
  const res = await fetch(`${gatewayOrigin()}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? ((await res.json()) as T) : ((await res.text()) as unknown as T);
}

/** POST a gateway `/v1/...` path with the bearer token and a JSON body. Returns
 *  null when not in web mode; throws on a non-OK response. JSON is parsed. */
export async function gatewayPost<T>(path: string, body: unknown): Promise<T | null> {
  if (!isGatewayWeb) return null;
  const token = gatewayToken();
  const res = await fetch(`${gatewayOrigin()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? ((await res.json()) as T) : ((await res.text()) as unknown as T);
}

/** DELETE a gateway `/v1/...` path with the bearer token. Returns null when not
 *  in web mode; throws on a non-OK response. */
export async function gatewayDelete(path: string): Promise<void> {
  if (!isGatewayWeb) return;
  const token = gatewayToken();
  const res = await fetch(`${gatewayOrigin()}${path}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

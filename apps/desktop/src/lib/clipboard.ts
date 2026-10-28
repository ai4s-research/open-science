import { isTauri } from "./tauri";

/**
 * Write text to the OS clipboard. In the desktop app this goes through Tauri's
 * native clipboard — WKWebView's `navigator.clipboard.writeText` is unreliable
 * (often rejects with NotAllowedError even inside a user gesture). A browser
 * has `navigator.clipboard` only on a secure origin; the gateway over a LAN
 * address is plain http, so there it copies through a hidden text field.
 * Throws on failure so callers can surface an error.
 */
export async function copyText(text: string): Promise<void> {
  if (isTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  focused?.focus();
  if (!copied) throw new Error("copy was refused");
}

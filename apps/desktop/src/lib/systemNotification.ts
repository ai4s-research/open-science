import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface PermissionNotificationInput {
  action: string;
  resources: string[];
}

function permissionBody(input: PermissionNotificationInput): string {
  const firstResource = input.resources[0];
  return firstResource ? `${input.action}\n${firstResource}` : input.action;
}

/** Native permission for notifications, requesting it the first time. Shared by
 *  every notification path so the ask happens once, not per call. */
async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  return granted;
}

export async function notifyPermissionRequest(input: PermissionNotificationInput): Promise<boolean> {
  if (!(await ensureNotificationPermission())) return false;

  try {
    sendNotification({
      title: "Open Science needs your approval",
      body: permissionBody(input),
    });
    return true;
  } catch {
    return false;
  }
}

/** A turn-finished notification. Title and body arrive ALREADY TRANSLATED — the
 *  caller (runtime.ts) owns the i18n keys, so this module stays a pure sender
 *  and every language gets its own copy. Off by default; only fires when the
 *  user enables it in Settings. */
export interface TurnCompleteNotificationInput {
  /** Translated title, e.g. "Turn complete" / "Turn failed" / "Turn interrupted". */
  title: string;
  /** Translated body, e.g. the session's title or a one-line summary. */
  body: string;
}

export async function notifyTurnComplete(input: TurnCompleteNotificationInput): Promise<boolean> {
  if (!(await ensureNotificationPermission())) return false;

  try {
    sendNotification({ title: input.title, body: input.body });
    return true;
  } catch {
    return false;
  }
}

/** Compact "time ago" like the reference UI: 37m · 18h · 3d · 1w · 9mo · 2y.
 *  Under a minute reads as "now". `now` is passed so a whole list formats
 *  against one instant instead of drifting row by row. */
export function timeAgo(ms: number | undefined, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (d < 30) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** Which heading a timestamp belongs under in a history list. Buckets are
 *  calendar-based (not "24 hours ago"), so a conversation from last night sits
 *  under Yesterday the way a person would file it. */
export type TimeBucket = "today" | "yesterday" | "week" | "month" | "older";

export function timeBucket(ms: number | undefined, now: number): TimeBucket {
  if (!ms) return "older";
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return "today";
  const day = 24 * 60 * 60 * 1000;
  if (ms >= startOfToday - day) return "yesterday";
  if (ms >= startOfToday - 7 * day) return "week";
  if (ms >= startOfToday - 30 * day) return "month";
  return "older";
}

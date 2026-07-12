import { cn } from "@/lib/cn";

/** The settings surfaces' shared text-input look (see SettingsPage). */
export const inputCls = (extra = "") =>
  cn(
    "h-9 rounded-input border border-border bg-surface px-3 text-[13px] text-text outline-none",
    "placeholder:text-muted focus:border-accent/60",
    extra,
  );

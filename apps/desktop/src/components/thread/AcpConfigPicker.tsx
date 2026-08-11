import type { AcpConfigOption } from "@ai4s/sdk/acp";
import { cn } from "@/lib/cn";

/**
 * The AGENT's own session selectors — model, reasoning level, permission mode —
 * as ACP v1 exposes them (`configOptions` + `session/set_config_option`).
 *
 * There is no catalog of ours behind this: the agent sends the list, we render
 * it in the order it gave (the spec makes that order its priority) and send the
 * chosen value back. Labels are the agent's own words and stay untranslated for
 * the same reason a model id does — they name things that exist on the agent,
 * not in this app.
 *
 * Boolean options never appear: they are only legal when the client advertises
 * `session.configOptions.boolean`, and we do not.
 */
export function AcpConfigPicker({
  options,
  onChange,
  disabled,
}: {
  options: AcpConfigOption[];
  onChange: (configId: string, value: string) => void;
  disabled?: boolean;
}) {
  const selectable = options.filter((o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0);
  if (selectable.length === 0) return null;
  return (
    <>
      {selectable.map((option) => (
        <select
          key={option.id}
          className={cn(
            "h-7 max-w-[9rem] shrink-0 rounded-input border border-transparent bg-transparent pl-2 text-[12px]",
            "text-muted outline-none transition-colors select-chrome",
            "hover:bg-surface-2 hover:text-text focus:border-accent/45 focus:bg-surface-2",
          )}
          aria-label={option.name ?? option.id}
          title={option.description ?? option.name ?? option.id}
          disabled={disabled}
          value={typeof option.currentValue === "string" ? option.currentValue : ""}
          onChange={(e) => onChange(option.id, e.target.value)}
        >
          {option.options?.map((value) => (
            <option key={value.value} value={value.value}>
              {value.name ?? value.value}
            </option>
          ))}
        </select>
      ))}
    </>
  );
}

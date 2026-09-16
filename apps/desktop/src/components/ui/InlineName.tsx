import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Rename in place: the name becomes an input, Enter or a click away commits it,
 * Escape puts it back.
 *
 * One component for every name the user can change — a Screen tab, a terminal,
 * a session — because renaming should feel the same wherever it is done, and
 * because the fiddly parts (select-on-open, commit-on-blur, not letting the
 * click reach whatever is underneath) are worth getting right once.
 */
export function InlineName({
  initial,
  placeholder,
  ariaLabel,
  className,
  onCommit,
  onCancel,
}: {
  initial: string;
  /** Shown when the name is empty — usually the derived name it falls back to. */
  placeholder: string;
  ariaLabel?: string;
  className?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      // The row underneath usually does something on click (focus a pane,
      // switch a Screen); typing in the field must not trigger it.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      className={cn(
        "h-5 w-28 rounded border border-border bg-surface px-1 text-[12px] text-text outline-none",
        className,
      )}
    />
  );
}

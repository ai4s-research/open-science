import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconThinkOutlineRegular,
} from "@/components/icons/dsh";
import { cn } from "@/lib/cn";
import type { ReasoningBlock } from "@ai4s/shared";
import css from "./ReasoningDisclosure.module.css";

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = window.requestAnimationFrame(() => setShown(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-300 ease-out",
        shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export const ReasoningDisclosure = memo(function ReasoningDisclosure({
  block,
}: {
  block: ReasoningBlock;
}) {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={css.title}
      >
        <span className={css.leading} aria-hidden="true">
          <span className={css.thinkIcon}>
            <IconThinkOutlineRegular />
          </span>
          <span className={css.chevron}>
            {open ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
          </span>
        </span>
        {/* A block in the thread is a finished thought; the live one is on
            the status row beside "Working…". */}
        <span className={css.label}>{t("reasoning.thought")}</span>
      </button>
      <Collapse open={open}>
        <pre className={css.body}>{block.text}</pre>
      </Collapse>
    </div>
  );
});

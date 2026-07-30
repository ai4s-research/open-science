import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookMarked, Copy, HelpCircle, Quote } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { appendMemory, isTauri } from "@/lib/tauri";

/** Longest excerpt carried into a follow-up or into memory. A whole answer
 *  pasted back would just re-fill the context this feature exists to save. */
const MAX = 4000;

interface Anchor {
  text: string;
  x: number;
  y: number;
}

/**
 * Actions on a piece of an answer (#63): select text in an agent reply and act
 * on it directly instead of copying it out and retyping the question.
 *
 * Selections outside an answer (tool output, your own messages, the composer)
 * are ignored — the toolbar would be noise there, and quoting your own words
 * back to the agent is not a thing anyone wants.
 */
export function SelectionActions({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation(["session", "common"]);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);
  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);

  useEffect(() => {
    const read = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.isCollapsed || !text) {
        setAnchor(null);
        return;
      }
      // Both ends must sit inside one answer: a drag that runs off the end of
      // a message into the next block is not a quote of anything coherent.
      const host = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest("[data-agent-message]") ??
        null;
      const from = host(sel.anchorNode);
      if (!from || from !== host(sel.focusNode)) {
        setAnchor(null);
        return;
      }
      // Geometry is only for placing the toolbar — never a reason to withhold
      // the actions if a webview declines to measure the range.
      let x = 0;
      let y = 0;
      try {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top;
      } catch {
        /* fall back to the top-left corner */
      }
      setAnchor({ text: text.slice(0, MAX), x, y });
    };
    // `selectionchange` fires mid-drag too; reading on pointer/key release is
    // enough and keeps the toolbar from flickering under the moving cursor.
    const onDown = (e: PointerEvent) => {
      if (bar.current?.contains(e.target as Node)) return; // clicking the toolbar
      setAnchor(null);
    };
    document.addEventListener("pointerup", read);
    document.addEventListener("keyup", read);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointerup", read);
      document.removeEventListener("keyup", read);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);

  const done = useCallback(() => {
    setAnchor(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  if (!anchor) return null;

  const quoted = anchor.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const ask = (lead: string) => {
    setComposerDraft(lead ? `${quoted}\n\n${lead}` : quoted);
    done();
  };

  // Memory follows the session's own folder: a passage worth keeping usually
  // belongs to that project, and falls back to global memory otherwise.
  const directory = sessions.find((s) => s.id === sessionId)?.directory;
  const project = projects.find((p) => p.path === directory);
  const remember = async () => {
    try {
      await appendMemory(
        project ? "project" : "global",
        project ? project.path : null,
        anchor.text,
      );
      toast.success(
        project
          ? t("selection.savedProject", { name: project.name })
          : t("selection.savedGlobal"),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    done();
  };

  const copy = async () => {
    try {
      await copyText(anchor.text);
      toast.success(t("message.copied"));
    } catch {
      toast.error(t("message.copyFailed"));
    }
    done();
  };

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t("selection.aria")}
      // Fixed to the viewport: the selection rect is measured there, and the
      // thread scrolls under it — clearing the selection closes it anyway.
      style={{ left: anchor.x, top: Math.max(8, anchor.y - 8) }}
      className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-card border border-border bg-surface p-1 text-[13px] shadow-pop"
    >
      <Action icon={<Quote size={14} />} label={t("selection.quote")} onClick={() => ask("")} />
      <Action
        icon={<HelpCircle size={14} />}
        label={t("selection.explain")}
        onClick={() => ask(t("selection.explainPrompt"))}
      />
      {isTauri && (
        <Action
          icon={<BookMarked size={14} />}
          label={t("selection.remember")}
          onClick={() => void remember()}
        />
      )}
      <Action icon={<Copy size={14} />} label={t("message.copy")} onClick={() => void copy()} />
    </div>
  );
}

function Action({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center gap-1.5 rounded-input px-2 py-1 text-text outline-none hover:bg-surface-2"
    >
      <span className="text-muted">{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

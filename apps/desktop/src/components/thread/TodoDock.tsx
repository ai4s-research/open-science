import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import type { TodoItem } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";

const NO_TODOS: TodoItem[] = [];

/**
 * The agent's task list, attached to the top of the composer like the queue.
 * Collapsed to one line of counts by default, so it informs without taking
 * the conversation's room; shaped after DeepSeek Harness's own todo dock.
 * Fed by ACP's `plan` and OpenCode's todo tool alike. Renders nothing when
 * the agent has made no list.
 */
export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("session");
  const todos = useRuntimeStore((s) => s.threads[sessionId]?.todos ?? NO_TODOS);
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;

  const count = (status: TodoItem["status"]) => todos.filter((item) => item.status === status).length;
  const progress = [
    ["done", count("completed")],
    ["active", count("in_progress")],
    ["pending", count("pending")],
  ] as const;

  return (
    <section
      aria-label={t("composer.todos.title")}
      className="mx-5 rounded-t-2xl border border-b-0 border-border/70 bg-surface-2 px-1.5 py-1"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-input py-0.5 pl-1.5 pr-1 text-left text-sm hover:text-text"
      >
        <ListChecks size={14} className="shrink-0 text-muted" aria-hidden />
        <span className="shrink-0 text-text">{t("composer.todos.title")}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {progress
            .filter(([, n]) => n > 0)
            .map(([key, n]) => t(`composer.todos.${key}`, { count: n }))
            .join(" · ")}
        </span>
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-muted" aria-hidden />
        ) : (
          <ChevronUp size={13} className="shrink-0 text-muted" aria-hidden />
        )}
      </button>
      {open && (
        <ul className="max-h-48 overflow-y-auto pb-1 pt-0.5">
          {todos.map((item, i) => (
            <li key={`${i}:${item.content}`} className="flex min-w-0 items-start gap-2 py-0.5 pl-1.5 text-sm">
              <span
                role="img"
                aria-label={t(`composer.todos.status.${item.status}`)}
                className="flex h-5 w-3.5 shrink-0 items-center justify-center"
              >
                <StatusMark status={item.status} />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  item.status === "completed" || item.status === "cancelled"
                    ? "text-muted"
                    : "text-text",
                  item.status === "cancelled" && "line-through",
                )}
              >
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") return <Check size={12} className="text-accent" />;
  if (status === "in_progress") return <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />;
  return <span className="h-2 w-2 rounded-full border border-muted" />;
}

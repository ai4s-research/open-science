import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Plus } from "lucide-react";
import { useDragPane } from "@/lib/dragPane";
import { DEFAULT_PROJECT, selectActiveProjectId, useLayoutStore } from "@/lib/layout";
import { rootSessionOf, startSessionScreen, useRuntimeStore } from "@/lib/runtime";
import { revealArtifact } from "@/lib/artifactFile";
import { openProjectFolder, workspaceBase } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { samePath } from "@/lib/workspacePath";
import { timeAgo } from "@/lib/relativeTime";
import { toast } from "@/lib/toast";
import { StateDot } from "@/components/icons/dsh/StateDot";
import { cn } from "@/lib/cn";

/** Recent conversations listed on a project's home. */
const RECENT = 6;

/** A path as people read it: the home folder as `~`. Display only — the full
 *  path stays in the tooltip. */
function tildePath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, "~");
}

/** The greeting for this time of day. */
function greetingKey(hour: number) {
  if (hour >= 5 && hour < 11) return "home.greeting.morning" as const;
  if (hour >= 11 && hour < 13) return "home.greeting.noon" as const;
  if (hour >= 13 && hour < 18) return "home.greeting.afternoon" as const;
  if (hour >= 18 && hour < 23) return "home.greeting.evening" as const;
  return "home.greeting.night" as const;
}

/**
 * A project's home: what a Screen shows when it holds nothing — the project's
 * last Screen closed, or a project opened for the first time. It says where
 * you are (the project, its folder, how much is in it), offers a new
 * conversation, and lists the latest ones to pick back up.
 *
 * A quiet, left-aligned page: type does the work — no illustration, no glow,
 * no card of identical icons. The one human touch is the greeting.
 *
 * It never fills itself: a Screen gets a conversation only when asked — the
 * button here, the bar's "+", ⌘T — or the last Screen could never be closed.
 * Still the drop target for a session dragged from the sidebar
 * (`data-empty-group`), lit while one hovers.
 */
export function EmptyGroup() {
  const { t } = useTranslation(["session", "nav"]);
  const navigate = useNavigate();
  const projectId = useLayoutStore(selectActiveProjectId);
  const project = useRuntimeStore((s) => s.projects.find((p) => p.id === projectId));
  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);
  const runningSessions = useRuntimeStore((s) => s.runningSessions);
  const sessionParents = useRuntimeStore((s) => s.sessionParents);
  const webReadOnly = useRuntimeStore((s) => s.webReadOnly);
  const hovering = useDragPane((s) => !!s.active && !!s.active.target && "empty" in s.active.target);
  // A project's Screen before the project list has loaded: say nothing rather
  // than flash Default's name and sessions in its place.
  const loading = projectId !== DEFAULT_PROJECT && !project;

  // Default's folder is the base one its dated session folders live under.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (!project) void workspaceBase().then(setBase).catch(() => {});
  }, [project]);
  const path = project?.path ?? base;

  // This project's conversations, newest first. Default's are the ones filed
  // in no project — the same split the sidebar makes.
  const mine = sessions
    .filter((s) => !s.parentId)
    .filter((s) =>
      project ? samePath(s.directory, project.path) : !projects.some((p) => samePath(s.directory, p.path)),
    )
    .sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
  const recent = mine.slice(0, RECENT);
  const busy = new Set(Object.keys(runningSessions).map((sid) => rootSessionOf(sessionParents, sid)));
  const now = Date.now();
  const isMac = navigator.userAgent.includes("Mac");

  const openFolder = () => {
    const done = project ? openProjectFolder(project.id) : revealArtifact("", "base");
    void done.catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  };
  const openSession = (id: string) => {
    useLayoutStore.getState().openSessionEphemeral(id, projectId);
    navigate(`/live/${id}`);
  };

  return (
    <div
      data-empty-group
      className={cn(
        "h-full w-full overflow-y-auto px-6 transition-colors sm:px-10",
        hovering && "bg-accent/10 ring-1 ring-inset ring-accent/50",
      )}
    >
      {!loading && (
        <div className="project-home mx-auto w-full max-w-[640px] pb-16 pt-[14vh]">
          <p className="text-sm text-muted">{t(greetingKey(new Date(now).getHours()))}</p>
          <h1 className="mt-1 truncate text-[26px] font-semibold leading-tight tracking-tight text-text">
            {/* Default is called what the Screen bar's project switcher calls it. */}
            {project?.name ?? t("group.defaultProject")}
          </h1>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-[13px] text-muted">
            {path && (
              <span className="min-w-0 truncate" title={path}>
                {tildePath(path)}
              </span>
            )}
            {path && <span aria-hidden>·</span>}
            <span className="shrink-0">
              {project ? t("home.count", { count: mine.length }) : t("home.countDefault", { count: mine.length })}
            </span>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {!webReadOnly && (
              <button
                onClick={() => void startSessionScreen(projectId)}
                aria-keyshortcuts={isMac ? "Meta+T" : "Control+T"}
                className="flex h-9 items-center gap-2 rounded-input bg-accent pl-3 pr-2.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
              >
                <Plus size={15} strokeWidth={2.25} />
                {t("nav:projects.newSession")}
                {/* eslint-disable-next-line i18next/no-literal-string -- keyboard shortcut, not UI copy */}
                <kbd aria-hidden className="ml-1 rounded bg-white/15 px-1.5 py-px font-sans text-[11px] font-normal">{isMac ? "⌘T" : "Ctrl T"}</kbd>
              </button>
            )}
            {!isGatewayWeb && path && (
              <button
                onClick={openFolder}
                className="flex h-9 items-center gap-2 rounded-input px-3 text-sm text-text transition-colors hover:bg-surface-2"
              >
                <FolderOpen size={15} className="text-muted" />
                {t("home.openFolder")}
              </button>
            )}
          </div>

          <div className="mt-12">
            <div className="flex items-baseline justify-between border-b border-border pb-2">
              <span className="text-[13px] font-medium text-text">{t("home.recent")}</span>
              {mine.length > RECENT && (
                <button onClick={() => navigate("/history")} className="text-[13px] text-muted hover:text-text">
                  {t("home.seeAll", { count: mine.length })}
                </button>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="py-6 text-sm text-muted">
                {project ? t("home.emptyProject") : t("home.emptyDefault")}
              </p>
            ) : (
              <ul>
                {recent.map((s) => (
                  <li key={s.id} className="border-b border-border/60 last:border-b-0">
                    <button
                      onClick={() => openSession(s.id)}
                      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-input px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{s.title}</span>
                      {/* On the right, by the time: a left column for it would
                          indent every title off the heading's edge. */}
                      {busy.has(s.id) && (
                        // eslint-disable-next-line i18next/no-literal-string -- StateDot state, not UI copy
                        <StateDot state="ongoing" />
                      )}
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {timeAgo(s.updated ?? s.created, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import {
  AppWindow,
  Coffee,
  MemoryStick,
  NotebookPen,
  Plug,
  Server,
  Terminal as TerminalIcon,
} from "lucide-react";
import {
  AWAKE_MODES,
  fetchPorts,
  fetchResources,
  formatBytes,
  holdAwake,
  kernelNotebookName,
  portUrl,
  shouldHoldAwake,
  storeAwakeMode,
  storedAwakeMode,
  type AwakeMode,
  type ListeningPort,
  type ResourceGroup,
  type ResourceUsage,
} from "@/lib/systemStatus";
import {
  isTauri,
  listSshHosts,
  openExternal,
  sshConnect,
  sshSessions,
  type SshSession,
} from "@/lib/tauri";
import { useRuntimeStore } from "@/lib/runtime";
import { leaves, useLayoutStore } from "@/lib/layout";
import { cn } from "@/lib/cn";

/**
 * The status bar's right-hand segments, borrowed from Orca's
 * (`CaffeinateStatusSegment`, `ResourceUsageStatusSegment`, `PortsStatusSegment`,
 * `SshStatusSegment`).
 *
 * All four follow the same shape, which is the point of a status bar: an icon
 * and one number, quiet until it is worth noticing, with the detail behind a
 * click. None of them is a panel; a panel would cost permanent space for
 * something read in passing.
 */

/** How often each segment re-reads.
 *
 *  Slow on purpose: these walk the process table and the open sockets, nobody
 *  watches a memory figure second by second, and work done for a number nobody
 *  is looking at is work taken from the thing they are. Opening a segment
 *  refreshes it immediately, which is when the figure actually matters. */
const POLL_MS = 60_000;

/** Poll while the app is open, and again whenever it regains focus — the work
 *  that changed these numbers usually ran while the window was behind
 *  something else. */
function usePolled<T>(read: () => Promise<T>, initial: T): [T, () => void] {
  const [value, setValue] = useState<T>(initial);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const run = () => void read().then((next) => alive && setValue(next)).catch(() => {});
    refresh.current = run;
    run();
    const timer = setInterval(run, POLL_MS);
    window.addEventListener("focus", run);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", run);
    };
    // The reader is recreated on every render; re-running the effect for that
    // would restart the timer each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, () => refresh.current()];
}

/** Shared chrome: a quiet segment that highlights on hover. */
function SegmentButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Popover.Trigger asChild>
      <button
        type="button"
        aria-label={label}
        title={label}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        {children}
      </button>
    </Popover.Trigger>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <Popover.Portal>
      <Popover.Content
        // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="z-50 w-[280px] overflow-hidden rounded-card border border-border bg-surface text-text shadow-pop"
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

function PanelTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 pb-2 pt-3">
      <span className="text-[13px] font-semibold">{title}</span>
      {note && <span className="text-[11px] text-muted">{note}</span>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3.5 pb-3 text-[12px] text-muted">{text}</p>;
}

// ─── Coffee: keep the machine awake ──────────────────────────────────

export function AwakeSegment() {
  const { t } = useTranslation("nav");
  const [mode, setMode] = useState<AwakeMode>(storedAwakeMode);
  // "Auto" means: while an agent is working. That is the whole reason the
  // setting exists — a long run the lid closes on is a wasted run.
  const working = useRuntimeStore((s) => Object.keys(s.runningSessions).length > 0);
  const active = shouldHoldAwake(mode, working);

  useEffect(() => {
    void holdAwake(active);
  }, [active]);

  // These segments report on THIS machine. Over the web gateway there is no
  // machine of ours to report on, so the segment is absent rather than showing
  // a zero that means nothing.
  if (!isTauri) return null;

  const choose = (next: AwakeMode) => {
    setMode(next);
    storeAwakeMode(next);
  };

  return (
    <Popover.Root>
      <SegmentButton label={`${t("status.awake.title")} — ${t(`status.awake.mode.${mode}`)}`}>
        <Coffee size={12} strokeWidth={1.5} className={cn(active && "text-text")} />
        <span className="text-[11px] font-medium">{t(`status.awake.mode.${mode}`)}</span>
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-text" : "bg-muted/40")}
        />
      </SegmentButton>
      <Panel>
        <PanelTitle
          title={t("status.awake.title")}
          note={t(active ? "status.awake.active" : "status.awake.inactive")}
        />
        <div role="radiogroup" aria-label={t("status.awake.title")} className="pb-1">
          {AWAKE_MODES.map((option) => (
            <button
              key={option}
              role="radio"
              aria-checked={mode === option}
              onClick={() => choose(option)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-3.5 py-2 text-left hover:bg-surface-2",
                mode === option && "bg-surface-2",
              )}
            >
              <span className="text-[13px]">{t(`status.awake.mode.${option}`)}</span>
              <span className="text-[11px] text-muted">{t(`status.awake.hint.${option}`)}</span>
            </button>
          ))}
        </div>
      </Panel>
    </Popover.Root>
  );
}

// ─── Resources: what this app is costing ─────────────────────────────

export function ResourceSegment() {
  const { t } = useTranslation("nav");
  const [usage, refresh] = usePolled<ResourceUsage | null>(fetchResources, null);
  if (!usage) return null;

  return (
    <Popover.Root onOpenChange={(open) => open && refresh()}>
      <SegmentButton label={t("status.resources.title")}>
        <MemoryStick size={12} strokeWidth={1.5} />
        <span className="text-[11px] font-medium tabular-nums">
          {formatBytes(usage.memoryBytes)}
        </span>
        <span className="text-muted/50">·</span>
        <TerminalIcon size={12} strokeWidth={1.5} />
        <span className="text-[11px] tabular-nums">{usage.processCount}</span>
      </SegmentButton>
      <Panel>
        <PanelTitle
          title={t("status.resources.title")}
          note={`${formatBytes(usage.memoryBytes)} · ${usage.processCount}`}
        />
        {/* A row per thing the user opened, heaviest first — the pane to go and
            look at, rather than a total to be annoyed by. */}
        <div className="pb-1">
          {usage.groups.map((group) => (
            <div key={`${group.kind}:${group.id}`} className="flex items-center gap-2 px-3.5 py-1.5">
              <GroupIcon kind={group.kind} />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {groupName(group, {
                  terminal: t("status.resources.terminal"),
                  app: t("status.resources.app"),
                })}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted">
                {group.cpuPercent >= 1 && (
                  <span className="mr-2">
                    {t("status.resources.cpu", { n: Math.round(group.cpuPercent) })}
                  </span>
                )}
                {formatBytes(group.memoryBytes)}
              </span>
            </div>
          ))}
        </div>
        <p className="border-t border-faint px-3.5 py-2 text-[11px] text-muted">
          {t("status.resources.note")}
        </p>
      </Panel>
    </Popover.Root>
  );
}

function GroupIcon({ kind }: { kind: string }) {
  const className = "shrink-0 text-muted";
  if (kind === "terminal") return <TerminalIcon size={12} strokeWidth={1.5} className={className} />;
  if (kind === "kernel") return <NotebookPen size={12} strokeWidth={1.5} className={className} />;
  return <AppWindow size={12} strokeWidth={1.5} className={className} />;
}

/** What to call a row. A terminal is called what the user named it — that is
 *  the point of naming it — and only falls back to the process the shell is
 *  running. */
function groupName(group: ResourceGroup, names: { terminal: string; app: string }): string {
  if (group.kind === "terminal") {
    return terminalPaneName(group.id) ?? group.label ?? names.terminal;
  }
  if (group.kind === "kernel") return kernelNotebookName(group.id);
  return names.app;
}

/** The name the user gave a terminal pane, from the layout. */
function terminalPaneName(leafId: string): string | null {
  for (const group of useLayoutStore.getState().groups) {
    if (!group.tree) continue;
    for (const leaf of leaves(group.tree)) {
      if (leaf.id === leafId && leaf.content?.kind === "terminal") return leaf.content.name ?? null;
    }
  }
  return null;
}

// ─── Ports: what the work has opened ─────────────────────────────────

export function PortsSegment() {
  const { t } = useTranslation("nav");
  const [ports, refresh] = usePolled<ListeningPort[]>(fetchPorts, []);
  if (!isTauri) return null;

  return (
    <Popover.Root onOpenChange={(open) => open && refresh()}>
      <SegmentButton label={t("status.ports.title")}>
        <Plug size={12} strokeWidth={1.5} />
        <span className="text-[11px] tabular-nums">{ports.length}</span>
      </SegmentButton>
      <Panel>
        <PanelTitle title={t("status.ports.title")} />
        {ports.length === 0 ? (
          <Empty text={t("status.ports.empty")} />
        ) : (
          <div className="pb-1">
            {ports.map((port) => (
              <button
                key={port.port}
                onClick={() => void openExternal(portUrl(port))}
                title={t("status.ports.openTitle", { url: portUrl(port) })}
                className="flex w-full items-center gap-2 px-3.5 py-2 text-left hover:bg-surface-2"
              >
                <span className="w-12 shrink-0 text-[13px] tabular-nums">{port.port}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  {port.command}
                </span>
                {port.public && (
                  // Worth saying out loud: this one is not just yours.
                  <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">
                    {t("status.ports.public")}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </Panel>
    </Popover.Root>
  );
}

// ─── Hosts: the machines this workbench reaches ──────────────────────

export function HostsSegment() {
  const { t } = useTranslation("nav");
  // Every host the machine KNOWS (~/.ssh/config), not only the ones with a live
  // session — as Orca does, which lists its whole target roster and marks each
  // one's state. A segment that only counts live connections is blank exactly
  // when you want to open one.
  const [known, refreshHosts] = usePolled<string[]>(listSshHosts, []);
  const [live, refreshSessions] = usePolled<SshSession[]>(sshSessions, []);
  /** Typed rather than a dynamic key: the four states are the only four, and a
   *  status the config grew tomorrow should not render as a missing string. */
  const statusLabel = (status: string) => {
    switch (status) {
      case "connected":
        return t("status.hosts.status.connected");
      case "connecting":
        return t("status.hosts.status.connecting");
      case "prompt":
        return t("status.hosts.status.prompt");
      case "failed":
        return t("status.hosts.status.failed");
      default:
        return t("status.hosts.status.disconnected");
    }
  };
  const statusOf = (host: string) => live.find((s) => s.host === host)?.status ?? "disconnected";
  const hosts = [...known]
    .map((host) => ({ host, status: statusOf(host) }))
    // Connected first: what you can reach right now is the useful half.
    .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"));
  const connected = hosts.filter((h) => h.status === "connected").length;
  if (!isTauri) return null;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) return;
        refreshHosts();
        refreshSessions();
      }}
    >
      <SegmentButton label={t("status.hosts.title")}>
        <Server size={12} strokeWidth={1.5} className={cn(connected > 0 && "text-ok")} />
        <span className="text-[11px] tabular-nums">
          {t("status.hosts.count", { count: connected })}
        </span>
      </SegmentButton>
      <Panel>
        <PanelTitle title={t("status.hosts.title")} />
        {hosts.length === 0 ? (
          <Empty text={t("status.hosts.empty")} />
        ) : (
          <div className="pb-1">
            {hosts.map((host) => (
              <button
                key={host.host}
                // A disconnected host is a thing you want to connect, so the
                // row does it. An already-connected one has nothing to do here.
                disabled={host.status !== "disconnected"}
                onClick={() => void sshConnect(host.host).catch(() => {})}
                title={host.status === "disconnected" ? t("status.hosts.connect") : undefined}
                className="flex w-full items-center gap-2 px-3.5 py-2 text-left enabled:hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    host.status === "connected"
                      ? "bg-ok"
                      : host.status === "failed"
                        ? "bg-error"
                        : "bg-muted/50",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">{host.host}</span>
                <span className="shrink-0 text-[11px] text-muted">
                  {statusLabel(host.status)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </Popover.Root>
  );
}

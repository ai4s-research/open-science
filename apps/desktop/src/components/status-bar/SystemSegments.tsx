import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import {
  AppWindow,
  Coffee,
  MemoryStick,
  NotebookPen,
  Loader2,
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
  computeProbe,
  isTauri,
  listSshHosts,
  openExternal,
  sshSessions,
  type ComputeProbe,
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
  // Every machine the config knows, not only the ones with a live session —
  // as Orca does, which lists its whole target roster. A segment that counts
  // only live connections is blank exactly when you want to open one.
  const [known, refreshHosts] = usePolled<string[]>(listSshHosts, []);
  const [live, refreshSessions] = usePolled<SshSession[]>(sshSessions, []);
  const openContentPane = useLayoutStore((s) => s.openContentPane);
  /** What each machine turned out to be, once asked. Kept for the session: a
   *  probe is an ssh round trip, and a machine's cores do not change. */
  const [probes, setProbes] = useState<Record<string, ComputeProbe | "asking">>({});

  const statusOf = (host: string) => live.find((s) => s.host === host)?.status ?? "disconnected";
  const hosts = [...known]
    .map((host) => ({ host, status: statusOf(host) }))
    // Connected first: what you can reach right now is the useful half.
    .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"));
  const connected = hosts.filter((h) => h.status === "connected").length;

  /** Machines already asked. A ref, not the state above: hovering a row fires
   *  several events in a row and the state a handler closed over is a render
   *  behind, so the state guard let three ssh round trips out per hover. */
  const asked = useRef(new Set<string>());

  /** Ask a machine what it is — on hover, once. */
  const probe = (host: string) => {
    if (asked.current.has(host)) return;
    asked.current.add(host);
    setProbes((p) => ({ ...p, [host]: "asking" }));
    void computeProbe(host)
      .then((result) => setProbes((p) => ({ ...p, [host]: result })))
      .catch(() => setProbes((p) => ({ ...p, [host]: { ...UNREACHABLE } })));
  };

  /** A shell on that machine, in a pane of its own.
   *
   *  `ssh <host>` typed into a real terminal rather than a connection opened
   *  invisibly: the user's own keys, their own agent, and any password or
   *  one-time code prompt lands somewhere they can answer it. Clicking a host
   *  used to start a shared connection with nothing on screen to show for it,
   *  which is why it looked like nothing had happened. */
  const openShell = (host: string) => {
    openContentPane({
      // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
      kind: "terminal",
      name: host,
      command: `ssh ${host}`,
    });
  };

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
          {t("status.hosts.count", { count: hosts.length })}
        </span>
      </SegmentButton>
      <Panel>
        <PanelTitle title={t("status.hosts.title")} note={t("status.hosts.hint")} />
        {hosts.length === 0 ? (
          <Empty text={t("status.hosts.empty")} />
        ) : (
          <div className="max-h-[22rem] overflow-y-auto pb-1">
            {hosts.map(({ host, status }) => (
              <HostRow
                key={host}
                host={host}
                status={status}
                probe={probes[host]}
                onHover={() => probe(host)}
                onOpen={() => openShell(host)}
              />
            ))}
          </div>
        )}
      </Panel>
    </Popover.Root>
  );
}

const UNREACHABLE: ComputeProbe = {
  reachable: false,
  message: null,
  needs_sign_in: false,
  os: null,
  cores: null,
  load1: null,
  mem_total_bytes: null,
  mem_avail_bytes: null,
  disk_total_bytes: null,
  disk_free_bytes: null,
  gpus: [],
  slurm: null,
};

/** One machine: its name, and — once hovered — what it actually is. */
function HostRow({
  host,
  status,
  probe,
  onHover,
  onOpen,
}: {
  host: string;
  status: string;
  probe: ComputeProbe | "asking" | undefined;
  onHover: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation("nav");
  const asking = probe === "asking";
  const known = probe && probe !== "asking" ? probe : null;
  const reachable = known?.reachable ?? (status === "connected" ? true : null);

  return (
    <button
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onOpen}
      title={t("status.hosts.openShell", { host })}
      className="flex w-full flex-col gap-0.5 px-3.5 py-2 text-left hover:bg-surface-2"
    >
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            reachable === true ? "bg-ok" : reachable === false ? "bg-error" : "bg-muted/50",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{host}</span>
        {asking && <Loader2 size={11} className="shrink-0 animate-spin text-muted" />}
      </span>
      {/* What the machine IS, under its name. The question a roster of hosts
          has to answer is "which one has the GPU", and a column of
          "not connected" answered nothing. */}
      {known && (
        <span className="pl-3.5 text-[11px] text-muted">
          {known.reachable
            ? describeMachine(known, {
                cores: (n) => t("status.hosts.cores", { n }),
                disk: (free, total) => t("status.hosts.disk", { free, total }),
              })
            : (known.message ?? t("status.hosts.unreachable"))}
        </span>
      )}
    </button>
  );
}

/** Cores, memory, disk and GPUs on one line — in that order, because that is
 *  the order the question is usually asked in. */
function describeMachine(
  probe: ComputeProbe,
  say: { cores: (n: number) => string; disk: (free: string, total: string) => string },
): string {
  const parts: string[] = [];
  if (probe.cores) parts.push(say.cores(probe.cores));
  if (probe.mem_total_bytes) {
    parts.push(
      probe.mem_avail_bytes
        ? `${formatBytes(probe.mem_avail_bytes)} / ${formatBytes(probe.mem_total_bytes)}`
        : formatBytes(probe.mem_total_bytes),
    );
  }
  if (probe.disk_free_bytes && probe.disk_total_bytes) {
    parts.push(say.disk(formatBytes(probe.disk_free_bytes), formatBytes(probe.disk_total_bytes)));
  }
  for (const gpu of probe.gpus) {
    parts.push(gpu.mem_total_mib ? `${gpu.name} ${gpu.util_pct}%` : gpu.name);
  }
  if (probe.slurm) parts.push(probe.slurm);
  return parts.join(" · ");
}

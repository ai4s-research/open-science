import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, LogIn, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  addComputeMachine,
  computeCancel,
  computeJobs,
  computeMachines,
  computeProbe,
  isTauri,
  listSshHosts,
  removeComputeMachine,
  type ComputeJob,
  type ComputeProbe,
  type GpuInfo,
  type Machine,
} from "@/lib/tauri";
import { isSignedIn, useSshStore } from "@/lib/ssh";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { inputCls } from "./inputCls";
import { Section } from "./Section";

/** The `t` type the plain (non-component) helpers below take as a parameter. */
type TFn = TFunction<["settings", "common"]>;

/**
 * Remote compute over SSH. Connect any machine you can SSH to (CPU or GPU;
 * Slurm optional). Each machine shows capability chips and an expandable
 * detail: a usage snapshot (non-Slurm) or the Slurm queue (Slurm). The chosen
 * host is recorded in .openscience/compute.json for the remote-compute skill.
 */
export function RemoteComputeCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Per-host live probe + expand/queue state, keyed by host.
  const [probes, setProbes] = useState<Record<string, ComputeProbe | "loading">>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, ComputeJob[] | null>>({});
  // Shared-connection state per host (#73): which machines the user is signed
  // in to, and whether this platform can share a connection at all.
  const sshSessions = useSshStore((s) => s.sessions);
  const sharingSupported = useSshStore((s) => s.sharingSupported);
  const signIn = useSshStore((s) => s.connect);
  const signOut = useSshStore((s) => s.disconnect);

  // A finished sign-in turns a host that answered "permission denied" into a
  // working one — re-probe it so the row shows real capabilities rather than
  // the sign-in prompt the user just satisfied.
  const connectedHosts = Object.values(sshSessions)
    .filter((s) => s.status === "connected")
    .map((s) => s.host)
    .sort()
    .join(",");

  const probe = useCallback(async (host: string) => {
    setProbes((p) => ({ ...p, [host]: "loading" }));
    try {
      const result = await computeProbe(host);
      setProbes((p) => ({ ...p, [host]: result }));
      // The shared connection expired (its persist window elapsed, the VPN
      // dropped, the laptop slept): the host is asking for credentials again, so
      // drop the stale "signed in" state — otherwise the row keeps claiming a
      // connection that is gone and hides the way to get it back (#73).
      if (result.needs_sign_in && useSshStore.getState().sessions[host]) {
        void useSshStore.getState().disconnect(host);
      }
      // Read the queue only for Slurm hosts — no queue exists otherwise.
      if (result.slurm) {
        // A Slurm host's detail *is* the queue — open it by default.
        setExpanded((e) => ({ ...e, [host]: true }));
        try {
          const list = await computeJobs(host);
          setJobs((j) => ({ ...j, [host]: list }));
        } catch {
          setJobs((j) => ({ ...j, [host]: null }));
        }
      }
    } catch (e) {
      setProbes((p) => ({
        ...p,
        [host]: { reachable: false, message: e instanceof Error ? e.message : String(e) } as ComputeProbe,
      }));
    }
  }, []);

  const loadMachines = useCallback(async () => {
    const list = await computeMachines().catch(() => []);
    setMachines(list);
    list.forEach((m) => void probe(m.host));
  }, [probe]);

  useEffect(() => {
    if (!isTauri) return;
    void listSshHosts().then(setHosts).catch(() => undefined);
    void loadMachines();
  }, [loadMachines]);

  useEffect(() => {
    for (const host of connectedHosts ? connectedHosts.split(",") : []) {
      void probe(host);
    }
  }, [connectedHosts, probe]);

  const add = async () => {
    const host = draft.trim();
    if (!host) return;
    setAdding(true);
    setAddError(null);
    try {
      await addComputeMachine(host, undefined);
      setDraft("");
      await loadMachines(); // probes every listed machine, including this new host
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (host: string) => {
    try {
      await removeComputeMachine(host);
      setMachines((m) => m.filter((x) => x.host !== host));
    } catch (e) {
      toast.error(`${t("toast.couldNotRemove")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const cancel = async (host: string, id: string) => {
    try {
      await computeCancel(host, id);
    } catch (e) {
      toast.error(
        `${t("remoteCompute.toast.couldNotCancel", { id })}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    toast.success(t("remoteCompute.toast.jobCanceled", { id }));
    // The cancel itself succeeded; a refetch failure just leaves the queue
    // stale, same as probe()'s jobs failure — it must not read as a cancel error.
    try {
      const list = await computeJobs(host);
      setJobs((j) => ({ ...j, [host]: list }));
    } catch {
      setJobs((j) => ({ ...j, [host]: null }));
    }
  };

  return (
    <Section title={t("remoteCompute.title")} hint={t("remoteCompute.subtitle")} flush>
        {!isTauri ? (
          <p className="px-4 py-3 text-[13px] text-muted">{t("remoteCompute.unavailable")}</p>
        ) : (
          <>
            <div>
              {machines.length === 0 && (
                <p className="bg-surface px-3 py-2.5 text-[13px] text-muted">
                  {t("remoteCompute.empty")}
                </p>
              )}
              {machines.map((m, i) => (
                <MachineRow
                  key={m.host}
                  machine={m}
                  probe={probes[m.host]}
                  expanded={!!expanded[m.host]}
                  jobs={jobs[m.host]}
                  first={i === 0}
                  onToggle={() => setExpanded((e) => ({ ...e, [m.host]: !e[m.host] }))}
                  onRefresh={() => void probe(m.host)}
                  onRemove={() => void remove(m.host)}
                  onCancel={(id) => void cancel(m.host, id)}
                  signedIn={isSignedIn(sshSessions, m.host)}
                  sharingSupported={sharingSupported !== false}
                  onSignIn={() => void signIn(m.host)}
                  onSignOut={async () => {
                    await signOut(m.host);
                    void probe(m.host);
                  }}
                />
              ))}
              <div className={cn("p-3", machines.length > 0 && "border-t border-faint")}>
                <div className="flex items-center gap-2">
                  <input
                    list="ssh-hosts"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void add()}
                    placeholder={
                      hosts.length > 0
                        ? t("remoteCompute.hostPlaceholderWithHosts", { count: hosts.length })
                        : t("remoteCompute.hostPlaceholder")
                    }
                    className={inputCls("flex-1 font-mono")}
                  />
                  <datalist id="ssh-hosts">
                    {hosts.map((h) => (
                      <option key={h} value={h} />
                    ))}
                  </datalist>
                  <button className={btnAccent()} onClick={() => void add()} disabled={adding || !draft.trim()}>
                    {adding ? <Loader2 size={12} className="animate-spin" /> : null}
                    {adding ? t("remoteCompute.adding") : t("remoteCompute.add")}
                  </button>
                </div>
                {addError && <p className="mt-2 text-xs text-error">{addError}</p>}
              </div>
            </div>
          </>
        )}
    </Section>
  );
}

function MachineRow({
  machine,
  probe,
  expanded,
  jobs,
  first,
  onToggle,
  onRefresh,
  onRemove,
  onCancel,
  signedIn,
  sharingSupported,
  onSignIn,
  onSignOut,
}: {
  machine: Machine;
  probe: ComputeProbe | "loading" | undefined;
  expanded: boolean;
  jobs: ComputeJob[] | null | undefined;
  first: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  onCancel: (id: string) => void;
  signedIn: boolean;
  sharingSupported: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const loading = probe === "loading" || probe === undefined;
  const p = typeof probe === "object" ? probe : null;
  const reachable = !!p?.reachable;
  // The host answered but wants credentials interactively. Offering a sign-in
  // beats showing an ssh error the user cannot act on — but only where one
  // authenticated connection can actually be shared with everything after it.
  const needsSignIn = !!p?.needs_sign_in && sharingSupported;
  const chips = p && reachable ? capabilityChips(p, t) : [];
  return (
    <div className={cn("bg-surface", !first && "border-t border-faint")}>
      <div className="flex items-center gap-2.5 px-3 py-2.5 text-[13px]">
        <button
          className="shrink-0 text-muted transition-colors hover:text-text"
          onClick={onToggle}
          aria-label={expanded ? t("remoteCompute.collapse") : t("remoteCompute.expand")}
        >
          <ChevronRight size={13} className={cn("transition-transform", expanded && "rotate-90")} />
        </button>
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            loading ? "bg-muted" : reachable ? "bg-ok" : "bg-error",
          )}
        />
        <span className="font-mono font-medium text-text">{machine.label || machine.host}</span>
        {machine.label && <span className="text-xs text-muted">{machine.host}</span>}
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {loading
            ? t("remoteCompute.checking")
            : reachable
              ? [signedIn ? t("remoteCompute.signedIn") : null, ...chips].filter(Boolean).join(" · ")
              : needsSignIn
                ? t("remoteCompute.signInRequired")
                : !!p?.needs_sign_in && !sharingSupported
                  ? t("remoteCompute.sharingUnavailable")
                  : p?.message ?? t("remoteCompute.unreachable")}
        </span>
        {needsSignIn && !signedIn && (
          <button
            className="flex shrink-0 items-center gap-1 rounded-input bg-accent px-2 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
            onClick={onSignIn}
          >
            <LogIn size={12} /> {t("remoteCompute.signIn")}
          </button>
        )}
        {signedIn && (
          <button
            className="shrink-0 text-xs text-muted transition-colors hover:text-text"
            onClick={onSignOut}
            title={t("remoteCompute.signOutTitle")}
          >
            {t("remoteCompute.signOut")}
          </button>
        )}
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text"
          onClick={onRefresh}
          title={t("remoteCompute.reprobeTitle")}
          aria-label={t("remoteCompute.reprobeTitle")}
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
        <button
          className="shrink-0 text-xs text-muted transition-colors hover:text-error"
          onClick={onRemove}
          title={t("remoteCompute.removeTitle")}
        >
          {t("common:actions.remove")}
        </button>
      </div>
      {expanded && reachable && p && (
        <div className="border-t border-faint px-3 py-2.5">
          {p.slurm ? (
            <SlurmQueue jobs={jobs} onCancel={onCancel} />
          ) : (
            <UsageSnapshot p={p} />
          )}
        </div>
      )}
    </div>
  );
}

function UsageSnapshot({ p }: { p: ComputeProbe }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="space-y-1.5 text-xs text-muted">
      {p.cores != null && p.load1 != null && (
        <div>
          <span className="text-text">{t("remoteCompute.usage.cpuLoad")}</span> {p.load1.toFixed(2)} /{" "}
          {t("remoteCompute.chips.cores", { count: p.cores })}
        </div>
      )}
      {p.mem_total_bytes != null && (
        <div>
          <span className="text-text">{t("remoteCompute.usage.memory")}</span>{" "}
          {fmtBytes((p.mem_total_bytes ?? 0) - (p.mem_avail_bytes ?? 0))} / {fmtBytes(p.mem_total_bytes)}
        </div>
      )}
      {p.gpus.map((g, i) => (
        <div key={i}>
          {/* eslint-disable-next-line i18next/no-literal-string -- unit/format glue ("%", "/", "GB"), not prose; consistent with the rest of this card */}
          <span className="text-text">{g.name}</span> {g.util_pct}% ·{" "}
          {Math.round(g.mem_used_mib / 1024)} / {Math.round(g.mem_total_mib / 1024)} GB
        </div>
      ))}
      {p.disk_free_bytes != null && p.disk_total_bytes != null && (
        <div>
          <span className="text-text">{t("remoteCompute.usage.disk")}</span>{" "}
          {t("remoteCompute.chips.diskFree", { size: fmtBytes(p.disk_free_bytes) })} /{" "}
          {fmtBytes(p.disk_total_bytes)}
        </div>
      )}
    </div>
  );
}

function SlurmQueue({
  jobs,
  onCancel,
}: {
  jobs: ComputeJob[] | null | undefined;
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  if (jobs === undefined) return <p className="text-xs text-muted">{t("remoteCompute.slurm.readingQueue")}</p>;
  if (jobs === null) return <p className="text-xs text-muted">{t("remoteCompute.slurm.queueUnavailable")}</p>;
  if (jobs.length === 0) return <p className="text-xs text-muted">{t("remoteCompute.slurm.noJobs")}</p>;
  return (
    <div className="space-y-1">
      {jobs.map((j) => (
        <div key={j.id} className="flex items-center gap-2.5 text-[13px]">
          <span className="font-mono text-xs text-muted">{j.id}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-border",
              j.state === "RUNNING" ? "text-ok" : j.state === "PENDING" ? "text-warn" : "text-muted",
            )}
          >
            {j.state}
          </span>
          <span className="min-w-0 flex-1 truncate text-text">{j.name}</span>
          <span className="font-mono text-xs text-muted">{j.time}</span>
          <span className="text-xs text-muted">{j.partition}</span>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error"
            onClick={() => onCancel(j.id)}
            title={t("remoteCompute.slurm.cancelJob", { id: j.id })}
            aria-label={t("remoteCompute.slurm.cancelJob", { id: j.id })}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Collapsed identity chips, e.g. ["16 cores", "64 GB", "2× RTX 3090", "1.2 TB free"]. */
function capabilityChips(p: ComputeProbe, t: TFn): string[] {
  const chips: string[] = [];
  if (p.cores != null) chips.push(t("remoteCompute.chips.cores", { count: p.cores }));
  if (p.mem_total_bytes != null) chips.push(fmtBytes(p.mem_total_bytes));
  const gpu = gpuSummary(p.gpus, t);
  if (gpu) chips.push(gpu);
  if (p.disk_free_bytes != null) {
    chips.push(t("remoteCompute.chips.diskFree", { size: fmtBytes(p.disk_free_bytes) }));
  }
  if (p.slurm) chips.push(p.slurm.replace(/^slurm\s*/i, t("remoteCompute.chips.slurmPrefix")));
  return chips;
}

function gpuSummary(gpus: GpuInfo[], t: TFn): string | null {
  if (gpus.length === 0) return null;
  const name = gpus[0].name;
  return gpus.every((g) => g.name === name)
    ? t("remoteCompute.chips.gpuHomogeneous", { count: gpus.length, name })
    : t("remoteCompute.chips.gpuMixed", { count: gpus.length });
}

/** Bytes → short human string: 64 GB, 1.2 TB, 400 GB. */
function fmtBytes(n: number | null): string {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}


// Color-based hover/disabled, never `opacity` (which flickers in WKWebView).
const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );

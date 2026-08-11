import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeProbe, ComputeJob, Machine, SshSession } from "@/lib/tauri";
import { useSshStore } from "@/lib/ssh";
import { RemoteComputeCard } from "./RemoteComputeCard";

const bridge = {
  listSshHosts: vi.fn<() => Promise<string[]>>(),
  computeMachines: vi.fn<() => Promise<Machine[]>>(),
  addComputeMachine: vi.fn<(h: string, l?: string) => Promise<void>>(),
  removeComputeMachine: vi.fn<(h: string) => Promise<void>>(),
  computeProbe: vi.fn<(h: string) => Promise<ComputeProbe>>(),
  computeJobs: vi.fn<(h: string) => Promise<ComputeJob[]>>(),
  computeCancel: vi.fn<(h: string, id: string) => Promise<void>>(),
  sshConnect: vi.fn<(h: string) => Promise<void>>(),
  sshDisconnect: vi.fn<(h: string) => Promise<void>>(),
  sshAnswer: vi.fn<(h: string, s: string) => Promise<void>>(),
  sshSessions: vi.fn<() => Promise<SshSession[]>>(),
  sshSharingSupported: vi.fn<() => Promise<boolean>>(),
};

vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  listSshHosts: (...a: []) => bridge.listSshHosts(...a),
  computeMachines: (...a: []) => bridge.computeMachines(...a),
  addComputeMachine: (...a: [string, string?]) => bridge.addComputeMachine(...a),
  removeComputeMachine: (...a: [string]) => bridge.removeComputeMachine(...a),
  computeProbe: (...a: [string]) => bridge.computeProbe(...a),
  computeJobs: (...a: [string]) => bridge.computeJobs(...a),
  computeCancel: (...a: [string, string]) => bridge.computeCancel(...a),
  sshConnect: (...a: [string]) => bridge.sshConnect(...a),
  sshDisconnect: (...a: [string]) => bridge.sshDisconnect(...a),
  sshAnswer: (...a: [string, string]) => bridge.sshAnswer(...a),
  sshSessions: (...a: []) => bridge.sshSessions(...a),
  sshSharingSupported: (...a: []) => bridge.sshSharingSupported(...a),
}));

const gpuProbe: ComputeProbe = {
  reachable: true, message: null, needs_sign_in: false, os: "Linux 6.5", cores: 16, load1: 1.2,
  mem_total_bytes: 67_516_000_000, mem_avail_bytes: 55_000_000_000,
  disk_total_bytes: 2_000_000_000_000, disk_free_bytes: 1_200_000_000_000,
  gpus: [
    { name: "RTX 3090", mem_total_mib: 24576, mem_used_mib: 8100, util_pct: 40 },
    { name: "RTX 3090", mem_total_mib: 24576, mem_used_mib: 0, util_pct: 0 },
  ],
  slurm: null,
};
const slurmProbe: ComputeProbe = { ...gpuProbe, gpus: [], slurm: "slurm 23.11.4" };

describe("RemoteComputeCard", () => {
  beforeEach(() => {
    Object.values(bridge).forEach((f) => f.mockReset());
    bridge.listSshHosts.mockResolvedValue(["home-3090"]);
    bridge.sshSessions.mockResolvedValue([]);
    bridge.sshSharingSupported.mockResolvedValue(true);
    bridge.sshConnect.mockResolvedValue(undefined);
    bridge.sshDisconnect.mockResolvedValue(undefined);
    useSshStore.setState({ sessions: {}, sharingSupported: true, dialogHost: null });
  });

  it("lists a non-Slurm machine with capability chips and never reads the queue", async () => {
    bridge.computeMachines.mockResolvedValue([{ host: "home-3090", label: "8x3090", caps: null }]);
    bridge.computeProbe.mockResolvedValue(gpuProbe);
    render(<RemoteComputeCard />);

    expect(await screen.findByText("home-3090")).toBeInTheDocument();
    expect(await screen.findByText(/16 cores/)).toBeInTheDocument();
    expect(screen.getByText(/2× RTX 3090/)).toBeInTheDocument();
    expect(bridge.computeJobs).not.toHaveBeenCalled();
  });

  it("adds a machine then probes it via the post-add machine list refetch", async () => {
    // No separate probe call after add — loadMachines() re-fetches the machine
    // list (now including the new host) and probes everything it lists.
    bridge.computeMachines.mockResolvedValueOnce([]); // initial load: none
    bridge.computeMachines.mockResolvedValueOnce([{ host: "home-3090", label: null, caps: null }]); // post-add
    bridge.addComputeMachine.mockResolvedValue();
    bridge.computeProbe.mockResolvedValue(gpuProbe);
    render(<RemoteComputeCard />);

    await userEvent.type(screen.getByRole("combobox"), "home-3090");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(bridge.addComputeMachine).toHaveBeenCalledWith("home-3090", undefined));
    expect(bridge.computeMachines).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(bridge.computeProbe).toHaveBeenCalledWith("home-3090"));
  });

  it("shows the Slurm queue for a Slurm machine", async () => {
    bridge.computeMachines.mockResolvedValue([{ host: "login-a", label: null, caps: null }]);
    bridge.computeProbe.mockResolvedValue(slurmProbe);
    bridge.computeJobs.mockResolvedValue([
      { id: "42", state: "RUNNING", time: "1:23", partition: "gpu", name: "fit-model" },
    ]);
    render(<RemoteComputeCard />);

    expect(await screen.findByText(/Slurm/)).toBeInTheDocument();
    await waitFor(() => expect(bridge.computeJobs).toHaveBeenCalledWith("login-a"));
    expect(await screen.findByText("fit-model")).toBeInTheDocument();
  });
  // #73: a cluster that wants a password or a one-time code answers ssh with a
  // refusal, not with data. The row must offer a sign-in instead of an error the
  // user cannot act on.
  it("offers a sign-in when the machine asks for credentials, and re-probes once signed in", async () => {
    const refused: ComputeProbe = {
      ...gpuProbe,
      reachable: false,
      needs_sign_in: true,
      message: "this machine asks for a password or a one-time code",
      gpus: [],
    };
    bridge.computeMachines.mockResolvedValue([{ host: "hpc-login", label: null, caps: null }]);
    bridge.computeProbe.mockResolvedValue(refused);
    render(<RemoteComputeCard />);

    const signIn = await screen.findByRole("button", { name: /Sign in/ });
    expect(screen.getByText(/sign-in required/)).toBeInTheDocument();
    await userEvent.click(signIn);
    await waitFor(() => expect(bridge.sshConnect).toHaveBeenCalledWith("hpc-login"));

    // The sign-in succeeds: the row re-probes itself, so it stops showing the
    // prompt the user just satisfied.
    bridge.computeProbe.mockResolvedValue(gpuProbe);
    act(() =>
      useSshStore.setState({
        sessions: {
          "hpc-login": { host: "hpc-login", status: "connected", prompt: null, notice: null, error: null },
        },
      }),
    );
    await waitFor(() => expect(bridge.computeProbe).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/signed in/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });

  it("says so plainly where one connection cannot be shared, instead of a sign-in that would not stick", async () => {
    // Windows' bundled OpenSSH has no ControlMaster: signing in would have to be
    // repeated for every single command, so the control is not offered at all.
    useSshStore.setState({ sharingSupported: false });
    bridge.computeMachines.mockResolvedValue([{ host: "hpc-login", label: null, caps: null }]);
    bridge.computeProbe.mockResolvedValue({
      ...gpuProbe,
      reachable: false,
      needs_sign_in: true,
      message: "this machine asks for a password or a one-time code",
      gpus: [],
    });
    render(<RemoteComputeCard />);

    expect(await screen.findByText(/OpenSSH connection sharing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });

  it("hands back the shared connection on Sign out", async () => {
    bridge.computeMachines.mockResolvedValue([{ host: "hpc-login", label: null, caps: null }]);
    bridge.computeProbe.mockResolvedValue(gpuProbe);
    useSshStore.setState({
      sessions: {
        "hpc-login": { host: "hpc-login", status: "connected", prompt: null, notice: null, error: null },
      },
    });
    render(<RemoteComputeCard />);

    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(bridge.sshDisconnect).toHaveBeenCalledWith("hpc-login"));
  });
  it("drops a stale sign-in when the shared connection has expired", async () => {
    // The persist window elapsed while the app was idle: the host asks for
    // credentials again, so the row must stop claiming a live connection.
    bridge.computeMachines.mockResolvedValue([{ host: "hpc-login", label: null, caps: null }]);
    bridge.computeProbe.mockResolvedValue({
      ...gpuProbe,
      reachable: false,
      needs_sign_in: true,
      message: "this machine asks for a password or a one-time code",
      gpus: [],
    });
    useSshStore.setState({
      sessions: {
        "hpc-login": { host: "hpc-login", status: "connected", prompt: null, notice: null, error: null },
      },
    });
    render(<RemoteComputeCard />);

    await waitFor(() => expect(bridge.sshDisconnect).toHaveBeenCalledWith("hpc-login"));
    expect(await screen.findByRole("button", { name: /Sign in/ })).toBeInTheDocument();
    expect(screen.queryByText(/signed in/)).toBeNull();
  });
});

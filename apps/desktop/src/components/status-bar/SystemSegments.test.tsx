import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { formatBytes, shouldHoldAwake } from "@/lib/systemStatus";
import { AwakeSegment, HostsSegment, PortsSegment, ResourceSegment } from "./SystemSegments";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const openExternal = vi.fn();
const sshSessions = vi.fn(async () => [] as unknown[]);
const listSshHosts = vi.fn(async () => [] as string[]);
const sshConnect = vi.fn(async (_host: string) => {});
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
  openExternal: (url: string) => openExternal(url),
  sshSessions: () => sshSessions(),
  listSshHosts: () => listSshHosts(),
  sshConnect: (host: string) => sshConnect(host),
}));

describe("keeping the machine awake", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useRuntimeStore.setState({ runningSessions: {} });
  });

  it("holds nothing until asked", () => {
    expect(shouldHoldAwake("off", true)).toBe(false);
    expect(shouldHoldAwake("on", false)).toBe(true);
  });

  it("auto means: while an agent is working", () => {
    // The whole reason the setting exists — a long run the lid closes on is a
    // wasted run.
    expect(shouldHoldAwake("auto", false)).toBe(false);
    expect(shouldHoldAwake("auto", true)).toBe(true);
  });

  it("starts holding the moment an agent starts working, in Auto", async () => {
    render(<AwakeSegment />);
    await userEvent.click(screen.getByRole("button", { name: /Keep awake/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Auto/ }));

    invoke.mockClear();
    useRuntimeStore.setState({ runningSessions: { s1: true } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("awake_hold", { on: true }));
  });

  it("remembers the mode, because it is a standing preference", async () => {
    render(<AwakeSegment />);
    await userEvent.click(screen.getByRole("button", { name: /Keep awake/ }));
    await userEvent.click(screen.getByRole("radio", { name: /^On/ }));

    expect(window.localStorage.getItem("ai4s.awake.mode.v1")).toBe("on");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("awake_hold", { on: true }));
  });
});

describe("what the workbench is costing", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    invoke.mockResolvedValue({
      memoryBytes: 13_200_000_000,
      processCount: 19,
      cpuPercent: 12,
      groups: [
        { kind: "terminal", id: "p7", label: "cargo", memoryBytes: 9_000_000_000, cpuPercent: 80, processCount: 3 },
        { kind: "kernel", id: "python:/ws/whale.ipynb", label: "python", memoryBytes: 3_000_000_000, cpuPercent: 2, processCount: 1 },
        { kind: "app", id: "", label: "", memoryBytes: 1_200_000_000, cpuPercent: 0.4, processCount: 15 },
      ],
    });
  });

  it("reads in GB, with the process count beside it", async () => {
    render(<ResourceSegment />);

    expect(await screen.findByText("12.29 GB")).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("says whose processes these are", async () => {
    render(<ResourceSegment />);
    await userEvent.click(await screen.findByRole("button", { name: "Resources" }));

    // Whose processes these are is worth one line; the rest was explaining.
    expect(await screen.findByText("This app and everything it started.")).toBeInTheDocument();
  });

  it("breaks the total down by what the user opened", async () => {
    render(<ResourceSegment />);
    await userEvent.click(await screen.findByRole("button", { name: "Resources" }));
    const panel = within(await screen.findByRole("dialog"));

    // A total says the workbench is heavy; a row says WHICH pane to go and look
    // at. The terminal row is named after the heaviest process in it, and the
    // notebook row after its file.
    expect(panel.getByText("cargo")).toBeInTheDocument();
    expect(panel.getByText("whale.ipynb")).toBeInTheDocument();
    expect(panel.getByText("8.38 GB")).toBeInTheDocument();
    expect(panel.getByText("80% CPU")).toBeInTheDocument();
  });

  it("leaves the CPU column off a row that is doing nothing", async () => {
    render(<ResourceSegment />);
    await userEvent.click(await screen.findByRole("button", { name: "Resources" }));
    const panel = within(await screen.findByRole("dialog"));

    // 0.4% is noise; printing it would make every idle row look busy.
    expect(panel.queryByText("0% CPU")).not.toBeInTheDocument();
  });

  it("rounds to MB below a gigabyte", () => {
    expect(formatBytes(840 * 1024 * 1024)).toBe("840 MB");
  });
});

describe("ports the work has opened", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    openExternal.mockClear();
    invoke.mockResolvedValue([
      { port: 8888, pid: 900, command: "jupyter", public: false },
      { port: 4000, pid: 901, command: "node", public: true },
    ]);
  });

  it("counts them on the bar and opens one on a click", async () => {
    render(<PortsSegment />);
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Ports" }));
    await userEvent.click(await screen.findByText("8888"));

    expect(openExternal).toHaveBeenCalledWith("http://localhost:8888");
  });

  it("marks the ones the network can reach", async () => {
    render(<PortsSegment />);
    await userEvent.click(screen.getByRole("button", { name: "Ports" }));

    const panel = within(await screen.findByRole("dialog"));
    // Worth saying out loud: that one is not just yours.
    expect(panel.getByText("public")).toBeInTheDocument();
    expect(panel.getAllByText("public")).toHaveLength(1);
  });
});

describe("remote hosts", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("lists every host the machine knows, not only the live ones", async () => {
    listSshHosts.mockResolvedValue(["home-3090", "tc-silicon", "tc-shanghai"]);
    sshSessions.mockResolvedValue([{ host: "home-3090", status: "connected" }]);
    render(<HostsSegment />);

    // The count is what you can reach right now…
    expect(await screen.findByText("1 host")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hosts" }));
    const panel = within(await screen.findByRole("dialog"));
    // …but the panel is the whole roster, or it would be blank exactly when you
    // want to open a connection.
    expect(panel.getByText("tc-shanghai")).toBeInTheDocument();
    expect(panel.getAllByText("not connected")).toHaveLength(2);
  });

  it("connects a host from its row", async () => {
    listSshHosts.mockResolvedValue(["home-3090"]);
    sshSessions.mockResolvedValue([]);
    render(<HostsSegment />);
    await userEvent.click(screen.getByRole("button", { name: "Hosts" }));

    await userEvent.click(await screen.findByText("home-3090"));

    expect(sshConnect).toHaveBeenCalledWith("home-3090");
  });
});

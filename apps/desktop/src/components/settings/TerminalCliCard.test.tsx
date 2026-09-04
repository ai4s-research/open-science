import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliShimStatus } from "@/lib/tauri";
import { TerminalCliCard } from "./TerminalCliCard";

const state = vi.hoisted(() => ({ current: null as CliShimStatus | null }));
const install = vi.hoisted(() => vi.fn(async () => state.current));

vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  getCliShimStatus: async () => state.current,
  installCliShim: (...a: []) => install(...a),
}));

const status = (over: Partial<CliShimStatus> = {}): CliShimStatus => ({
  binary: "/Applications/Open Science.app/Contents/MacOS/osd",
  shim: "/Users/x/bin/osd",
  installed: true,
  occupied: false,
  route: "already-on-path",
  profile: null,
  pathHint: null,
  ...over,
});

beforeEach(() => {
  install.mockClear();
  state.current = status();
});

describe("Settings → the terminal command", () => {
  it("reports a command the launch already installed, with nothing left to do", async () => {
    render(<TerminalCliCard />);
    await waitFor(() => expect(screen.getByText("/Users/x/bin/osd")).toBeInTheDocument());
    expect(screen.getByText(/Ready — run `osd` in a new terminal/)).toBeInTheDocument();
    // Nothing to paste: PATH already reaches it.
    expect(screen.queryByText(/export PATH=/)).not.toBeInTheDocument();
    // The button is repair, not setup.
    expect(screen.getByRole("button", { name: /Reinstall/ })).toBeEnabled();
  });

  it("names the profile it extended, so nothing was changed behind the user's back", async () => {
    state.current = status({ route: "shell-profile", profile: "/Users/x/.zprofile" });
    render(<TerminalCliCard />);
    await waitFor(() =>
      expect(screen.getByText(/added to \/Users\/x\/.zprofile/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/export PATH=/)).not.toBeInTheDocument();
  });

  it("falls back to a line to paste only when nothing automatic worked", async () => {
    state.current = status({
      route: "unreachable",
      pathHint: 'export PATH="/Users/x/.local/bin:$PATH"',
    });
    render(<TerminalCliCard />);
    await waitFor(() =>
      expect(screen.getByText('export PATH="/Users/x/.local/bin:$PATH"')).toBeInTheDocument(),
    );
    expect(screen.getByText(/nothing on your PATH reaches it/)).toBeInTheDocument();
  });

  it("repairs an install by hand when the app has moved", async () => {
    const user = userEvent.setup();
    state.current = status({ installed: false });
    render(<TerminalCliCard />);
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());

    state.current = status({ installed: true });
    await user.click(screen.getByRole("button", { name: "Install command" }));
    expect(install).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByText(/Ready — run `osd` in a new terminal/)).toBeInTheDocument(),
    );
  });

  it("refuses to overwrite a file it did not write", async () => {
    // A stranger's file means ours is not installed, whatever else is true.
    state.current = status({ occupied: true, installed: false });
    render(<TerminalCliCard />);
    await waitFor(() =>
      expect(screen.getByText(/A file this app did not write/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Install command" })).toBeDisabled();
  });

  it("says so plainly when the build carries no osd, instead of offering a broken button", async () => {
    state.current = status({ binary: null, installed: false });
    render(<TerminalCliCard />);
    await waitFor(() =>
      expect(screen.getByText("This build does not carry the osd command.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Install command" })).toBeDisabled();
  });
});

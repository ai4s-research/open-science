import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "@/lib/tauri";

const status = vi.fn<() => Promise<ComputerUseStatus>>();
const openPermissions = vi.fn<(p?: "accessibility" | "screenshots") => Promise<void>>();

// isTauri is false in this environment, so the card would render nothing at all
// without this: what is under test is the three states the backend can report,
// not the desktop guard.
vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  getComputerUseStatus: () => status(),
  openComputerUsePermissions: (p?: "accessibility" | "screenshots") => openPermissions(p),
}));

const { ComputerUseCard } = await import("./ComputerUseCard");

const macOS = (over: Partial<ComputerUseStatus> = {}): ComputerUseStatus => ({
  available: false,
  platform: "macos",
  helperAppPath: "/Applications/Open Science.app/Contents/Resources/computer-use/x.app",
  accessibility: "not-granted",
  screenshots: "not-granted",
  reason: "Accessibility permission has not been granted to the helper",
  ...over,
});

beforeEach(() => {
  status.mockReset();
  openPermissions.mockReset();
  openPermissions.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("ComputerUseCard", () => {
  it("does not claim anything is ungranted before the first answer arrives", async () => {
    // Checking launches the helper app and takes seconds. Offering "Grant…"
    // meanwhile told the user they had not granted a permission they had.
    let settle: (value: ComputerUseStatus) => void = () => {};
    status.mockReturnValue(new Promise<ComputerUseStatus>((resolve) => (settle = resolve)));
    render(<ComputerUseCard />);

    expect(await screen.findByText(/Checking/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Grant/ })).not.toBeInTheDocument();

    settle(macOS({ available: true, accessibility: "granted", reason: null }));
    expect(await screen.findByText(/Ready\./)).toBeInTheDocument();
  });

  it("says what is missing, and offers to grant exactly that permission", async () => {
    status.mockResolvedValue(macOS());
    render(<ComputerUseCard />);

    expect(await screen.findByText(/has not been granted/)).toBeInTheDocument();
    const grants = await screen.findAllByRole("button", { name: /Grant/ });
    expect(grants).toHaveLength(2);

    await userEvent.click(grants[0]);
    // The first row is Accessibility — the one without which nothing works.
    expect(openPermissions).toHaveBeenCalledWith("accessibility");
  });

  it("reports a granted permission instead of offering it again", async () => {
    status.mockResolvedValue(
      macOS({ available: true, accessibility: "granted", reason: null }),
    );
    render(<ComputerUseCard />);

    expect(await screen.findByText(/Ready\./)).toBeInTheDocument();
    expect(screen.getByText("Granted")).toBeInTheDocument();
    // Screen Recording is still ungranted, and is the only remaining offer.
    expect(screen.getAllByRole("button", { name: /Grant/ })).toHaveLength(1);
  });

  it("hides the permission rows where the platform has no such grant", async () => {
    status.mockResolvedValue({
      available: true,
      platform: "linux",
      helperAppPath: null,
      accessibility: "unsupported",
      screenshots: "unsupported",
      reason: null,
    });
    render(<ComputerUseCard />);

    expect(await screen.findByText(/Ready\./)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Grant/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Accessibility")).not.toBeInTheDocument();
  });
});

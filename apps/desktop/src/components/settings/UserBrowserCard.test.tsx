import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserBrowser } from "@/lib/tauri";

const detect = vi.fn<() => Promise<UserBrowser | null>>();

vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  detectUserBrowser: () => detect(),
}));

const { UserBrowserCard } = await import("./UserBrowserCard");

beforeEach(() => detect.mockReset());
afterEach(() => vi.clearAllMocks());

describe("UserBrowserCard", () => {
  it("says nothing at all when no such browser is installed", async () => {
    detect.mockResolvedValue(null);
    const { container } = render(<UserBrowserCard />);
    await waitFor(() => expect(detect).toHaveBeenCalled());
    // The common case: an empty section here would be a heading about nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it("names the difference from the bundled connector, not just the fact it exists", async () => {
    detect.mockResolvedValue({
      appPath: "/Applications/ego lite.app",
      command: "/Users/x/.local/bin/ego-browser",
    });
    render(<UserBrowserCard />);

    expect(await screen.findByText(/reachable/i)).toBeInTheDocument();
    // The point of the card: this one carries the user's real sessions, and it
    // asks before it is used. Both have to be on screen.
    expect(screen.getByText(/real logged-in sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/ask before the first use/i)).toBeInTheDocument();
    expect(screen.getByText("/Users/x/.local/bin/ego-browser")).toBeInTheDocument();
  });

  it("does not call an app without its CLI reachable", async () => {
    detect.mockResolvedValue({ appPath: "/Applications/ego lite.app", command: null });
    render(<UserBrowserCard />);

    expect(await screen.findByText(/cannot reach it/i)).toBeInTheDocument();
    expect(screen.queryByText(/and reachable/i)).not.toBeInTheDocument();
  });
});

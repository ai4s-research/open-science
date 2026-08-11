import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshSession } from "@/lib/tauri";
import { useSshStore } from "@/lib/ssh";
import { SshSignInDialog } from "./SshSignInDialog";

const bridge = vi.hoisted(() => ({
  sshAnswer: vi.fn(async (_host: string, _secret: string) => {}),
  sshConnect: vi.fn(async (_host: string) => {}),
  sshDisconnect: vi.fn(async (_host: string) => {}),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  sshAnswer: (...a: [string, string]) => bridge.sshAnswer(...a),
  sshConnect: (...a: [string]) => bridge.sshConnect(...a),
  sshDisconnect: (...a: [string]) => bridge.sshDisconnect(...a),
  sshSessions: async () => [],
  sshSharingSupported: async () => true,
}));

const asking = (prompt: string, notice: string | null = null): SshSession => ({
  host: "hpc-login",
  status: "prompt",
  prompt,
  notice,
  error: null,
});

function open(session: SshSession) {
  act(() =>
    useSshStore.setState({
      dialogHost: session.host,
      sessions: { [session.host]: session },
      submitting: false,
    }),
  );
}

beforeEach(() => {
  bridge.sshAnswer.mockClear();
  bridge.sshDisconnect.mockClear();
  useSshStore.setState({ dialogHost: null, sessions: {}, submitting: false });
});

describe("SshSignInDialog", () => {
  it("stays out of the way until a host needs a sign-in", () => {
    render(<SshSignInDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The point of the feature: whatever the server asks is what the user sees.
  // Campus 2FA wording is too varied to classify, and guessing wrong is how a
  // working cluster becomes an unusable one.
  it("shows the server's own question verbatim, with its surrounding output", async () => {
    render(<SshSignInDialog />);
    open(asking("(asq@login) Passcode or option (1-3):", "Duo two-factor login\n 1. Duo Push"));

    expect(await screen.findByText("(asq@login) Passcode or option (1-3):")).toBeInTheDocument();
    expect(screen.getByText(/1\. Duo Push/)).toBeInTheDocument();
  });

  it("relays the answer and masks it while typing", async () => {
    render(<SshSignInDialog />);
    open(asking("Password:"));

    const input = await screen.findByLabelText("Password:");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.type(input, "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(bridge.sshAnswer).toHaveBeenCalledWith("hpc-login", "hunter2"));
  });

  it("clears the field for the next step so a password is never sent as the code", async () => {
    render(<SshSignInDialog />);
    open(asking("Password:"));
    const input = await screen.findByLabelText("Password:");
    await userEvent.type(input, "hunter2{Enter}");
    await waitFor(() => expect(bridge.sshAnswer).toHaveBeenCalledTimes(1));

    // Second step of the same sign-in: a one-time code.
    open(asking("Verification code:"));
    const next = await screen.findByLabelText("Verification code:");
    expect(next).toHaveValue("");
    // Submit is inert until something is typed, so Enter cannot resend step one.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("cancelling closes the connection attempt rather than leaving it half-open", async () => {
    render(<SshSignInDialog />);
    open(asking("Password:"));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(bridge.sshDisconnect).toHaveBeenCalledWith("hpc-login"));
    expect(useSshStore.getState().dialogHost).toBeNull();
  });

  it("reports a failure with the server's last words and offers no submit", async () => {
    render(<SshSignInDialog />);
    open({
      host: "hpc-login",
      status: "failed",
      prompt: null,
      notice: null,
      error: "Permission denied, please try again.",
    });

    expect(await screen.findByText("Permission denied, please try again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    // Closing a failed sign-in must not re-run disconnect on a dead attempt.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(bridge.sshDisconnect).not.toHaveBeenCalled();
    expect(useSshStore.getState().dialogHost).toBeNull();
  });
});

import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";

/**
 * Ask the desktop UI to sign in to a compute host that authenticates
 * interactively, then wait for that shared connection to come up (#73).
 *
 * The app owns the sign-in: it opens ONE authenticated connection per host over
 * a real terminal and relays the server's own prompts (password, one-time code,
 * push approval) to a dialog. This tool is how the agent reaches that dialog
 * mid-run instead of failing with "Permission denied" — the call itself is the
 * signal the UI acts on, and the polling below is the agent waiting for the
 * human to finish. Once it returns, every later `ssh`/`rsync`/`sbatch` on that
 * host rides the same connection and is never prompted again.
 */

/** Same shape the desktop enforces: no leading `-` (which would smuggle an ssh
 *  option) and no shell metacharacters. */
function isSafeHost(host: string): boolean {
  return /^[A-Za-z0-9._@-]+$/.test(host) && !host.startsWith("-");
}

const CONFIG = () => process.env.OPENSCIENCE_SSH_CONFIG;

/** Whether the shared connection is live. `ssh -O check` is the only honest
 *  answer: the connection may have been established minutes or hours ago. */
function isShared(host: string): Promise<boolean> {
  const config = CONFIG();
  if (!config) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "ssh",
      ["-F", config, "-O", "check", "--", host],
      { timeout: 10_000 },
      (error) => resolve(!error),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default tool({
  description:
    "Sign in to a remote compute host that asks for a password or a one-time code, by asking the Open Science Desktop UI to prompt the user. Call this when an ssh/scp/rsync/sbatch command on a saved machine fails with a permission or authentication error, BEFORE reporting the failure — many institutional clusters require two-factor authentication on every connection. It returns once the shared connection is up (the user may take a minute to approve), after which every later command on that host needs no credentials. Do not call it for host-key or network errors: signing in cannot fix those.",
  args: {
    host: tool.schema
      .string()
      .min(1)
      .describe("The machine to sign in to, exactly as it is saved/used with ssh (host or user@host)."),
  },
  async execute(args) {
    const host = args.host.trim();
    if (!isSafeHost(host)) {
      throw new Error("host must be a plain hostname or user@host");
    }
    const config = CONFIG();
    if (!config) {
      throw new Error(
        "interactive sign-in is unavailable here: this runtime is not connected to the desktop app's shared ssh configuration",
      );
    }
    if (await isShared(host)) {
      return JSON.stringify({ host, connected: true, alreadyConnected: true });
    }
    // The UI opens its sign-in dialog on seeing this call; wait for the user.
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      if (await isShared(host)) {
        return JSON.stringify({ host, connected: true });
      }
    }
    throw new Error(
      `no shared connection to ${host} after waiting for the sign-in. Tell the user what you need it for and ask them to sign in from Settings → Compute, then retry.`,
    );
  },
});

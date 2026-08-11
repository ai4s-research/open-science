// Interactive SSH sign-in state (#73).
//
// Clusters that ask for a password or a one-time code on every connection are
// unusable with key-only, non-interactive ssh. The app opens ONE authenticated
// connection per host and shares it with everything afterwards, so the user
// signs in once per working session — here we hold that flow's UI state.
//
// The dialog opens wherever the need arises: the user pressing Connect in
// Settings, or the agent hitting a host it cannot reach mid-run. A pending
// question always surfaces, because something is blocked until it is answered.
import { create } from "zustand";
import {
  isTauri,
  sshAnswer,
  sshConnect,
  sshDisconnect,
  sshSessions,
  sshSharingSupported,
  type SshSession,
} from "./tauri";

interface SshState {
  /** Live state per host, mirrored from the `ssh:state` event. */
  sessions: Record<string, SshSession>;
  /** Whether one authenticated connection can be shared at all (false on
   *  Windows). Null until probed. */
  sharingSupported: boolean | null;
  /** The host whose sign-in dialog is open, or null. */
  dialogHost: string | null;
  /** Set while an answer is in flight, so the dialog cannot double-submit. */
  submitting: boolean;
  init: () => Promise<void>;
  /** Open the dialog and start (or adopt) the shared connection. */
  connect: (host: string) => Promise<void>;
  answer: (secret: string) => Promise<void>;
  /** Give up on the sign-in: closes the connection attempt and the dialog. */
  cancel: () => Promise<void>;
  /** Leave the sign-in running but get the dialog out of the way. */
  dismiss: () => void;
  disconnect: (host: string) => Promise<void>;
}

let started = false;

export const useSshStore = create<SshState>((set, get) => ({
  sessions: {},
  sharingSupported: null,
  dialogHost: null,
  submitting: false,

  init: async () => {
    if (started) return;
    started = true;
    if (!isTauri) {
      // The web client has no ssh of its own: the shared connection lives on the
      // desktop host, and its sign-in happens there.
      set({ sharingSupported: false });
      return;
    }
    set({ sharingSupported: await sshSharingSupported() });
    const list = await sshSessions();
    set({ sessions: Object.fromEntries(list.map((s) => [s.host, s])) });
    const { listen } = await import("@tauri-apps/api/event");
    await listen<SshSession[]>("ssh:state", ({ payload }) => {
      const sessions = Object.fromEntries(payload.map((s) => [s.host, s]));
      const { dialogHost } = get();
      // A question nobody can see blocks the work that triggered it — so a
      // pending prompt opens the dialog even if the user closed it, or if the
      // connection was started by the agent rather than by hand.
      const asking = payload.find((s) => s.status === "prompt");
      set({
        sessions,
        dialogHost: asking ? asking.host : dialogHost,
        submitting: false,
      });
      // Signed in: the card takes over from here.
      if (dialogHost && sessions[dialogHost]?.status === "connected") {
        set({ dialogHost: null });
      }
    });
  },

  connect: async (host) => {
    set({ dialogHost: host });
    try {
      await sshConnect(host);
    } catch (e) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [host]: {
            host,
            status: "failed",
            prompt: null,
            notice: null,
            error: e instanceof Error ? e.message : String(e),
          },
        },
      }));
    }
  },

  answer: async (secret) => {
    const host = get().dialogHost;
    if (!host) return;
    set({ submitting: true });
    try {
      await sshAnswer(host, secret);
    } catch (e) {
      set((s) => ({
        submitting: false,
        sessions: {
          ...s.sessions,
          [host]: {
            ...(s.sessions[host] ?? { host, prompt: null, notice: null }),
            host,
            status: "failed",
            prompt: null,
            error: e instanceof Error ? e.message : String(e),
          },
        },
      }));
    }
  },

  cancel: async () => {
    const host = get().dialogHost;
    set({ dialogHost: null, submitting: false });
    if (host) await get().disconnect(host);
  },

  dismiss: () => set({ dialogHost: null }),

  disconnect: async (host) => {
    await sshDisconnect(host);
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[host];
      return { sessions };
    });
  },
}));

/** Whether a host's shared connection is live right now. */
export function isSignedIn(sessions: Record<string, SshSession>, host: string): boolean {
  return sessions[host]?.status === "connected";
}

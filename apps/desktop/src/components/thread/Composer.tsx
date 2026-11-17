import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardList,
  Hand,
  MessageSquare,
  Plus,
  Square,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import {
  addBinaryToWorkspace,
  addFilesToWorkspace,
  addPathsToWorkspace,
  discardWorkspaceFile,
  type AttachedFile,
  addTextToWorkspace,
  isTauri,
  logDebug,
  type ApprovalMode,
} from "@/lib/tauri";
import { getClient, useRuntimeStore, type AgentMode } from "@/lib/runtime";
import {
  applyRef,
  condenseTranscript,
  matchPaths,
  matchSessions,
  referenceBlock,
  refTriggerAt,
  walkWorkspace,
} from "@/components/thread/references";
import { ModelPicker, type AgentControl } from "@/components/thread/ModelPicker";
import { WorkspaceChip } from "@/components/thread/WorkspaceChip";
import { AttachmentChip } from "@/components/thread/AttachmentChip";
import { useUiStore } from "@/lib/store";
import { parkDraft, unparkDraft } from "@/lib/composerStash";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { pressOnPadding } from "@/lib/padPress";
import { useLabelsOverflow } from "@/lib/useCompactWidth";
import { isGatewayWeb } from "@/lib/webMode";
import { discardUpload, uploadToWorkspace } from "@/lib/artifactFile";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** A paste longer than this becomes a workspace file chip instead of raw text. */
const PASTE_AS_FILE_CHARS = 2000;
const PASTE_AS_FILE_LINES = 25;
/** Max composer height before it scrolls internally. */
const MAX_HEIGHT_PX = 160;

/** Extension for a clipboard image's MIME type (`image/png` → `png`,
 *  `image/svg+xml` → `svg`, `image/jpeg` → `jpg`); falls back to `png`. */
function imageExt(mime: string): string {
  const sub = mime.split("/")[1]?.split(";")[0]?.replace("+xml", "") ?? "";
  const mapped = ({ jpeg: "jpg" } as Record<string, string>)[sub];
  return mapped ?? (sub || "png");
}

/** A Blob's bytes as base64 (no data-URI prefix). FileReader handles large
 *  images without the call-stack limit that spreading into btoa hits. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

// Terminal-style input history: every sent input (prompt, "!cmd", "/name args")
// in its typed form, shared across sessions, newest last, ↑/↓ to recall.
const HISTORY_KEY = "ai4s.inputHistory";
const HISTORY_MAX = 100;
function readHistory(): string[] {
  try {
    const arr = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function recordHistory(entry: string): void {
  if (!entry) return;
  const prev = readHistory();
  if (prev[prev.length - 1] === entry) return; // consecutive duplicate
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([...prev, entry].slice(-HISTORY_MAX)));
  } catch {
    /* full or unavailable storage never blocks a send */
  }
}

/** A "/" palette entry — the runtime's config commands, skills and MCP prompts. */
export interface ComposerCommand {
  name: string;
  description?: string;
  source?: string;
  /** Takes no arguments, so picking it runs it — no chip to fill in first. */
  immediate?: boolean;
  /** Listed but will not run now; the description says why. */
  unavailable?: boolean;
}

/** The two approval modes the composer can switch between (Codex-style). Copy
 *  (label/description) is translated at render time — see `approvalCopy`. */
const APPROVAL_OPTIONS: { mode: ApprovalMode; icon: typeof Hand }[] = [
  { mode: "approve", icon: Hand },
  { mode: "full", icon: Zap },
];

/**
 * The "Ask anything" composer. Static mock sessions pass no `onSend`; the live
 * OpenCode session passes one to submit prompts to the runtime. Attached
 * workspace files show as removable chips above the input, not as prompt text.
 *
 * Two prefix modes (only when their handler is provided):
 *   `!`  — shell mode: the rest of the line runs directly in the session's
 *          workspace folder (terminal styling, no model turn).
 *   `/`  — command palette: pick a slash command (config command / skill /
 *          MCP prompt) with ↑/↓ + Tab/Enter, then type arguments and send.
 *          One that takes no arguments (`immediate`) runs on Enter.
 *          A "/name" that matches no known command stays a plain prompt.
 *          Two of them are the composer's own: `/plan` (plan mode on; with a
 *          message, also sends it; `/plan off` leaves) and `/compact`.
 *
 * While a turn runs (`working` + `onQueue`) the input stays live: Enter queues
 * the message for after the turn, Cmd/Ctrl+Enter sends it now — OpenCode then
 * picks it up at the turn's next step (steer). On an empty input
 * Cmd/Ctrl+Enter steers the whole queue (`onSteerQueued`).
 */
export function Composer({
  onSend,
  onQueue,
  onSteerQueued,
  onRunShell,
  onRunCommand,
  commands = [],
  disabled,
  working,
  onStop,
  placeholder,
  approvalMode,
  onApprovalModeChange,
  agentMode,
  onAgentModeChange,
  showModelPicker,
  modelSessionId,
  agentControl,
  showWorkspaceChip = true,
  draftKey,
  sessionDir,
  currentSessionId,
  onInteract,
  onCompactContext,
  compactRefusal,
  acceptsHandoff = true,
  visible = true,
}: {
  /** `attachments` are the chip file names, omitted when there are none. The
   *  text already names them; the list lets the send attach the images too. */
  onSend?: (text: string, attachments?: string[]) => void;
  /** Queue a message for after the running turn (Enter while `working`). */
  onQueue?: (text: string, attachments?: string[]) => void;
  /** Send every queued message now (Cmd/Ctrl+Enter on an empty input). */
  onSteerQueued?: () => void;
  onRunShell?: (command: string) => void;
  onRunCommand?: (name: string, args: string) => void;
  commands?: ComposerCommand[];
  disabled?: boolean;
  /** A turn is running: the send button becomes Stop (wired to `onStop`). */
  working?: boolean;
  onStop?: () => void;
  /** Defaults to `t("composer.placeholder.default")` ("Ask anything"). */
  placeholder?: string;
  /** The approval switch shows only when the surface provides both (the live
   *  session does; static mock sessions don't). */
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  /** Plan mode — `/plan`, the toolbar chip and Shift+Tab. Same both-or-nothing
   *  contract; the live session withholds it when the runtime has no "plan"
   *  agent. */
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  /** Show the inline model + reasoning-effort switcher (left of send). The live
   *  session opts in; static mock sessions have no runtime to switch. */
  showModelPicker?: boolean;
  /** Bind the model picker to a session (per-pane model/effort); omit for the
   *  global default. */
  modelSessionId?: string;
  /** Which agent this conversation runs on, and that agent's own models. The
   *  model picker leads with it; omitted where no ACP agent can run (#14). */
  agentControl?: AgentControl;
  /** Show the draft workspace-folder chip. Only the draft pane opts in — in a
   *  split layout the other panes already have a bound session/folder. */
  showWorkspaceChip?: boolean;
  /** This pane's draft slot, so the folder chip names THIS draft's destination. */
  draftKey?: string;
  /** Workspace folder the `@` picker lists files from; omit to offer none. */
  sessionDir?: string;
  /** This pane's session, excluded from the `#` picker (referencing the
   *  conversation you are already in adds nothing). */
  currentSessionId?: string | null;
  /** Fired when the user edits the input — used to pin a tentative screen (#3)
   *  the moment they start typing, so it isn't reused/lost on the next click. */
  onInteract?: () => void;
  /** When provided, offers `/compact` (asked once before it runs). The live
   *  session wires it to `compactContext`; static mock sessions omit it. */
  onCompactContext?: () => void;
  /** Why `/compact` would not run now (translated), or null when it would.
   *  Asked when the palette lists it and when it is run. */
  compactRefusal?: () => string | null;
  /** May this composer take an app-wide prepared draft (the provenance panel's
   *  "Reproduce")? Exactly one should: every pane of every screen is mounted,
   *  including hidden ones, and a draft claimed by any other lands where the
   *  user cannot see it. The live session passes its focused pane. */
  acceptsHandoff?: boolean;
  /** This composer's pane has layout boxes. A pane in a Screen hidden without
   *  layout cannot be measured until it comes back — and one that kept its
   *  layout must not be re-measured at all (see useLabelsOverflow). */
  visible?: boolean;
}) {
  const { t } = useTranslation(["session", "common"]);
  const resolvedPlaceholder = placeholder ?? t("composer.placeholder.default");
  // Approval-mode copy keyed by mode — APPROVAL_OPTIONS itself stays static
  // (icons only) so it can live at module scope outside the component.
  const approvalCopy: Record<ApprovalMode, { label: string; description: string }> = {
    approve: {
      label: t("composer.approval.approve.label"),
      description: t("composer.approval.approve.description"),
    },
    full: {
      label: t("composer.approval.full.label"),
      description: t("composer.approval.full.description"),
    },
  };
  // Reclaim whatever this pane had typed before it was last unmounted (a screen
  // switch tears panes down). Unparked once, on mount, so the two states below
  // seed from the same draft.
  const [restored] = useState(() => (draftKey ? unparkDraft(draftKey) : null));
  const [value, setValue] = useState(restored?.text ?? "");
  const [files, setFiles] = useState<string[]>(restored?.files ?? []);
  // Listed even when it would be refused (a draft, a small context), so that
  // "/compact" is never mistaken for prompt text — the row says why instead.
  // The reason is only worked out while the palette could show it.
  function compactCommand(): ComposerCommand {
    const refusal = /^\/\S*$/.test(value) ? (compactRefusal?.() ?? null) : null;
    return {
      name: "compact",
      description: refusal ?? t("composer.builtin.compact"),
      source: "local",
      immediate: true,
      ...(refusal ? { unavailable: true } : {}),
    };
  }
  // The composer's own slash commands, listed ahead of the runtime's. Each is
  // offered only when its surface wires it (a static mock session wires none).
  const builtins: ComposerCommand[] = [
    ...(agentMode && onAgentModeChange
      ? [{ name: "plan", description: t("composer.builtin.plan"), source: "local" }]
      : []),
    ...(onCompactContext ? [compactCommand()] : []),
  ];
  const allCommands = [
    ...builtins,
    ...commands.filter((c) => !builtins.some((b) => b.name === c.name)),
  ];
  /** Of `files`, the ones this composer COPIED in — the only ones removing a
   *  chip may delete. See `addWorkspaceFile`. */
  const owned = useRef<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** Highlighted palette row; clamped to the current matches. */
  const [sel, setSel] = useState(0);
  /** Esc closed the palette for the current input; typing reopens it. */
  const [paletteClosed, setPaletteClosed] = useState(false);
  /** A committed slash command: shown as a chip, the input holds arguments. */
  const [command, setCommand] = useState<string | null>(null);
  /** ↑/↓ history navigation; `draft` is what was typed before recalling. */
  const [hist, setHist] = useState<{ index: number; draft: string } | null>(null);
  /** The approval-mode menu is open. */
  const [approvalOpen, setApprovalOpen] = useState(false);
  // `/compact` changes what the agent can see for the rest of the
  // conversation. Cheap to ask, expensive to undo by hand.
  const [confirmCompact, setConfirmCompact] = useState(false);
  const approvalRef = useRef<HTMLDivElement>(null);

  // Dismiss the approval menu on any outside press. (Button blur can't do
  // this: WKWebView never focuses a clicked button, so blur never fires.)
  useEffect(() => {
    if (!approvalOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!approvalRef.current?.contains(e.target as Node)) setApprovalOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [approvalOpen]);
  // A narrow pane cannot fit "Approve for me · Plan mode · GPT-5.6 sol · High" as
  // words. When the action row's items do not fit it, the toolbar keeps the
  // icons and drops the labels; every one of those buttons already carries an
  // aria-label and a title, so nothing becomes unreachable.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const compactToolbar = useLabelsOverflow(toolbarRef, visible);

  const taRef = useRef<HTMLTextAreaElement>(null);
  // Caret position, tracked so an "@"/"#" being typed can be recognized in
  // place — mid-sentence references matter as much as ones at the start.
  const [caret, setCaret] = useState(0);
  /** Workspace paths for the "@" picker, walked once per folder on first use. */
  const [refFiles, setRefFiles] = useState<string[] | null>(null);
  /** Conversations attached with "#": chips above the input, resolved to a
   *  quoted excerpt when the prompt is sent. */
  const [refSessions, setRefSessions] = useState<{ id: string; title: string }[]>([]);
  const [refSel, setRefSel] = useState(0);
  const [refClosed, setRefClosed] = useState(false);
  const allSessions = useRuntimeStore((s) => s.sessions);
  const composerDraft = useUiStore((s) => s.composerDraft);
  const setComposerDraft = useUiStore((s) => s.setComposerDraft);

  // Mirror the unsent draft where the rest of the app can see it: a pane that
  // unmounts must not throw away what was typed, and closing a Screen asks
  // first only when there IS something to lose (see composerStash).
  useEffect(() => {
    if (draftKey) parkDraft(draftKey, { text: value, files });
  }, [draftKey, value, files]);

  const shellMode = !!onRunShell && !command && value.startsWith("!");
  // The palette is open while the command NAME is being typed ("/na…"); the
  // first space ends name-typing (arguments follow) and closes it.
  const slashTyping = !!onRunCommand && !command && /^\/\S*$/.test(value);
  const query = slashTyping ? value.slice(1).toLowerCase() : "";
  const matches = slashTyping
    ? allCommands
        .filter((c) => c.name.toLowerCase().includes(query))
        .sort(
          (a, b) =>
            Number(b.name.toLowerCase().startsWith(query)) -
            Number(a.name.toLowerCase().startsWith(query)),
        )
    : [];
  const paletteOpen = matches.length > 0 && !paletteClosed && !disabled;
  const selIndex = Math.min(sel, Math.max(matches.length - 1, 0));

  // "@" a workspace file, "#" a past conversation (#63). Only in a real
  // session: a static mock has no runtime to read files or history from.
  const trigger = onSend && !shellMode && !command && !refClosed
    ? refTriggerAt(value, caret)
    : null;
  const fileMatches =
    trigger?.kind === "file" ? matchPaths(refFiles ?? [], trigger.query) : [];
  const sessionMatches =
    trigger?.kind === "session"
      ? matchSessions(allSessions, currentSessionId ?? null, trigger.query)
      : [];
  const refCount = trigger?.kind === "file" ? fileMatches.length : sessionMatches.length;
  const refOpen = !!trigger && refCount > 0 && !disabled;
  const refIndex = Math.min(refSel, Math.max(refCount - 1, 0));

  // The file list is only worth walking once the user actually types "@".
  useEffect(() => {
    if (trigger?.kind !== "file" || refFiles !== null) return;
    let live = true;
    void walkWorkspace(sessionDir).then((paths) => {
      if (live) setRefFiles(paths);
    });
    return () => {
      live = false;
    };
  }, [trigger?.kind, refFiles, sessionDir]);

  // A folder switch invalidates the cached listing.
  useEffect(() => setRefFiles(null), [sessionDir]);

  /** Put the chosen reference in place of the "@…"/"#…" being typed. */
  const takeRef = (insert: string) => {
    if (!trigger) return;
    const next = applyRef(value, trigger, caret, insert);
    setValue(next.value);
    setCaret(next.caret);
    setRefSel(0);
    const el = taRef.current;
    // The caret must land after the inserted text, not where React put it.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickFile = (path: string) => takeRef(`@${path}`);
  const pickSession = (s: { id: string; title: string }) => {
    setRefSessions((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
    // The chip carries the reference; the typed "#…" has done its job.
    takeRef("");
  };

  // Each edit resets the palette: selection back to the top, Esc-close undone.
  useEffect(() => {
    setSel(0);
    setPaletteClosed(false);
    setRefSel(0);
    setRefClosed(false);
  }, [value]);

  // Committing a command turns it into a chip; the input then holds only the
  // arguments — the "/name" can never degrade into ordinary prompt text.
  // Enter or a click on a command that takes no arguments runs it outright
  // (`/clear`, `/compact`); Tab only completes it into a chip, so a stray Tab
  // can never wipe a conversation.
  const pick = (c: ComposerCommand, run = true) => {
    if (c.immediate && run) {
      setHist(null);
      if (runCommand(c.name, "", false)) {
        recordHistory(`/${c.name}`);
        setValue("");
      }
      return;
    }
    setCommand(c.name);
    setValue("");
    taRef.current?.focus();
  };

  const onChange = (v: string) => {
    onInteract?.(); // typing pins a tentative preview screen (#3)
    setHist(null); // an edit leaves history navigation
    // A full known command name followed by whitespace commits it, same as a
    // pick — whether typed ("/init ") or pasted whole ("/init focus\n…"); the
    // remainder becomes the arguments. Unknown names (paths) stay plain text.
    if (onRunCommand && !command) {
      const m = /^\/(\S+)\s([\s\S]*)$/.exec(v);
      if (m && allCommands.some((c) => c.name === m[1])) {
        setCommand(m[1]);
        setValue(m[2]);
        taRef.current?.focus();
        return;
      }
    }
    setValue(v);
  };

  const unchip = () => {
    if (!command) return;
    setValue(value ? `/${command} ${value}` : `/${command}`);
    setCommand(null);
    taRef.current?.focus();
  };

  // Consume a draft another surface prepared (e.g. provenance "Reproduce") —
  // prefilled, never auto-sent: the user reviews and presses send. Text the
  // user was already typing is kept, with the draft appended below it.
  useEffect(() => {
    if (composerDraft === null || !acceptsHandoff) return;
    setValue((v) => (v.trim() ? `${v.trimEnd()}\n\n${composerDraft}` : composerDraft));
    setComposerDraft(null);
    taRef.current?.focus();
  }, [composerDraft, setComposerDraft, acceptsHandoff]);

  // Auto-grow with the content, scroll internally beyond the cap.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);
  // …and again when its width changes. Measured while its Screen was hidden or
  // not laid out yet, the box is a sliver: even the placeholder wraps a word a
  // line and the height lands on the cap — and nothing re-measured it once the
  // box had its width back, so an empty composer could stay 160px tall.
  useEffect(() => {
    const el = taRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Send the typed message with its chips. While a turn runs it is queued
   *  for after the turn, unless `now` (Cmd/Ctrl+Enter) steers it in. */
  const sendMessage = (text: string, now: boolean) => {
    if (!text && files.length === 0 && refSessions.length === 0) return;
    const fileNote =
      files.length > 0 ? `Files added to the workspace: ${files.join(", ")}` : "";
    const base = text && fileNote ? `${text}\n\n${fileNote}` : text || fileNote;
    // The chips travel with the text: the note names the workspace copy, and the
    // names let the send turn images into real multimodal parts (#88). Passed
    // only when there are chips, so a plain send keeps its one-argument shape.
    const attachments = files.length > 0 ? [...files] : null;
    const deliver = working && onQueue && !now ? onQueue : onSend;
    const send = (t: string) => (attachments ? deliver?.(t, attachments) : deliver?.(t));
    if (refSessions.length > 0) {
      // Referenced conversations are fetched and condensed before sending, so
      // the agent gets the earlier context without the user copy-pasting it.
      const attached = [...refSessions];
      setRefSessions([]);
      void buildReferences(attached).then((blocks) =>
        send(blocks ? `${blocks}\n\n${base}` : base),
      );
    } else {
      send(base);
    }
    setFiles([]);
    // The sent files belong to the conversation now, so this composer no longer
    // owns any of them. Leaving the set behind would arm a real deletion: send
    // `pasted.png`, later drag that same file back in from the Files pane —
    // which attaches it IN PLACE — and removing that chip would delete it.
    owned.current.clear();
  };

  /** Run a slash command: the composer's own `/plan` and `/compact` here, the
   *  runtime's through `onRunCommand`. Returns false when it cannot run now
   *  (the input is then kept). */
  const runCommand = (name: string, args: string, now: boolean): boolean => {
    if (name === "plan" && agentMode && onAgentModeChange) {
      if (args === "off") {
        onAgentModeChange("build");
        return true;
      }
      // Set before sending: the send reads the mode from the store.
      onAgentModeChange("plan");
      if (args) sendMessage(args, now);
      return true;
    }
    if (name === "compact" && onCompactContext) {
      // Mid-turn the runtime refuses and says why; nothing to confirm then.
      if (working) {
        onCompactContext();
        return true;
      }
      const refusal = compactRefusal?.();
      if (refusal) toast.info(refusal);
      else setConfirmCompact(true);
      return true;
    }
    // A runtime command or a shell line is a turn of its own; the server
    // refuses one while another runs.
    if (working) {
      toast.error(t("composer.busyCommand"));
      return false;
    }
    onRunCommand?.(name, args);
    return true;
  };

  const submit = (now = false) => {
    if (disabled) return;
    const text = value.trim();
    setHist(null);
    // A chipped command runs as itself — arguments optional.
    if (command) {
      if (!runCommand(command, text, now)) return;
      recordHistory(text ? `/${command} ${text}` : `/${command}`);
      setCommand(null);
      setValue("");
      return;
    }
    // "!" — run the rest of the line as a shell command (no model turn).
    if (shellMode) {
      const line = value.slice(1).trim();
      if (!line) return;
      if (working) {
        toast.error(t("composer.busyCommand"));
        return;
      }
      onRunShell?.(line);
      recordHistory(`!${line}`);
      setValue("");
      return;
    }
    // "/name args" — run a KNOWN slash command; unknown names stay a prompt
    // (a message can legitimately start with a path like "/etc/hosts …").
    if (onRunCommand && text.startsWith("/")) {
      const name = text.slice(1).split(/\s/, 1)[0];
      if (allCommands.some((c) => c.name === name)) {
        if (!runCommand(name, text.slice(1 + name.length).trim(), now)) return;
        recordHistory(text);
        setValue("");
        return;
      }
    }
    // Cmd/Ctrl+Enter on an empty input mid-turn steers the whole queue.
    if (now && working && !text && files.length === 0 && refSessions.length === 0) {
      onSteerQueued?.();
      return;
    }
    sendMessage(text, now);
    if (text) recordHistory(text);
    setValue("");
  };

  /** Quote each referenced conversation down to its ask and its conclusion.
   *  A conversation that cannot be read is skipped rather than failing the
   *  send — the user's own message still goes through. */
  const buildReferences = async (refs: { id: string; title: string }[]): Promise<string> => {
    const client = getClient();
    if (!client) return "";
    const blocks = await Promise.all(
      refs.map(async (r) => {
        try {
          const messages = await client.getMessages(r.id);
          const excerpt = condenseTranscript(messages);
          return excerpt ? referenceBlock(r.title, excerpt) : "";
        } catch {
          return "";
        }
      }),
    );
    return blocks.filter(Boolean).join("\n\n");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // During IME composition (e.g. pinyin), Enter picks a candidate — it must
    // not send. WebKit reports the committing keydown as legacy keyCode 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // While the palette is open, the keyboard drives it, not the send.
    if (paletteOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaletteClosed(true);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pick(matches[selIndex], e.key === "Enter");
        return;
      }
    }
    // The "@"/"#" picker takes the same keys as the "/" palette while it is up.
    if (refOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setRefSel((i) => Math.min(i + 1, refCount - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setRefSel((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setRefClosed(true);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        if (trigger?.kind === "file") pickFile(fileMatches[refIndex]!);
        else {
          const s = sessionMatches[refIndex]!;
          pickSession({ id: s.id, title: s.title });
        }
        return;
      }
    }
    // Backspace on an empty input dissolves the command chip back into text.
    if (e.key === "Backspace" && command && value === "") {
      e.preventDefault();
      unchip();
      return;
    }
    // Terminal-style history: ↑ at the very start of the input recalls the
    // previous sent input; while navigating, ↑/↓ walk older/newer and walking
    // past the newest restores the unsent draft. Any edit leaves navigation.
    if (e.key === "ArrowUp" && !command) {
      const el = taRef.current;
      const atStart = !!el && el.selectionStart === 0 && el.selectionEnd === 0;
      if (hist || atStart) {
        const entries = readHistory();
        const index = (hist ? hist.index : entries.length) - 1;
        if (index >= 0) {
          e.preventDefault();
          setHist({ index, draft: hist ? hist.draft : value });
          setValue(entries[index]);
        }
        return;
      }
    }
    if (e.key === "ArrowDown" && hist) {
      e.preventDefault();
      const entries = readHistory();
      const index = hist.index + 1;
      if (index < entries.length) {
        setHist({ ...hist, index });
        setValue(entries[index]);
      } else {
        setValue(hist.draft);
        setHist(null);
      }
      return;
    }
    // Shift+Tab flips plan mode, as in Claude Code.
    if (e.key === "Tab" && e.shiftKey && agentMode && onAgentModeChange) {
      e.preventDefault();
      onAgentModeChange(agentMode === "plan" ? "build" : "plan");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.metaKey || e.ctrlKey);
    }
  };

  // The desktop writes through Rust into the draft's folder; the browser has no
  // disk of its own, so it uploads to the gateway into this session's folder.
  const canAttach = (isTauri || isGatewayWeb) && !!onSend;
  const writeBlob = async (name: string, blob: Blob) =>
    isGatewayWeb
      ? uploadToWorkspace(name, blob, sessionDir)
      : addBinaryToWorkspace(name, await blobToBase64(blob));

  // Anything pasted that is a FILE becomes a workspace chip; only characters
  // stay characters. A screenshot, a .md copied in Finder and a CSV all arrive
  // as clipboard file items and all belong in the draft's folder (materialized
  // first) — copying a Markdown file used to dump its path into the box as
  // text, because only `image/*` was looked for. A very long text paste becomes
  // a file too, rather than flooding the box.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const blobs = Array.from(e.clipboardData.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((b): b is File => b !== null);
    if (blobs.length > 0) {
      e.preventDefault();
      void addWorkspaceFile(async () =>
        Promise.all(
          blobs.map(async (blob) => ({
            // A bitmap has no name of its own, so it gets one; a file copied
            // in a file manager keeps the name the person knows it by.
            name: await writeBlob(blob.name || `pasted.${imageExt(blob.type)}`, blob),
            copied: true,
          })),
        ),
      );
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (text.length <= PASTE_AS_FILE_CHARS && text.split("\n").length <= PASTE_AS_FILE_LINES) {
      return; // normal paste
    }
    e.preventDefault();
    void addWorkspaceFile(async () => [
      {
        name: isGatewayWeb
          ? await uploadToWorkspace(
              "pasted.txt",
              new Blob([text], { type: "text/plain" }),
              sessionDir,
            )
          : await addTextToWorkspace("pasted.txt", text),
        copied: true,
      },
    ]);
  };

  // Shared: materialize the draft's folder, run the write, and chip the result
  // (one file or several — paste yields one, a multi-file drop yields many).
  //
  // `copied` is remembered separately from the chip list so removing a chip can
  // delete the workspace copy it made, and can NEVER delete a file that was
  // only referenced in place. It is a set beside `files` rather than a field on
  // it because `files` is also the send's `attachments` argument and the parked
  // draft's shape; a restored draft therefore forgets what it owned, and its
  // chips fall back to dropping the reference — the old behaviour, not a wrong
  // deletion.
  const addWorkspaceFile = async (write: () => Promise<AttachedFile[]>) => {
    try {
      await useRuntimeStore.getState().ensureDraftWorkspace();
      const added = await write();
      if (added.length === 0) return;
      for (const a of added) if (a.copied) owned.current.add(a.name);
      setFiles((f) => [...f, ...added.map((a) => a.name)]);
    } catch (err) {
      toast.error(
        t("composer.error.paste", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  /** Remove a chip, and delete the file if this composer is what put it there. */
  const removeFile = (name: string) => {
    setFiles((f) => f.filter((n) => n !== name));
    if (!owned.current.delete(name)) return;
    void (isGatewayWeb ? discardUpload(name, sessionDir) : discardWorkspaceFile(name)).catch(() => {
      // The chip is gone either way: a file that cannot be deleted is litter in
      // the workspace folder, not a reason to put the attachment back.
    });
  };

  // Latest drop handler, kept in a ref so the native subscription below can run
  // exactly once yet always invoke current logic. Re-subscribing on every render
  // (the previous `[onSend]` dep — onSend is a fresh function each render) leaked
  // native listeners under render churn, so one drop copied the file ~150 times
  // into the project root (issue #44). null when drops aren't accepted.
  const onDropRef = useRef<((paths: string[]) => void) | null>(null);
  onDropRef.current =
    isTauri && onSend
      ? (paths) => {
          if (paths.length > 0) void addWorkspaceFile(() => addPathsToWorkspace(paths));
        }
      : null;

  // Drag-and-drop files onto the app → workspace chips. Tauri captures OS file
  // drops natively (the DOM `drop` event never sees them), so we subscribe to
  // its webview drag-drop event, which hands us absolute paths. Subscribed once
  // for the composer's lifetime; a drop anywhere in the window attaches here.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragOver(true);
          else if (p.type === "leave") setDragOver(false);
          else if (p.type === "drop") {
            setDragOver(false);
            onDropRef.current?.(p.paths);
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch (err) {
        // The webview drag-drop API can be unavailable (partial Tauri bridge,
        // test env) — native file drops are an enhancement, so degrade quietly
        // rather than surfacing an unhandled rejection.
        void logDebug(`composer drag-drop unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Browser: files from a drop or the picker are uploaded one by one, so one
  // that fails (too large, read-only token) does not lose the others' chips.
  const uploadFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    setAdding(true);
    try {
      await addWorkspaceFile(async () => {
        const added: AttachedFile[] = [];
        for (const f of picked) {
          try {
            added.push({ name: await uploadToWorkspace(f.name, f, sessionDir), copied: true });
          } catch (err) {
            toast.error(
              t("composer.error.addFiles", {
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        return added;
      });
    } finally {
      setAdding(false);
    }
  };
  const pickerRef = useRef<HTMLInputElement>(null);

  // Browser drops are DOM events on the composer. Everywhere else in the page
  // a dropped file would make the browser navigate to it, leaving the app.
  useEffect(() => {
    if (!isGatewayWeb) return;
    const block = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
  const webDrop =
    isGatewayWeb && canAttach
      ? {
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(true);
          },
          onDragLeave: (e: DragEvent<HTMLDivElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(Array.from(e.dataTransfer.files));
          },
        }
      : {};

  // Copy local files into the agent workspace; they appear as chips.
  const addFiles = async () => {
    if (isGatewayWeb) {
      pickerRef.current?.click();
      return;
    }
    setAdding(true);
    try {
      // Same as paste: give the draft its folder before copying files in.
      await useRuntimeStore.getState().ensureDraftWorkspace();
      const added = await addFilesToWorkspace();
      for (const a of added) if (a.copied) owned.current.add(a.name);
      if (added.length > 0) setFiles((f) => [...f, ...added.map((a) => a.name)]);
    } catch (err) {
      toast.error(
        t("composer.error.addFiles", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setAdding(false);
    }
  };

  const canSend =
    !disabled &&
    (command
      ? true // a chipped command may run without arguments
      : shellMode
        ? value.slice(1).trim().length > 0
        : !!value.trim() || files.length > 0);

  return (
    <div
      {...webDrop}
      onMouseDown={(e) => pressOnPadding(e, taRef.current)}
      className={cn(
        // A capsule with no layout border: a hairline ring plus a soft wide
        // shadow (after DSH's composer card), so it floats over the thread.
        "relative rounded-[24px] bg-surface px-3 pb-2.5 pt-3 shadow-composer ring-1",
        // Plan mode gets the blue link tone — distinct from shell (warn) and
        // a chipped command (accent) — so a read-only turn is unmistakable.
        shellMode
          ? "ring-warn/60"
          : command
            ? "ring-accent/50"
            : agentMode === "plan"
              ? "ring-link/60"
              : "ring-border/70",
        // Dragging a file over the window: highlight the composer as the target.
        dragOver && "ring-2 ring-accent/60",
      )}
    >
      {refOpen && (
        <div
          role="listbox"
          aria-label={
            trigger?.kind === "file"
              ? t("composer.reference.filesAria")
              : t("composer.reference.sessionsAria")
          }
          className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-card"
        >
          {trigger?.kind === "file"
            ? fileMatches.map((path, i) => (
                <button
                  key={path}
                  role="option"
                  aria-selected={i === refIndex}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-input px-2 py-1.5 text-left",
                    i === refIndex ? "bg-surface-2" : "hover:bg-surface-2",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickFile(path);
                  }}
                >
                  <span className="shrink-0 font-mono text-xs text-text">
                    {path.split(/[\\/]/).pop()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                    {path}
                  </span>
                </button>
              ))
            : sessionMatches.map((m, i) => (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={i === refIndex}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-input px-2 py-1.5 text-left",
                    i === refIndex ? "bg-surface-2" : "hover:bg-surface-2",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSession({ id: m.id, title: m.title });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text">{m.title}</span>
                </button>
              ))}
          {trigger?.kind === "file" && refFiles === null && (
            <div className="px-2 py-1.5 text-xs text-muted">
              {t("composer.reference.scanning")}
            </div>
          )}
        </div>
      )}
      {paletteOpen && (
        <div
          role="listbox"
          aria-label={t("composer.commandsAria")}
          className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-card"
        >
          {matches.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === selIndex}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-input px-2 py-1.5 text-left",
                i === selIndex ? "bg-surface-2" : "hover:bg-surface-2",
              )}
              // mousedown, not click — a click would blur the textarea first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              <span className={cn("shrink-0 font-mono text-xs", c.unavailable ? "text-muted" : "text-text")}>
                /{c.name}
              </span>
              {c.description && (
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.description}</span>
              )}
              {(c.source === "skill" || c.source === "mcp") && (
                <span className="shrink-0 rounded px-1 py-0.5 text-[10px] uppercase text-muted ring-1 ring-border">
                  {c.source === "skill" ? t("composer.source.skill") : t("composer.source.mcp")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {files.map((name) => (
            <AttachmentChip
              key={name}
              name={name}
              dir={sessionDir}
              onRemove={() => removeFile(name)}
            />
          ))}
        </div>
      )}
      {refSessions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {refSessions.map((r) => (
            <span
              key={r.id}
              className="flex items-center gap-1.5 rounded-input bg-surface-2 py-1 pl-2 pr-1 text-xs text-text ring-1 ring-border"
              title={t("composer.reference.chipTitle")}
            >
              <MessageSquare size={11} className="shrink-0 text-accent" />
              <span className="max-w-[220px] truncate">{r.title}</span>
              <button
                className="rounded p-0.5 text-muted hover:bg-border hover:text-text"
                aria-label={t("composer.reference.removeAria", { title: r.title })}
                onClick={() => setRefSessions((prev) => prev.filter((x) => x.id !== r.id))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          onChange(e.target.value);
        }}
        // Clicking or arrowing elsewhere moves the caret out of a half-typed
        // "@…", which must close the picker rather than leave it stranded.
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={
          command
            ? t("composer.placeholder.arguments")
            : shellMode
              ? t("composer.placeholder.shell")
              : resolvedPlaceholder
        }
        className={cn(
          "max-h-[160px] min-h-[36px] w-full resize-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text outline-none placeholder:text-muted",
          (shellMode || command) && "font-mono",
        )}
        aria-label={t("composer.placeholder.default")}
      />
      {/* Codex-style action row: mode controls bottom-left, send bottom-right.
          ONE line, always. A wrapping row looks broken — the send button ends
          up on its own line under the other controls, with a gap between them
          — and flexbox wraps on an item's natural width rather than shrinking
          it first, so the long model name alone was enough to trigger it.
          Every item keeps its natural width (none shrinks — a squeezed chip
          spilled its "· effort ⌄" over the send button); when they do not
          all fit, the buttons drop their labels (useLabelsOverflow). */}
      <div ref={toolbarRef} className="flex min-w-0 items-center gap-1.5 pt-2">
        {command ? (
          <span
            className="flex h-7 shrink-0 items-center gap-1 rounded-input bg-accent/15 pl-2 pr-1 font-mono text-xs text-accent"
            title={t("composer.command.chipTitle")}
          >
            /{command}
            <button
              className="rounded p-0.5 hover:bg-accent/20"
              aria-label={t("composer.command.removeAria")}
              onClick={unchip}
            >
              <X size={11} />
            </button>
          </span>
        ) : shellMode ? (
          <span
            className="flex h-7 shrink-0 items-center gap-1 rounded-input bg-warn/15 px-1.5 font-mono text-xs text-warn"
            title={t("composer.shellMode.title")}
          >
            <Terminal size={13} />
            {t("composer.shellMode.badge")}
          </span>
        ) : (
          canAttach && (
            <>
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted ring-1 ring-border hover:bg-surface-2 hover:text-text disabled:opacity-40"
                aria-label={t("composer.attach.addAria")}
                title={t("composer.attach.title")}
                onClick={() => void addFiles()}
                disabled={adding}
              >
                <Plus size={16} />
              </button>
              {isGatewayWeb && (
                <input
                  ref={pickerRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    e.target.value = ""; // picking the same file again still fires
                    void uploadFiles(picked);
                  }}
                />
              )}
            </>
          )
        )}
        {/* Folder picker for a fresh draft — renders nothing once the session
            exists (its folder then shows in the header's Files toggle). */}
        {showWorkspaceChip && <WorkspaceChip draftKey={draftKey} compact={compactToolbar} />}
        {/* Plan mode shows only while on — entered with /plan or Shift+Tab,
            left with ×, /plan off or Shift+Tab again. */}
        {agentMode === "plan" && onAgentModeChange && (
          <span
            className={cn(
              "flex h-7 shrink-0 items-center rounded-full bg-link/15 text-xs text-link",
              compactToolbar ? "gap-0.5 pl-1.5 pr-1" : "gap-1.5 pl-2.5 pr-1",
            )}
            title={t("composer.planMode.title")}
          >
            <ClipboardList size={12} />
            {!compactToolbar && <span>{t("composer.planMode.label")}</span>}
            <button
              className="rounded-full p-0.5 hover:bg-link/25"
              aria-label={t("composer.planMode.exitAria")}
              onClick={() => onAgentModeChange("build")}
            >
              <X size={11} />
            </button>
          </span>
        )}
        {approvalMode && onApprovalModeChange && !isGatewayWeb && (
          <div className="relative shrink-0" ref={approvalRef}>
            {approvalOpen && (
              <div
                role="menu"
                aria-label={t("composer.approval.menuAria")}
                className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-card border border-border bg-surface p-1 shadow-card"
              >
                <div className="px-2 pb-1 pt-1.5 text-xs text-muted">
                  {t("composer.approval.menuTitle")}
                </div>
                {APPROVAL_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    role="menuitemradio"
                    aria-checked={opt.mode === approvalMode}
                    className="flex w-full items-start gap-2 rounded-input px-2 py-1.5 text-left hover:bg-surface-2"
                    // mousedown, not click — a click would blur the textarea first.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setApprovalOpen(false);
                      if (opt.mode !== approvalMode) onApprovalModeChange(opt.mode);
                    }}
                  >
                    <opt.icon size={13} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-text">{approvalCopy[opt.mode].label}</span>
                      <span className="block text-xs text-muted">
                        {approvalCopy[opt.mode].description}
                      </span>
                    </span>
                    {opt.mode === approvalMode && (
                      <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <button
              aria-label={t("composer.approval.aria")}
              title={t("composer.approval.title")}
              className={cn(
                "flex h-7 items-center rounded-full text-xs text-muted hover:bg-surface-2 hover:text-text",
                compactToolbar ? "gap-0.5 px-1.5" : "gap-1.5 px-2.5",
              )}
              onClick={() => setApprovalOpen((o) => !o)}
            >
              {approvalMode === "full" ? <Zap size={12} /> : <Hand size={12} />}
              {!compactToolbar && <span>{approvalCopy[approvalMode].label}</span>}
              {!compactToolbar && <ChevronDown size={11} />}
            </button>
          </div>
        )}
        {/* Model picker + send kept together, pushed right (and wrapping as a
            unit) so the send button is always reachable on a narrow pane. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {confirmCompact && onCompactContext && (
            <ConfirmDialog
              title={t("composer.compact.confirmTitle")}
              body={t("composer.compact.confirmBody")}
              confirmLabel={t("composer.compact.confirmAction")}
              // Not destructive: the full original conversation stays on disk
              // (see the "Context compacted" row's own copy). A red button here
              // would teach the reader to ignore red.
              // eslint-disable-next-line i18next/no-literal-string -- tone enum, not UI copy
              tone="default"
              // The question is about THIS pane's conversation, so it is asked
              // over that pane. Covering the whole window left the reader
              // guessing which split had asked.
              // eslint-disable-next-line i18next/no-literal-string -- scope enum, not UI copy
              scope="pane"
              onConfirm={() => {
                setConfirmCompact(false);
                onCompactContext();
              }}
              onCancel={() => setConfirmCompact(false)}
            />
          )}
          {(showModelPicker || agentControl) && (
            <ModelPicker sessionId={modelSessionId} compact={compactToolbar} agent={agentControl} />
          )}
          {/* Mid-turn, typed text gets its own button — it queues, the same
              as Enter — beside Stop, which stays in the send button's spot. */}
          {working && onQueue && canSend && (
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text ring-1 ring-border hover:bg-surface-2"
              aria-label={t("composer.queue.add")}
              title={t("composer.queue.addTitle")}
              onClick={() => submit()}
            >
              <ArrowUp size={16} />
            </button>
          )}
          {working && onStop ? (
            // Same spot, same shape, one action: the send button becomes Stop
            // while the agent works — always live, even though the input is not.
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:opacity-90"
              aria-label={t("composer.stop.aria")}
              title={t("composer.stop.title")}
              onClick={onStop}
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40"
              aria-label={t("composer.send.aria")}
              onClick={() => submit()}
              disabled={!canSend}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

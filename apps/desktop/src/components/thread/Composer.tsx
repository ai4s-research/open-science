import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardList,
  Hammer,
  Hand,
  Loader2,
  MessageSquare,
  Paperclip,
  Shrink,
  Square,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import {
  addBinaryToWorkspace,
  addFilesToWorkspace,
  addPathsToWorkspace,
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
import { ModelPicker } from "@/components/thread/ModelPicker";
import { AcpConfigPicker } from "@/components/thread/AcpConfigPicker";
import type { AcpConfigOption } from "@ai4s/sdk/acp";
import { WorkspaceChip } from "@/components/thread/WorkspaceChip";
import { useUiStore } from "@/lib/store";
import { parkDraft, unparkDraft } from "@/lib/composerStash";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useCompactWidth } from "@/lib/useCompactWidth";
import { isGatewayWeb } from "@/lib/webMode";

/** Composer width below which the toolbar shows icons without their labels. */
const TOOLBAR_LABEL_MIN_PX = 440;

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
}

/** The two approval modes the composer can switch between (Codex-style). Copy
 *  (label/description) is translated at render time — see `approvalCopy`. */
const APPROVAL_OPTIONS: { mode: ApprovalMode; icon: typeof Hand }[] = [
  { mode: "approve", icon: Hand },
  { mode: "full", icon: Zap },
];

/** Build (default) or Plan — OpenCode's read-only planning agent. Copy is
 *  translated at render time (`agentCopy`), mirroring the approval switch. */
const AGENT_OPTIONS: { mode: AgentMode; icon: typeof Hammer }[] = [
  { mode: "build", icon: Hammer },
  { mode: "plan", icon: ClipboardList },
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
 *          A "/name" that matches no known command stays a plain prompt.
 */
export function Composer({
  onSend,
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
  configOptions,
  onConfigOption,
  showWorkspaceChip = true,
  draftKey,
  sessionDir,
  currentSessionId,
  onInteract,
  onCompactContext,
  compacting,
  acceptsHandoff = true,
  visible = true,
}: {
  /** `attachments` are the chip file names, omitted when there are none. The
   *  text already names them; the list lets the send attach the images too. */
  onSend?: (text: string, attachments?: string[]) => void;
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
  /** The Build/Plan agent switch — same both-or-nothing contract; the live
   *  session withholds it when the runtime has no "plan" agent. */
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  /** Show the inline model + reasoning-effort switcher (left of send). The live
   *  session opts in; static mock sessions have no runtime to switch. */
  showModelPicker?: boolean;
  /** Bind the model picker to a session (per-pane model/effort); omit for the
   *  global default. */
  modelSessionId?: string;
  /** An ACP agent's OWN session selectors (model, reasoning level, mode). They
   *  replace the model picker when an ACP agent is driving: the agent owns its
   *  model, and these are the choices it actually offers (#14). */
  configOptions?: AcpConfigOption[];
  onConfigOption?: (configId: string, value: string) => void;
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
  /** When provided, shows the manual compress-context button left of the model
   *  picker. The live session wires it to `compactContext`; static mock
   *  sessions omit it. Disabled while a turn runs or a compaction is in
   *  flight for this session. */
  onCompactContext?: () => void;
  compacting?: boolean;
  /** May this composer take an app-wide prepared draft (the provenance panel's
   *  "Reproduce")? Exactly one should: every pane of every screen is mounted,
   *  including hidden ones, and a draft claimed by any other lands where the
   *  user cannot see it. The live session passes its focused pane. */
  acceptsHandoff?: boolean;
  /** This composer's pane has layout boxes. A pane in a Screen hidden without
   *  layout cannot be measured until it comes back — and one that kept its
   *  layout must not be re-measured at all (see useCompactWidth). */
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
  // Agent-mode copy, same pattern as approvalCopy.
  const agentCopy: Record<AgentMode, { label: string; description: string }> = {
    build: {
      label: t("composer.agent.build.label"),
      description: t("composer.agent.build.description"),
    },
    plan: {
      label: t("composer.agent.plan.label"),
      description: t("composer.agent.plan.description"),
    },
  };
  // Reclaim whatever this pane had typed before it was last unmounted (a screen
  // switch tears panes down). Unparked once, on mount, so the two states below
  // seed from the same draft.
  const [restored] = useState(() => (draftKey ? unparkDraft(draftKey) : null));
  const [value, setValue] = useState(restored?.text ?? "");
  const [files, setFiles] = useState<string[]>(restored?.files ?? []);
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
  const approvalRef = useRef<HTMLDivElement>(null);
  /** The agent-mode menu is open. */
  const [agentOpen, setAgentOpen] = useState(false);
  const agentRef = useRef<HTMLDivElement>(null);

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
  // Same for the agent menu.
  useEffect(() => {
    if (!agentOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!agentRef.current?.contains(e.target as Node)) setAgentOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [agentOpen]);
  // A narrow pane cannot fit "Approve for me · Build · GPT-5.6 sol · High" as
  // words — the row wrapped and ate the composer's height. Below this width the
  // toolbar keeps the icons and drops the labels; every one of those buttons
  // already carries an aria-label and a title, so nothing becomes unreachable.
  const rootRef = useRef<HTMLDivElement>(null);
  const compactToolbar = useCompactWidth(rootRef, TOOLBAR_LABEL_MIN_PX, visible);

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
    ? commands
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
  const pick = (c: ComposerCommand) => {
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
      if (m && commands.some((c) => c.name === m[1])) {
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

  const submit = () => {
    if (disabled) return;
    const text = value.trim();
    setHist(null);
    // A chipped command runs as itself — arguments optional.
    if (command) {
      onRunCommand?.(command, text);
      recordHistory(text ? `/${command} ${text}` : `/${command}`);
      setCommand(null);
      setValue("");
      return;
    }
    // "!" — run the rest of the line as a shell command (no model turn).
    if (shellMode) {
      const line = value.slice(1).trim();
      if (!line) return;
      onRunShell?.(line);
      recordHistory(`!${line}`);
      setValue("");
      return;
    }
    // "/name args" — run a KNOWN slash command; unknown names stay a prompt
    // (a message can legitimately start with a path like "/etc/hosts …").
    if (onRunCommand && text.startsWith("/")) {
      const name = text.slice(1).split(/\s/, 1)[0];
      if (commands.some((c) => c.name === name)) {
        onRunCommand(name, text.slice(1 + name.length).trim());
        recordHistory(text);
        setValue("");
        return;
      }
    }
    if (!text && files.length === 0 && refSessions.length === 0) return;
    const fileNote =
      files.length > 0 ? `Files added to the workspace: ${files.join(", ")}` : "";
    const base = text && fileNote ? `${text}\n\n${fileNote}` : text || fileNote;
    // The chips travel with the text: the note names the workspace copy, and the
    // names let the send turn images into real multimodal parts (#88). Passed
    // only when there are chips, so a plain send keeps its one-argument shape.
    const attachments = files.length > 0 ? [...files] : null;
    const send = (t: string) => (attachments ? onSend?.(t, attachments) : onSend?.(t));
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
    if (text) recordHistory(text);
    setValue("");
    setFiles([]);
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
        pick(matches[selIndex]);
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Very long pastes become a workspace file chip instead of flooding the box;
  // a pasted image (screenshot) becomes an image file chip. Both land in the
  // draft's own folder (materialized first) so the session can see them.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!isTauri || !onSend) return;
    // A clipboard image — works the same across macOS/Windows/Linux webviews,
    // which all expose the bitmap as an `image/*` clipboard item.
    const imageItem = Array.from(e.clipboardData.items ?? []).find((it) =>
      it.type.startsWith("image/"),
    );
    const blob = imageItem?.getAsFile();
    if (blob) {
      e.preventDefault();
      void addWorkspaceFile(async () => {
        const base64 = await blobToBase64(blob);
        return addBinaryToWorkspace(`pasted.${imageExt(blob.type)}`, base64);
      });
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (text.length <= PASTE_AS_FILE_CHARS && text.split("\n").length <= PASTE_AS_FILE_LINES) {
      return; // normal paste
    }
    e.preventDefault();
    void addWorkspaceFile(() => addTextToWorkspace("pasted.txt", text));
  };

  // Shared: materialize the draft's folder, run the write, and chip the result
  // (one file or several — paste yields one, a multi-file drop yields many).
  const addWorkspaceFile = async (write: () => Promise<string | string[]>) => {
    try {
      await useRuntimeStore.getState().ensureDraftWorkspace();
      const res = await write();
      const names = Array.isArray(res) ? res : [res];
      if (names.length > 0) setFiles((f) => [...f, ...names]);
    } catch (err) {
      toast.error(
        t("composer.error.paste", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
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

  // Copy local files into the agent workspace; they appear as chips.
  const addFiles = async () => {
    setAdding(true);
    try {
      // Same as paste: give the draft its folder before copying files in.
      await useRuntimeStore.getState().ensureDraftWorkspace();
      const names = await addFilesToWorkspace();
      if (names.length > 0) setFiles((f) => [...f, ...names]);
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

  const canAttach = isTauri && !!onSend;
  const canSend =
    !disabled &&
    (command
      ? true // a chipped command may run without arguments
      : shellMode
        ? value.slice(1).trim().length > 0
        : !!value.trim() || files.length > 0);

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative rounded-card border bg-surface px-2 py-2 shadow-card",
        // Plan mode gets the blue link tone — distinct from shell (warn) and
        // a chipped command (accent) — so a read-only turn is unmistakable.
        shellMode
          ? "border-warn/60"
          : command
            ? "border-accent/50"
            : agentMode === "plan"
              ? "border-link/60"
              : "border-border",
        // Dragging a file over the window: highlight the composer as the target.
        dragOver && "border-accent ring-2 ring-accent/40",
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
              <span className="shrink-0 font-mono text-xs text-text">/{c.name}</span>
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
            <span
              key={name}
              className="flex items-center gap-1.5 rounded-input bg-surface-2 py-1 pl-2 pr-1 font-mono text-xs text-text ring-1 ring-border"
            >
              <Paperclip size={11} className="shrink-0 text-muted" />
              <span className="max-w-[220px] truncate">{name}</span>
              <button
                className="rounded p-0.5 text-muted hover:bg-border hover:text-text"
                aria-label={t("composer.file.removeAria", { name })}
                onClick={() => setFiles((f) => f.filter((n) => n !== name))}
              >
                <X size={11} />
              </button>
            </span>
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
          "max-h-[160px] w-full resize-none bg-transparent px-1.5 py-0.5 text-sm leading-6 text-text outline-none placeholder:text-muted",
          (shellMode || command) && "font-mono",
        )}
        aria-label={t("composer.placeholder.default")}
      />
      {/* Codex-style action row: mode controls bottom-left, send bottom-right.
          `flex-wrap` so a narrow (tiled) pane wraps the controls to a second
          line instead of overflowing outside the box. */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
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
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
              aria-label={t("composer.attach.addAria")}
              title={t("composer.attach.title")}
              onClick={() => void addFiles()}
              disabled={adding}
            >
              <Paperclip size={15} />
            </button>
          )
        )}
        {/* Folder picker for a fresh draft — renders nothing once the session
            exists (its folder then shows in the header's Files toggle). */}
        {showWorkspaceChip && <WorkspaceChip draftKey={draftKey} />}
        {agentMode && onAgentModeChange && (
          <div className="relative shrink-0" ref={agentRef}>
            {agentOpen && (
              <div
                role="menu"
                aria-label={t("composer.agent.menuAria")}
                className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-card border border-border bg-surface p-1 shadow-card"
              >
                <div className="px-2 pb-1 pt-1.5 text-xs text-muted">
                  {t("composer.agent.menuTitle")}
                </div>
                {AGENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    role="menuitemradio"
                    aria-checked={opt.mode === agentMode}
                    className="flex w-full items-start gap-2 rounded-input px-2 py-1.5 text-left hover:bg-surface-2"
                    // mousedown, not click — a click would blur the textarea first.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setAgentOpen(false);
                      if (opt.mode !== agentMode) onAgentModeChange(opt.mode);
                    }}
                  >
                    <opt.icon size={13} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-text">{agentCopy[opt.mode].label}</span>
                      <span className="block text-xs text-muted">
                        {agentCopy[opt.mode].description}
                      </span>
                    </span>
                    {opt.mode === agentMode && (
                      <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <button
              aria-label={t("composer.agent.aria")}
              title={t("composer.agent.title")}
              className={cn(
                "flex h-7 items-center rounded-full text-xs",
                compactToolbar ? "gap-0.5 px-1.5" : "gap-1.5 px-2.5",
                agentMode === "plan"
                  ? "bg-link/15 text-link hover:bg-link/25"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
              onClick={() => setAgentOpen((o) => !o)}
            >
              {agentMode === "plan" ? <ClipboardList size={12} /> : <Hammer size={12} />}
              {!compactToolbar && <span>{agentCopy[agentMode].label}</span>}
              {!compactToolbar && <ChevronDown size={11} />}
            </button>
          </div>
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
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {onCompactContext && (
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("composer.compact.aria")}
              title={t("composer.compact.title")}
              onClick={onCompactContext}
              disabled={compacting || working || disabled}
            >
              {compacting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Shrink size={13} />
              )}
            </button>
          )}
          {showModelPicker && <ModelPicker sessionId={modelSessionId} compact={compactToolbar} />}
          {configOptions && onConfigOption && (
            <AcpConfigPicker options={configOptions} onChange={onConfigOption} disabled={working} />
          )}
          {working && onStop ? (
            // Same spot, same shape, one action: the send button becomes Stop
            // while the agent works — always live, even though the input is not.
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input bg-accent text-accent-fg hover:opacity-90"
              aria-label={t("composer.stop.aria")}
              title={t("composer.stop.title")}
              onClick={onStop}
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40"
              aria-label={t("composer.send.aria")}
              onClick={submit}
              disabled={!canSend}
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

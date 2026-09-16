import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { cn } from "@/lib/cn";
import type { MountedEditor } from "./codeMirrorSetup";

/**
 * A real text editor for the places this app lets you TYPE code — notebook
 * cells and an edited file (#33).
 *
 * CodeMirror rather than Monaco: JupyterLab 4 runs CodeMirror 6 for exactly
 * this job, it loads a language at a time instead of a whole IDE, and it is
 * light enough for a narrow tiled pane. Read-only code elsewhere (chat blocks,
 * diffs, the file preview) stays on `CodeViewer`'s highlight.js — mounting an
 * editor per code block in a long thread would cost far more than it returns.
 *
 * CodeMirror itself sits behind a dynamic import (`codeMirrorSetup`): it is
 * ~216 kB gzipped, and a session that never edits anything never loads it.
 */
export type CodeEditorLanguage = "python" | "markdown" | "json" | "text";

/** A key this editor must handle BEFORE CodeMirror's own bindings.
 *
 *  It has to go through CodeMirror's keymap rather than a React `onKeyDown`:
 *  CodeMirror listens on the content element, which fires before React's
 *  root-level listener, so by the time a React handler called preventDefault
 *  the editor had already inserted the newline. */
export interface CodeEditorCommand {
  /** CodeMirror key syntax: `Shift-Enter`, `Mod-Enter`, `Escape`, `Mod-s`. */
  key: string;
  run: () => void;
}

export interface CodeEditorHandle {
  focus(): void;
  /** Focus with the caret at the very end — how Jupyter enters a cell from the
   *  keyboard, as opposed to a click, which keeps the caret where it landed. */
  focusAtEnd(): void;
  /** Formatting, for a toolbar above the editor. Each one leaves the caret
   *  where typing continues naturally and hands focus back to the text. */
  wrap(before: string, after: string): void;
  linePrefix(prefix: string): void;
  insert(text: string): void;
}

/** Map a file's language name onto the grammars this build carries. Anything
 *  else edits as plain text, which is still an editor — just without
 *  highlighting — and never an error. */
export function editorLanguage(language: string | undefined): CodeEditorLanguage {
  switch (language?.toLowerCase()) {
    case "python":
    case "py":
      return "python";
    case "markdown":
    case "md":
      return "markdown";
    case "json":
    case "ipynb":
      return "json";
    default:
      return "text";
  }
}

export function CodeEditor({
  value,
  language = "text",
  readOnly = false,
  lineNumbers = false,
  maxHeight,
  commands,
  onChange,
  onFocus,
  ariaLabel,
  placeholder,
  className,
  handleRef,
}: {
  value: string;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  lineNumbers?: boolean;
  /** Shown while the file is empty — a new note otherwise opens as a blank
   *  rectangle that gives the writer nothing to start from. */
  placeholder?: string;
  /** CSS length. Past it the editor scrolls instead of growing without bound. */
  maxHeight?: string;
  commands?: CodeEditorCommand[];
  onChange?: (value: string) => void;
  onFocus?: () => void;
  ariaLabel?: string;
  className?: string;
  handleRef?: Ref<CodeEditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<MountedEditor | null>(null);
  // Props the editor reads at event time reach it through refs, so a new
  // closure on every render never forces a rebuild — which would throw away the
  // caret, the selection and the undo history on each keystroke.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const valueRef = useRef(value);
  valueRef.current = value;
  const ariaLabelRef = useRef(ariaLabel);
  ariaLabelRef.current = ariaLabel;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => editor.current?.focus(),
      focusAtEnd: () => editor.current?.focusAtEnd(),
      wrap: (before, after) => editor.current?.wrap(before, after),
      linePrefix: (prefix) => editor.current?.linePrefix(prefix),
      insert: (text) => editor.current?.insert(text),
    }),
    [],
  );

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let disposed = false;
    void (async () => {
      const { mountEditor } = await import("./codeMirrorSetup");
      // The pane can close while the chunk is in flight; mounting into a
      // detached node would leave an editor nobody can reach or destroy.
      if (disposed) return;
      editor.current = mountEditor({
        parent,
        // Read at mount time: both may have moved on while the chunk loaded.
        doc: valueRef.current,
        ariaLabel: ariaLabelRef.current,
        placeholder: placeholderRef.current,
        language,
        readOnly,
        lineNumbers,
        getCommands: () => commandsRef.current ?? [],
        onChange: (next) => onChangeRef.current?.(next),
      });
    })();
    return () => {
      disposed = true;
      editor.current?.destroy();
      editor.current = null;
    };
    // Built once per language/mode. `value` and `ariaLabel` are pushed into the
    // live editor by the effects below rather than by rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, lineNumbers]);

  useEffect(() => {
    editor.current?.relabel(ariaLabel, readOnly);
  }, [ariaLabel, readOnly]);

  // Adopt a value that changed OUTSIDE the editor: a reload from disk, or an
  // agent writing the file the user is looking at.
  useEffect(() => {
    editor.current?.setValue(value);
  }, [value]);

  return (
    <div
      ref={host}
      onFocus={onFocus}
      style={maxHeight ? { maxHeight } : undefined}
      className={cn(
        "w-full overflow-hidden rounded-input border border-border bg-surface text-text",
        "focus-within:border-accent/50",
        className,
      )}
    />
  );
}

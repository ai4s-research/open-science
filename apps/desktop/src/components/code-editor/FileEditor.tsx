import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/lib/store";
import type { CodeEditorHandle } from "./CodeEditor";
import type { MountedEditor } from "./monacoSetup";

/**
 * A real editor for a real file.
 *
 * Monaco — the editor VS Code runs, and the one Orca uses. Everything that
 * makes editing a file bearable comes with it: find and replace, multiple
 * cursors, column selection, folding, a minimap, sticky scroll, bracket
 * colouring, a suggest widget, and a context menu that knows what it is looking
 * at. None of that is a feature you bolt on afterwards.
 *
 * Notebook CELLS keep `CodeEditor` (CodeMirror): they are one-line boxes by the
 * dozen, JupyterLab runs CodeMirror there for the same reason, and mounting a
 * full IDE per cell would be absurd.
 *
 * Monaco itself sits behind a dynamic import — a session that never opens a
 * file never loads it.
 */
export function FileEditor({
  value,
  language,
  readOnly = false,
  prose = false,
  onChange,
  onSave,
  ariaLabel,
  className,
  handleRef,
}: {
  value: string;
  /** A file's language name or extension; mapped to Monaco's id. */
  language?: string;
  readOnly?: boolean;
  /** Markdown and plain notes: wrapped lines, no minimap, no line numbers. */
  prose?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  ariaLabel?: string;
  className?: string;
  handleRef?: Ref<CodeEditorHandle>;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<MountedEditor | null>(null);
  // Props the editor reads at event time reach it through refs, so a new
  // closure on every render never forces a rebuild — which would throw away the
  // caret, the selection, the undo history and the folded regions.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const valueRef = useRef(value);
  valueRef.current = value;
  const ariaLabelRef = useRef(ariaLabel);
  ariaLabelRef.current = ariaLabel;
  const theme = useUiStore((s) => s.theme);

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
      const { mountEditor, monacoLanguage } = await import("./monacoSetup");
      // The pane can close while the chunk is in flight; mounting into a
      // detached node would leave an editor nobody can reach or destroy.
      if (disposed) return;
      editor.current = mountEditor({
        parent,
        // Read at mount time: both may have moved on while the chunk loaded.
        doc: valueRef.current,
        ariaLabel: ariaLabelRef.current,
        language: monacoLanguage(language),
        readOnly,
        prose,
        onChange: (next) => onChangeRef.current?.(next),
        onSave: () => onSaveRef.current?.(),
      });
    })();
    return () => {
      disposed = true;
      editor.current?.destroy();
      editor.current = null;
    };
    // Built once per file kind. `value` and `ariaLabel` are pushed into the live
    // editor by the effects below rather than by rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, prose]);

  useEffect(() => {
    editor.current?.relabel(ariaLabel, readOnly);
  }, [ariaLabel, readOnly]);

  // Adopt a value that changed OUTSIDE the editor: a reload from disk, or an
  // agent writing the file the user is looking at.
  useEffect(() => {
    editor.current?.setValue(value);
  }, [value]);

  // Monaco resolves its colours once, so a theme change has to be handed to it.
  useEffect(() => {
    editor.current?.retheme();
  }, [theme]);

  return <div ref={host} className={cn("h-full w-full min-w-0", className)} />;
}

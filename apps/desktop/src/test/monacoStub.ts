// A stand-in for Monaco in tests.
//
// Monaco measures fonts, uses canvas and expects a real layout engine, none of
// which jsdom has — mounting it in a unit test produces an empty box. The tests
// that reach for an editor are not testing Monaco (it is VS Code's editor and
// carries its own suite); they test the SURROUNDING behaviour: that typing
// marks the file dirty, that autosave writes, that discard throws the draft
// away. A textarea with the same contract exercises all of that.
import { applyLinePrefixToBlock } from "@/components/code-editor/markdownEdits";
import type { MountedEditor } from "@/components/code-editor/monacoSetup";

/** Inlined, not re-exported: a mock factory cannot import the module it is
 *  standing in for. Tests never assert on the mapping — `monacoSetup`'s own
 *  tests do. */
export function monacoLanguage(language: string | undefined): string {
  return language ?? "plaintext";
}

export function mountEditor(options: {
  parent: HTMLElement;
  doc: string;
  readOnly: boolean;
  ariaLabel: string | undefined;
  onChange: (value: string) => void;
  onSave?: () => void;
}): MountedEditor {
  const area = options.parent.ownerDocument.createElement("textarea");
  area.value = options.doc;
  area.readOnly = options.readOnly;
  if (options.ariaLabel) area.setAttribute("aria-label", options.ariaLabel);
  area.addEventListener("input", () => options.onChange(area.value));
  // Cmd/Ctrl+S is the app's, not the browser's — the real editor binds it too.
  area.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      options.onSave?.();
    }
  });
  options.parent.appendChild(area);

  /** Replace the selection, or insert at the caret when there is none. */
  const replace = (text: string, select?: { from: number; to: number }) => {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    area.value = area.value.slice(0, start) + text + area.value.slice(end);
    if (select) area.setSelectionRange(start + select.from, start + select.to);
    options.onChange(area.value);
  };

  return {
    setValue: (next) => {
      if (area.value === next) return;
      area.value = next;
    },
    relabel: (ariaLabel, readOnly) => {
      if (ariaLabel) area.setAttribute("aria-label", ariaLabel);
      area.readOnly = readOnly;
    },
    focus: () => area.focus(),
    focusAtEnd: () => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    },
    wrap: (before, after) => {
      const start = area.selectionStart ?? 0;
      const end = area.selectionEnd ?? start;
      const selected = area.value.slice(start, end);
      replace(before + selected + after, {
        from: before.length,
        to: before.length + selected.length,
      });
    },
    linePrefix: (prefix) => {
      // The real rule, not an approximation: the toolbar test is about whether
      // a heading BECOMES a quote, which is `applyLinePrefixToBlock`'s job.
      const caret = area.selectionStart ?? 0;
      const start = area.value.lastIndexOf("\n", caret - 1) + 1;
      const lineEnd = area.value.indexOf("\n", area.selectionEnd ?? caret);
      const end = lineEnd === -1 ? area.value.length : lineEnd;
      const block = applyLinePrefixToBlock(area.value.slice(start, end), prefix);
      area.value = area.value.slice(0, start) + block + area.value.slice(end);
      options.onChange(area.value);
    },
    insert: (text) => replace(text),
    retheme: () => {},
    layout: () => {},
    destroy: () => area.remove(),
  };
}

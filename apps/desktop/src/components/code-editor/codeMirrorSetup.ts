// Everything that touches CodeMirror, kept behind one dynamic import.
//
// Why a separate module: CodeMirror plus its three grammars is ~216 kB gzipped,
// and most sessions never open an editor at all. Importing it from the React
// component would put all of that in the first chunk the app loads — which the
// phone on the web gateway pays for before it has rendered anything.
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers as lineNumberGutter,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { tags } from "@lezer/highlight";
import { applyLinePrefixToBlock, wrapSelection } from "./markdownEdits";
import type { CodeEditorCommand, CodeEditorLanguage } from "./CodeEditor";

function languageExtension(language: CodeEditorLanguage): Extension[] {
  switch (language) {
    case "python":
      return [python()];
    case "markdown":
      return [markdown()];
    case "json":
      return [json()];
    case "text":
      return [];
  }
}

/** Token colours come from the same CSS variables `.hljs-*` uses, so the editor
 *  follows the app's theme (all three of them) without a second palette to keep
 *  in step. */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--hl-keyword)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--hl-entity)" },
  { tag: [tags.definition(tags.variableName), tags.propertyName], color: "var(--hl-entity)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--hl-constant)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--hl-string)" },
  { tag: [tags.standard(tags.variableName), tags.self], color: "var(--hl-builtin)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--hl-comment)" },
  { tag: [tags.tagName, tags.heading], color: "var(--hl-tag)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, textDecoration: "underline" },
]);

/** Chrome that has to be CSS rather than Tailwind: these class names belong to
 *  CodeMirror's own DOM, which never passes through any of this app's JSX. */
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--color-text, inherit)" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    padding: "0.75rem",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: "12.5px",
    lineHeight: "1.65",
    caretColor: "currentColor",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--hl-comment)",
    paddingRight: "0.25rem",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-line": { padding: "0" },
});

function contentAttributes(ariaLabel: string | undefined, readOnly: boolean): Extension {
  return EditorView.contentAttributes.of({
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(readOnly ? { "aria-readonly": "true" } : {}),
  });
}

/** The live editor, as the React component drives it. */
export interface MountedEditor {
  /** Replace the text when it changed OUTSIDE the editor. A no-op when the
   *  editor already holds it — dispatching the same text would collapse the
   *  selection on every keystroke. */
  setValue(next: string): void;
  /** Change the accessible label without rebuilding the view. Notebook cells
   *  are labelled by position, so inserting one relabels every cell below it;
   *  a rebuild there would discard undo history and carets the user never
   *  touched. */
  relabel(ariaLabel: string | undefined, readOnly: boolean): void;
  focus(): void;
  focusAtEnd(): void;
  /** Wrap the selection in markers — bold, italic, code, a link. Toggles back
   *  off when the selection already carries them. */
  wrap(before: string, after: string): void;
  /** Put a heading/list/quote marker on every line the selection touches. */
  linePrefix(prefix: string): void;
  /** Drop text in at the caret, replacing any selection. */
  insert(text: string): void;
  destroy(): void;
}

export function mountEditor(options: {
  parent: HTMLElement;
  doc: string;
  language: CodeEditorLanguage;
  readOnly: boolean;
  lineNumbers: boolean;
  ariaLabel: string | undefined;
  /** Shown while the document is empty, as Orca's markdown editor does. */
  placeholder: string | undefined;
  /** Read through a getter so a re-render's new closures are picked up without
   *  rebuilding the editor. */
  getCommands: () => CodeEditorCommand[];
  onChange: (value: string) => void;
}): MountedEditor {
  const labels = new Compartment();
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(highlightStyle),
        ...languageExtension(options.language),
        ...(options.lineNumbers ? [lineNumberGutter()] : []),
        ...(options.placeholder ? [placeholderExtension(options.placeholder)] : []),
        // Highest precedence: these keys mean something to the surrounding app
        // (run this cell, leave edit mode, save) and must win over the editor's
        // own Enter and Escape.
        Prec.highest(
          keymap.of(
            options.getCommands().map(({ key }) => ({
              key,
              run: () => {
                const command = options.getCommands().find((c) => c.key === key);
                if (!command) return false;
                command.run();
                return true;
              },
            })),
          ),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.readOnly.of(options.readOnly),
        EditorView.editable.of(!options.readOnly),
        // The label belongs on the editable element itself — the element that
        // carries CodeMirror's own `role="textbox"`. Putting it on the wrapper
        // would announce two textboxes per editor.
        labels.of(contentAttributes(options.ariaLabel, options.readOnly)),
        EditorView.lineWrapping,
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    setValue: (next) => {
      if (view.state.doc.toString() === next) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    relabel: (ariaLabel, readOnly) => {
      view.dispatch({ effects: labels.reconfigure(contentAttributes(ariaLabel, readOnly)) });
    },
    wrap: (before, after) => {
      const { from, to } = view.state.selection.main;
      const result = wrapSelection(view.state.sliceDoc(from, to), before, after);
      view.dispatch({
        changes: { from, to, insert: result.text },
        selection: { anchor: from + result.from, head: from + result.to },
      });
      view.focus();
    },
    linePrefix: (prefix) => {
      const { from, to } = view.state.selection.main;
      // Whole lines, always: a marker applies to the line the caret is on, even
      // when nothing is selected.
      const start = view.state.doc.lineAt(from).from;
      const end = view.state.doc.lineAt(to).to;
      const insert = applyLinePrefixToBlock(view.state.sliceDoc(start, end), prefix);
      view.dispatch({
        changes: { from: start, to: end, insert },
        selection: { anchor: start + insert.length },
      });
      view.focus();
    },
    insert: (text) => {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    focus: () => view.focus(),
    focusAtEnd: () => {
      view.focus();
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end, head: end } });
    },
    destroy: () => view.destroy(),
  };
}

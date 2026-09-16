// Everything that touches Monaco, kept behind one dynamic import.
//
// Monaco is the editor VS Code itself runs, and the one Orca uses
// (`components/editor/monaco-*`). The reason to take it whole rather than
// assemble an editor is that the things that make an editor feel real —
// find and replace, folding, multiple cursors, column selection, a suggest
// widget, bracket colouring, a context menu that knows what a symbol is —
// are not features you add one at a time. They are what an editor IS, and
// they arrive together or not at all.
//
// It stays behind a dynamic import for the same reason CodeMirror does: a
// session that never opens a file never pays for it. Notebook cells keep
// CodeMirror — they are one-line boxes by the dozen, where a full IDE per cell
// would be absurd, and JupyterLab 4 runs CodeMirror there for the same reason.
import * as monaco from "monaco-editor";
// Monaco's export map is `"./*": "./esm/vs/*.js"`, so the specifier is the path
// BELOW `esm/vs` — spelling out `esm/vs` here resolves to `esm/vs/esm/vs/...`
// and fails at build time.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

import { applyLinePrefixToBlock, wrapSelection } from "./markdownEdits";

/** Monaco's language services run in workers. Bundled by Vite (`?worker`) and
 *  loaded from the app itself — never from a CDN, which is what Monaco's
 *  default loader would do and which would leave the editor dead offline. */
function installWorkers(): void {
  self.MonacoEnvironment = {
    getWorker(_id: string, label: string) {
      if (label === "json") return new JsonWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };
}

/** The app's own palette, as a Monaco theme.
 *
 *  Read from the same CSS variables the rest of the app uses, so the editor
 *  follows every theme (including the user's own) without a second palette to
 *  keep in step. Monaco needs hex, not `var(...)`, so the values are resolved
 *  at definition time and the theme is redefined whenever it may have changed.
 */
function defineTheme(): string {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const background = read("--surface", "#ffffff");
  const foreground = read("--text", "#2a2723");
  // Monaco rejects 4- and 8-digit hex and anything that is not hex at all.
  const hex = (value: string, fallback: string) =>
    /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

  monaco.editor.defineTheme(THEME, {
    base: isDark(background) ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: strip(read("--hl-comment", "#8a8580")) },
      { token: "keyword", foreground: strip(read("--hl-keyword", "#a33d2e")) },
      { token: "string", foreground: strip(read("--hl-string", "#3f7f5f")) },
      { token: "number", foreground: strip(read("--hl-constant", "#8a5a00")) },
      { token: "type", foreground: strip(read("--hl-entity", "#2f5fa8")) },
    ],
    colors: {
      "editor.background": hex(background, "#ffffff"),
      "editor.foreground": hex(foreground, "#2a2723"),
      "editorLineNumber.foreground": hex(read("--muted", "#8a8580"), "#8a8580"),
      "editor.lineHighlightBackground": hex(read("--surface-2", "#f2efe7"), "#f2efe7"),
      "editorIndentGuide.background1": hex(read("--border", "#e5e0d6"), "#e5e0d6"),
    },
  });
  return THEME;
}

const THEME = "osd";

/** Monaco wants a bare hex, no `#`. */
function strip(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "808080";
}

/** Whether a background colour is dark enough to want a dark editor base. */
function isDark(background: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(background.trim());
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i]!, 16));
  // Rec. 601 luma: good enough to pick between two bases.
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** The language ids Monaco knows, mapped from what this app calls a file. */
export function monacoLanguage(language: string | undefined): string {
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
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
      return "javascript";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "ini";
    case "sql":
      return "sql";
    case "r":
      return "r";
    case "html":
      return "html";
    case "css":
      return "css";
    case "xml":
      return "xml";
    case "dockerfile":
      return "dockerfile";
    default:
      return "plaintext";
  }
}

/** The live editor, as the React component drives it. Deliberately the same
 *  shape `codeMirrorSetup` exposes, so the markdown toolbar and the callers do
 *  not care which engine is under them. */
export interface MountedEditor {
  setValue(next: string): void;
  relabel(ariaLabel: string | undefined, readOnly: boolean): void;
  focus(): void;
  focusAtEnd(): void;
  wrap(before: string, after: string): void;
  linePrefix(prefix: string): void;
  insert(text: string): void;
  /** Re-read the palette — the user changed theme. */
  retheme(): void;
  layout(): void;
  destroy(): void;
}

export function mountEditor(options: {
  parent: HTMLElement;
  doc: string;
  language: string;
  readOnly: boolean;
  /** Prose (markdown): wrap lines, no minimap, no line numbers — a note is not
   *  a program, and a minimap of a paragraph is decoration. */
  prose: boolean;
  ariaLabel: string | undefined;
  onChange: (value: string) => void;
  onSave?: () => void;
}): MountedEditor {
  installWorkers();
  const theme = defineTheme();

  const editor = monaco.editor.create(options.parent, {
    value: options.doc,
    language: options.language,
    theme,
    readOnly: options.readOnly,
    ariaLabel: options.ariaLabel,
    automaticLayout: true,
    // What makes it an editor rather than a text box.
    minimap: { enabled: !options.prose },
    lineNumbers: options.prose ? "off" : "on",
    folding: !options.prose,
    stickyScroll: { enabled: !options.prose },
    bracketPairColorization: { enabled: true },
    wordWrap: options.prose ? "on" : "off",
    renderWhitespace: "selection",
    renderLineHighlight: "line",
    occurrencesHighlight: "singleFile",
    selectionHighlight: true,
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSurroundingLines: 2,
    scrollBeyondLastLine: false,
    fontSize: 12.5,
    lineHeight: 1.65,
    fontFamily:
      "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Cascadia Mono', 'Consolas', monospace",
    fontLigatures: true,
    tabSize: 2,
    detectIndentation: true,
    padding: { top: 10, bottom: 10 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    // The pane is narrow and tiled; an overview ruler in it is noise.
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    guides: { indentation: !options.prose, bracketPairs: !options.prose },
    suggestOnTriggerCharacters: true,
    quickSuggestions: !options.prose,
    // Word-based suggestions in prose would propose the last paragraph's nouns.
    wordBasedSuggestions: options.prose ? "off" : "currentDocument",
    contextmenu: true,
  });

  const changed = editor.onDidChangeModelContent(() => {
    options.onChange(editor.getValue());
  });

  // Save belongs to the app, not to the editor, so it is bound here rather than
  // left to Monaco's own (browser-swallowed) Ctrl+S.
  if (options.onSave) {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => options.onSave?.());
  }

  /** Replace the current selection, keeping undo history and the caret sane. */
  const replaceSelection = (text: string, selectAfter?: { from: number; to: number }) => {
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits("osd", [{ range: selection, text, forceMoveMarkers: true }]);
    if (selectAfter) {
      const model = editor.getModel();
      const start = model?.getOffsetAt(selection.getStartPosition()) ?? 0;
      const from = model?.getPositionAt(start + selectAfter.from);
      const to = model?.getPositionAt(start + selectAfter.to);
      if (from && to) {
        editor.setSelection(
          new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column),
        );
      }
    }
    editor.focus();
  };

  return {
    setValue: (next) => {
      // A no-op when it already holds this: pushing the same text would reset
      // the caret on every keystroke the change came from.
      if (editor.getValue() === next) return;
      editor.setValue(next);
    },
    relabel: (ariaLabel, readOnly) => {
      editor.updateOptions({ ariaLabel, readOnly });
    },
    focus: () => editor.focus(),
    focusAtEnd: () => {
      const model = editor.getModel();
      if (model) {
        const last = model.getLineCount();
        editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      }
      editor.focus();
    },
    wrap: (before, after) => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model) return;
      const result = wrapSelection(model.getValueInRange(selection), before, after);
      replaceSelection(result.text, { from: result.from, to: result.to });
    },
    linePrefix: (prefix) => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model) return;
      // Whole lines, always: a marker applies to the line the caret is on, even
      // when nothing is selected.
      const block = new monaco.Range(
        selection.startLineNumber,
        1,
        selection.endLineNumber,
        model.getLineMaxColumn(selection.endLineNumber),
      );
      const insert = applyLinePrefixToBlock(model.getValueInRange(block), prefix);
      editor.executeEdits("osd", [{ range: block, text: insert, forceMoveMarkers: true }]);
      editor.focus();
    },
    insert: (text) => replaceSelection(text),
    retheme: () => {
      monaco.editor.setTheme(defineTheme());
    },
    layout: () => editor.layout(),
    destroy: () => {
      changed.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
    },
  };
}

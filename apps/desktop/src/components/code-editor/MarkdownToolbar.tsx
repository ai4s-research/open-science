import { useTranslation } from "react-i18next";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  Quote,
  Strikethrough,
} from "lucide-react";
import type { CodeEditorHandle } from "./CodeEditor";

/**
 * The formatting row above a markdown file, borrowed from Orca's markdown
 * editor — the same actions in the same order: paragraph and headings, then
 * the character styles, then the three list kinds, then quote, link and code.
 *
 * It drives the CodeMirror document through the editor's handle rather than
 * holding any state of its own: the file is the source of truth, and a button
 * is a shortcut for typing the marker by hand, which is how a markdown editor
 * stays a markdown editor.
 */
export function MarkdownToolbar({ editor }: { editor: () => CodeEditorHandle | null }) {
  const { t } = useTranslation("inspector");
  const prefix = (p: string) => () => editor()?.linePrefix(p);
  const wrap = (before: string, after = before) => () => editor()?.wrap(before, after);

  return (
    <div
      role="toolbar"
      aria-label={t("markdownToolbar.label")}
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-faint px-2 py-1"
    >
      {/* eslint-disable i18next/no-literal-string -- markdown markers, not UI copy */}
      <Button label={t("markdownToolbar.paragraph")} onClick={prefix("")}>
        <Pilcrow size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.heading1")} onClick={prefix("# ")}>
        <Heading1 size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.heading2")} onClick={prefix("## ")}>
        <Heading2 size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.heading3")} onClick={prefix("### ")}>
        <Heading3 size={13} strokeWidth={1.5} />
      </Button>
      <Divider />
      <Button label={t("markdownToolbar.bold")} onClick={wrap("**")}>
        <Bold size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.italic")} onClick={wrap("*")}>
        <Italic size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.strikethrough")} onClick={wrap("~~")}>
        <Strikethrough size={13} strokeWidth={1.5} />
      </Button>
      <Divider />
      <Button label={t("markdownToolbar.bulletList")} onClick={prefix("- ")}>
        <List size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.numberedList")} onClick={prefix("1. ")}>
        <ListOrdered size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.checklist")} onClick={prefix("- [ ] ")}>
        <ListChecks size={13} strokeWidth={1.5} />
      </Button>
      <Divider />
      <Button label={t("markdownToolbar.quote")} onClick={prefix("> ")}>
        <Quote size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.link")} onClick={wrap("[", "](url)")}>
        <LinkIcon size={13} strokeWidth={1.5} />
      </Button>
      <Button label={t("markdownToolbar.code")} onClick={wrap("`")}>
        <Code2 size={13} strokeWidth={1.5} />
      </Button>
      {/* eslint-enable i18next/no-literal-string */}
    </div>
  );
}

function Button({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // The editor must keep the caret: a button that steals focus would apply
      // the marker to whatever was selected before, or to nothing at all.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

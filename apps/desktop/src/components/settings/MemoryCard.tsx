import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import {
  getMemoryEnabled,
  readMemory,
  setMemoryEnabled,
  writeMemory,
  type MemoryScope,
} from "@/lib/tauri";
import { Section } from "./Section";

type SaveState = "idle" | "saving" | "saved";

/**
 * The persistent context layers (#62). Two editable Markdown documents that the
 * runtime loads ahead of the conversation:
 *
 *   global   — one file, applied to every conversation in every project
 *   project  — the open project's own AGENTS.md, applied only inside it
 *
 * They are plain files on purpose: the user can read, edit and delete every
 * line, and nothing the model writes can silently overwrite them. The switch
 * turns both layers off for temporary work.
 */
export function MemoryCard() {
  const { t } = useTranslation(["settings", "common"]);
  const workspace = useRuntimeStore((s) => s.workspace);
  const projects = useRuntimeStore((s) => s.projects);
  const reconnect = useRuntimeStore((s) => s.connectRetry);
  // Project memory belongs to a named project folder — a dated one-off session
  // folder is not somewhere a user would look for lasting notes.
  const project = projects.find((p) => p.path === workspace) ?? null;

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getMemoryEnabled().then(setEnabled);
  }, []);

  const toggle = async () => {
    if (enabled == null || busy) return;
    setBusy(true);
    await setMemoryEnabled(!enabled);
    setEnabled(!enabled);
    // The sidecar restarts to reload its instruction list.
    await reconnect();
    setBusy(false);
  };

  return (
    <>
      <Section title={t("memory.title")} hint={t("memory.hint")}>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled ?? false}
            disabled={enabled == null || busy}
            onChange={() => void toggle()}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block text-[13px] text-text">{t("memory.enableLabel")}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              {t("memory.enableHint")}
            </span>
          </span>
          {busy && <Loader2 size={14} className="ml-auto mt-0.5 shrink-0 animate-spin text-muted" />}
        </label>
      </Section>

      <MemoryEditor
        // eslint-disable-next-line i18next/no-literal-string -- MemoryScope enum, not UI copy
        scope="global"
        directory={null}
        title={t("memory.globalTitle")}
        hint={t("memory.globalHint")}
        placeholder={t("memory.globalPlaceholder")}
        muted={enabled === false}
      />

      {project ? (
        <MemoryEditor
          key={project.path}
          // eslint-disable-next-line i18next/no-literal-string -- MemoryScope enum, not UI copy
          scope="project"
          directory={project.path}
          title={t("memory.projectTitle", { name: project.name })}
          hint={t("memory.projectHint")}
          placeholder={t("memory.projectPlaceholder")}
          muted={enabled === false}
        />
      ) : (
        <Section title={t("memory.projectNoneTitle")} hint={t("memory.projectNoneHint")}>
          <p className="text-[13px] text-muted">{t("memory.projectNoneBody")}</p>
        </Section>
      )}
    </>
  );
}

/** One memory layer: load, edit, save. Save is explicit — an autosaving
 *  instruction file would rewrite itself under a half-typed sentence. */
function MemoryEditor({
  scope,
  directory,
  title,
  hint,
  placeholder,
  muted,
}: {
  scope: MemoryScope;
  directory: string | null;
  title: string;
  hint: string;
  placeholder: string;
  muted: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [state, setState] = useState<SaveState>("idle");

  useEffect(() => {
    let live = true;
    void readMemory(scope, directory).then((v) => {
      if (!live) return;
      setText(v);
      setSaved(v);
    });
    return () => {
      live = false;
    };
  }, [scope, directory]);

  const dirty = text != null && text !== saved;

  const save = async () => {
    if (text == null || !dirty) return;
    setState("saving");
    await writeMemory(scope, directory, text);
    setSaved(text);
    setState("saved");
    // The confirmation is transient; the next edit clears it anyway.
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Section
      title={title}
      hint={hint}
      action={
        <div className="flex shrink-0 items-center gap-2">
          {state === "saved" && !dirty && (
            <span className="flex items-center gap-1 text-xs text-ok">
              <Check size={13} />
              {t("memory.saved")}
            </span>
          )}
          <button
            onClick={() => void save()}
            disabled={!dirty || state === "saving"}
            className="rounded-input bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {t("common:actions.save")}
          </button>
        </div>
      }
    >
      <textarea
        value={text ?? ""}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        rows={8}
        className={cn(
          "w-full resize-y rounded-input border border-border bg-surface-2 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-text outline-none placeholder:text-muted focus:border-accent",
          muted && "opacity-60",
        )}
      />
      {muted && <p className="mt-2 text-xs text-muted">{t("memory.disabledNote")}</p>}
    </Section>
  );
}

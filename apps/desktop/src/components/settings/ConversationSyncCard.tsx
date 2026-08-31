import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Row, Section } from "./Section";
import { pickFolder } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { checkSyncDir, runSync, setSyncDir, syncDir } from "@/lib/syncRunner";
import { useRuntimeStore } from "@/lib/runtime";

/**
 * Conversation sync across a user's own machines (#124).
 *
 * Desktop only, and off until a folder is chosen. The folder is meant to live
 * on a cloud drive; each conversation is mirrored there as its own JSON file,
 * which is what makes this work at all — a cloud client can synchronise many
 * small files but not one live SQLite database.
 */
export function ConversationSyncCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessions = useRuntimeStore((s) => s.sessions);

  useEffect(() => setDir(syncDir()), []);

  const choose = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    try {
      await checkSyncDir(picked);
    } catch (err) {
      toast.error(`${t("sync.unusable")}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setSyncDir(picked);
    setDir(picked);
    toast.success(t("sync.folderSet"));
  }, [t]);

  const stop = useCallback(() => {
    setSyncDir(null);
    setDir(null);
    toast.success(t("sync.stopped"));
  }, [t]);

  const now = useCallback(async () => {
    setBusy(true);
    try {
      const result = await runSync(sessions.map((s) => ({ id: s.id, updated: s.updated })));
      if (!result) return;
      // Errors are reported even when some conversations did sync: a silent
      // partial failure is how a machine quietly stops carrying its history.
      if (result.errors.length > 0) toast.error(result.errors[0]);
      else toast.success(t("sync.done", { imported: result.imported, exported: result.exported }));
    } finally {
      setBusy(false);
    }
  }, [sessions, t]);

  return (
    <Section title={t("sync.title")} hint={t("sync.hint")} flush>
      <div className="divide-y divide-faint">
        <Row
          title={t("sync.folderTitle")}
          hint={dir ?? t("sync.folderNone")}
          control={
            <div className="flex shrink-0 items-center gap-2">
              <button
                className="inline-flex items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
                onClick={() => void choose()}
              >
                <FolderOpen size={14} />
                {dir ? t("sync.change") : t("sync.choose")}
              </button>
              {dir && (
                <button
                  className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
                  onClick={stop}
                >
                  {t("sync.stop")}
                </button>
              )}
            </div>
          }
        />
        {dir && (
          <Row
            title={t("sync.nowTitle")}
            hint={t("sync.nowHint")}
            control={
              <button
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-60"
                onClick={() => void now()}
              >
                <RefreshCw size={14} className={busy ? "animate-spin" : undefined} />
                {busy ? t("sync.running") : t("sync.now")}
              </button>
            }
          />
        )}
      </div>
    </Section>
  );
}

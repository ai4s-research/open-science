import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import {
  FileSearch,
  Moon,
  NotebookPen,
  PackagePlus,
  Plus,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useUiStore } from "@/lib/store";
import { openDraftScreen, useRuntimeStore } from "@/lib/runtime";
import { DEFAULT_PROJECT, useLayoutStore } from "@/lib/layout";
import { useIsMobile } from "@/lib/useIsMobile";
import { isGatewayWeb } from "@/lib/webMode";
import { WORKFLOW_STARTERS } from "@/components/thread/WorkflowStarters";

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Prompt for a starter workflow by id, so ⌘K and the empty-session cards stay in sync. */
const starterPrompt = (id: string) => WORKFLOW_STARTERS.find((s) => s.id === id)?.prompt ?? "";

export function CommandPalette() {
  const { t } = useTranslation("nav");
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const navigate = useNavigate();
  // Tiling is desktop-only: web/phone show one pane, so there is no Screen to open.
  const newPaneAllowed = !useIsMobile() && !isGatewayWeb;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      }
      // Consume Esc only when the palette is open — a marked-handled Esc must
      // not also interrupt a running agent turn (LiveSessionPage listens too).
      if (e.key === "Escape" && useUiStore.getState().paletteOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const close = () => setOpen(false);

  // Start a new session and send a workflow prompt, then reveal that session.
  // Its own Screen and pane, like every other "new session" entry — the pane the
  // user was reading stays put.
  const runWorkflow = async (starterId: string) => {
    close();
    const layout = useLayoutStore.getState();
    // A workflow's session lands in a dated folder, so its Screen is Default's.
    const leafId = newPaneAllowed ? layout.openInNewGroup(null, DEFAULT_PROJECT) : null;
    useRuntimeStore.getState().startDraft();
    const id = await useRuntimeStore.getState().sendPrompt(starterPrompt(starterId));
    if (id && leafId) layout.bindSession(leafId, id);
    if (id) navigate(`/live/${id}`);
  };

  const actions: Action[] = [
    { id: "new", label: t("commandPalette.actions.newSession"), icon: <Plus size={16} />, run: () => { if (newPaneAllowed) openDraftScreen(DEFAULT_PROJECT); useRuntimeStore.getState().startDraft(); navigate("/live"); close(); } },
    { id: "analyze", label: t("commandPalette.actions.analyzeData"), icon: <FileSearch size={16} />, run: () => void runWorkflow("analyze") },
    { id: "review", label: t("commandPalette.actions.auditReport"), icon: <ShieldCheck size={16} />, run: () => void runWorkflow("audit") },
    { id: "notebooks", label: t("commandPalette.actions.openNotebooks"), icon: <NotebookPen size={16} />, run: () => { navigate("/notebooks"); close(); } },
    { id: "skills", label: t("commandPalette.actions.manageSkills"), icon: <PackagePlus size={16} />, run: () => { navigate("/skills"); close(); } },
    { id: "settings", label: t("commandPalette.actions.openSettings"), icon: <Settings size={16} />, run: () => { navigate("/settings"); close(); } },
    { id: "theme", label: t("commandPalette.actions.toggleTheme"), icon: <Moon size={16} />, run: () => { toggleTheme(); close(); } },
  ];

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[16vh]"
      onClick={close}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg">
        <Command
          label={t("commandPalette.ariaLabel")}
          className="overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          <Command.Input
            autoFocus
            placeholder={t("commandPalette.placeholder")}
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
              {t("commandPalette.noResults")}
            </Command.Empty>
            {actions.map((a) => (
              <Command.Item
                key={a.id}
                value={a.label}
                onSelect={a.run}
                className="flex cursor-pointer items-center gap-3 rounded-input px-3 py-2 text-sm text-text data-[selected=true]:bg-surface-2"
              >
                <span className="text-muted">{a.icon}</span>
                {a.label}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

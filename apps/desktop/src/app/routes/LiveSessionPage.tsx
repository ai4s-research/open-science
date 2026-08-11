import { useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useRuntimeStore } from "@/lib/runtime";
import { findLeaf, leaves, useLayoutStore } from "@/lib/layout";
import { useIsMobile } from "@/lib/useIsMobile";
import { isGatewayWeb } from "@/lib/webMode";
import { SessionView } from "@/components/session/SessionView";
import { PaneTree } from "@/components/session/PaneTree";
import { GroupTabs } from "@/components/session/GroupTabs";
import { EmptyGroup } from "@/components/session/EmptyGroup";
import { PresentedArtifactPane } from "@/components/session/PresentedArtifactPane";

/**
 * Live agent surface. Owns the split-layout ↔ runtime plumbing: it keeps the
 * URL and the single directory-scoped stream (`openSession`) in step with the
 * FOCUSED pane, and renders either a single session (one pane, or the web /
 * phone fallback where tiling can't work) or the ghostty-style pane tree.
 *
 * Per-session concerns (thread, composer, right pane) live in SessionView; this
 * wrapper never reads them, so a background pane's SSE folds don't repaint it.
 */
export function LiveSessionPage() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const tree = useLayoutStore((s) => s.tree);
  const focusedLeafId = useLayoutStore((s) => s.focusedLeafId);
  const pruneSessions = useLayoutStore((s) => s.pruneSessions);
  const focusedLeaf = tree && focusedLeafId ? findLeaf(tree, focusedLeafId) : null;
  const focusedSid = focusedLeaf?.sessionId ?? null;

  const status = useRuntimeStore((s) => s.status);
  const switching = useRuntimeStore((s) => s.switching);
  const sessions = useRuntimeStore((s) => s.sessions);
  const workspace = useRuntimeStore((s) => s.workspace);
  const runningCount = useRuntimeStore((s) => Object.keys(s.runningSessions).length);
  const openSession = useRuntimeStore((s) => s.openSession);
  const loadHistory = useRuntimeStore((s) => s.loadHistory);
  const resetDraftView = useRuntimeStore((s) => s.resetDraftView);
  const reconcileRunning = useRuntimeStore((s) => s.reconcileRunning);
  const syncPaneStreams = useRuntimeStore((s) => s.syncPaneStreams);

  const connected = status === "ready" || switching;
  const sessionDir = sessions.find((s) => s.id === focusedSid)?.directory;

  const isMobile = useIsMobile();
  // Tiling can't work on a phone or the narrow web client — show the focused
  // pane alone (the tree is kept, so it returns when there's room again). On
  // desktop we ALWAYS render the tree, even for a lone pane, so it stays a
  // drop target for docking the first dragged-in session.
  const webOrMobile = isMobile || isGatewayWeb;

  // Every DISTINCT folder shown across the panes — background streams keep the
  // non-foreground ones live so different projects stream concurrently. In the
  // single-pane fallback only the focused pane renders, so no background streams
  // are wanted (the foreground stream covers it).
  const paneDirs = useMemo(() => {
    if (webOrMobile || !tree) return [];
    const dirs = new Set<string>();
    for (const l of leaves(tree)) {
      if (!l.sessionId) continue;
      const d = sessions.find((s) => s.id === l.sessionId)?.directory;
      if (d) dirs.add(d);
    }
    return [...dirs];
  }, [webOrMobile, tree, sessions]);
  const paneDirsKey = paneDirs.join("|");
  useEffect(() => {
    syncPaneStreams(paneDirs);
    // Re-runs on pane-set, folder-resolution, and foreground-folder changes
    // (syncPaneStreams excludes whatever folder the foreground stream covers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDirsKey, workspace, connected, syncPaneStreams]);

  // URL → focus: sidebar navigation / deep-links / reload land the target
  // session in a pane. If another pane already shows it, focus THAT pane rather
  // than duplicating it into the focused one; otherwise bind it onto the focused
  // pane. Read fresh layout state so this reacts only to real URL changes.
  const urlId = params.sessionId ?? null;
  useEffect(() => {
    const st = useLayoutStore.getState();
    const leaf = st.tree && st.focusedLeafId ? findLeaf(st.tree, st.focusedLeafId) : null;
    if ((leaf?.sessionId ?? null) === urlId) return;
    // Already shown in the ACTIVE group → just focus that pane.
    if (urlId && st.tree) {
      const inActive = leaves(st.tree).find((l) => l.sessionId === urlId);
      if (inActive) {
        st.focusLeaf(inActive.id);
        return;
      }
    }
    // Shown in ANOTHER group (e.g. Back after a group switch) → switch to that
    // group and focus it, rather than clobbering the active group's pane.
    if (urlId) {
      for (const g of st.groups) {
        if (g.id === st.activeGroupId || !g.tree) continue;
        const hit = leaves(g.tree).find((l) => l.sessionId === urlId);
        if (hit) {
          st.setActiveGroup(g.id);
          st.focusLeaf(hit.id);
          return;
        }
      }
    }
    // Brand-new target: fill an empty group, else bind onto the active focus.
    if (!st.tree || !st.focusedLeafId) {
      if (urlId) st.reset(urlId);
      return;
    }
    st.bindSession(st.focusedLeafId, urlId);
  }, [urlId]);

  // focus → URL: reflect the focused session in the address bar (switching
  // panes, or a draft's first send binding a new id). Only ever navigates TO a
  // real session, never back to bare "/live" — so it can never clobber a
  // deep-linked/reloaded URL before URL→focus binds it (the loop the old
  // single-pane page avoided by reading the param directly). Draft transitions
  // (/new, /clear) navigate to "/live" explicitly where they happen. Push (not
  // replace) so a new conversation adds a history entry (Back works).
  useEffect(() => {
    if (!focusedSid) return;
    const want = `/live/${focusedSid}`;
    if (location.pathname !== want) navigate(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSid]);

  // Load history for every OTHER visible pane (the focused one loads via
  // openSession). Without this a restored/tiled background pane shows a skeleton
  // until clicked. loadHistory no-ops when already loaded, so this is cheap.
  useEffect(() => {
    if (!connected || webOrMobile || !tree) return;
    for (const l of leaves(tree)) {
      if (l.sessionId && l.sessionId !== focusedSid) void loadHistory(l.sessionId);
    }
  }, [tree, connected, webOrMobile, focusedSid, loadHistory]);

  // focus → runtime: bind the single directory-scoped stream to the focused
  // session (cross-folder opens restart the sidecar). A draft focus resets to a
  // blank draft only if a real session was current — never wiping a just-written
  // /clear thread (currentId is already null then).
  useEffect(() => {
    if (focusedSid) {
      void openSession(focusedSid);
    } else if (useRuntimeStore.getState().currentId) {
      // View-only reset: re-blanking a pane must not reroute the next session
      // out of the project the user picked (#69).
      resetDraftView();
    }
  }, [focusedSid, connected, sessionDir, openSession, resetDraftView]);

  // One backstop poll for the whole layout: if any pane's session.idle was lost
  // (SSE reconnect windows), re-check the server so no spinner outlives its turn.
  useEffect(() => {
    if (runningCount === 0) return;
    const timer = window.setInterval(() => void reconcileRunning(), 15_000);
    return () => window.clearInterval(timer);
  }, [runningCount, reconcileRunning]);

  // Drop tiled panes whose session was deleted, collapsing toward one pane.
  useEffect(() => {
    if (sessions.length === 0) return;
    pruneSessions(new Set(sessions.map((s) => s.id)));
  }, [sessions, pruneSessions]);

  // Web / phone: no tiling — show the focused pane alone (its own titlebar), or
  // the onboarding if the group is somehow empty.
  if (webOrMobile) {
    return focusedLeaf ? (
      focusedLeaf.artifact && focusedLeaf.sessionId ? (
        <PresentedArtifactPane
          artifact={focusedLeaf.artifact}
          leafId={focusedLeaf.id}
          sessionId={focusedLeaf.sessionId}
          onClose={() => useLayoutStore.getState().closePane(focusedLeaf.id)}
        />
      ) : (
        <SessionView sessionId={focusedLeaf.sessionId} leafId={focusedLeaf.id} focused chromeAsTitlebar />
      )
    ) : (
      <EmptyGroup />
    );
  }
  // Desktop: the group tab strip owns the window titlebar; below it, the pane
  // tree, or the drag-a-session onboarding for an empty group.
  return (
    <div className="flex h-full min-w-0 flex-col">
      <GroupTabs />
      <div className="min-h-0 flex-1">{tree ? <PaneTree /> : <EmptyGroup />}</div>
    </div>
  );
}

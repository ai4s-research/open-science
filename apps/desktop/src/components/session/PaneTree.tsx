import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MIN_SIZE,
  leaves,
  useLayoutStore,
  type DockEdge,
  type LayoutGroup,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
} from "@/lib/layout";
import { useDragDivider } from "@/lib/useDragDivider";
import { useDragPane } from "@/lib/dragPane";
import { cn } from "@/lib/cn";
import { hasParkedDraft } from "@/lib/composerStash";
import { draftKeyFor } from "@/lib/runtime";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SessionView } from "./SessionView";
import { PresentedArtifactPane } from "./PresentedArtifactPane";

/**
 * Ghostty-style recursive tiling renderer for ONE screen. A split becomes a
 * flex row/column of N children with N−1 draggable dividers; leaves host a
 * SessionView wrapped in a click-to-focus ring. A zoomed leaf renders alone,
 * full-area, without discarding the tree.
 *
 * Takes its screen as a prop rather than reading the store's active-group
 * mirror: every screen stays mounted (LiveSessionPage hides the inactive ones),
 * so this renders one specific group, active or not. `memo` is what makes that
 * affordable — a background screen's group object keeps its identity while the
 * active one is edited, so nothing below re-renders until that screen itself
 * changes.
 *
 * `active` says this screen is the one on display. Panes in a hidden screen
 * must not behave as focused: a screen keeps its own focused leaf, and that
 * pane would otherwise answer app-wide keys and read the globally-current
 * session while invisible.
 */
export const PaneTree = memo(function PaneTree({
  group,
  active,
  laidOut,
}: {
  group: LayoutGroup;
  active: boolean;
  /** This screen has layout boxes — it is on display, or hidden in a way that
   *  keeps them. Separate from `active` because they answer different
   *  questions: `active` is "the user is looking at this" (side effects),
   *  `laidOut` is "the DOM can be measured" (measurements and scroll). A screen
   *  that keeps its layout must NOT re-measure when it reappears: forcing that
   *  layout while the document is dirty is the thrash a switch cannot afford. */
  laidOut: boolean;
}) {
  const { tree, focusedLeafId, zoomedLeafId } = group;
  // Rendered only for a non-empty group (LiveSessionPage shows onboarding
  // otherwise), but guard defensively so the types narrow.
  if (!tree) return null;
  const allLeaves = leaves(tree);
  // A lone pane needs no focus ring / dim (nothing to distinguish it from).
  const solo = allLeaves.length === 1;

  if (zoomedLeafId) {
    const zoomed = allLeaves.find((l) => l.id === zoomedLeafId);
    if (zoomed) {
      return (
        <Leaf
          key={zoomed.id}
          leaf={zoomed}
          zoom={zoomed.zoom ?? 1}
          focused
          active={active}
          laidOut={laidOut}
          solo
        />
      );
    }
  }

  return (
    <Node node={tree} focusedLeafId={focusedLeafId ?? ""} active={active} laidOut={laidOut} solo={solo} />
  );
});

function Node({
  node,
  focusedLeafId,
  active,
  laidOut,
  solo,
}: {
  node: PaneNode;
  focusedLeafId: string;
  active: boolean;
  laidOut: boolean;
  solo: boolean;
}) {
  if (node.kind === "leaf") {
    return (
      <Leaf
        // Keyed by leaf so a tree edit that moves panes around reconciles them
        // by identity. Screens no longer share this position — each renders its
        // own PaneTree — which is what keeps an incoming screen from inheriting
        // the outgoing one's composer text (#91).
        key={node.id}
        leaf={node}
        // Tiled panes are narrow → default to 75% unless the user set a zoom.
        zoom={node.zoom ?? (solo ? 1 : 0.75)}
        focused={node.id === focusedLeafId}
        active={active}
        laidOut={laidOut}
        solo={solo}
      />
    );
  }
  return <Split node={node} focusedLeafId={focusedLeafId} active={active} laidOut={laidOut} />;
}

/** Cumulative boundary after child `i` (fraction 0..1). */
const boundaryAt = (sizes: number[], i: number): number =>
  sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);

/** Apply a dragged boundary between children `i`/`i+1`: only that adjacent pair
 *  changes; their sum is preserved and each stays ≥ MIN_SIZE. */
function sizesFromBoundary(sizes: number[], i: number, boundary: number): number[] {
  const pairStart = sizes.slice(0, i).reduce((a, b) => a + b, 0);
  const pairSum = sizes[i] + sizes[i + 1];
  const si = Math.max(MIN_SIZE, Math.min(boundary - pairStart, pairSum - MIN_SIZE));
  const next = [...sizes];
  next[i] = si;
  next[i + 1] = pairSum - si;
  return next;
}

function Split({
  node,
  focusedLeafId,
  active,
  laidOut,
}: {
  node: PaneSplit;
  focusedLeafId: string;
  active: boolean;
  laidOut: boolean;
}) {
  const setSplitSizes = useLayoutStore((s) => s.setSplitSizes);
  const containerRef = useRef<HTMLDivElement>(null);
  const row = node.dir === "row";
  // While a divider drags, the live sizes live here; the store is written on up.
  const [live, setLive] = useState<{ i: number; sizes: number[] } | null>(null);
  const sizes = live?.sizes ?? node.sizes;

  return (
    <div
      ref={containerRef}
      className={cn("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col")}
    >
      {node.children.map((child, i) => (
        <FragmentChild
          key={child.id}
          size={sizes[i]}
          divider={
            i < node.children.length - 1 ? (
              <Divider
                row={row}
                containerRef={containerRef}
                boundary={boundaryAt(sizes, i)}
                onLive={(b) => setLive({ i, sizes: sizesFromBoundary(node.sizes, i, b) })}
                onCommit={(b) => {
                  setLive(null);
                  setSplitSizes(node.id, sizesFromBoundary(node.sizes, i, b));
                }}
              />
            ) : null
          }
        >
          <Node
            node={child}
            focusedLeafId={focusedLeafId}
            active={active}
            laidOut={laidOut}
            solo={false}
          />
        </FragmentChild>
      ))}
    </div>
  );
}

/** One child cell (proportional flex) plus the divider that follows it. */
function FragmentChild({
  size,
  children,
  divider,
}: {
  size: number;
  children: React.ReactNode;
  divider: React.ReactNode;
}) {
  return (
    <>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${size} 1 0%` }}>
        {children}
      </div>
      {divider}
    </>
  );
}

function Divider({
  row,
  containerRef,
  boundary,
  onLive,
  onCommit,
}: {
  row: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  boundary: number;
  onLive: (boundary: number) => void;
  onCommit: (boundary: number) => void;
}) {
  const { dragging, handleProps } = useDragDivider({
    value: boundary,
    compute: (p) => {
      const el = containerRef.current;
      if (!el) return boundary;
      const r = el.getBoundingClientRect();
      const f = row ? (p.x - r.left) / r.width : (p.y - r.top) / r.height;
      const clamped = Math.max(0, Math.min(1, f));
      onLive(clamped);
      return clamped;
    },
    onCommit,
  });
  return (
    <div
      {...handleProps}
      className={cn(
        "group relative z-10 shrink-0 bg-border",
        row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <div
        className={cn(
          "absolute transition-colors",
          row ? "inset-y-0 -left-[2px] -right-[2px]" : "inset-x-0 -top-[2px] -bottom-[2px]",
          dragging ? "bg-accent/60" : "group-hover:bg-accent/40",
        )}
      />
    </div>
  );
}

/**
 * Does closing this pane need a confirmation? Only when it holds something:
 * a session (whatever is in it is not knowable from here) or an unsent line.
 * A fresh split nobody used is an empty slot and closes on the click.
 */
function paneNeedsConfirm(leaf: PaneLeaf): boolean {
  return !!leaf.sessionId || !!leaf.artifact || hasParkedDraft(draftKeyFor(leaf.id));
}

function Leaf({
  leaf,
  zoom,
  focused,
  active,
  laidOut,
  solo,
}: {
  leaf: Extract<PaneNode, { kind: "leaf" }>;
  zoom: number;
  focused: boolean;
  /** This pane's screen is the one on display. */
  active: boolean;
  /** …and it has layout boxes (see PaneTree). */
  laidOut: boolean;
  solo: boolean;
}) {
  const leafId = leaf.id;
  // The ring is a per-screen mark (and invisible while the screen is hidden),
  // but everything SessionView does with "focused" is app-wide — answering Esc,
  // showing the global error, a draft pane adopting the current session — so a
  // hidden screen's focused pane is not live.
  const live = focused && active;
  const { t } = useTranslation("session");
  const [confirmClose, setConfirmClose] = useState(false);
  const focusLeaf = useLayoutStore((s) => s.focusLeaf);
  const closePane = useLayoutStore((s) => s.closePane);
  return (
    // `data-leaf-id` lets the drag controller hit-test this pane under the
    // pointer. Focus follows the click, terminal-style: pointer-down capture
    // wins even over a button inside, so tapping anywhere focuses it first.
    <div
      data-leaf-id={leafId}
      onPointerDownCapture={() => {
        if (!focused) focusLeaf(leafId);
      }}
      className={cn(
        "relative h-full min-h-0 w-full min-w-0",
        // A soft inset ring marks the focused pane; unfocused panes dim slightly.
        // A lone pane needs neither (nothing to contrast against).
        solo ? "" : focused ? "ring-1 ring-inset ring-accent/50" : "opacity-[0.97]",
      )}
    >
      {/* GroupTabs owns the window titlebar on desktop, so panes never do.
          The sole pane can't be closed (nothing to promote) → no ✕. */}
      {leaf.artifact && leaf.sessionId ? (
        <PresentedArtifactPane
          artifact={leaf.artifact}
          leafId={leafId}
          sessionId={leaf.sessionId}
          onClose={() => closePane(leafId)}
        />
      ) : (
        <SessionView
          sessionId={leaf.sessionId}
          leafId={leafId}
          focused={live}
          visible={active}
          laidOut={laidOut}
          chromeAsTitlebar={false}
          zoom={zoom}
          solo={solo}
          onClose={
            solo
              ? undefined
              : // Same rule as closing a Screen: only ask when there is
                // something to lose. An unbound pane nobody has typed into is
                // just an empty slot — closing it on the click is the point of
                // having opened it.
                () => (paneNeedsConfirm(leaf) ? setConfirmClose(true) : closePane(leafId))
          }
        />
      )}
      {confirmClose && (
        <ConfirmDialog
          title={t("group.confirmClose.title")}
          body={t("group.confirmClose.body")}
          confirmLabel={t("group.confirmClose.action")}
          onConfirm={() => {
            setConfirmClose(false);
            closePane(leafId);
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
      {/* Only the Screen on display is a drop target — and its overlay re-renders
          on every pointer move of a drag, which a hidden Screen must not pay. */}
      {active && <DropOverlay leafId={leafId} />}
    </div>
  );
}

/** The half-rectangle the pointer's edge maps to, for the drop highlight. */
const HALF_CLASS: Record<DockEdge, string> = {
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
};

/** During a pane drag, outline every droppable leaf and fill the hovered half
 *  of the target. Pointer-events:none so the drag hit-test reaches the leaf. */
function DropOverlay({ leafId }: { leafId: string }) {
  const active = useDragPane((s) => s.active);
  if (!active) return null;
  const t = active.target;
  const edge = t && "leafId" in t && t.leafId === leafId ? t.edge : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute inset-0 ring-1 ring-inset ring-accent/20" />
      {edge && (
        <div className={cn("absolute rounded-sm bg-accent/25 ring-1 ring-accent/60", HALF_CLASS[edge])} />
      )}
    </div>
  );
}

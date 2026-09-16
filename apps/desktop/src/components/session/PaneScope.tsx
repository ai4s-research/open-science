import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * The element one tiled pane occupies.
 *
 * A question about a pane's own work — "compact this conversation?" — belongs
 * over that pane, not over the whole window. But the component that asks is
 * buried deep inside it (the composer, say), and every box on the way down is a
 * candidate for `position: relative`, so `absolute inset-0` lands on whichever
 * ancestor happens to be positioned rather than on the pane.
 *
 * So the pane publishes its own element here, and anything that needs to cover
 * the pane portals into it.
 */
const PaneScopeContext = createContext<HTMLElement | null>(null);

export function PaneScope({ children }: { children: (ref: (el: HTMLElement | null) => void) => ReactNode }) {
  // State, not a ref: consumers must re-render once the element exists.
  const [element, setElement] = useState<HTMLElement | null>(null);
  return (
    <PaneScopeContext.Provider value={element}>{children(setElement)}</PaneScopeContext.Provider>
  );
}

/** The pane this component sits in, or null outside a tiled pane (a route, a
 *  dialog of its own). */
export function usePaneScope(): HTMLElement | null {
  return useContext(PaneScopeContext);
}

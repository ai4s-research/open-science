import type { ILink, Terminal } from "@xterm/xterm";

/**
 * A click on a link that a TUI redraws while the button is down still opens it.
 *
 * xterm opens a link only if the link under the pointer at mouseup is the very
 * object it was at mousedown. Claude Code redraws a running tool row several
 * times a second, and each redraw makes xterm ask for the row's links again and
 * hold a new object, so a click spanning a redraw did nothing, however fast the
 * answer came back. Here a link counts as the same when its text and cells are:
 * if xterm let such a click go, it is opened at mouseup instead.
 *
 * `wrap` every link handed to xterm. The terminal must be open.
 */
export function keepClicksAcrossRedraws(term: Terminal) {
  const key = (l: ILink) => `${l.text}\0${l.range.start.x},${l.range.start.y}-${l.range.end.x},${l.range.end.y}`;
  let hovered: ILink | null = null;
  let down: string | null = null;
  let opened = false;
  const el = term.element;
  const onDown = (e: MouseEvent) => {
    down = e.button === 0 && hovered ? key(hovered) : null;
    opened = false;
  };
  const onUp = (e: MouseEvent) => {
    const was = down;
    down = null;
    // After xterm's own handler: open only what it let go.
    setTimeout(() => {
      if (was && !opened && hovered && key(hovered) === was && !term.hasSelection()) hovered.activate(e, hovered.text);
    });
  };
  el?.addEventListener("mousedown", onDown, true);
  el?.addEventListener("mouseup", onUp);
  return {
    wrap(link: ILink): ILink {
      const wrapped: ILink = {
        ...link,
        hover: (event, text) => {
          hovered = wrapped;
          link.hover?.(event, text);
        },
        leave: (event, text) => {
          if (hovered === wrapped) hovered = null;
          link.leave?.(event, text);
        },
        activate: (event, text) => {
          opened = true;
          link.activate(event, text);
        },
      };
      return wrapped;
    },
    dispose() {
      el?.removeEventListener("mousedown", onDown, true);
      el?.removeEventListener("mouseup", onUp);
    },
  };
}

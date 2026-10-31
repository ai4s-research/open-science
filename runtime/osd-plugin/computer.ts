// `computer`: look at, and drive, the apps on the user's own screen.
//
// The whole design is Orca's (github.com/stablyai/orca, MIT): read the app's
// ACCESSIBILITY TREE, act on a numbered element from it, and treat pixels as
// confirmation rather than as the interface. That is why there is no
// "screenshot, then click 840,312" loop here — a click by element index either
// lands on the control the tree named or fails saying why, and the provider can
// often read the result back and say whether it actually took effect.
//
// Three native providers sit behind this, one per platform (macOS accessibility
// API, AT-SPI on Linux, UI Automation on Windows). They answer the same calls
// and report their own capabilities, so a verb a platform cannot do comes back
// as `unsupported_capability` rather than as silence.
//
// Scope: desktop windows. Web pages belong to the browser connector.
//
// The host layer lives beside this plugin's folder, in `computer/` — the same
// place in the repository (`runtime/computer`) and in the deployed profile.
import { formatComputerResult } from "../computer/format";
import { COMPUTER_VERBS, runComputerVerb, type ComputerVerb } from "../computer/index";

const VERB_HELP = [
  "capabilities — what this platform's provider supports. No other arguments.",
  "list_apps — running apps, with the bundle ids to use as `app`. No other arguments.",
  "list_windows — windows of `app`, with the windowId/windowIndex to target.",
  "get_state — accessibility tree of one app window. THE call to make before any action, and again after one.",
  "click — `elementIndex`, or `x`/`y` as a fallback. Optional clickCount, mouseButton, modifiers.",
  "perform_action — run one accessibility action the tree lists on an element: `elementIndex` + `actionName`.",
  "set_value — write `value` into the editable element at `elementIndex`. Prefer this over typing.",
  "type_text — send `text` to whatever currently has focus. Unverifiable; check the tree afterwards.",
  "press_key — one key: Return, Escape, Tab, ArrowDown, …",
  "hotkey — one modifier chord plus one key: CmdOrCtrl+A, CmdOrCtrl+Shift+P.",
  "paste_text — put `text` on the clipboard and paste it at the focus.",
  "scroll — `direction` (up/down/left/right) at `elementIndex` or `x`/`y`, optional `pages`.",
  "drag — `fromElementIndex`+`toElementIndex`, or `fromX`/`fromY`/`toX`/`toY`.",
].join("\n");

const int = (description: string) => ({ type: "integer", description });
const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });

export const computerTool = {
  name: "computer",
  description:
    "Inspect and control apps running on the user's own computer — native apps, and desktop browser windows that need window-level control. Reads an app's accessibility tree, where every element carries an index you then act on; a screenshot is optional confirmation, not the interface.\n\n" +
    "Always: list_apps (find the app) → get_state (read the tree) → one action → get_state again. Element indexes are sparse and go stale after any navigation, scroll, focus change or re-render, so never reuse an index across an action, and never guess one from the element count.\n\n" +
    "Every action reports whether its effect could be VERIFIED. An unverified action is not a completed action: read the tree back before telling the user it worked, and say the effect is unproven if it could have sent, submitted, bought or deleted something.\n\n" +
    "Do not use this for page-level web automation — use the browser connector for that. Do not push, submit forms, send messages, buy, delete, or change account settings unless the user asked for that exact thing.\n\n" +
    "Verbs:\n" +
    VERB_HELP,
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...COMPUTER_VERBS], description: "Which verb to run. See the verb list in the description." },
      app: str(
        "The desktop app to act on: a bundle id from list_apps (preferred), its name, or pid:<number>. Required for everything except capabilities and list_apps. This names an APP, never a website.",
      ),
      windowId: int("Target this window id from list_windows."),
      windowIndex: int("Target this window index from list_windows. Use only when the window has no id."),
      restoreWindow: { type: "boolean", description: "Bring the window forward first. Needed when the app is not already frontmost." },
      screenshot: {
        type: "boolean",
        description:
          "Also capture the window as an image. Off by default. Ask for it when you need pixels: confirming something visually, reading a canvas the tree cannot describe, or picking x/y coordinates.",
      },
      elementIndex: int("The element to act on, by its index in the tree."),
      actionName: str("For perform_action: the accessibility action name, exactly as the tree lists it."),
      value: str("For set_value: the text to write into the element."),
      text: str("For type_text and paste_text: the text to send."),
      key: str("For press_key: one key. For hotkey: one chord, e.g. CmdOrCtrl+A."),
      x: num("Window-local x, when no element index fits."),
      y: num("Window-local y, when no element index fits."),
      clickCount: int("For click: 2 for a double click."),
      mouseButton: { type: "string", enum: ["left", "right", "middle"], description: "For click: which button." },
      modifiers: str(
        "For click: a modifier chord held during the click, e.g. CmdOrCtrl+Shift. Never send separate modifier-down/up calls.",
      ),
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "For scroll: which way." },
      pages: num("For scroll: how many pages. Defaults to one."),
      fromElementIndex: int("For drag: the element to drag from."),
      toElementIndex: int("For drag: the element to drop on."),
      fromX: num("For drag: window-local x to drag from."),
      fromY: num("For drag: window-local y to drag from."),
      toX: num("For drag: window-local x to drop at."),
      toY: num("For drag: window-local y to drop at."),
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

/** Run one verb. Returns the text the model reads, and the screenshot's path
 *  when one was taken (it is in the text too, so a client that does not show
 *  attachments still leaves the model a way to reach the image). */
export async function runComputer(args: Record<string, unknown>): Promise<{ output: string; screenshotPath?: string }> {
  const verb = args.action as ComputerVerb;
  if (verb !== "capabilities" && verb !== "list_apps" && !args.app) {
    throw new Error(`computer ${verb} needs an app. Run list_apps and pass a bundle id.`);
  }
  try {
    const result = await runComputerVerb(verb, args);
    const { output, screenshotPath } = formatComputerResult(result);
    return screenshotPath ? { output, screenshotPath } : { output };
  } catch (error) {
    // The provider's error codes are the recovery contract the skill guide is
    // written against, so they must survive to the model verbatim.
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(typeof code === "string" ? `${code}: ${message}` : message);
  }
}

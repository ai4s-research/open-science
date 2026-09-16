import { tool } from "@opencode-ai/plugin";
import { formatComputerResult } from "../computer/format";
import { COMPUTER_VERBS, runComputerVerb, type ComputerVerb } from "../computer/index";

/**
 * Look at, and drive, the apps on the user's own screen.
 *
 * The whole design is Orca's (github.com/stablyai/orca, MIT): read the app's
 * ACCESSIBILITY TREE, act on a numbered element from it, and treat pixels as
 * confirmation rather than as the interface. That is why there is no
 * "screenshot, then click 840,312" loop here — a click by element index either
 * lands on the control the tree named or fails saying why, and the provider can
 * often read the result back and say whether it actually took effect.
 *
 * Three native providers sit behind this, one per platform (macOS accessibility
 * API, AT-SPI on Linux, UI Automation on Windows). They answer the same calls
 * and report their own capabilities, so a verb a platform cannot do comes back
 * as `unsupported_capability` rather than as silence.
 *
 * Scope: desktop windows. Web pages belong to the browser connector, which
 * drives a page directly instead of poking at a window that happens to show one.
 */

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

const s = tool.schema;

export default tool({
  description:
    "Inspect and control apps running on the user's own computer — native apps, and desktop browser windows that need window-level control. Reads an app's accessibility tree, where every element carries an index you then act on; a screenshot is optional confirmation, not the interface.\n\n" +
    "Always: list_apps (find the app) → get_state (read the tree) → one action → get_state again. Element indexes are sparse and go stale after any navigation, scroll, focus change or re-render, so never reuse an index across an action, and never guess one from the element count.\n\n" +
    "Every action reports whether its effect could be VERIFIED. An unverified action is not a completed action: read the tree back before telling the user it worked, and say the effect is unproven if it could have sent, submitted, bought or deleted something.\n\n" +
    "Do not use this for page-level web automation — use the browser connector for that. Do not push, submit forms, send messages, buy, delete, or change account settings unless the user asked for that exact thing.\n\n" +
    "Verbs:\n" +
    VERB_HELP,
  args: {
    action: s.enum(COMPUTER_VERBS).describe("Which verb to run. See the verb list in the description."),
    app: s
      .string()
      .optional()
      .describe(
        "The desktop app to act on: a bundle id from list_apps (preferred), its name, or pid:<number>. Required for everything except capabilities and list_apps. This names an APP, never a website.",
      ),
    windowId: s.number().int().optional().describe("Target this window id from list_windows."),
    windowIndex: s
      .number()
      .int()
      .optional()
      .describe("Target this window index from list_windows. Use only when the window has no id."),
    restoreWindow: s
      .boolean()
      .optional()
      .describe("Bring the window forward first. Needed when the app is not already frontmost."),
    screenshot: s
      .boolean()
      .optional()
      .describe(
        "Also capture the window as an image. Off by default. Ask for it when you need pixels: confirming something visually, reading a canvas the tree cannot describe, or picking x/y coordinates.",
      ),
    elementIndex: s.number().int().optional().describe("The element to act on, by its index in the tree."),
    actionName: s
      .string()
      .optional()
      .describe("For perform_action: the accessibility action name, exactly as the tree lists it."),
    value: s.string().optional().describe("For set_value: the text to write into the element."),
    text: s.string().optional().describe("For type_text and paste_text: the text to send."),
    key: s.string().optional().describe("For press_key: one key. For hotkey: one chord, e.g. CmdOrCtrl+A."),
    x: s.number().optional().describe("Window-local x, when no element index fits."),
    y: s.number().optional().describe("Window-local y, when no element index fits."),
    clickCount: s.number().int().optional().describe("For click: 2 for a double click."),
    mouseButton: s.enum(["left", "right", "middle"]).optional().describe("For click: which button."),
    modifiers: s
      .string()
      .optional()
      .describe(
        "For click: a modifier chord held during the click, e.g. CmdOrCtrl+Shift. Never send separate modifier-down/up calls.",
      ),
    direction: s.enum(["up", "down", "left", "right"]).optional().describe("For scroll: which way."),
    pages: s.number().optional().describe("For scroll: how many pages. Defaults to one."),
    fromElementIndex: s.number().int().optional().describe("For drag: the element to drag from."),
    toElementIndex: s.number().int().optional().describe("For drag: the element to drop on."),
    fromX: s.number().optional().describe("For drag: window-local x to drag from."),
    fromY: s.number().optional().describe("For drag: window-local y to drag from."),
    toX: s.number().optional().describe("For drag: window-local x to drop at."),
    toY: s.number().optional().describe("For drag: window-local y to drop at."),
  },
  async execute(args) {
    const verb = args.action as ComputerVerb;
    if (verb !== "capabilities" && verb !== "list_apps" && !args.app) {
      throw new Error(`computer ${verb} needs an app. Run list_apps and pass a bundle id.`);
    }
    try {
      const result = await runComputerVerb(verb, args as Record<string, unknown>);
      const { output, screenshotPath } = formatComputerResult(result);
      if (!screenshotPath) return output;
      // The path is in `output` too: an attachment the client does not render
      // must still leave the model a way to reach the image.
      return {
        output,
        attachments: [
          { type: "file" as const, mime: "image/png", url: `file://${screenshotPath}` },
        ],
      };
    } catch (error) {
      // The provider's error codes are the recovery contract the skill guide is
      // written against, so they must survive to the model verbatim.
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(typeof code === "string" ? `${code}: ${message}` : message);
    }
  },
});

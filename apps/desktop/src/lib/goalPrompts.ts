// Goal mode (/goal) drives itself by POSTing turns into the session: the
// bundled plugin's auto-continue (`sendContinuation`) and the app's own resume
// nudge. OpenCode stores those as ordinary user messages, so a reloaded thread
// showed the machine text — several hundred words of continuation policy
// wrapped around the objective — as if the user had typed it. The pill already
// reports what those turns are doing ("auto-turn N"), so the thread hides them.

/** Agent-facing (English, like all agent prompts). A resumed goal has no
 *  pending idle event to re-arm the plugin's continuation loop — verified
 *  against opencode 1.17.13 — so resume must kick one turn; the loop takes
 *  over from that turn's idle. */
export const GOAL_RESUME_NUDGE = "Continue working toward the active goal.";

/** Opening lines of the turns the goal plugin injects on its own: the
 *  auto-continue prompt and the safety-limit wrap-up (bundled plugin 0.1.24 —
 *  `continuationPrompt` / `limitPrompt`). The plugin marks these messages in no
 *  other way, so first-line matching is the only signal available; re-check
 *  them when the pinned plugin version moves. */
const PLUGIN_PROMPT_OPENERS = [
  "Continue working toward the active session goal.",
  "The active session goal has reached a safety limit.",
];

/** Was this user turn written by goal mode rather than by the user? */
export function isGoalInjectedPrompt(text: string): boolean {
  const body = text.trim();
  if (body === GOAL_RESUME_NUDGE) return true;
  return PLUGIN_PROMPT_OPENERS.some((opener) => body.startsWith(opener));
}

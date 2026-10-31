// Goal mode under OpenCode 1 drove itself by POSTing turns into the session:
// the goal plugin's auto-continue and the app's own resume nudge, stored as
// ordinary user messages. Conversations carried over from OpenCode 1 still
// hold them, so the thread keeps hiding them. (OpenCode 2's built-in /goal
// marks its own turns, and the SDK drops those before they get here.)

/** The resume nudge the app used to send after resuming a goal. */
const GOAL_RESUME_NUDGE = "Continue working toward the active goal.";

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

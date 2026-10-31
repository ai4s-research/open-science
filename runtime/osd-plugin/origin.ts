// The conversation a shell command runs for. `osd` called from inside a
// conversation reads it as OSD_ORIGIN_SESSION, and the gateway uses it to keep
// two agents from messaging each other without end.

/** Shell commands a tool call is about to run, with the session they run for,
 *  until the shell that runs each one is created. Bounded: an entry no shell
 *  claims (the call was denied) ages out. */
export class ShellOrigins {
  private readonly pending: Array<{ command: string; sessionID: string; at: number }> = [];

  constructor(
    private readonly ttlMs = 60_000,
    private readonly max = 200,
    private readonly now = () => Date.now(),
  ) {}

  expect(command: unknown, sessionID: unknown): void {
    if (typeof command !== "string" || typeof sessionID !== "string" || !sessionID) return;
    this.prune();
    this.pending.push({ command, sessionID, at: this.now() });
    if (this.pending.length > this.max) this.pending.shift();
  }

  take(command: unknown): string | undefined {
    if (typeof command !== "string") return undefined;
    this.prune();
    const i = this.pending.findIndex((p) => p.command === command);
    return i < 0 ? undefined : this.pending.splice(i, 1)[0].sessionID;
  }

  private prune(): void {
    const oldest = this.now() - this.ttlMs;
    while (this.pending.length > 0 && this.pending[0].at < oldest) this.pending.shift();
  }
}

import { describe, expect, it } from "vitest";
import { readRepaint, spliceRepaint } from "./terminalResize";

// Claude Code 2.1.311's answer to a resize, as captured from its pty.
const erase = (rows: number) => "\x1b[H" + "\x1b[2K\x1b[1B".repeat(rows) + "\x1b[H";
const lead = "\x1b[?25l\x1b[2D\x1b[4B";
const tail = "\x1b[2C\x1b[4A\x1b[?25h";
const answer = (rows: number, lines: string[]) =>
  lead + erase(rows) + lines.map((l) => `\x1b[3G${l}\x1b[39m\r\r`).join("\n") + "\n" + tail;

const turn = [
  "⏺ First message, long enough to be found again",
  "  its second line",
  "",
  "⏺ Second message, also long enough to be found",
  "  wrapped once at the new width",
  "",
  "❯",
];

describe("readRepaint", () => {
  it("finds the repaint after the end of an earlier frame, and waits for all of it", () => {
    const earlier = "um\x1b[110G/effort\x1b[39m\r\r\n" + tail;
    const data = earlier + answer(5, turn);
    expect(readRepaint(data.slice(0, earlier.length + 20), 5)).toBeNull();
    expect(readRepaint(data.slice(0, -3), 5)).toBeNull();
    const repaint = readRepaint(data, 5)!;
    expect(repaint.before).toBe(earlier + lead);
    expect(repaint.lines).toHaveLength(turn.length + 1);
    expect(repaint.tail).toBe("\x1b[?25h");
  });

  it("ignores a shell's answer and an erase of another height", () => {
    expect(readRepaint("\r\x1b[K% ", 5)).toBeNull();
    expect(readRepaint(answer(4, turn), 5)).toBeNull();
  });
});

describe("spliceRepaint", () => {
  it("writes the repaint from the line the old top row starts, erasing from there down", () => {
    // The old screen starts at the second message; the first is in scrollback.
    const screen = ["⏺ Second message, also long enough to be found wrapped", "  once at the new width", "", "❯", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[1;1H\x1b[J");
    expect(repaint).not.toContain("First message");
    expect(repaint).toContain("Second message");
    expect(repaint.endsWith(tail)).toBe(true);
  });

  it("keeps old rows the repaint does not redraw, above the match", () => {
    const screen = ["an older line the repaint leaves out", "", "⏺ First message, long enough to be found again", "", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
    expect(repaint).toContain("First message");
  });

  it("skips a row whose text repeats, which could match the wrong copy", () => {
    const repeated = "⎿ Shell cwd was reset to /Users/someone/project";
    const screen = [repeated, "", "⏺ First message, long enough to be found again", repeated, ""];
    const { clear } = spliceRepaint(readRepaint(answer(5, [...turn, repeated]), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
  });

  it("with nothing to line up, writes the whole repaint below the old screen", () => {
    const screen = ["something else entirely, unrelated", "more of it, also unrelated text", "", "", ""];
    const { clear, repaint } = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen);
    expect(clear).toBe("\x1b[3;1H\x1b[J");
    expect(repaint).toContain("First message");
  });
});

// Captured from Claude Code 2.1.314 in a 60x22 pane (p684, 2026-11-01): the
// screen as the turn ended, and the repaint it then made on its own. The
// repaint carries the reply's last 22 rows, none of them on screen yet; only
// the prompt box and the status line below it are the same in both.
const p684 = {
  screen: [
    "",
    "",
    "",
    "     backend 5m: req=38449 500=0 toomany=0",
    "     N              REP   READY",
    "     litellm        3     3",
    "     … +2 lines (ctrl+o to expand)",
    "",
    "⏺ Bash(hq log wxdd --tag vela \"运维已把 aurora-pro vela_user",
    "      CONNECTION LIMIT 300→2000(实测)，现占 187；backend 5",
    "      分钟 3.8 万请求 0 个 500。副本恢复由 karpathy#2e08f8",
    "      按其计划做(目标 free 48 + pai…)",
    "  ⎿    这次踩了坑或查清了以后用得上的事，另记一条：hq m",
    "     em add traps|findings \"一句话标题\"",
    "",
    "✻ Wandering… (42s · ↓ 2.2k tokens)",
    "",
    "────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "",
  ],
  repaint: "\u001b[H\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[2K\u001b[1B\u001b[H\u001b[5G2000\u001b[10G还很远。\r\r\n\u001b[3G-\u001b[5G\u001b[1mbackend\u001b[22m：过去\u001b[19G5\u001b[21G分钟处理了约\u001b[34G3.8\u001b[38G万个请求，没有一个\r\r\n\u001b[5G500，也没有连不上库的报错。\r\r\n\r\r\n\u001b[3G\u001b[1mworker\u001b[10G我这次没有改回\u001b[25G64。\u001b[22m\r\r\n\u001b[3G发版的那个会话后来接手了扩缩容，它定的规模是\u001b[48G48\u001b[51G个普通\r\r\n\u001b[3Gworker\u001b[10G加\u001b[13G16\u001b[16G个付费\u001b[23Gworker，现在已经是这个数，所以\u001b[54G64\r\r\n\u001b[3G不再是目标。它还临时调低了一些配置，包括\u001b[44Glitellm\u001b[52G从\u001b[55G4\r\r\n\u001b[3G个缩到\u001b[10G3\r\r\n\u001b[3G个，原本打算等连接问题解决后再恢复。我已经告诉它上限调到了\r\r\n\u001b[3G2000，这些配置可以按它的计划恢复。\r\r\n\r\r\n\u001b[3G旧版本的\u001b[12Gworker\u001b[19G还剩\u001b[24G3\u001b[26G个，在跑完手头的任务。连接已经够用\r\r\n\u001b[3G，它们退得快慢都不影响线上。\r\r\n\r\r\n\u001b[38;2;215;119;87m✻\u001b[3GWan\u001b[38;2;245;149;117mder\u001b[38;2;215;119;87ming…\u001b[14G\u001b[38;2;102;102;102m(42s\u001b[19G·\u001b[21G↓\u001b[23G2.2k\u001b[28Gtokens)\u001b[39m\r\r\n\r\r\n\u001b[38;2;138;138;138m────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[38;2;102;102;102m❯ \u001b[39m\r\r\n\u001b[38;2;138;138;138m────────────────────────────────────────────────────────────\u001b[39m\r\r\n\u001b[3G\u001b[38;2;171;43;63m⏵⏵\u001b[6Gbypass\u001b[13Gpermissions\u001b[25Gon\u001b[38;2;102;102;102m (shift+tab\u001b[39Gto\u001b[42Gcycle)\u001b[39m\r\r\n\u001b[2C\u001b[3A\u001b[?25h",
};

describe("spliceRepaint, a repaint of its own carrying new lines", () => {
  it("skips no line that is not already there: the reply is written in full", () => {
    const repaint = readRepaint(p684.repaint, 22)!;
    const splice = spliceRepaint(repaint, p684.screen, []);
    expect(splice.matched).toBe(false);
  });

  it("still lines up a repaint whose skipped lines are on screen above the match", () => {
    const screen = ["⏺ First message, long enough to be found again", "  its second line", "", "⏺ Second message, also long enough to be found", ""];
    const splice = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen, []);
    expect(splice.matched).toBe(true);
    expect(splice.clear).toBe("\x1b[1;1H\x1b[J");
  });

  it("writes the prompt a rewind restores, though that message is still in scrollback", () => {
    const rule = "────────────────────────────────────────";
    const status = "⏵⏵ auto mode on (shift+tab to cycle)";
    const asked = "❯ 请输出 1 到 80 的数字，每行一个，不要别的";
    const scrollback = ["⏺ Earlier reply, long enough to be found", "", asked];
    const screen = ["  80", "", rule, "❯", rule, `  ${status}`];
    const lines = ["⏺ Earlier reply, long enough to be found", "", rule, asked, rule, status];
    const splice = spliceRepaint(readRepaint(answer(6, lines), 6)!, screen, scrollback);
    expect(splice.matched).toBe(false);
  });

  it("still lines up a repaint whose skipped lines went into scrollback", () => {
    const scrollback = ["⏺ First message, long enough to be found again", "  its second line"];
    const screen = ["", "⏺ Second message, also long enough to be found", "  wrapped once at the new width", "", "❯"];
    const splice = spliceRepaint(readRepaint(answer(5, turn), 5)!, screen, scrollback);
    expect(splice.matched).toBe(true);
    expect(splice.repaint).not.toContain("First message");
  });
});

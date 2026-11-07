import { memo, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ThreadBlock } from "@ai4s/shared";
import { IconBranchOutlineRegular, IconSearchOutlineRegular } from "@/components/icons/dsh";
import { PANE_HEADER, PaneTitlebarInset, PANE_ICON_BUTTON } from "@/components/inspector/RightPane";
import { useDragDivider } from "@/lib/useDragDivider";
import css from "./TrajectoryPane.module.css";

/**
 * Every step of a conversation as one table, after DeepSeek Harness's
 * Trajectory view (ui-trajectory, MIT, (c) 2026 DeepSeek): a toolbar
 * (Duration / Turns / Calls + search), a three-lane timeline (Input · Model ·
 * Tools) and 30px rows tagged USER / ASSISTANT / TOOL, each tool call showing
 * `name payload → result`. DSH builds it from its own event projection; this
 * reads the thread the conversation already renders, so it adds no data path.
 */

type Kind = "user" | "assistant" | "tool" | "system";
type Lane = "user" | "model" | "tool";

interface Step {
  key: number;
  turn: number;
  turnStart: boolean;
  kind: Kind;
  /** One-line text for message rows. */
  text: string;
  thinking?: boolean;
  /** Full reasoning text, present only for thinking rows. */
  fullText?: string;
  tool?: { name: string; payload: string; result: string; error: boolean };
  /** Timeline placement; absent when the step carries no timing. */
  lane?: Lane;
  start?: number;
  end?: number;
}

/** One plain line: code fences, link syntax and emphasis marks dropped. */
function oneLine(text: string | undefined): string {
  return (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

function describe(b: ThreadBlock, t: (key: string, o?: Record<string, unknown>) => string): string {
  switch (b.kind) {
    case "step-summary":
      return b.summary;
    case "reviewer":
      return b.note ?? b.findings.map((f) => f.title).join(" · ");
    case "table":
      return b.caption ?? b.columns.join(" · ");
    case "figure":
      return b.title;
    case "artifact":
      return b.filename;
    case "status-line":
      return b.text;
    case "running-jobs":
      return b.title;
    case "compaction":
      return t("trajectory.compacted");
    default:
      return b.kind;
  }
}

function buildSteps(blocks: ThreadBlock[], t: (key: string, o?: Record<string, unknown>) => string): Step[] {
  const steps: Step[] = [];
  let turn = 0;
  let seenUser = false;
  blocks.forEach((b, key) => {
    let turnStart = key === 0;
    if (b.kind === "user") {
      if (seenUser) turn += 1;
      seenUser = true;
      turnStart = true;
    }
    const base = { key, turn, turnStart };
    switch (b.kind) {
      case "user":
        steps.push({ ...base, kind: "user", text: oneLine(b.text), lane: "user" });
        break;
      case "agent":
        steps.push({
          ...base,
          kind: "assistant",
          text: oneLine(b.markdown),
          lane: "model",
          start: b.created,
          end: b.completed,
        });
        break;
      case "reasoning":
        steps.push({ ...base, kind: "assistant", text: oneLine(b.text), thinking: true, fullText: b.text, lane: "model" });
        break;
      case "tool-call": {
        const error = b.status === "failed";
        steps.push({
          ...base,
          kind: "tool",
          text: "",
          tool: {
            name: b.tool ?? b.verb ?? "tool",
            payload: oneLine(b.command ?? b.filePath ?? b.title),
            result: firstLine(b.output ?? b.outputSummary),
            error,
          },
          lane: "tool",
          start: b.startedAt,
          end: b.endedAt,
        });
        break;
      }
      default:
        steps.push({ ...base, kind: "system", text: oneLine(describe(b, t)) });
    }
  });
  return steps;
}

const KIND_CLASS: Record<Kind, string> = {
  user: css.user,
  assistant: css.assistant,
  tool: css.tool,
  system: css.system,
};

const LANE_ROW: Record<Lane, number> = { user: 0, model: 1, tool: 2 };

/** Drag limits for the detail panel: it stays readable, and so does the table beside it. */
const DETAILS_MIN = 240;
const TABLE_MIN = 120;

/** Timeline spans: actual timing when every timed step has it (DSH "Duration"),
 *  else equal-width operations in order. Untimed steps borrow their
 *  neighbours' time so a user message still lands between the turns. */
function layoutSpans(steps: Step[], actual: boolean) {
  const laned = steps.filter((s) => s.lane);
  const timed = laned.filter((s) => s.start !== undefined && s.end !== undefined);
  const useTime = actual && timed.length > 0;
  if (!useTime) {
    const n = Math.max(1, laned.length);
    return laned.map((s, i) => ({ step: s, left: i / n, width: 1 / n }));
  }
  const min = Math.min(...timed.map((s) => s.start!));
  const max = Math.max(...timed.map((s) => s.end!));
  const span = Math.max(1, max - min);
  let cursor = min;
  return laned.map((s) => {
    const start = s.start ?? cursor;
    const end = s.end ?? start;
    cursor = end;
    return { step: s, left: (start - min) / span, width: Math.max(0, end - start) / span };
  });
}

export const TrajectoryPane = memo(function TrajectoryPane({
  blocks,
  onClose,
  controls,
}: {
  blocks: ThreadBlock[];
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation("session");
  const tr = t as unknown as (key: string, o?: Record<string, unknown>) => string;
  const steps = useMemo(() => buildSteps(blocks, tr), [blocks, tr]);
  const [actualDuration, setActualDuration] = useState(true);
  const [turnsCollapsed, setTurnsCollapsed] = useState(false);
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const needle = query.trim().toLowerCase();
  const selectedStep = selectedKey !== null ? steps.find((s) => s.key === selectedKey) ?? null : null;
  const selectRow = useCallback((key: number) => {
    setSelectedKey((prev) => (prev === key ? null : key));
  }, []);

  // Detail width: null until dragged, so CSS picks the default for the layout.
  const splitRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null);
  const { dragging, dragValue, handleProps } = useDragDivider({
    value: detailsWidth ?? detailsRef.current?.offsetWidth ?? DETAILS_MIN,
    compute: ({ x }) => {
      const split = splitRef.current!.getBoundingClientRect();
      const max = Math.max(DETAILS_MIN, split.width - TABLE_MIN);
      return Math.min(max, Math.max(DETAILS_MIN, split.right - x));
    },
    onCommit: setDetailsWidth,
  });
  const shownWidth = dragValue ?? detailsWidth;

  const matches = (s: Step) =>
    needle === "" ||
    [s.text, s.tool?.name, s.tool?.payload, s.tool?.result].some((v) => v?.toLowerCase().includes(needle));
  const visible = steps.filter((s) => matches(s) && !(callsCollapsed && s.kind === "tool"));
  const spans = layoutSpans(steps, actualDuration);
  const turnCount = steps.length ? steps[steps.length - 1].turn + 1 : 0;
  const turnLefts = spans.filter((sp) => sp.step.turnStart && sp.step.key !== 0).map((sp) => sp.left);

  const kindLabel = (k: Kind) =>
    k === "user" ? t("trajectory.user") : k === "assistant" ? t("trajectory.assistant") : k === "tool" ? t("trajectory.tool") : t("trajectory.message");

  // Collapsed turns: one line per turn — its ask, and how many steps followed.
  const turnSummaries = useMemo(() => {
    const byTurn = new Map<number, { ask: string; count: number }>();
    for (const s of steps) {
      const cur = byTurn.get(s.turn) ?? { ask: "", count: 0 };
      if (s.kind === "user" && !cur.ask) cur.ask = s.text;
      else cur.count += 1;
      byTurn.set(s.turn, cur);
    }
    return byTurn;
  }, [steps]);

  const eventCell = (s: Step) => (
    <td className={css.event}>
      <span className={css.turnRail} />
      {s.turnStart && (
        <span className={css.turnLabel}>{t("trajectory.turn", { n: s.turn + 1 })}</span>
      )}
      <span className={css.eventInner}>
        {/* Narrow tables show the first character in a square chip; CSS picks one. */}
        <span className={`${css.kindTag} ${css.kindFull} ${KIND_CLASS[s.kind]}`}>{kindLabel(s.kind)}</span>
        <span className={`${css.kindTag} ${css.kindShort} ${KIND_CLASS[s.kind]}`} title={kindLabel(s.kind)}>
          {Array.from(kindLabel(s.kind))[0]}
        </span>
      </span>
    </td>
  );

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className={PANE_HEADER}>
        <PaneTitlebarInset />
        <IconBranchOutlineRegular size={14} />
        <span className="text-sm font-medium text-text">{t("trajectory.title")}</span>
        <span className="text-xs text-muted">{t("trajectory.steps", { count: steps.length })}</span>
        <div className="flex-1" />
        {controls}
        <button className={PANE_ICON_BUTTON} aria-label={t("trajectory.close")} onClick={onClose}>
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div className={css.root}>
        <div className={css.toolbar} role="toolbar">
          <div className={css.actions}>
            <button
              type="button"
              className={css.toggle}
              aria-pressed={actualDuration}
              title={actualDuration ? t("trajectory.useEqual") : t("trajectory.useActual")}
              onClick={() => setActualDuration((v) => !v)}
            >
              {t("trajectory.duration")}
            </button>
            <button
              type="button"
              className={css.toggle}
              aria-pressed={!turnsCollapsed}
              title={turnsCollapsed ? t("trajectory.expandTurns") : t("trajectory.collapseTurns")}
              onClick={() => setTurnsCollapsed((v) => !v)}
            >
              {t("trajectory.turns")}
            </button>
            <button
              type="button"
              className={css.toggle}
              aria-pressed={!callsCollapsed}
              title={callsCollapsed ? t("trajectory.expandCalls") : t("trajectory.collapseCalls")}
              onClick={() => setCallsCollapsed((v) => !v)}
            >
              {t("trajectory.calls")}
            </button>
          </div>
          <label className={css.search}>
            <IconSearchOutlineRegular size={11} />
            <input
              className={css.searchInput}
              value={query}
              placeholder={t("trajectory.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>

        {steps.length > 0 && (
          <div className={css.plot}>
            <div className={css.labels}>
              <span>{t("trajectory.input")}</span>
              <span>{t("trajectory.model")}</span>
              <span>{t("trajectory.tools")}</span>
            </div>
            <div className={css.track}>
              {turnLefts.map((left, i) => (
                <span key={i} className={css.turnBoundary} style={{ left: `${left * 100}%` }} />
              ))}
              {spans.map(({ step, left, width }) => (
                <span
                  key={step.key}
                  className={css.span}
                  data-lane={step.lane}
                  data-error={step.tool?.error || undefined}
                  data-dim={needle !== "" && !matches(step) ? true : undefined}
                  style={
                    {
                      top: 7 + LANE_ROW[step.lane!] * 14,
                      left: `calc(${left * 100}% + 0.5px)`,
                      width: `max(2px, calc(${width * 100}% - 1px))`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          </div>
        )}

        <div ref={splitRef} className={css.split} data-dragging={dragging || undefined}>
          <div className={css.tablePane}>
            {steps.length === 0 ? (
              <div className={css.empty}>{t("trajectory.empty")}</div>
            ) : visible.length === 0 ? (
              <div className={css.empty}>{t("trajectory.noMatch")}</div>
            ) : (
              <table className={css.table}>
                <colgroup>
                  <col className={css.eventColumn} />
                  <col />
                </colgroup>
                <tbody>
                  {turnsCollapsed
                    ? Array.from({ length: turnCount }, (_, turn) => {
                        const sum = turnSummaries.get(turn);
                        if (!sum) return null;
                        return (
                          <tr
                            key={`turn-${turn}`}
                            className={css.collapsedRow}
                            data-turn-start="true"
                            onClick={() => setTurnsCollapsed(false)}
                          >
                            <td className={css.event}>
                              <span className={css.turnRail} />
                              <span className={css.turnLabel}>{t("trajectory.turn", { n: turn + 1 })}</span>
                            </td>
                            <td className={css.content}>
                              <span className={css.collapsedTurn}>
                                <span className={css.collapsedEllipsis}>…</span>
                                <span className={css.contentText}>
                                  {sum.ask} · {t("trajectory.steps", { count: sum.count })}
                                </span>
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    : visible.map((s) => (
                        <tr
                          key={s.key}
                          data-turn-start={s.turnStart || undefined}
                          data-error={s.tool?.error || undefined}
                          data-selected={selectedKey === s.key || undefined}
                          onClick={() => selectRow(s.key)}
                        >
                          {eventCell(s)}
                          <td className={css.content}>
                            {s.tool ? (
                              <span className={css.resultPreview}>
                                <span className={css.resultRequest}>
                                  <span className={css.toolName}>{s.tool.name}</span>
                                  <span className={css.toolPayload}>{s.tool.payload}</span>
                                </span>
                                <span className={css.inlineResult}>
                                  <span className={css.arrow}>→</span>
                                  <span
                                    className={`${css.inlineResultText} ${s.tool.error ? css.error : ""} ${s.tool.result ? "" : css.noOutput}`}
                                  >
                                    {s.tool.result || t("trajectory.noOutput")}
                                  </span>
                                </span>
                              </span>
                            ) : (
                              <span className={`${css.contentText} ${s.thinking ? css.thinking : ""}`}>{s.text}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            )}
          </div>

          {selectedStep !== null && (
            <div
              ref={detailsRef}
              className={css.details}
              style={shownWidth !== null ? { width: shownWidth, maxWidth: "none" } : undefined}
            >
              <div {...handleProps} className={css.resizeHandle} />
              <div className={css.detailsHeader}>
                <div className={css.detailsTitle}>
                  <span className={`${css.kindTag} ${KIND_CLASS[selectedStep.kind]}`}>
                    {kindLabel(selectedStep.kind)}
                  </span>
                  <span className={css.detailsName}>
                    {selectedStep.tool?.name ?? (selectedStep.thinking ? t("trajectory.thinking") : "")}
                  </span>
                </div>
                <button
                  type="button"
                  className={css.detailsClose}
                  aria-label={t("trajectory.close")}
                  onClick={() => setSelectedKey(null)}
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              </div>
              <div className={css.detailBody}>
                {selectedStep.tool ? (
                  <dl className={css.detailOverview}>
                    <div>
                      <dt>{t("trajectory.tool")}</dt>
                      <dd>{selectedStep.tool.name}</dd>
                    </div>
                    <div>
                      <dt>{t("trajectory.input")}</dt>
                      <dd className={css.detailPayload}>{selectedStep.tool.payload}</dd>
                    </div>
                    <div>
                      <dt>{t("trajectory.result")}</dt>
                      <dd className={`${css.detailPayload} ${selectedStep.tool.error ? css.error : ""}`}>
                        {selectedStep.tool.result || t("trajectory.noOutput")}
                      </dd>
                    </div>
                  </dl>
                ) : selectedStep.thinking && selectedStep.fullText ? (
                  <pre className={css.detailPayload}>{selectedStep.fullText}</pre>
                ) : (
                  <pre className={css.detailPayload}>{selectedStep.text}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

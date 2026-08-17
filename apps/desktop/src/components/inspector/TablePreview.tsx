import { useTranslation } from "react-i18next";
import { HSCROLL_ATTR } from "@/lib/wheelChain";

// Shared tabular preview: first row of data is the header (csv and xlsx alike).
export interface TableData {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export function TablePreview({ table }: { table: TableData }) {
  const { t } = useTranslation(["inspector", "common"]);
  return (
    <div className="p-3">
      {/* `overflow-y-hidden` keeps this a horizontal scroller only — otherwise
          CSS promotes the other axis to `auto` and the table swallows the
          pane's vertical wheel. The marker returns WebKit's latched trackpad
          gestures to the pane as well (lib/wheelChain). */}
      <div
        {...{ [HSCROLL_ATTR]: "" }}
        className="overflow-x-auto overflow-y-hidden rounded-input border border-border bg-surface"
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              {table.columns.map((c, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-b border-border/60 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-1.5 font-mono text-[12.5px] text-text">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated && (
        <div className="py-2 text-center text-xs text-muted">
          {t("table.showingFirstRows", { count: table.rows.length })}
        </div>
      )}
    </div>
  );
}

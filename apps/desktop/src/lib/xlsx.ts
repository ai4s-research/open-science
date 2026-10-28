// Render a workbook to per-sheet HTML tables for the previewer, preserving the
// visual formatting Excel/WPS shows: cell fills, font size/color/weight/italic,
// alignment, borders, and column widths. We use ExcelJS (not SheetJS) because
// the open-source SheetJS build's sheet_to_html emits values only — no styles —
// which is why fills and font sizes were previously lost. Caps keep a huge
// sheet from locking the UI.
import ExcelJS from "exceljs";
import JSZip from "jszip";

export interface SheetHtml {
  name: string;
  /** A `<table>` fragment; all cell text is HTML-escaped. */
  html: string;
  truncated: boolean;
}

const MAX_ROWS = 500;
const MAX_COLS = 50;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

/** ExcelJS colors are 8-hex ARGB. Take the RGB and treat it as opaque — these
 *  files routinely store a `00` alpha byte that still means a visible color in
 *  Excel/WPS, so honoring alpha would wrongly hide fills. Theme/indexed colors
 *  (no `argb`) are skipped rather than guessed. */
function argbToCss(color: unknown): string | undefined {
  const argb = (color as { argb?: string } | undefined)?.argb;
  if (typeof argb !== "string" || argb.length < 6) return undefined;
  return `#${argb.slice(-6)}`;
}

const V_ALIGN: Record<string, string> = { top: "top", middle: "middle", bottom: "bottom" };

/** Inline CSS for one cell from its ExcelJS style. */
function cellStyle(cell: ExcelJS.Cell): string {
  const s: string[] = [];
  const fill = cell.fill as { type?: string; pattern?: string; fgColor?: unknown } | undefined;
  if (fill?.type === "pattern" && fill.pattern === "solid") {
    const bg = argbToCss(fill.fgColor);
    if (bg) s.push(`background:${bg}`);
  }
  const font = cell.font ?? {};
  const color = argbToCss(font.color);
  if (color) s.push(`color:${color}`);
  if (font.size) s.push(`font-size:${(font.size * 4) / 3}px`); // pt → px
  if (font.name) s.push(`font-family:'${font.name.replace(/'/g, "")}',sans-serif`);
  if (font.bold) s.push("font-weight:600");
  if (font.italic) s.push("font-style:italic");
  if (font.underline) s.push("text-decoration:underline");

  const align = cell.alignment ?? {};
  // Default alignment mirrors Excel: numbers right, everything else left.
  const horiz = align.horizontal ?? (cell.type === ExcelJS.ValueType.Number ? "right" : "left");
  if (horiz === "center" || horiz === "right") s.push(`text-align:${horiz}`);
  if (align.vertical && V_ALIGN[align.vertical]) s.push(`vertical-align:${V_ALIGN[align.vertical]}`);
  if (align.wrapText) s.push("white-space:normal");

  for (const side of ["top", "right", "bottom", "left"] as const) {
    const b = (cell.border as Record<string, { style?: string; color?: unknown }> | undefined)?.[side];
    if (b?.style) {
      const w = b.style.includes("thick") || b.style === "medium" ? 2 : 1;
      s.push(`border-${side}:${w}px solid ${argbToCss(b.color) ?? "#c9c2b6"}`);
    }
  }
  return s.join(";");
}

// ExcelJS reads a workbook by literal names, not by what they mean in OOXML,
// so valid files from other generators crash it. Two habits matter:
//  - tag names: it matches `xdr:wsDr`, `workbook`, `r:id` as written, so
//    `<x:workbook>` (OpenXML SDK) reads no sheets and `<wsDr>` without `xdr:`
//    (Google Sheets, openpyxl) fails on the drawing's anchors;
//  - link targets: it finds tables, comments and drawings by the relative path
//    Excel writes (`../tables/table1.xml`), so an absolute `/xl/tables/…`
//    target finds nothing.
// normalizeXlsxForPreview rewrites both into Excel's own form before loading.

/** The prefix ExcelJS expects for each namespace (`null`: the default
 *  namespace, no prefix). */
const EXCELJS_PREFIX: Record<string, string | null> = {
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main": null,
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing": "xdr",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
};
const XMLNS = "http://www.w3.org/2000/xmlns/";

/** True when the part declares a known namespace under a prefix ExcelJS does
 *  not expect — the cheap text check that leaves ordinary Excel files alone. */
function hasForeignPrefix(xml: string): boolean {
  for (const m of xml.matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*["']([^"']*)["']/g)) {
    const want = EXCELJS_PREFIX[m[2]];
    if (want !== undefined && (m[1] ?? null) !== want) return true;
  }
  return false;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Rewrite one XML part so every element and attribute in a known namespace
 *  carries the prefix ExcelJS expects. The same document, renamed. */
export function canonicalizePrefixes(xml: string): string {
  const src = new DOMParser().parseFromString(xml, "application/xml");
  if (src.getElementsByTagName("parsererror").length > 0) return xml;
  const doc = document.implementation.createDocument(null, null, null);
  const rename = (ns: string | null, name: string, local: string) => {
    const want = ns ? EXCELJS_PREFIX[ns] : undefined;
    if (want === undefined) return name;
    return want ? `${want}:${local}` : local;
  };
  const copy = (el: Element): Element => {
    const out = doc.createElementNS(el.namespaceURI, rename(el.namespaceURI, el.tagName, el.localName));
    for (const a of Array.from(el.attributes)) {
      if (a.namespaceURI === XMLNS) {
        // Declarations of other namespaces stay (mc:Ignorable names them);
        // the renamed ones are declared once, on the root, below.
        if (EXCELJS_PREFIX[a.value] === undefined) out.setAttributeNS(XMLNS, a.name, a.value);
        continue;
      }
      out.setAttributeNS(a.namespaceURI, rename(a.namespaceURI, a.name, a.localName), a.value);
    }
    for (const n of Array.from(el.childNodes)) {
      out.appendChild(n.nodeType === Node.ELEMENT_NODE ? copy(n as Element) : doc.importNode(n, true));
    }
    return out;
  };
  const root = copy(src.documentElement);
  // Declared explicitly: left to itself the serializer invents `ns1:` for a
  // prefixed attribute whose prefix is not in scope.
  for (const [ns, prefix] of Object.entries(EXCELJS_PREFIX)) {
    if (prefix) root.setAttributeNS(XMLNS, `xmlns:${prefix}`, ns);
  }
  doc.appendChild(root);
  return XML_DECL + new XMLSerializer().serializeToString(doc);
}

/** Rewrite a `.rels` part's absolute internal targets (`/xl/tables/t1.xml`)
 *  to the relative form Excel writes (`../tables/t1.xml`). `relsPath` is the
 *  part's zip path, e.g. `xl/worksheets/_rels/sheet1.xml.rels`. */
export function relativizeTargets(xml: string, relsPath: string): string {
  if (!/\sTarget\s*=\s*["']\//.test(xml)) return xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return xml;
  // Targets resolve against the folder of the part these rels belong to.
  const from = relsPath.replace(/(^|\/)_rels\/[^/]*$/, "").split("/").filter(Boolean);
  for (const rel of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
    const target = rel.getAttribute("Target") ?? "";
    if (!target.startsWith("/") || rel.getAttribute("TargetMode") === "External") continue;
    const to = target.split("/").filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
    rel.setAttribute("Target", [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/"));
  }
  return XML_DECL + new XMLSerializer().serializeToString(doc);
}

/** Bring a workbook into the form ExcelJS reads (see above). Returns the
 *  original bytes when nothing needs it, or on any zip error — a normalization
 *  must never break the preview. The file on disk is untouched. */
export async function normalizeXlsxForPreview(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir || !/\.(xml|rels)$/.test(name)) continue;
      const xml = await zip.files[name].async("string");
      let out = hasForeignPrefix(xml) ? canonicalizePrefixes(xml) : xml;
      if (name.endsWith(".rels")) out = relativizeTargets(out, name);
      if (out !== xml) {
        zip.file(name, out);
        changed = true;
      }
    }
    return changed ? await zip.generateAsync({ type: "arraybuffer" }) : bytes;
  } catch {
    return bytes;
  }
}

export async function workbookSheets(bytes: ArrayBuffer): Promise<SheetHtml[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await normalizeXlsxForPreview(bytes));

  return wb.worksheets.map((ws) => {
    const dim = ws.dimensions as { top?: number; left?: number; bottom?: number; right?: number } | undefined;
    const top = dim?.top || 1;
    const left = dim?.left || 1;
    const bottom = dim?.bottom || 1;
    const right = dim?.right || 1;
    const lastRow = Math.min(bottom, top + MAX_ROWS - 1);
    const lastCol = Math.min(right, left + MAX_COLS - 1);
    const truncated = bottom > lastRow || right > lastCol;

    // Merges: the top-left cell spans; every other covered cell is skipped.
    const spans = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    for (const range of ws.model.merges ?? []) {
      const [a, b] = range.split(":");
      const s = cellRef(a);
      const e = cellRef(b);
      if (!s || !e) continue;
      spans.set(`${s.r},${s.c}`, { rs: e.r - s.r + 1, cs: e.c - s.c + 1 });
      for (let r = s.r; r <= e.r; r++)
        for (let c = s.c; c <= e.c; c++) if (r !== s.r || c !== s.c) covered.add(`${r},${c}`);
    }

    // Column widths (Excel char units → px), so the layout matches the sheet.
    let cols = "";
    for (let c = left; c <= lastCol; c++) {
      const w = ws.getColumn(c).width;
      cols += `<col style="width:${w ? Math.round(w * 7 + 5) : 64}px">`;
    }

    let body = "";
    for (let r = top; r <= lastRow; r++) {
      body += "<tr>";
      for (let c = left; c <= lastCol; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const cell = ws.getCell(r, c);
        const span = spans.get(`${r},${c}`);
        const attrs = span ? ` rowspan="${span.rs}" colspan="${span.cs}"` : "";
        const style = cellStyle(cell);
        body += `<td${attrs}${style ? ` style="${style}"` : ""}>${escapeHtml(cell.text ?? "")}</td>`;
      }
      body += "</tr>";
    }

    return {
      name: ws.name,
      html: `<table><colgroup>${cols}</colgroup><tbody>${body}</tbody></table>`,
      truncated,
    };
  });
}

/** Decode an A1-style cell ref (e.g. "AB12") to 1-based {r, c}. */
function cellRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(m[2], 10), c };
}

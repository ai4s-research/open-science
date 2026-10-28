import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { relativizeTargets, workbookSheets } from "./xlsx";

async function toBytes(build: (wb: ExcelJS.Workbook) => void): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe("workbookSheets", () => {
  it("renders every sheet to an HTML table, keeping merged cells as spans", async () => {
    const bytes = await toBytes((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.getCell("A1").value = "Report title";
      ws.mergeCells("A1:B1");
      ws.getCell("A2").value = "name";
      ws.getCell("B2").value = "value";
      ws.getCell("A3").value = "moon";
      ws.getCell("B3").value = 42;
      wb.addWorksheet("Notes").getCell("A1").value = "only one cell";
    });
    const sheets = await workbookSheets(bytes);

    expect(sheets.map((s) => s.name)).toEqual(["Data", "Notes"]);
    expect(sheets[0].html).toContain("<table");
    expect(sheets[0].html).toContain("Report title");
    expect(sheets[0].html).toMatch(/colspan="2"/);
    expect(sheets[0].truncated).toBe(false);
    expect(sheets[1].html).toContain("only one cell");
  });

  it("preserves cell fill, font color/size, and bold as inline styles", async () => {
    const bytes = await toBytes((wb) => {
      const ws = wb.addWorksheet("S");
      const cell = ws.getCell("A1");
      cell.value = "Header";
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC45038" } };
      cell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    });
    const html = (await workbookSheets(bytes))[0].html;
    expect(html).toContain("background:#C45038");
    expect(html).toContain("color:#FFFFFF");
    expect(html).toMatch(/font-size:18(\.\d+)?px/); // 14pt → px
    expect(html).toContain("font-weight:600");
  });

  it("escapes HTML in cell values", async () => {
    const bytes = await toBytes((wb) => {
      wb.addWorksheet("S").getCell("A1").value = "<img src=x>";
    });
    expect((await workbookSheets(bytes))[0].html).not.toContain("<img");
  });
});

// Valid workbooks from other generators that ExcelJS reads by literal names.
// Each fixture is an ExcelJS workbook rewritten into that generator's form.
describe("workbookSheets with other generators' spelling", () => {
  /** A one-sheet workbook with a styled cell, an image and a table. */
  async function base(): Promise<JSZip> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.getCell("A1").value = "name";
    ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC45038" } };
    ws.addTable({ name: "T", ref: "A1", columns: [{ name: "name" }], rows: [["moon"]] });
    // A 1×1 PNG, so the sheet has a drawing.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    ws.addImage(wb.addImage({ base64: png, extension: "png" }), "C3:D4");
    return JSZip.loadAsync(await wb.xlsx.writeBuffer());
  }
  async function edit(zip: JSZip, name: string, f: (xml: string) => string) {
    zip.file(name, f(await zip.file(name)!.async("string")));
  }
  async function sheets(zip: JSZip) {
    return workbookSheets(await zip.generateAsync({ type: "arraybuffer" }));
  }

  it("reads a drawing written without the xdr: prefix (Google Sheets, openpyxl)", async () => {
    const zip = await base();
    await edit(zip, "xl/drawings/drawing1.xml", (x) =>
      x.replace(/xmlns:xdr=/, "xmlns=").replace(/<(\/?)xdr:/g, "<$1"),
    );
    const [sheet] = await sheets(zip);
    expect(sheet.html).toContain("moon");
    expect(sheet.html).toContain("background:#C45038");
  });

  it("reads x:-prefixed parts with absolute link targets (OpenXML SDK)", async () => {
    const zip = await base();
    for (const name of ["xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
      await edit(zip, name, (x) =>
        x
          .replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
          .replace(/<(\/?)(?![?!])(?![\w]+:)/g, "<$1x:"),
      );
    }
    for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".rels") && n.startsWith("xl/"))) {
      await edit(zip, name, (x) =>
        x.replace(/Target="(?:\.\.\/)?([^"/][^"]*)"/g, 'Target="/xl/$1"'),
      );
    }
    const [sheet] = await sheets(zip);
    expect(sheet.html).toContain("moon");
    expect(sheet.html).toContain("background:#C45038");
  });

  it("relativizes absolute targets against the part the rels belong to", () => {
    const rels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="a" Type="t" Target="/xl/tables/table1.xml"/>' +
      '<Relationship Id="b" Type="t" Target="/xl/worksheets/sheet2.xml"/>' +
      '<Relationship Id="c" Type="t" Target="https://example.com/" TargetMode="External"/>' +
      "</Relationships>";
    const out = relativizeTargets(rels, "xl/worksheets/_rels/sheet1.xml.rels");
    expect(out).toContain('Target="../tables/table1.xml"');
    expect(out).toContain('Target="sheet2.xml"');
    expect(out).toContain('Target="https://example.com/"');
    expect(relativizeTargets(rels, "_rels/.rels")).toContain('Target="xl/tables/table1.xml"');
  });
});

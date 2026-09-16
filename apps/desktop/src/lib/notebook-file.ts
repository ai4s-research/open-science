import type { NotebookCell } from "@ai4s/shared";
import { isCodeLanguage, type KernelLanguage } from "./kernel";

/** Minimal nbformat-4 shapes we read and write. */
interface IpynbOutput {
  output_type: string;
  text?: string | string[];
  data?: { "text/plain"?: string | string[]; "image/png"?: string | string[] };
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface IpynbCell {
  cell_type: string;
  source: string | string[];
  outputs?: IpynbOutput[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
}
interface Ipynb {
  cells: IpynbCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

const joinSource = (s: string | string[] | undefined): string =>
  Array.isArray(s) ? s.join("") : (s ?? "");

const KERNELSPECS: Record<KernelLanguage, { display_name: string; name: string }> = {
  python: { display_name: "Python 3", name: "python3" },
  r: { display_name: "R", name: "ir" },
};

/** The notebook's kernel language, from its kernelspec/language_info. Default python. */
export function notebookLanguage(json: string): KernelLanguage {
  let name = "";
  try {
    const nb = JSON.parse(json) as Ipynb;
    const ks = nb.metadata?.kernelspec as { language?: string; name?: string } | undefined;
    const li = nb.metadata?.language_info as { name?: string } | undefined;
    name = (ks?.language ?? ks?.name ?? li?.name ?? "").toLowerCase();
  } catch {
    /* fall through to default */
  }
  return name === "r" || name === "ir" ? "r" : "python";
}

function outputsOf(outputs: IpynbOutput[] | undefined): { text?: string; image?: string } {
  if (!outputs?.length) return {};
  let image: string | undefined;
  const parts = outputs.map((o) => {
    if (o.output_type === "stream") return joinSource(o.text);
    if (o.output_type === "execute_result" || o.output_type === "display_data") {
      const png = joinSource(o.data?.["image/png"]).replace(/\n/g, "");
      if (png && !image) image = png; // keep the first figure
      return joinSource(o.data?.["text/plain"]);
    }
    if (o.output_type === "error")
      return o.traceback?.join("\n") ?? `${o.ename}: ${o.evalue}`;
    return "";
  });
  const text = parts
    .map((p) => p.trimEnd())
    .filter(Boolean)
    .join("\n");
  return { text: text || undefined, image };
}

/** Parse .ipynb JSON into the app's cell model. Throws on non-notebook JSON. */
export function parseIpynb(json: string): NotebookCell[] {
  const nb = JSON.parse(json) as Ipynb;
  if (!Array.isArray(nb.cells)) throw new Error("not a Jupyter notebook (no cells array)");
  const lang = notebookLanguage(json); // code cells run on the notebook's kernel
  return nb.cells.map((cell, i) => {
    const out = cell.cell_type === "code" ? outputsOf(cell.outputs) : {};
    return {
      index: i + 1,
      language: cell.cell_type === "code" ? lang : cell.cell_type,
      code: joinSource(cell.source),
      output: out.text,
      image: out.image,
      count: typeof cell.execution_count === "number" ? cell.execution_count : undefined,
    };
  });
}

/** Serialize the app's cell model back to nbformat 4.5 JSON. */
export function serializeIpynb(cells: NotebookCell[]): string {
  // A notebook has one kernel language; take it from the first code cell.
  const lang: KernelLanguage =
    (cells.find((c) => isCodeLanguage(c.language))?.language as KernelLanguage) ?? "python";
  const ks = KERNELSPECS[lang];
  const nb: Ipynb = {
    cells: cells.map((c) => {
      if (!isCodeLanguage(c.language)) {
        return { cell_type: c.language, source: c.code, metadata: {} };
      }
      const outputs: IpynbOutput[] = [];
      if (c.output) {
        outputs.push({
          output_type: "stream",
          text: c.output.endsWith("\n") ? c.output : `${c.output}\n`,
        });
      }
      if (c.image) {
        outputs.push({ output_type: "display_data", data: { "image/png": c.image } });
      }
      return {
        cell_type: "code",
        source: c.code,
        outputs,
        metadata: {},
        execution_count: c.count ?? null,
      };
    }),
    metadata: {
      kernelspec: { display_name: ks.display_name, language: lang, name: ks.name },
      language_info: { name: lang },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(nb, null, 1);
}

/** A blank single-cell notebook document for the given kernel language. */
export function emptyIpynb(language: KernelLanguage = "python"): string {
  return serializeIpynb([{ index: 1, language, code: "" }]);
}

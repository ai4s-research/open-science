// Curated open-source science MCP connectors (P1-2). These are existing,
// maintained open-source MCP servers — we one-click provision them into a
// shared isolated env (bundled uv) and register them; we do not reimplement
// literature/database access ourselves. Keep this list small and vetted.
import type { McpConfig } from "@ai4s/sdk";

export interface ScienceConnector {
  /** MCP server name written into OpenCode's config. */
  id: string;
  label: string;
  /** Short discipline chip, e.g. "materials", "economics". */
  discipline: string;
  description: string;
  /** PyPI package installed into the shared science-MCP env. */
  pkg: string;
  /** Console script the package installs (resolved next to the managed python).
   *  Preferred when set — many MCP servers ship a script, not a `-m` module. */
  bin?: string;
  /** Fallback: Python `-m` module the server runs as, plus any args. */
  module?: string;
  args?: string[];
  /** Env var the server reads its API key from (free keys; never logged). */
  apiKeyEnv?: string;
  /** Where the user gets a free key. */
  apiKeyUrl?: string;
  /** Shown before Enable when the install is large. */
  installNote?: string;
  /** Upstream project, shown so users can vet it before enabling. */
  source: string;
}

export const SCIENCE_CONNECTORS: ScienceConnector[] = [
  {
    id: "paper-search",
    label: "Literature search",
    discipline: "all fields",
    description:
      "arXiv · PubMed · Crossref · Semantic Scholar · bioRxiv/medRxiv — search & fetch papers",
    pkg: "paper-search-mcp",
    module: "paper_search_mcp.server",
    source: "github.com/openags/paper-search-mcp",
  },
  {
    id: "biomcp",
    label: "Biomedical databases",
    discipline: "biology",
    description: "PubMed articles, ClinicalTrials.gov, and genomic variants (MyVariant/ClinVar)",
    pkg: "biomcp-python",
    module: "biomcp",
    args: ["run"],
    source: "github.com/genomoncology/biomcp",
  },
  {
    id: "materials-project",
    label: "Materials Project",
    discipline: "materials",
    description:
      "Query material properties, crystal structures, and phase diagrams from the Materials Project database",
    pkg: "mcp-materials-project",
    bin: "mcp-materials-project",
    apiKeyEnv: "MP_API_KEY",
    apiKeyUrl: "https://next-gen.materialsproject.org/api",
    installNote: "large — installs pymatgen + mp-api on first enable",
    source: "github.com/luffysolution-svg/mcp-materials-project",
  },
  {
    id: "fred",
    label: "FRED economic data",
    discipline: "economics",
    description:
      "Federal Reserve (FRED) economic time series — GDP, inflation, unemployment, rates, and more",
    pkg: "fred-mcp",
    bin: "fred-mcp",
    apiKeyEnv: "FRED_API_KEY",
    apiKeyUrl: "https://fred.stlouisfed.org/docs/api/api_key.html",
    source: "github.com/tosin2013/fred-mcp",
  },
  {
    id: "spaceweather",
    label: "Space weather",
    discipline: "physics",
    description:
      "Solar wind, solar flares, Kp/Dst geomagnetic indices, radiation storms, and aurora forecasts (NOAA SWPC · NASA DONKI · USGS)",
    pkg: "spaceweather-mcp",
    bin: "spaceweather-mcp",
    source: "github.com/hoon1983/spaceweather-mcp",
  },
  {
    id: "open-meteo",
    label: "Weather & climate (Open-Meteo)",
    discipline: "earth/climate",
    description:
      "Current & historical weather, air quality, and timezones from Open-Meteo — free, no key",
    pkg: "mcp-weather-server",
    module: "mcp_weather_server",
    source: "github.com/isdaniel/mcp_weather_server",
  },
  {
    id: "usgs-water",
    label: "USGS water data",
    discipline: "earth/climate",
    description:
      "USGS Water Services — streamflow, flood stages, peak events, and monitoring sites across the US",
    pkg: "usgs-mcp",
    bin: "usgs-mcp",
    source: "github.com/mansurjisan/ocean-mcp",
  },
  // --- Bioinformatics databases ---
  {
    id: "uniprot",
    label: "UniProt proteins",
    discipline: "biology",
    description:
      "UniProtKB protein data — search, retrieve entries, sequences, Gene Ontology annotations, and ID mapping across 200+ databases",
    pkg: "uniprot-mcp",
    bin: "uniprot-mcp",
    source: "github.com/josefdc/Uniprot-MCP",
  },
  {
    id: "ensembl",
    label: "Ensembl genes",
    discipline: "biology",
    description:
      "Ensembl genome database — gene annotations, transcripts, variants, cross-species comparisons, and ID mapping",
    pkg: "ensembl-mcp",
    module: "ensembl_mcp.server",
    source: "github.com/Ensembl/ensembl-mcp",
  },
  {
    id: "geo-ncbi",
    label: "GEO datasets",
    discipline: "biology",
    description:
      "NCBI Gene Expression Omnibus (GEO) — search and retrieve gene expression datasets, series, and samples via E-Utils API",
    pkg: "geo-mcp",
    module: "geomcp.server",
    source: "github.com/MCPmed/geomcp",
  },
  {
    id: "ncbi-eutils",
    label: "NCBI databases",
    discipline: "biology",
    description:
      "NCBI E-utilities — PubMed, Gene, Nucleotide, Protein, SRA, and other NCBI databases via Entrez API",
    pkg: "ncbi-mcp",
    module: "ncbi_mcp.server",
    source: "github.com/QiGoki/ncbi-mcp",
  },
  {
    id: "kegg",
    label: "KEGG pathways",
    discipline: "biology",
    description:
      "KEGG bioinformatics database — metabolic pathways, disease pathways, drug targets, orthologs, and compound/reaction networks",
    pkg: "kegg-mcp-server",
    module: "kegg_mcp_server.server",
    source: "github.com/Lucas-Servi/kegg-mcp-server-python",
  },
  {
    id: "string-db",
    label: "STRING interactions",
    discipline: "biology",
    description:
      "STRING protein-protein interaction network — functional associations, interaction partners, network analysis across 5000+ organisms",
    pkg: "string-mcp",
    module: "string_mcp.server",
    source: "github.com/medmcp/STRINGmcp",
  },
];

/** Resolve a console script that sits next to the managed python interpreter
 *  (unix: `<env>/bin/<script>`; Windows: `<env>/Scripts/<script>.exe`). */
function scriptBeside(python: string, bin: string): string {
  const sep = python.includes("\\") ? "\\" : "/";
  const dir = python.slice(0, python.lastIndexOf(sep));
  const exe = python.toLowerCase().endsWith(".exe") ? ".exe" : "";
  return `${dir}${sep}${bin}${exe}`;
}

/** Local-MCP config for a connector, given the managed interpreter path and an
 *  optional API key (passed via env, never written to provenance/logs). */
export function connectorConfig(
  c: ScienceConnector,
  python: string,
  apiKey?: string,
): McpConfig {
  const command = c.bin
    ? [scriptBeside(python, c.bin)]
    : [python, "-m", c.module ?? "", ...(c.args ?? [])];
  const config: McpConfig = { type: "local", command, enabled: true };
  if (c.apiKeyEnv && apiKey && apiKey.trim()) {
    config.environment = { [c.apiKeyEnv]: apiKey.trim() };
  }
  return config;
}

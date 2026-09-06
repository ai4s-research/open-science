// Curated science MCP connectors (P1-2). Almost all of these are existing,
// maintained open-source MCP servers that we one-click provision into a
// shared isolated env (bundled uv) and register — we do not reimplement
// literature/database access ourselves. Keep this list small and vetted.
//
// A `type: "remote"` entry is the one exception to "we host it": it points at
// a vendor's own official hosted MCP server (OAuth-authenticated) instead of
// a PyPI package, for cases where the vendor runs the only sanctioned
// endpoint (e.g. Elicit) rather than publishing something installable.
import type { McpConfig } from "@ai4s/sdk";

interface ScienceConnectorBase {
  /** MCP server name written into OpenCode's config. */
  id: string;
  label: string;
  /** Short discipline chip, e.g. "materials", "economics". */
  discipline: string;
  description: string;
  /** Upstream project, shown so users can vet it before enabling. */
  source: string;
}

export interface LocalScienceConnector extends ScienceConnectorBase {
  type?: "local";
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
  /** True when `apiKeyEnv` is a hard requirement to run at all (e.g. a
   *  contact email NCBI's E-utils rejects requests without) rather than an
   *  optional rate-limit key — changes the field's hint text, not whether
   *  Enable is disabled (that already keys off `apiKeyEnv` alone). */
  apiKeyRequired?: boolean;
  /** Shown before Enable when the install is large. */
  installNote?: string;
}

export interface RemoteScienceConnector extends ScienceConnectorBase {
  type: "remote";
  /** The vendor's own hosted MCP endpoint — nothing installed locally. */
  url: string;
  /** How OpenCode authenticates to `url`. Only "oauth" exists today. */
  auth: "oauth";
}

export type ScienceConnector = LocalScienceConnector | RemoteScienceConnector;

export const SCIENCE_CONNECTORS: ScienceConnector[] = [
  {
    type: "remote",
    id: "elicit",
    label: "Elicit",
    discipline: "all fields",
    description:
      "Semantic search over 138M+ papers, systematic reviews, and evidence reports — official Elicit connector, sign in with your Elicit account",
    url: "https://elicit.com/api/mcp",
    auth: "oauth",
    source: "elicit.com (official, docs.elicit.com)",
  },
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
    id: "geo-mcp",
    label: "GEO (Gene Expression Omnibus)",
    discipline: "biology",
    description:
      "Search and retrieve gene expression / functional genomics datasets, series, samples, and platforms from NCBI GEO via E-utils",
    pkg: "geo-mcp",
    bin: "geo-mcp",
    apiKeyEnv: "GEOMCP_EMAIL",
    apiKeyRequired: true,
    apiKeyUrl: "https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/",
    source: "github.com/MCPmed/geomcp",
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
];

/** Resolve a console script that sits next to the managed python interpreter
 *  (unix: `<env>/bin/<script>`; Windows: `<env>/Scripts/<script>.exe`). */
function scriptBeside(python: string, bin: string): string {
  const sep = python.includes("\\") ? "\\" : "/";
  const dir = python.slice(0, python.lastIndexOf(sep));
  const exe = python.toLowerCase().endsWith(".exe") ? ".exe" : "";
  return `${dir}${sep}${bin}${exe}`;
}

/** MCP config for a connector. `python` (the managed interpreter path) and
 *  `apiKey` (passed via env, never written to provenance/logs) only apply to
 *  a local connector; a remote one just points at the vendor's own URL and
 *  authenticates separately via `OpenCodeClient.startMcpOAuth`. */
export function connectorConfig(
  c: ScienceConnector,
  python?: string,
  apiKey?: string,
): McpConfig {
  if (c.type === "remote") {
    return { type: "remote", url: c.url, enabled: true };
  }
  const command = c.bin
    ? [scriptBeside(python ?? "", c.bin)]
    : [python ?? "", "-m", c.module ?? "", ...(c.args ?? [])];
  const config: McpConfig = { type: "local", command, enabled: true };
  if (c.apiKeyEnv && apiKey && apiKey.trim()) {
    config.environment = { [c.apiKeyEnv]: apiKey.trim() };
  }
  return config;
}

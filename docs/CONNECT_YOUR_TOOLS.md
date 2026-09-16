# Connect your lab tools

Open Science Desktop is a workbench: it aggregates tools, it doesn't replace them.
Anything the agent can reach is an **MCP server** (Model Context Protocol) or a
**skill**. Both are pluggable — you don't touch app code to add one.

## One-click science connectors

Settings → **MCP servers** lists curated open-source connectors. Click **Enable**
and the app provisions the server into an isolated environment (bundled `uv`,
managed Python — your system is untouched) and registers it. Today:

- **Literature search** (all fields) — arXiv, PubMed, Crossref, Semantic Scholar,
  bioRxiv/medRxiv ([paper-search-mcp](https://github.com/openags/paper-search-mcp)).
- **Biomedical databases** (biology) — PubMed, ClinicalTrials.gov, genomic variants
  ([biomcp](https://github.com/genomoncology/biomcp)).
- **Materials Project** (materials) — properties, structures, phase diagrams
  ([mcp-materials-project](https://github.com/luffysolution-svg/mcp-materials-project); free MP API key).
- **FRED economic data** (economics) — Federal Reserve time series
  ([fred-mcp](https://github.com/tosin2013/fred-mcp); free FRED API key).
- **Space weather** (physics) — solar wind, flares, Kp/Dst indices, radiation
  storms, aurora, from NOAA SWPC / NASA DONKI / USGS
  ([spaceweather-mcp](https://github.com/hoon1983/spaceweather-mcp); no key).
- **Weather & climate** (earth) — current & historical weather, air quality,
  timezones from Open-Meteo
  ([mcp-weather-server](https://github.com/isdaniel/mcp_weather_server); no key).
- **USGS water data** (earth) — streamflow, flood stages, peak events, sites
  ([usgs-mcp](https://github.com/mansurjisan/ocean-mcp); no key).
- **Web search** (all fields) — live web sources beyond the paper databases:
  docs, news, primary sources ([You.com hosted MCP](https://you.com/docs);
  keyless — no account, no key, nothing installed).

Literature and database results carry real identifiers (DOI / PMID / arXiv id),
so the `traceability-review` skill can audit them afterward.

## Bring your own MCP server

Any MCP server works — internal ELN, LIMS, a database gateway, an instrument
bridge. In Settings → **MCP servers**, use the add form:

- **local** — a command the app launches and talks to over stdio. Example:
  `npx -y @playwright/mcp` (browser), or `uvx your-lab-mcp` for a Python server.
- **remote** — a URL the app connects to over HTTP. Example:
  `https://mcp.your-lab.internal/sse`.

The entry is written to the bundled OpenCode's config and applies immediately;
its live status (connected / failed) shows in the same list.

### Minimal local MCP server (Python)

```python
# lab_tools.py — run with: uvx --from fastmcp fastmcp run lab_tools.py
from fastmcp import FastMCP

mcp = FastMCP("lab-tools")

@mcp.tool()
def sample_metadata(sample_id: str) -> dict:
    """Look up a sample in the lab database."""
    return {"id": sample_id, "assay": "RNA-seq", "status": "passed_qc"}

if __name__ == "__main__":
    mcp.run()
```

Add it as a **local** server with the command that launches it. Restart-free.

## Bring your own skill

A skill is a folder with a `SKILL.md` (instructions the agent follows) plus any
scripts/templates it needs. Install one from the **Skills** page (paste a URL or
Markdown; the agent saves it under the workspace's `.opencode/skills/`). The
app also bundles first-party skills (e.g. `traceability-review`) and the
`ai4s-skills` pack.

## Safety

- Every server you add can make its own network calls and run its own code —
  review the source before enabling. The curated list is vetted; your own
  entries are your responsibility.
- Command execution, file deletion, dependency installs, and remote connections
  still go through the agent's approval flow.
- Provider keys and tokens live in an app-private file, never in the workspace,
  provenance, logs, or exports.

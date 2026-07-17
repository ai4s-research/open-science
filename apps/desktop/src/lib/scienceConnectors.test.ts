import { describe, expect, it } from "vitest";
import { SCIENCE_CONNECTORS, connectorConfig } from "./scienceConnectors";

const byId = (id: string) => {
  const c = SCIENCE_CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error(`no connector ${id}`);
  return c;
};

describe("connectorConfig", () => {
  it("launches a `-m module` connector (paper-search)", () => {
    const cfg = connectorConfig(byId("paper-search"), "/env/bin/python");
    expect(cfg).toMatchObject({
      type: "local",
      command: ["/env/bin/python", "-m", "paper_search_mcp.server"],
      enabled: true,
    });
    expect(cfg.type === "local" && cfg.environment).toBeUndefined();
  });

  it("keeps a module connector's extra args (biomcp run)", () => {
    const cfg = connectorConfig(byId("biomcp"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "/env/bin/python",
      "-m",
      "biomcp",
      "run",
    ]);
  });

  it("launches a console-script connector beside the interpreter (unix)", () => {
    const cfg = connectorConfig(byId("materials-project"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "/env/bin/mcp-materials-project",
    ]);
  });

  it("resolves the console script on Windows with .exe", () => {
    const cfg = connectorConfig(byId("fred"), "C:\\env\\Scripts\\python.exe", "KEY");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "C:\\env\\Scripts\\fred-mcp.exe",
    ]);
  });

  it("passes an API key via environment, trimmed", () => {
    const cfg = connectorConfig(byId("materials-project"), "/env/bin/python", "  mp-secret  ");
    expect(cfg.type === "local" && cfg.environment).toEqual({ MP_API_KEY: "mp-secret" });
  });

  it("omits environment when the key is blank", () => {
    const cfg = connectorConfig(byId("fred"), "/env/bin/python", "   ");
    expect(cfg.type === "local" && cfg.environment).toBeUndefined();
  });

  it("every connector declares an id, discipline, package, and a launch path", () => {
    for (const c of SCIENCE_CONNECTORS) {
      expect(c.id && c.discipline && c.pkg && c.source).toBeTruthy();
      expect(Boolean(c.bin) || Boolean(c.module)).toBe(true);
      if (c.apiKeyEnv) expect(c.apiKeyUrl).toBeTruthy(); // key-needing → tell users where to get one
    }
  });

  it("ships at least two non-bio disciplines (P1-2 breadth)", () => {
    const disciplines = new Set(SCIENCE_CONNECTORS.map((c) => c.discipline));
    expect(disciplines.has("materials")).toBe(true);
    expect(disciplines.has("economics")).toBe(true);
  });

  it("covers physics and earth/climate — the two previously-empty disciplines", () => {
    const disciplines = new Set(SCIENCE_CONNECTORS.map((c) => c.discipline));
    expect(disciplines.has("physics")).toBe(true);
    expect(disciplines.has("earth/climate")).toBe(true);
  });

  it("launches the space-weather connector as a console script (physics)", () => {
    const cfg = connectorConfig(byId("spaceweather"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual(["/env/bin/spaceweather-mcp"]);
  });

  it("launches Open-Meteo weather as a `-m module` connector (earth, no key)", () => {
    const c = byId("open-meteo");
    expect(c.apiKeyEnv).toBeUndefined(); // Open-Meteo is free, no key
    const cfg = connectorConfig(c, "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "/env/bin/python",
      "-m",
      "mcp_weather_server",
    ]);
  });

  it("launches USGS water data as a console script (earth, no key)", () => {
    const cfg = connectorConfig(byId("usgs-water"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual(["/env/bin/usgs-mcp"]);
  });

  it("launches UniProt as a console script (biology, no key)", () => {
    const cfg = connectorConfig(byId("uniprot"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual(["/env/bin/uniprot-mcp"]);
  });

  it("launches Ensembl as a -m module connector (biology, no key)", () => {
    const cfg = connectorConfig(byId("ensembl"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "/env/bin/python", "-m", "ensembl_mcp.server",
    ]);
  });

  it("launches KEGG as a -m module connector (biology, no key)", () => {
    const cfg = connectorConfig(byId("kegg"), "/env/bin/python");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "/env/bin/python", "-m", "kegg_mcp_server.server",
    ]);
  });

  it("launches UniProt on Windows with .exe", () => {
    const cfg = connectorConfig(byId("uniprot"), "C:\\env\\Scripts\\python.exe");
    expect(cfg.type === "local" && cfg.command).toEqual([
      "C:\\env\\Scripts\\uniprot-mcp.exe",
    ]);
  });

  it("has biology discipline coverage for new bio connectors", () => {
    const bioConnectors = SCIENCE_CONNECTORS.filter((c) => c.discipline === "biology");
    expect(bioConnectors.length).toBeGreaterThanOrEqual(7); // biomcp + 6 new
  });
});

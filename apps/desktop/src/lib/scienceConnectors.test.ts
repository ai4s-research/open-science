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

  it("every local connector declares an id, discipline, package, and a launch path", () => {
    for (const c of SCIENCE_CONNECTORS) {
      if (c.type === "remote") continue;
      expect(c.id && c.discipline && c.pkg && c.source).toBeTruthy();
      expect(Boolean(c.bin) || Boolean(c.module)).toBe(true);
      if (c.apiKeyEnv) expect(c.apiKeyUrl).toBeTruthy(); // key-needing → tell users where to get one
    }
  });

  it("every remote connector declares an id, discipline, https url, and source", () => {
    for (const c of SCIENCE_CONNECTORS) {
      if (c.type !== "remote") continue;
      expect(c.id && c.discipline && c.source).toBeTruthy();
      expect(c.url.startsWith("https://")).toBe(true);
      expect(c.auth).toBe("oauth");
    }
  });

  it("registers Elicit as a remote, OAuth-authenticated connector", () => {
    const c = byId("elicit");
    if (c.type !== "remote") throw new Error("elicit should be a remote connector");
    expect(c.url).toBe("https://elicit.com/api/mcp");
    const cfg = connectorConfig(c);
    expect(cfg).toEqual({ type: "remote", url: "https://elicit.com/api/mcp", enabled: true });
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
    if (c.type === "remote") throw new Error("open-meteo should be a local connector");
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
});

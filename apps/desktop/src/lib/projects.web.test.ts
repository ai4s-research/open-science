// Projects from a browser (#81). On a headless install EVERY user is a web
// user, so "create a project" cannot be a desktop-only path — there is no
// desktop to fall back to.
//
// `window.__OS_WEB__` is set before the imports rather than mocked: the flag is
// read once at module load (that is the real thing being exercised), and a
// mocked `isGatewayWeb` would not reach `gatewayPost`'s own copy of it.
import { beforeEach, describe, expect, it, vi } from "vitest";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;
Object.defineProperty(window, "location", {
  value: { ...window.location, origin: "http://gw" },
  writable: true,
});

const fetchMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => {
    throw new Error("the web client must never reach Tauri IPC");
  },
}));

const { createProject, listProjects } = await import("./tauri");

describe("projects in the web client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("os_gateway_token", "tok");
  });

  it("creates a project through the gateway instead of failing on Tauri IPC", async () => {
    const project = { id: "p1", name: "Reef survey", path: "/ws/projects/Reef-survey" };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => project,
    });

    expect(await createProject("Reef survey")).toEqual(project);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Reef survey" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("reports the gateway's own refusal, so a read-only token says so", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "token is read-only" }),
    });
    await expect(createProject("Reef survey")).rejects.toThrow("token is read-only");
  });

  it("still lists projects over the same surface", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [{ id: "p1", name: "Reef survey", path: "/ws/p" }],
    });
    expect(await listProjects()).toHaveLength(1);
  });
});

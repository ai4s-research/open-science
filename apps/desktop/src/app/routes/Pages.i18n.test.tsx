import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import i18n from "@/i18n";

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(async () => {
  useUiStore.getState().setLocale("en");
  await i18n.changeLanguage("en");
});

// COPYCAT RULE: useRuntimeStore is also module-global — restore the
// disconnected default after any test that fakes a "ready" runtime.
const RUNTIME_DEFAULTS = {
  status: useRuntimeStore.getState().status,
  agents: useRuntimeStore.getState().agents,
  tools: useRuntimeStore.getState().tools,
  detectTools: useRuntimeStore.getState().detectTools,
};
afterEach(() => useRuntimeStore.setState(RUNTIME_DEFAULTS));

describe("NotebooksPage strings (i18n)", () => {
  it("renders the page heading and the desktop-only empty state in English", async () => {
    renderAt("/notebooks");
    expect(await screen.findByRole("heading", { level: 1, name: "Notebooks" })).toBeInTheDocument();
    expect(screen.getByText("Notebooks are available in the desktop app.")).toBeInTheDocument();
    expect(screen.getByText("New notebook")).toBeInTheDocument();
  });
});

describe("FilesPage strings (i18n)", () => {
  it("renders the desktop-only explorer message and the preview prompt in English", async () => {
    renderAt("/files");
    expect(await screen.findByText("The file explorer is available in the desktop app.")).toBeInTheDocument();
    expect(screen.getByText("Select a file to preview it here.")).toBeInTheDocument();
  });
});

describe("SkillsPage strings (i18n)", () => {
  it("renders the page heading and the disconnected-runtime prompts in English", async () => {
    renderAt("/skills");
    expect(await screen.findByRole("heading", { level: 1, name: "Skills & Agents" })).toBeInTheDocument();
    expect(screen.getByText("Environment detection runs in the desktop app.")).toBeInTheDocument();
    expect(
      screen.getByText("Connect the runtime to list the skills and agents it has loaded."),
    ).toBeInTheDocument();
  });

  // #68: the app's own uv/Jupyter live off PATH, so the row must say who owns
  // the binary — the page used to read as the user's own install (or, before
  // the probe fell back at all, as "not found" for a working Jupyter).
  it("labels an app-managed tool and leaves the user's own install unlabelled", async () => {
    useRuntimeStore.setState({
      tools: [
        { name: "Python", found: true, version: "Python 3.12.2" },
        { name: "Jupyter", found: true, version: "jupyter 4.4.1", managed: true },
        { name: "R", found: false, version: null },
      ],
      // The page probes on mount; outside Tauri that resolves to an empty list
      // and would wipe the fixture before the assertions run.
      detectTools: async () => {},
    });
    renderAt("/skills");

    const jupyter = (await screen.findByText("Jupyter")).closest("div")!;
    expect(jupyter).toHaveTextContent("jupyter 4.4.1");
    expect(jupyter).toHaveTextContent("app-managed");

    const python = screen.getByText("Python").closest("div")!;
    expect(python).toHaveTextContent("Python 3.12.2");
    expect(python).not.toHaveTextContent("app-managed");

    // A genuinely absent tool still reports honestly.
    expect(screen.getByText("not found")).toBeInTheDocument();
  });

  it("translates the app-managed label and the corrected environment note", async () => {
    // LocaleProvider wraps the app above the router, so renderAt does not pick
    // up a store locale change — drive i18next directly (as i18n/format.test).
    await i18n.changeLanguage("zh-Hans");
    useRuntimeStore.setState({
      tools: [{ name: "Jupyter", found: true, version: "4.4.1", managed: true }],
      detectTools: async () => {},
    });
    renderAt("/skills");

    expect(await screen.findByText("应用内置")).toBeInTheDocument();
    // The note no longer claims uv/Jupyter are absent (#68) — it says who owns them.
    expect(screen.getByText(/uv 随应用内置/)).toBeInTheDocument();
  });

  it("translates the known agent-mode badge and falls back to the raw value for an unknown mode", async () => {
    useRuntimeStore.setState({
      status: "ready",
      agents: [
        { name: "build", description: "Primary build agent", mode: "primary" },
        { name: "custom-thing", description: "Some external agent", mode: "future-mode" },
      ],
    });
    renderAt("/skills");
    expect(await screen.findByText("build")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    // Unknown mode values (outside the closed set OpenCode emits) render raw, unmodified.
    expect(screen.getByText("future-mode")).toBeInTheDocument();
  });
});

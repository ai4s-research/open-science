import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { shippedLocales } from "@/i18n/config";

describe("Settings language selector", () => {
  it("shows a Language select with one option per shipped locale", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    expect(within(select).getAllByRole("option")).toHaveLength(shippedLocales().length);
  });

  it("updates the store locale on change", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    await userEvent.selectOptions(select, "ja");
    expect(useUiStore.getState().locale).toBe("ja");
    useUiStore.getState().setLocale("en");
  });
});

describe("Settings page strings (i18n)", () => {
  it("renders the General section with the settings sidebar navigation", async () => {
    renderAt("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("available in the desktop app")).toBeInTheDocument();
    // The sidebar became the settings navigation with a way back to the app.
    expect(screen.getByRole("button", { name: "Back to app" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connectors" })).toBeInTheDocument();
  });

  it("renders each section's own title and disconnected-runtime prompt", async () => {
    const runtime = renderAt("/settings/runtime");
    expect(await screen.findByText("Agent runtime")).toBeInTheDocument();
    runtime.unmount();

    const connectors = renderAt("/settings/connectors");
    expect(await screen.findByText("MCP servers")).toBeInTheDocument();
    expect(screen.getByText("Connect the runtime to configure MCP servers.")).toBeInTheDocument();
    connectors.unmount();

    renderAt("/settings/models");
    expect(await screen.findByText("Connect the runtime to configure models.")).toBeInTheDocument();
  });

  it("shows auto-review for OpenCode and hides the inapplicable control for ACP", async () => {
    const originalKind = useRuntimeStore.getState().runtimeKind;
    let view: ReturnType<typeof renderAt> | undefined;
    try {
      act(() => useRuntimeStore.setState({ runtimeKind: "opencode" }));
      view = renderAt("/settings");
      expect(
        await screen.findByRole("switch", { name: "Review after every turn that changes files" }),
      ).toBeInTheDocument();
      view.unmount();

      act(() => useRuntimeStore.setState({ runtimeKind: "acp" }));
      view = renderAt("/settings");
      expect(screen.getByRole("heading", { level: 2, name: "Workspace" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 2, name: "Review" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Review after every turn that changes files" }),
      ).not.toBeInTheDocument();
    } finally {
      view?.unmount();
      act(() => useRuntimeStore.setState({ runtimeKind: originalKind }));
    }
  });

  it("renders separate model browsing and provider management surfaces when connected", async () => {
    const original = useRuntimeStore.getState();
    let view: ReturnType<typeof renderAt> | undefined;
    try {
      useRuntimeStore.setState({ status: "ready", defaultModel: null });
      view = renderAt("/settings/models");
      // No client behind this render: the Models card sits in its loading
      // state while the separate Providers card is already on screen.
      expect(await screen.findByText("Loading the model catalog…")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: "Providers" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manage" })).toHaveAttribute("aria-expanded", "false");
    } finally {
      view?.unmount();
      useRuntimeStore.setState({ status: original.status, defaultModel: original.defaultModel });
    }
  });
});

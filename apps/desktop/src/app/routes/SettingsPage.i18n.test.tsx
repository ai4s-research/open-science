import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { shippedLocales } from "@/i18n/config";

describe("Settings language selector", () => {
  it("shows a Language control with one button per shipped locale", async () => {
    renderAt("/settings");
    const group = await screen.findByRole("group", { name: "Language" });
    expect(within(group).getAllByRole("button")).toHaveLength(shippedLocales().length);
  });

  it("updates the store locale on change", async () => {
    renderAt("/settings");
    const group = await screen.findByRole("group", { name: "Language" });
    await userEvent.click(within(group).getByRole("button", { name: /日本語/ }));
    expect(useUiStore.getState().locale).toBe("ja");
    useUiStore.getState().setLocale("en");
  });
});

describe("Settings page strings (i18n)", () => {
  it("renders the page title, subtitle, and card titles in English", async () => {
    renderAt("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(
      screen.getByText("Everything here configures the bundled OpenCode runtime — one config, no copies."),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent runtime")).toBeInTheDocument();
    expect(screen.getByText("MCP servers")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("renders the disconnected-runtime prompts and the Workspace fallback text", async () => {
    renderAt("/settings");
    expect(await screen.findByText("Connect the runtime to configure models.")).toBeInTheDocument();
    expect(screen.getByText("Connect the runtime to configure MCP servers.")).toBeInTheDocument();
    expect(screen.getByText("available in the desktop app")).toBeInTheDocument();
  });

  it("renders separate model browsing and provider management surfaces when connected", async () => {
    const original = useRuntimeStore.getState();
    let view: ReturnType<typeof renderAt> | undefined;
    try {
      useRuntimeStore.setState({ status: "ready", defaultModel: null });
      view = renderAt("/settings");
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

import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./store";

describe("uiStore theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ theme: "warm" });
  });

  it("cycles theme and persists to localStorage", () => {
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("dark");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("light");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("light");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("warm");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("warm");
  });
});

describe("uiStore theme variants", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the first variant of each theme", () => {
    expect(useUiStore.getState().themeVariants).toEqual({ warm: "soft", dark: "dimmed" });
  });

  it("keeps a variant per theme, persisted, and ignores one of another theme", () => {
    useUiStore.getState().setThemeVariant("dark", "graphite");
    expect(useUiStore.getState().themeVariants).toEqual({ warm: "soft", dark: "graphite" });
    expect(window.localStorage.getItem("ai4s.theme.dark.variant")).toBe("graphite");

    useUiStore.getState().setThemeVariant("warm", "graphite");
    expect(useUiStore.getState().themeVariants.warm).toBe("soft");
  });
});

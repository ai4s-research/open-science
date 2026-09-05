import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import * as tauri from "@/lib/tauri";
import { SplitMenu } from "./SplitMenu";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof tauri>();
  return { ...mod, isTauri: true, pickFolder: vi.fn() };
});
const pickFolder = vi.mocked(tauri.pickFolder);

describe("SplitMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.clearAllMocks());

  it("asks where the new pane's work goes BEFORE splitting", async () => {
    const onSplit = vi.fn();
    render(<SplitMenu sourceFolder="/ws/thesis" onSplit={onSplit} icon={null} label="Split right" />);

    await userEvent.click(screen.getByRole("button", { name: "Split right" }));

    // Opening the menu splits nothing — the split is the answer, not the click.
    expect(onSplit).not.toHaveBeenCalled();
    expect(screen.getByText("Continue in thesis")).toBeInTheDocument();
    expect(screen.getByText("New folder")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Continue in thesis"));
    expect(onSplit).toHaveBeenCalledWith("/ws/thesis");
  });

  it("takes 'new folder' as no destination — the pane makes its own", async () => {
    const onSplit = vi.fn();
    render(<SplitMenu sourceFolder="/ws/thesis" onSplit={onSplit} icon={null} label="Split down" />);

    await userEvent.click(screen.getByRole("button", { name: "Split down" }));
    await userEvent.click(screen.getByText("New folder"));

    expect(onSplit).toHaveBeenCalledWith(null);
  });

  it("splits into a hand-picked folder, and not at all when the picker is cancelled", async () => {
    const onSplit = vi.fn();
    render(<SplitMenu sourceFolder="/ws/thesis" onSplit={onSplit} icon={null} label="Split right" />);

    pickFolder.mockResolvedValueOnce(null); // cancelled
    await userEvent.click(screen.getByRole("button", { name: "Split right" }));
    await userEvent.click(screen.getByText("Choose another folder…"));
    expect(onSplit).not.toHaveBeenCalled();

    pickFolder.mockResolvedValueOnce("/ws/elsewhere");
    await userEvent.click(screen.getByRole("button", { name: "Split right" }));
    await userEvent.click(screen.getByText("Choose another folder…"));
    expect(onSplit).toHaveBeenCalledWith("/ws/elsewhere");
  });

  it("splits straight away when there is no folder to continue in", async () => {
    const onSplit = vi.fn();
    render(<SplitMenu sourceFolder={null} onSplit={onSplit} icon={null} label="Split right" />);

    await userEvent.click(screen.getByRole("button", { name: "Split right" }));

    // Nothing to ask about: a pane with no folder always gets a dated one.
    expect(onSplit).toHaveBeenCalledWith(null);
    expect(screen.queryByText("New folder")).not.toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ToolCallBlock } from "@ai4s/shared";
import { ToolTitle } from "./ToolCallRow";

const links = vi.hoisted(() => ({ activateLink: vi.fn() }));
vi.mock("@/lib/links", async (orig) => ({
  ...(await orig<object>()),
  activateLink: links.activateLink,
  resolveLink: async (text: string) =>
    text === "/Users/me/Downloads/Penguin AI.png"
      ? { kind: "path", path: "Downloads/Penguin AI.png", root: "home", isDir: false, display: text }
      : null,
}));

const block = (filePath?: string) =>
  ({ kind: "tool-call", status: "success", verb: "Read", title: filePath ?? "ls -lt", filePath }) as ToolCallBlock;

describe("ToolTitle", () => {
  it("links the file a step read; a click opens it and does not fold the row", async () => {
    const fold = vi.fn();
    render(
      <div onClick={fold}>
        <ToolTitle block={block("/Users/me/Downloads/Penguin AI.png")} className="" />
      </div>,
    );
    const title = screen.getByText("/Users/me/Downloads/Penguin AI.png");
    await waitFor(() => expect(title.className).toContain("cursor-pointer"));
    fireEvent.click(title);
    expect(links.activateLink).toHaveBeenCalledWith(expect.objectContaining({ path: "Downloads/Penguin AI.png" }), expect.anything());
    expect(fold).not.toHaveBeenCalled();
  });

  it("leaves a step without a file, or with one that is gone, plain", async () => {
    const fold = vi.fn();
    render(
      <div onClick={fold}>
        <ToolTitle block={block()} className="" />
        <ToolTitle block={block("/Users/me/gone.png")} className="" />
      </div>,
    );
    fireEvent.click(screen.getByText("/Users/me/gone.png"));
    expect(fold).toHaveBeenCalledTimes(1);
    expect(screen.getByText("ls -lt").className).not.toContain("cursor-pointer");
  });
});

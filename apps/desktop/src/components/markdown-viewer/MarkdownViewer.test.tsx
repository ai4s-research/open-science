import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  openExternal: openExternalMock,
}));

describe("MarkdownViewer", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
  });

  it("renders inline and block LaTeX via KaTeX", () => {
    const { container } = render(
      <MarkdownViewer>{"Mass–energy: $E = mc^2$.\n\n$$\\int_0^1 x^2\\,dx$$"}</MarkdownViewer>,
    );
    // KaTeX emits `.katex` nodes; a plain-text renderer would emit none.
    const math = container.querySelectorAll(".katex");
    expect(math.length).toBeGreaterThanOrEqual(2); // one inline, one display
    // The rendered output carries the variables, not the raw `$…$` delimiters.
    expect(container.textContent).toContain("E");
    expect(container.textContent).not.toContain("$E = mc^2$");
  });

  it("renders \\[…\\] and \\(…\\) bracket-delimited LaTeX (#51)", () => {
    const { container } = render(
      <MarkdownViewer>
        {
          "The distance \\(d\\) is:\n\n\\[\nd=\\sqrt{(x_1-x_2)^2+(y_1-y_2)^2+(z_1-z_2)^2}\n\\]\n\nand \\[\\theta=\\arccos\\frac{\\vec v_1\\cdot\\vec v_2}{|\\vec v_1||\\vec v_2|}\\]"
        }
      </MarkdownViewer>,
    );
    const math = container.querySelectorAll(".katex");
    expect(math.length).toBeGreaterThanOrEqual(3);
    // No raw LaTeX commands or delimiters leak into the visible text (KaTeX's
    // MathML <annotation> carries the TeX source by design — drop it first).
    container.querySelectorAll("annotation").forEach((a) => a.remove());
    expect(container.textContent).not.toContain("\\sqrt");
    expect(container.textContent).not.toContain("\\arccos");
    expect(container.textContent).not.toContain("\\[");
    expect(container.textContent).not.toContain("\\(");
  });

  it("does not touch bracket delimiters inside code", () => {
    const { container } = render(
      <MarkdownViewer>
        {"Use `\\(x\\)` inline.\n\n```latex\n\\[\nE = mc^2\n\\]\n```"}
      </MarkdownViewer>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("\\(x\\)");
    expect(container.textContent).toContain("\\[");
    expect(container.textContent).toContain("E = mc^2");
  });

  it("keeps \\\\[2pt] row spacing inside display math intact", () => {
    const { container } = render(
      <MarkdownViewer>
        {"\\[\n\\begin{aligned}\na &= b \\\\[2pt]\nc &= d\n\\end{aligned}\n\\]"}
      </MarkdownViewer>,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(1);
    container.querySelectorAll("annotation").forEach((a) => a.remove());
    expect(container.textContent).not.toContain("\\begin");
  });

  it("still renders ordinary markdown (a lone $ is not math)", () => {
    const { container } = render(<MarkdownViewer>{"It costs $5 and **works**."}</MarkdownViewer>);
    expect(container.querySelector("strong")?.textContent).toBe("works");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
  });

  it("opens an http(s) link externally without navigating the application", () => {
    const { getByRole } = render(
      <MarkdownViewer>{"[Open Science](https://example.com/research)"}</MarkdownViewer>,
    );
    const link = getByRole("link");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(link.dispatchEvent(click)).toBe(false);
    expect(openExternalMock).toHaveBeenCalledOnce();
    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/research");
  });

  it("blocks a relative document link from becoming an application route", () => {
    const { getByRole } = render(<MarkdownViewer>{"[Notes](other-notes.md)"}</MarkdownViewer>);
    const link = getByRole("link");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(link.dispatchEvent(click)).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});

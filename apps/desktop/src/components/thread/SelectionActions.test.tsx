import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { SelectionActions, signatureOf } from "./SelectionActions";

/** Select the text of `id` and release the pointer, as a user drag would. */
function selectIn(id: string) {
  const node = document.getElementById(id)!;
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.pointerUp(document);
}

function scene() {
  return render(
    <>
      <div data-agent-message>
        <p id="answer">Use a 4.5 sigma threshold for spike detection.</p>
      </div>
      <div>
        <p id="elsewhere">a tool log, or the user's own message</p>
      </div>
      <SelectionActions sessionId="s1" />
    </>,
  );
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  useUiStore.setState({ composerDraft: null });
  useRuntimeStore.setState({ sessions: [], projects: [] });
});

describe("SelectionActions", () => {
  it("offers actions for a selection inside an answer", () => {
    scene();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    selectIn("answer");

    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByText("Quote")).toBeInTheDocument();
    expect(screen.getByText("Explain")).toBeInTheDocument();
  });

  it("stays out of the way outside an answer — quoting your own words back is noise", () => {
    scene();
    selectIn("elsewhere");

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("quotes the selection into the composer instead of making the user retype it", () => {
    scene();
    selectIn("answer");
    fireEvent.click(screen.getByText("Quote"));

    expect(useUiStore.getState().composerDraft).toBe(
      "> Use a 4.5 sigma threshold for spike detection.",
    );
    // The toolbar closes with the selection it acted on.
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("asks a follow-up with the passage already quoted", () => {
    scene();
    selectIn("answer");
    fireEvent.click(screen.getByText("Explain"));

    expect(useUiStore.getState().composerDraft).toBe(
      "> Use a 4.5 sigma threshold for spike detection.\n\nExplain this part in more detail.",
    );
  });

  it("closes when the user clicks away", () => {
    scene();
    selectIn("answer");
    expect(screen.getByRole("toolbar")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("shows no memory action in the web client, which has no memory files", () => {
    // isTauri is false under the test environment — the desktop-only action is
    // withheld rather than shipped as a control that fails.
    scene();
    selectIn("answer");
    expect(screen.queryByText("Save to memory")).not.toBeInTheDocument();
  });
});

describe("dismissing the selection toolbar", () => {
  it("stays gone when the click leaves the same selection behind", () => {
    scene();
    selectIn("answer");
    expect(screen.getByRole("toolbar")).toBeInTheDocument();

    // A click on empty space: the toolbar hides on pointerdown, and then
    // pointerup reads the selection again. WebKit has not always collapsed it
    // by then, so the toolbar came straight back — a flicker that needed a
    // second click to be rid of.
    fireEvent.pointerDown(document.getElementById("elsewhere")!);
    fireEvent.pointerUp(document);

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("still shows for a NEW selection made right after a dismiss", () => {
    scene();
    selectIn("answer");
    fireEvent.pointerDown(document.getElementById("elsewhere")!);
    fireEvent.pointerUp(document);

    // Double-clicking a word immediately after dismissing is a new selection,
    // and must not be mistaken for the one just dismissed.
    const node = document.getElementById("answer")!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.pointerUp(document);

    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("describes a selection well enough to tell it from another", () => {
    const host = document.createElement("p");
    host.textContent = "alpha beta";
    document.body.appendChild(host);
    const range = (from: number, to: number) => {
      const r = document.createRange();
      r.setStart(host.firstChild!, from);
      r.setEnd(host.firstChild!, to);
      return {
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => r,
        toString: () => host.textContent!.slice(from, to),
      } as unknown as Selection;
    };

    expect(signatureOf(range(0, 5))).toBe(signatureOf(range(0, 5)));
    // A different selection must NOT look like the dismissed one, or
    // double-clicking a word right after a dismiss would show nothing.
    expect(signatureOf(range(0, 5))).not.toBe(signatureOf(range(6, 10)));
  });

  it("has no signature for an empty selection", () => {
    expect(signatureOf(null)).toBeNull();
    expect(signatureOf({ isCollapsed: true, rangeCount: 0 } as unknown as Selection)).toBeNull();
  });
});

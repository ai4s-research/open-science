import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { SelectionActions } from "./SelectionActions";

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

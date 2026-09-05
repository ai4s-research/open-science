import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMessage, UserMessage } from "./atoms";

// copyText hits the OS clipboard — stub it so the copy button is observable.
const { copyTextMock, toastErrorMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn(async () => {}),
  toastErrorMock: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));
vi.mock("@/lib/toast", () => ({ toast: { error: toastErrorMock, success: vi.fn() } }));

const dialog = () => screen.getByRole("alertdialog");

describe("UserMessage", () => {
  afterEach(() => vi.clearAllMocks());

  // Its controls are revealed by the message the pointer is tracked to, not by
  // CSS :hover — which WebKit leaves stale (see lib/hoverTracking).
  it("is a hover host, and its controls are a tracked hover row", () => {
    const { container } = render(<UserMessage block={{ kind: "user", text: "hi" }} />);
    expect(container.querySelector("[data-hover-host]")).not.toBeNull();
    const row = container.querySelector("[data-hover-row]");
    expect(row).not.toBeNull();
    // No :hover class decides visibility any more; the stylesheet does.
    expect(row?.className).not.toContain("group-hover");
  });

  it("renders the text in a right-aligned, content-hugging bubble", () => {
    const { container } = render(<UserMessage block={{ kind: "user", text: "部署" }} />);
    expect(screen.getByText("部署")).toBeInTheDocument();
    // Right-aligned column, bubble hugs its content (short prompts stay small).
    expect(container.querySelector(".items-end")).not.toBeNull();
    expect(container.querySelector(".w-fit")).not.toBeNull();
  });

  it("shows Edit/Revert only when the message has an id AND the handler", () => {
    const { rerender } = render(<UserMessage block={{ kind: "user", text: "hi", messageID: "m1" }} />);
    expect(screen.queryByLabelText("Edit")).toBeNull(); // no handlers
    expect(screen.queryByLabelText("Revert")).toBeNull();
    rerender(<UserMessage block={{ kind: "user", text: "hi" }} onEdit={() => {}} onRevert={() => {}} />);
    expect(screen.queryByLabelText("Edit")).toBeNull(); // no id
    expect(screen.queryByLabelText("Revert")).toBeNull();
    rerender(
      <UserMessage block={{ kind: "user", text: "hi", messageID: "m1" }} onEdit={() => {}} onRevert={() => {}} />,
    );
    expect(screen.getByLabelText("Edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Revert")).toBeInTheDocument();
  });

  it("edit resends only after the destructive-action dialog is confirmed", () => {
    const onEdit = vi.fn();
    render(<UserMessage block={{ kind: "user", text: "部署", messageID: "m1" }} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText("Edit"));
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(area.value).toBe("部署");
    fireEvent.change(area, { target: { value: "部署到生产" } });
    fireEvent.click(screen.getByText("Send"));
    // The dialog gates the destructive resend — nothing sent yet.
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByText("Edit & resend"));
    expect(onEdit).toHaveBeenCalledWith("m1", "部署到生产");
    expect(screen.queryByRole("textbox")).toBeNull(); // editor closed
  });

  it("cancelling the dialog keeps the editor open and sends nothing", () => {
    const onEdit = vi.fn();
    render(<UserMessage block={{ kind: "user", text: "部署", messageID: "m1" }} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(within(dialog()).getByText("Cancel"));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeInTheDocument(); // still editing
  });

  it("refuses to open the dialog for an empty edit", () => {
    render(<UserMessage block={{ kind: "user", text: "hi", messageID: "m1" }} onEdit={() => {}} />);
    fireEvent.click(screen.getByLabelText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    const send = screen.getByText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("revert rolls back to the message and prefills only after confirmation", () => {
    const onRevert = vi.fn();
    render(<UserMessage block={{ kind: "user", text: "部署", messageID: "m1" }} onRevert={onRevert} />);
    fireEvent.click(screen.getByLabelText("Revert"));
    expect(onRevert).not.toHaveBeenCalled(); // dialog gates it
    fireEvent.click(within(dialog()).getByText("Revert here"));
    expect(onRevert).toHaveBeenCalledWith("m1", "部署");
  });

  it("cancelling the revert dialog does nothing", () => {
    const onRevert = vi.fn();
    render(<UserMessage block={{ kind: "user", text: "部署", messageID: "m1" }} onRevert={onRevert} />);
    fireEvent.click(screen.getByLabelText("Revert"));
    fireEvent.click(within(dialog()).getByText("Cancel"));
    expect(onRevert).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("copies the message text to the clipboard", () => {
    render(<UserMessage block={{ kind: "user", text: "部署" }} />);
    fireEvent.click(screen.getByLabelText("Copy"));
    expect(copyTextMock).toHaveBeenCalledWith("部署");
  });
});

describe("AgentMessage", () => {
  afterEach(() => vi.clearAllMocks());

  it("copies the complete markdown answer and shows success feedback", async () => {
    render(<AgentMessage markdown={"Answer with **detail**"} />);
    fireEvent.click(screen.getByLabelText("Copy"));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("Answer with **detail**"));
    expect(screen.getByTitle("Copied")).toBeInTheDocument();
  });

  it("shows an error when the clipboard write fails", async () => {
    copyTextMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<AgentMessage markdown="Answer" />);
    fireEvent.click(screen.getByLabelText("Copy"));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Could not copy to the clipboard."));
  });
});

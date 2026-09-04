import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { ModelPicker } from "./ModelPicker";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5", name: "GPT-5", variants: ["low", "medium", "high"], contextLimit: 400000 },
      // no reasoning levels, and a window OpenCode does not know (custom endpoint)
      { id: "gpt-mini", name: "GPT-mini", variants: [], contextLimit: 0 },
    ],
  },
];

const renderPicker = () =>
  render(
    <MemoryRouter>
      <ModelPicker />
    </MemoryRouter>,
  );

const chip = () => screen.getByRole("button", { name: /switch model/i });

describe("ModelPicker", () => {
  const initial = useRuntimeStore.getState();
  let setDefaultModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    // Mirror the real store action: switching the default updates the state the
    // picker reads (so a switch to a reasoning model then exposes its slider).
    setDefaultModel = vi.fn(async (model: string) => {
      useRuntimeStore.setState({ defaultModel: model });
    });
    useRuntimeStore.setState({
      providers,
      defaultModel: "openai/gpt-5",
      reasoningVariant: null,
      setDefaultModel,
      switching: false,
    });
  });
  afterEach(() => {
    useRuntimeStore.setState(initial, true);
  });

  it("labels the chip with the current model", () => {
    renderPicker();
    expect(chip()).toHaveTextContent("GPT-5");
  });

  it("opens and lists every model", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("GPT-5")).toBeInTheDocument();
    expect(within(dialog).getByText("GPT-mini")).toBeInTheDocument();
  });

  it("builds a reasoning slider from the current model's variants and pins the choice", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByText(/reasoning effort/i)); // expand Advanced
    const slider = within(dialog).getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemax", "2"); // low / medium / high → 0..2

    fireEvent.keyDown(slider, { key: "End" }); // jump to the highest level
    expect(useRuntimeStore.getState().reasoningVariant).toBe("high");
    expect(chip()).toHaveTextContent("High"); // effort surfaces on the chip
  });

  it("steps the reasoning slider and clears to model default past the first level", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByText(/reasoning effort/i));
    const slider = within(dialog).getByRole("slider");
    fireEvent.keyDown(slider, { key: "Home" }); // lowest = low
    expect(useRuntimeStore.getState().reasoningVariant).toBe("low");
    fireEvent.keyDown(slider, { key: "ArrowLeft" }); // past the first stop → default
    expect(useRuntimeStore.getState().reasoningVariant).toBeNull();
  });

  it("hides the reasoning control for a model with no levels", async () => {
    useRuntimeStore.setState({ defaultModel: "openai/gpt-mini" });
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    expect(within(screen.getByRole("dialog")).queryByText(/reasoning effort/i)).toBeNull();
  });

  it("switches the default model and closes for a model with no reasoning levels", async () => {
    const user = userEvent.setup();
    renderPicker(); // current model is gpt-5
    await user.click(chip());
    await user.click(within(screen.getByRole("dialog")).getByText("GPT-mini"));
    expect(setDefaultModel).toHaveBeenCalledWith("openai/gpt-mini");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays open after switching to a reasoning-capable model (so effort can be tuned)", async () => {
    useRuntimeStore.setState({ defaultModel: "openai/gpt-mini" });
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    await user.click(within(screen.getByRole("dialog")).getByText("GPT-5"));
    expect(setDefaultModel).toHaveBeenCalledWith("openai/gpt-5");
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    // Advanced auto-expands so the effort slider is right there to adjust.
    expect(within(dialog).getByRole("slider")).toBeInTheDocument();
  });

  // A zero context window is not cosmetic: OpenCode skips auto-compaction
  // entirely, so the conversation grows unbounded and long turns eventually
  // stall with nothing but a spinner. The picker is where the model was chosen,
  // so it is where that has to be said.
  it("warns when the selected model has no known context window", async () => {
    useRuntimeStore.setState({ defaultModel: "openai/gpt-mini" });
    const user = userEvent.setup();
    renderPicker();
    await user.click(chip());
    expect(
      within(screen.getByRole("dialog")).getByText(/context window unknown/i),
    ).toBeInTheDocument();
  });

  it("spins only for a model switch, not a workspace move", async () => {
    // `switching` covers any workspace move, and switching Screens is one — so
    // reading it made the model chip spin on every Screen switch, next to a
    // header that was already reflowing.
    act(() => useRuntimeStore.setState({ switching: true, modelSwitching: false }));
    renderPicker();
    expect(chip().querySelector(".animate-spin")).toBeNull();

    act(() => useRuntimeStore.setState({ modelSwitching: true }));
    expect(chip().querySelector(".animate-spin")).not.toBeNull();
    act(() => useRuntimeStore.setState({ switching: false, modelSwitching: false }));
  });

  it("stays quiet when the window is known", async () => {
    const user = userEvent.setup();
    renderPicker(); // gpt-5, 400k window
    await user.click(chip());
    expect(
      within(screen.getByRole("dialog")).queryByText(/context window unknown/i),
    ).toBeNull();
  });

  // A provider can stop serving a model it still advertises (OpenCode Zen has
  // retired 19 of its 25 free ones). Offering it would only produce a provider
  // error mid-turn — but going silent would leave the user's own configured
  // model missing from the list with no explanation.
  describe("a model the provider has retired", () => {
    beforeEach(() => {
      useRuntimeStore.setState({
        providers: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: [
              { id: "hy3-free", name: "HY3 (free)", contextLimit: 262144, available: true },
              { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash (free)", contextLimit: 262144, available: false },
            ],
          },
        ],
        defaultModel: "opencode/ling-3.0-flash-free",
      });
    });

    it("is not offered in the list", async () => {
      const user = userEvent.setup();
      renderPicker();
      await user.click(chip());
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("HY3 (free)")).toBeInTheDocument();
      expect(within(dialog).queryByText("Ling 3.0 Flash (free)")).toBeNull();
    });

    it("is named on the chip and explained, while it is still the one configured", async () => {
      const user = userEvent.setup();
      renderPicker();
      expect(chip()).toHaveTextContent("Ling 3.0 Flash (free)");
      await user.click(chip());
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(/retired by its provider/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/Ling 3.0 Flash \(free\)/)).toBeInTheDocument();
    });

    it("says nothing once a served model is chosen", async () => {
      useRuntimeStore.setState({ defaultModel: "opencode/hy3-free" });
      const user = userEvent.setup();
      renderPicker();
      await user.click(chip());
      expect(within(screen.getByRole("dialog")).queryByText(/retired by its provider/i)).toBeNull();
    });
  });
});

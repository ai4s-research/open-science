import { describe, expect, it } from "vitest";
import { screenVisibility } from "./LiveSessionPage";

describe("how a Screen is hidden", () => {
  it("shows the active one", () => {
    const { className, style } = screenVisibility(true, false);
    expect(className).toBe("absolute inset-0");
    expect(style).toBeUndefined();
  });

  it("makes a warm Screen untouchable, not merely unpainted", () => {
    const { className, style } = screenVisibility(false, true);

    // `content-visibility: hidden` skips the subtree's LAYOUT, which is why a
    // warm Screen is cheap to keep. But it leaves the element in the hit-test
    // tree, and a warm Screen is `absolute inset-0` over the live one — so on
    // its own it turns into an invisible sheet that eats every wheel, click and
    // keystroke. `invisible` is what makes it untouchable. Both, or neither
    // works.
    expect(style).toEqual({ contentVisibility: "hidden" });
    expect(className).toContain("invisible");
    // …and NOT display:none, which is what "warm" exists to avoid.
    expect(className).not.toContain("hidden");
  });

  it("drops a cold Screen out of the layout entirely", () => {
    const { className, style } = screenVisibility(false, false);
    expect(className).toContain("hidden");
    expect(style).toBeUndefined();
  });
});

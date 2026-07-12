import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { ProviderManagerCard } from "./ProviderManagerCard";

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", models: [] },
  { id: "opencode", name: "OpenCode Zen", models: [] },
];

describe("ProviderManagerCard", () => {
  it("summarizes providers and keeps management content collapsed", () => {
    render(
      <ProviderManagerCard
        providers={providers}
        expanded={false}
        onExpandedChange={vi.fn()}
      >
        <div>Provider controls</div>
      </ProviderManagerCard>,
    );
    expect(screen.getByText(/2 connected: OpenAI, OpenCode Zen/)).toBeInTheDocument();
    expect(screen.queryByText("Provider controls")).not.toBeInTheDocument();
  });

  it("summarizes a single provider", () => {
    render(
      <ProviderManagerCard
        providers={[providers[0]]}
        expanded={false}
        onExpandedChange={vi.fn()}
      >
        <div>Provider controls</div>
      </ProviderManagerCard>,
    );
    expect(screen.getByText("1 connected: OpenAI")).toBeInTheDocument();
  });

  it("requests expansion and exposes controlled expanded content", async () => {
    const onExpandedChange = vi.fn();
    const { rerender } = render(
      <ProviderManagerCard
        providers={providers}
        expanded={false}
        onExpandedChange={onExpandedChange}
      >
        <div>Provider controls</div>
      </ProviderManagerCard>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    rerender(
      <ProviderManagerCard
        providers={providers}
        expanded
        onExpandedChange={onExpandedChange}
      >
        <div>Provider controls</div>
      </ProviderManagerCard>,
    );
    expect(screen.getByText("Provider controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

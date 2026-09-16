import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import i18n from "@/i18n";
import { ProviderManagerCard } from "./ProviderManagerCard";

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", models: [{ id: "o3", name: "o3" }] },
  { id: "anthropic", name: "Anthropic", models: [] },
];

describe("ProviderManagerCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows what it governs without asking to be opened first", () => {
    // It used to hide everything — including the add-a-provider form, the most
    // common task on this page — behind a "Manage" button.
    render(
      <ProviderManagerCard providers={providers}>
        <p>connect a provider</p>
      </ProviderManagerCard>,
    );

    expect(screen.getByText("connect a provider")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage|Collapse/ })).not.toBeInTheDocument();
  });

  it("summarises what is connected for a screen reader", () => {
    render(
      <ProviderManagerCard providers={providers}>
        <p>body</p>
      </ProviderManagerCard>,
    );
    expect(screen.getByText("2 connected: OpenAI, Anthropic")).toBeInTheDocument();
  });

  it("says so when nothing is connected", () => {
    render(
      <ProviderManagerCard providers={[]}>
        <p>body</p>
      </ProviderManagerCard>,
    );
    expect(screen.getByText("No providers connected")).toBeInTheDocument();
  });

  it("lets the caller replace the subtitle where the surface is read-only", () => {
    render(
      <ProviderManagerCard providers={providers} hint="Read-only from the browser">
        <p>body</p>
      </ProviderManagerCard>,
    );
    expect(screen.getByText("Read-only from the browser")).toBeInTheDocument();
  });
});

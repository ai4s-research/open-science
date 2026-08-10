import { describe, expect, it } from "vitest";
import { customProviderId } from "./customProviderId";

describe("customProviderId", () => {
  it("slugifies an ASCII name unchanged, so existing endpoints keep their ids", () => {
    expect(customProviderId("OpenRouter")).toBe("openrouter");
    expect(customProviderId("Ollama local")).toBe("ollama-local");
    expect(customProviderId("  My Endpoint v2  ")).toBe("my-endpoint-v2");
  });

  it("accepts a name with no ASCII characters at all (#89)", () => {
    const id = customProviderId("音云");
    expect(id).not.toBe("");
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("is stable for the same name", () => {
    expect(customProviderId("音云")).toBe(customProviderId("音云"));
  });

  it("keeps names that share an ASCII skeleton on distinct ids", () => {
    // Both collapse to "api" on the slug alone; colliding here would make the
    // second "Add endpoint" overwrite the first provider's config.
    expect(customProviderId("音云 API")).not.toBe(customProviderId("星河 API"));
    expect(customProviderId("音云")).not.toBe(customProviderId("大模型"));
  });

  it("bounds the id length for a long non-Latin name", () => {
    expect(customProviderId("智谱清言大模型服务平台").length).toBeLessThanOrEqual(16);
  });

  it("returns an id for a name that slugifies to nothing", () => {
    expect(customProviderId("!!!")).toMatch(/^custom-[0-9a-f]{8}$/);
  });

  it("returns \"\" only for a blank name", () => {
    expect(customProviderId("")).toBe("");
    expect(customProviderId("   ")).toBe("");
  });
});

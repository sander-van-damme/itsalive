import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/shell/core/providers";

describe("ProviderRegistry", () => {
  it("registers and routes neutral generation requests", async () => {
    const registry = new ProviderRegistry().register({ id: "local", generate: async request => ({ text: request.system }) });
    expect(registry.list()).toEqual(["local"]);
    const result = await registry.generate({ model: { id: "m", provider: "local", model: "x", maxContextTokens: 1_000, maxOutputTokens: 10 }, system: "system", messages: [], maxOutputTokens: 10 });
    expect(result.text).toBe("system");
  });

  it("rejects unknown providers clearly", () => {
    expect(() => new ProviderRegistry().get("missing")).toThrow("Unknown LLM provider");
  });
});

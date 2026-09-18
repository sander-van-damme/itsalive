import { describe, expect, it } from "vitest";
import { CONNECTION_TEST_OUTPUT_TOKENS, connectionTestModelConfig } from "../src/shell/core/connection-test";

describe("connectionTestModelConfig", () => {
  it("uses a deliberately small non-reasoning request budget", () => {
    const model = connectionTestModelConfig("openrouter", "openrouter/auto", 128_000);
    expect(CONNECTION_TEST_OUTPUT_TOKENS).toBe(8);
    expect(model.maxOutputTokens).toBe(8);
    expect(model.options).toEqual({ reasoning: { enabled: false } });
  });
});

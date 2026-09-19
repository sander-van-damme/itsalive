import { describe, expect, it } from "vitest";
import { CONNECTION_TEST_OUTPUT_TOKENS, connectionTestModelConfig } from "../src/shell/core/connection-test";

describe("connectionTestModelConfig", () => {
  it("leaves model-specific reasoning behavior to OpenRouter", () => {
    const model = connectionTestModelConfig("openrouter", "openrouter/auto", 128_000);
    expect(CONNECTION_TEST_OUTPUT_TOKENS).toBe(256);
    expect(model.maxOutputTokens).toBe(256);
    expect(model.options).toBeUndefined();
  });
});

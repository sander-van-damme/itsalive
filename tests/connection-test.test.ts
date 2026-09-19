import { describe, expect, it } from "vitest";
import { connectionTestModelConfig } from "../src/shell/core/connection-test";

describe("connectionTestModelConfig", () => {
  it("leaves generation and reasoning policy to OpenRouter", () => {
    expect(connectionTestModelConfig("openrouter", "openrouter/auto")).toEqual({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });
});

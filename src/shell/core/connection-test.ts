import type { ModelConfig } from "./types";

export const CONNECTION_TEST_OUTPUT_TOKENS = 8;

export function connectionTestModelConfig(provider: string, model: string, maxContextTokens: number): ModelConfig {
  return { id: "connection-test", provider, model, maxContextTokens, maxOutputTokens: CONNECTION_TEST_OUTPUT_TOKENS, options: { reasoning: { enabled: false } } };
}

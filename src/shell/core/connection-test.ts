import type { ModelConfig } from "./types";

export const CONNECTION_TEST_OUTPUT_TOKENS = 256;

export function connectionTestModelConfig(provider: string, model: string, maxContextTokens: number): ModelConfig {
  return { provider, model, maxContextTokens, maxOutputTokens: CONNECTION_TEST_OUTPUT_TOKENS };
}

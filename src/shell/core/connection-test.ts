import type { ModelConfig } from "./types";

export function connectionTestModelConfig(provider: string, model: string): ModelConfig {
  return { provider, model };
}

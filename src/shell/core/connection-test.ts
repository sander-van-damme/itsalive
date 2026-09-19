import type { ProviderModel } from "./types";

export function connectionTestModelConfig(provider: string, model: string): ProviderModel {
  return { provider, model };
}

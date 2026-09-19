import type { Credential } from "./types";

interface OpenRouterModelRecord {
  id?: unknown;
  context_length?: unknown;
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

export async function fetchOpenRouterContextCapacity(
  model: string,
  credential: Credential,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const response = await fetcher("https://openrouter.ai/api/v1/models/user", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.value}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load OpenRouter model metadata (${response.status})`);
  }

  const body = await response.json() as OpenRouterModelsResponse;
  if (!Array.isArray(body.data)) throw new Error("OpenRouter model metadata response was invalid");

  const record = body.data.find((value): value is OpenRouterModelRecord =>
    Boolean(value && typeof value === "object" && (value as OpenRouterModelRecord).id === model),
  );
  const capacity = record?.context_length;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(`OpenRouter did not report a context capacity for ${model}`);
  }
  return Math.floor(capacity);
}

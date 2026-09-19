import type { Credential } from "./types";

export interface OpenRouterKeyInfo {
  label?: string;
  usage?: number;
  limit?: number | null;
  limitRemaining?: number | null;
}

interface OpenRouterKeyResponse {
  data?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNumber(value);
}

export async function fetchOpenRouterKeyInfo(
  credential: Credential,
  fetcher: typeof fetch = fetch,
): Promise<OpenRouterKeyInfo> {
  const response = await fetcher("https://openrouter.ai/api/v1/key", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.value}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("OpenRouter API key was rejected");
    throw new Error(`Could not load OpenRouter API key details (${response.status})`);
  }

  const body = await response.json() as OpenRouterKeyResponse;
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    throw new Error("OpenRouter API key details response was invalid");
  }

  const data = body.data as Record<string, unknown>;
  const usage = finiteNumber(data.usage);
  const limit = nullableFiniteNumber(data.limit);
  const limitRemaining = nullableFiniteNumber(data.limit_remaining);

  return {
    ...(typeof data.label === "string" && data.label.trim() ? { label: data.label.trim() } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(limitRemaining !== undefined ? { limitRemaining } : {}),
  };
}

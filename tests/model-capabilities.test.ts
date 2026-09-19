import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterContextCapacity } from "../src/shell/core/model-capabilities";

describe("fetchOpenRouterContextCapacity", () => {
  it("uses the user-filtered OpenRouter model catalogue", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "other/model", context_length: 32_000 },
        { id: "openrouter/auto", context_length: 1_000_000 },
      ],
    }), { status: 200 }));

    await expect(fetchOpenRouterContextCapacity("openrouter/auto", { value: "secret" }, fetcher)).resolves.toBe(1_000_000);
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models/user", {
      headers: { accept: "application/json", authorization: "Bearer secret" },
    });
  });

  it("fails instead of inventing a context capacity", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "openrouter/auto", context_length: null }],
    }), { status: 200 }));

    await expect(fetchOpenRouterContextCapacity("openrouter/auto", { value: "secret" }, fetcher))
      .rejects.toThrow(/did not report a context capacity/);
  });
});

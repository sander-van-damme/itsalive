import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterKeyInfo } from "../src/shell/core/openrouter-account";

describe("fetchOpenRouterKeyInfo", () => {
  it("validates the current key without a generation request and returns spend metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        label: "sk-or-v1-test...123",
        usage: 25.5,
        limit: 100,
        limit_remaining: 74.5,
      },
    }), { status: 200 }));

    await expect(fetchOpenRouterKeyInfo({ value: "secret" }, fetcher)).resolves.toEqual({
      label: "sk-or-v1-test...123",
      usage: 25.5,
      limit: 100,
      limitRemaining: 74.5,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/key");
    expect(fetcher.mock.calls[0]?.[1]).toEqual({
      headers: { accept: "application/json", authorization: "Bearer secret" },
    });
  });

  it("reports rejected credentials clearly", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(fetchOpenRouterKeyInfo({ value: "bad-key" }, fetcher)).rejects.toThrow("OpenRouter API key was rejected");
  });

  it("preserves an explicit unlimited key without inventing a remaining balance", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { usage: 1.25, limit: null, limit_remaining: null },
    }), { status: 200 }));

    await expect(fetchOpenRouterKeyInfo({ value: "secret" }, fetcher)).resolves.toEqual({
      usage: 1.25,
      limit: null,
      limitRemaining: null,
    });
  });
});

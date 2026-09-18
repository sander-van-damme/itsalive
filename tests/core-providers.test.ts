import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAdapter, ProviderRegistry, ProviderResponseError } from "../src/shell/core/providers";

describe("ProviderRegistry", () => {
  afterEach(() => vi.restoreAllMocks());
  it("registers and routes neutral generation requests", async () => {
    const registry = new ProviderRegistry().register({ id: "local", generate: async request => ({ text: request.system }) });
    expect(registry.list()).toEqual(["local"]);
    const result = await registry.generate({ model: { id: "m", provider: "local", model: "x", maxContextTokens: 1_000, maxOutputTokens: 10 }, system: "system", messages: [], maxOutputTokens: 10 });
    expect(result.text).toBe("system");
  });

  it("rejects unknown providers clearly", () => {
    expect(() => new ProviderRegistry().get("missing")).toThrow("Unknown LLM provider");
  });

  it("preserves a sanitized response diagnostic when successful HTTP has no text", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { refusal: 'unsupported request shape' } }],
      authorization: 'Bearer must-not-leak',
      metadata: { api_key: 'must-not-leak-either' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const error = await createHttpAdapter({ id: 'custom', endpoint: 'https://example.test/generate' })
      .generate({ model: { id: 'm', provider: 'custom', model: 'x', maxContextTokens: 100, maxOutputTokens: 10 }, system: 'system', messages: [], maxOutputTokens: 10 }, { id: 'key', type: 'api-key', value: 'request-secret' })
      .catch(value => value);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error.message).toBe('Provider returned no text response');
    expect(error.diagnostic).toEqual({
      choices: [{ message: { refusal: 'unsupported request shape' } }],
      authorization: '[redacted]',
      metadata: { api_key: '[redacted]' },
    });
    expect(JSON.stringify(error.diagnostic)).not.toContain('must-not-leak');
  });
});

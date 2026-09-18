import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAdapter, ProviderRegistry, ProviderResponseError } from "../src/shell/core/providers";

describe("ProviderRegistry", () => {
  afterEach(() => vi.restoreAllMocks());
  it("registers and routes neutral generation requests", async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const registry = new ProviderRegistry().register({ id: "local", generate: async request => ({ text: request.system }) });
    expect(registry.list()).toEqual(["local"]);
    const result = await registry.generate({ model: { id: "m", provider: "local", model: "x", maxContextTokens: 1_000, maxOutputTokens: 10 }, system: "system", messages: [], maxOutputTokens: 10 });
    expect(result.text).toBe("system");
  });

  it('centrally traces full requests and sanitized responses without credentials', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    const registry = new ProviderRegistry().register({ id: 'local', generate: async () => ({ text: 'ok', raw: { authorization: 'Bearer secret-token' } }) });
    await registry.generate({ purpose: 'app design', model: { id: 'm', provider: 'local', model: 'x', maxContextTokens: 100, maxOutputTokens: 10 }, system: 'full system', messages: [{ role: 'user', content: 'full message' }], maxOutputTokens: 10 }, { id: 'credential', type: 'api-key', value: 'credential-secret' });
    const trace = JSON.stringify(info.mock.calls);
    expect(trace).toContain('full system');
    expect(trace).toContain('full message');
    expect(trace).toContain('[redacted]');
    expect(trace).not.toContain('secret-token');
    expect(trace).not.toContain('credential-secret');
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

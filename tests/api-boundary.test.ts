import { describe, expect, it, vi } from "vitest";
import { handleAPI } from "../src/server/api";
const request = (
  path: string,
  body: unknown,
  origin = "https://itsalive.org",
) =>
  new Request(`https://itsalive.org${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: "Bearer test-owned-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
describe("same-origin AI boundary", () => {
  it("rejects cross-origin use before contacting OpenAI", async () => {
    const fetcher = vi.fn();
    expect(
      (
        await handleAPI(
          request(
            "/api/ai/responses",
            { model: "gpt-6.1-sol", input: [] },
            "https://other.test",
          ),
          fetcher,
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the supplied key only at the fixed endpoint and streams without storing", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("data: test\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await handleAPI(
      request("/api/ai/responses", {
        model: "gpt-6.1-sol",
        input: [],
        store: true,
      }),
      fetcher,
    );
    expect(await result.text()).toBe("data: test\n\n");
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(
      JSON.parse(String((fetcher.mock.calls[0] as any)[1].body)).store,
    ).toBe(false);
  });
  it("fixes voice delegation and never exposes raw provider errors", async () => {
    const fetcher = vi.fn(
      async () => new Response("secret prompt echo", { status: 403 }),
    );
    const result = await handleAPI(
      request("/api/voice/sessions", {
        sdp: "offer",
        session: { instructions: "replace policy" },
        spokenReplies: false,
      }),
      fetcher,
    );
    const body = JSON.parse(String((fetcher.mock.calls[0] as any)[1].body));
    expect(body.session.model).toBe("gpt-live-1");
    expect(body.session.delegation.type).toBe("client");
    expect(body.session.instructions).not.toContain("replace policy");
    expect(await result.text()).not.toContain("secret prompt");
  });
  it("forwards a legitimate model context beyond the former 256 kB ceiling intact", async () => {
    const content = "source context ".repeat(40_000);
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true }),
    );
    const result = await handleAPI(
      request("/api/ai/responses", {
        model: "gpt-6.1-sol",
        input: [{ role: "user", content }],
      }),
      fetcher,
    );
    expect(result.status).toBe(200);
    expect(
      JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).input[0].content,
    ).toBe(content);
  });
  it("routes bounded questions only to the fixed Decisions endpoint", async () => {
    const question = {
      type: "predicate",
      name: "valid",
      instructions: "Is this valid?",
    };
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ answers: [] }),
    );
    const result = await handleAPI(
      request("/api/ai/decisions", {
        model: "gpt-6-luna",
        input: "Evidence",
        questions: [question],
        endpoint: "https://attacker.test",
        max_output_tokens: 1,
        store: true,
      }),
      fetcher,
    );
    expect(result.status).toBe(200);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/decisions",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      model: "gpt-6-luna",
      input: "Evidence",
      questions: [question],
    });
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed decisions and unsupported models before billing", async () => {
    const fetcher = vi.fn();
    for (const body of [
      { model: "gpt-6.1-sol", input: "", questions: [] },
      {
        model: "gpt-6-luna",
        input: "",
        questions: [{ type: "arbitrary", name: "x", instructions: "" }],
      },
    ]) {
      expect(
        (await handleAPI(request("/api/ai/decisions", body), fetcher)).status,
      ).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves relevant voice history without silent universal trimming", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      role: "user",
      content: `Turn ${index}: ` + "context".repeat(1000),
    }));
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}),
    );
    await handleAPI(
      request("/api/voice/sessions", { sdp: "offer", history }),
      fetcher,
    );
    expect(
      JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).session.input,
    ).toEqual(history);
  });
  it("preserves allowlisted failure reasons and numeric usage without private provider content", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "context_length_exceeded",
            message: "private prompt and key",
            param: "private source",
          },
          usage: {
            input_tokens: 100,
            output_tokens: 8,
            input_tokens_details: {
              cached_tokens: 20,
              cache_write_tokens: 10,
              private: "secret",
            },
            private: "secret",
          },
          output: [{ text: "private source" }],
        },
        { status: 400 },
      ),
    );
    const result = await handleAPI(
      request("/api/ai/responses", { model: "gpt-6.1-sol", input: [] }),
      fetcher,
    );
    const body = await result.json();
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.usage).toEqual({
      input_tokens: 100,
      output_tokens: 8,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    });
    expect(JSON.stringify(body)).not.toMatch(/private|secret/);
  });
  it("does not reflect unrecognized error codes or invalid usage counts", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: { code: "private-secret", message: "private" },
          usage: { input_tokens: -1, output_tokens: 8 },
        },
        { status: 400 },
      ),
    );
    const body = await (
      await handleAPI(
        request("/api/ai/decisions", {
          model: "gpt-6-luna",
          input: "",
          questions: [{ type: "predicate", name: "x", instructions: "" }],
        }),
        fetcher,
      )
    ).json();
    expect(body.error.code).toBeUndefined();
    expect(body.usage).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private");
  });
});

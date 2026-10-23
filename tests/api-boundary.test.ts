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
});

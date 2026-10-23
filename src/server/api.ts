/** Same-origin, bring-your-own-key API boundary. No platform credential is shared. */
export async function handleAPI(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const reply = (status: number, error: string) =>
    Response.json(
      { error },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (request.method !== "POST")
    return reply(405, "This action needs a POST request.");
  if (request.headers.get("origin") !== url.origin)
    return reply(403, "Unexpected request origin.");
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [^\s]{8,}$/.test(authorization))
    return reply(401, "Add an OpenAI API key in Settings to continue.");
  if (!request.headers.get("content-type")?.includes("application/json"))
    return reply(415, "A JSON request is required.");
  let bodyText: string;
  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    bodyText = "";
    if (reader)
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256_000) {
            await reader.cancel();
            return reply(
              413,
              "This request is too large. Try a smaller change.",
            );
          }
          bodyText += decoder.decode(value, { stream: true });
        }
        bodyText += decoder.decode();
      } finally {
        reader.releaseLock();
      }
  } catch {
    return reply(400, "The request was interrupted. Please try again.");
  }
  let input: Record<string, any>;
  try {
    input = JSON.parse(bodyText);
  } catch {
    return reply(400, "The request was incomplete. Please try again.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return reply(400, "Invalid request.");
  let endpoint: string;
  let body: Record<string, unknown>;
  if (url.pathname === "/api/ai/responses") {
    if (typeof input.model !== "string" || !Array.isArray(input.input))
      return reply(400, "Choose an AI model in Settings.");
    endpoint = "https://api.openai.com/v1/responses";
    body = { ...input, store: false, stream: true };
  } else if (url.pathname === "/api/voice/sessions") {
    if (
      typeof input.sdp !== "string" ||
      input.sdp.length > 65536 ||
      !input.sdp.trim()
    )
      return reply(
        400,
        "The microphone connection was incomplete. Please try again.",
      );
    const history = Array.isArray(input.history)
      ? input.history
          .filter(
            (item: any) =>
              item &&
              ["user", "assistant"].includes(item.role) &&
              typeof item.content === "string",
          )
          .slice(-12)
          .map((item: any) => ({
            role: item.role,
            content: item.content.slice(0, 3000),
          }))
      : [];
    endpoint = "https://api.openai.com/v1/live/sessions";
    body = {
      session: {
        model: "gpt-live-1",
        store: false,
        instructions: `You are the voice companion for It's Alive, an application for ordinary people. Be warm and concise. Delegate every request to create, change, repair, or inspect an application, and every question about its actual state, to the backend. Keep the conversation going while it works. The backend handles permissions and changes. Do not claim work is complete until its result confirms it. Treat interruptions as conversation, not automatic cancellation. Never expose code, tools, agents, model tiers, or internal machinery. ${input.spokenReplies === false ? "The user reads your replies as text with playback muted. Keep replies short and clear." : "Use natural spoken replies."}`,
        input: history,
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: input.sdp },
    };
  } else return reply(404, "Unknown action.");
  try {
    const result = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    // Error bodies may contain user content. Preserve only safe metadata.
    if (!result.ok)
      return Response.json(
        {
          error:
            result.status === 401
              ? "The OpenAI API key was not accepted. Check it in Settings."
              : result.status === 403
                ? "Your OpenAI account cannot use this model or speed."
                : result.status === 429
                  ? "OpenAI usage limits were reached. Check your allowance or try again shortly."
                  : "OpenAI could not complete this request. Download diagnostic logs in Settings for details.",
        },
        {
          status: result.status,
          headers: {
            "Cache-Control": "no-store",
            "X-Request-Id": result.headers.get("x-request-id") ?? "",
          },
        },
      );
    return new Response(result.body, {
      status: result.status,
      headers: {
        "Content-Type":
          result.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
        "X-Request-Id": result.headers.get("x-request-id") ?? "",
      },
    });
  } catch {
    return reply(
      502,
      "Could not reach OpenAI. Please check your connection and try again.",
    );
  }
}

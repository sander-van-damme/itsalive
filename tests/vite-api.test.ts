import { createServer, request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { apiPlugin } from "../src/server/vite-api";

afterEach(() => vi.unstubAllGlobals());

async function server() {
  let middleware: any;
  (apiPlugin().configureServer as Function)({
    middlewares: {
      use(handler: unknown) {
        middleware = handler;
      },
    },
  });
  const instance = createServer((request, response) => {
    void middleware(request, response, () => response.writeHead(404).end());
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  const address = instance.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  return { instance, origin: `http://127.0.0.1:${address.port}` };
}

it("rejects an untrusted origin before waiting for its unfinished request body", async () => {
  const { instance, origin } = await server();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/ai/responses`,
        {
          method: "POST",
          headers: {
            origin: "https://untrusted.test",
            "content-type": "application/json",
            "content-length": "1000000",
          },
        },
        (response) => {
          resolve(response.statusCode!);
          response.resume();
          request.destroy();
        },
      );
      request.on("error", reject);
      request.flushHeaders(); // Deliberately never finish the body.
    });
    expect(status).toBe(403);
  } finally {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
});

it("forwards authenticated model context beyond the old middleware ceiling", async () => {
  const { instance, origin } = await server();
  const body = JSON.stringify({
    model: "gpt-6.1-sol",
    input: [{ role: "user", content: "a".repeat(350_000) }],
  });
  const upstream = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).input[0].content).toHaveLength(
      350_000,
    );
    return Response.json({ status: "completed", output: [] });
  });
  vi.stubGlobal("fetch", upstream);
  try {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${origin}/api/ai/responses`,
          {
            method: "POST",
            headers: {
              origin,
              authorization: "Bearer fixture-credential",
              "content-type": "application/json",
            },
          },
          (response) => {
            let received = "";
            response.on("data", (chunk) => {
              received += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode!, body: received }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      },
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).status).toBe("completed");
    expect(upstream).toHaveBeenCalledOnce();
  } finally {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
});

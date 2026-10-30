import type { Plugin } from "vite";
import { once } from "node:events";
import { Readable } from "node:stream";
import { handleAPI } from "./api";
import { buildInfo } from "../../build-info";
export function apiPlugin(): Plugin {
  const serverBuild = buildInfo();
  return {
    name: "itsalive-api",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        if (!incoming.url?.startsWith("/api/")) return next();
        try {
          const controller = new AbortController();
          outgoing.on("close", () => {
            if (!outgoing.writableEnded) controller.abort();
          });
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (typeof value === "string") headers.set(key, value);
          // Forward a stream so handleAPI authenticates the origin and key before
          // reading the body. Do not buffer unauthenticated input in middleware.
          const init: RequestInit & { duplex: "half" } = {
            method: incoming.method,
            headers,
            ...(!["GET", "HEAD"].includes(incoming.method ?? "GET")
              ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array> }
              : {}),
            signal: controller.signal,
            duplex: "half",
          };
          const request = new Request(
            `http://${incoming.headers.host}${incoming.url}`,
            init,
          );
          const result =
            new URL(request.url).pathname === "/api/build" &&
            request.method === "GET"
              ? Response.json(
                  { ...serverBuild, deployment: null },
                  { headers: { "Cache-Control": "no-store" } },
                )
              : await handleAPI(request, fetch, {
                  chatgptClientId: process.env.CHATGPT_CLIENT_ID,
                });
          outgoing.statusCode = result.status;
          result.headers.forEach((value, key) =>
            outgoing.setHeader(key, value),
          );
          if (result.body) {
            const reader = result.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!outgoing.write(value))
                  await once(outgoing, "drain", { signal: controller.signal });
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          outgoing.end();
        } catch {
          if (!outgoing.headersSent) outgoing.statusCode = 500;
          outgoing.end();
        }
      });
    },
  };
}

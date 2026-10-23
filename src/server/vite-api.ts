import type { Plugin } from "vite";
import { handleAPI } from "./api";
export function apiPlugin(): Plugin {
  return {
    name: "itsalive-api",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        if (!incoming.url?.startsWith("/api/")) return next();
        try {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const chunk of incoming) {
            size += chunk.length;
            if (size > 256_000) {
              outgoing.statusCode = 413;
              outgoing.end("Request too large");
              return;
            }
            parts.push(chunk);
          }
          const controller = new AbortController();
          outgoing.on("close", () => {
            if (!outgoing.writableEnded) controller.abort();
          });
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (typeof value === "string") headers.set(key, value);
          const request = new Request(
            `http://${incoming.headers.host}${incoming.url}`,
            {
              method: incoming.method,
              headers,
              ...(parts.length ? { body: Buffer.concat(parts) } : {}),
              signal: controller.signal,
            },
          );
          const result = await handleAPI(request);
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
                outgoing.write(value);
              }
            } finally {
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

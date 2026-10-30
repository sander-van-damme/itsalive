import { handleAPI } from "./api";
import { BUILD_INFO } from "../shared/build";
interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CHATGPT_CLIENT_ID?: string;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/build" && request.method === "GET")
      return Response.json(
        {
          ...BUILD_INFO,
          deployment: env.CF_VERSION_METADATA
            ? {
                id: env.CF_VERSION_METADATA.id ?? "unknown",
                tag: env.CF_VERSION_METADATA.tag ?? "unknown",
                timestamp: env.CF_VERSION_METADATA.timestamp ?? "unknown",
              }
            : null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    return path.startsWith("/api/")
      ? handleAPI(request, fetch, { chatgptClientId: env.CHATGPT_CLIENT_ID })
      : env.ASSETS.fetch(request);
  },
};

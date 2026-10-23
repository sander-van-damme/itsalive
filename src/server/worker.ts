import { handleAPI } from "./api";
interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    return new URL(request.url).pathname.startsWith("/api/")
      ? handleAPI(request)
      : env.ASSETS.fetch(request);
  },
};

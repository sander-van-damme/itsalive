/** Shared by every project on the shell origin; app origins never download package code. */
export const DEPENDENCY_CACHE_NAME = "itsalive-dependencies-v2";
export interface CacheStats {
  networkRequests: number;
  cacheHits: number;
  bytesDownloaded: number;
}
export class DependencyCache {
  readonly stats: CacheStats = {
    networkRequests: 0,
    cacheHits: 0,
    bytesDownloaded: 0,
  };
  private memory = new Map<string, Uint8Array>();
  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  async read(url: string): Promise<Uint8Array> {
    const memory = this.memory.get(url);
    if (memory) {
      this.stats.cacheHits++;
      return memory;
    }
    const cache =
      typeof caches !== "undefined"
        ? await caches.open(DEPENDENCY_CACHE_NAME)
        : null;
    const stored = await cache?.match(url);
    if (stored) {
      const bytes = new Uint8Array(await stored.arrayBuffer());
      this.remember(url, bytes);
      this.stats.cacheHits++;
      return bytes;
    }
    const response = await this.fetcher(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
    this.stats.networkRequests++;
    if (!response.ok)
      throw new Error(
        `Dependency download failed (${response.status}): ${url}`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new Error(`Dependency exceeds the 8 MiB resource limit: ${url}`);
    this.stats.bytesDownloaded += bytes.byteLength;
    await cache?.put(url, new Response(bytes.slice().buffer));
    this.remember(url, bytes);
    return bytes;
  }
  private remember(url: string, bytes: Uint8Array): void {
    this.memory.set(url, bytes);
    let size = [...this.memory.values()].reduce(
      (total, item) => total + item.byteLength,
      0,
    );
    while (this.memory.size > 256 || size > 48 * 1024 * 1024) {
      const oldest = this.memory.keys().next().value!;
      size -= this.memory.get(oldest)!.byteLength;
      this.memory.delete(oldest);
    }
  }
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(hash)))}`;
}
export function dataUrl(bytes: Uint8Array, mime: string): string {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 8192)
    encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(encoded)}`;
}

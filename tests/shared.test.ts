import { describe, expect, it } from "vitest";
import {
  ROOT_DOMAIN,
  appOrigin,
  appSlugFromUrl,
  createBridgeMessage,
  createRequestId,
  isAppToShellMessage,
  isBridgeMessage,
  isExpectedAppOrigin,
  isShellToAppMessage,
  isValidAppSlug,
  isValidId,
  normalizeAppSlug,
  parseRootDomain,
  safeStringify,
  serializeError,
  toBoundedClone,
  truncateText,
  validateMessageEvent,
} from "../src/shared";

describe("domain helpers", () => {
  it("uses the canonical itsalive.org root domain", () => {
    expect(ROOT_DOMAIN).toBe("itsalive.org");
  });

  it("normalizes valid DNS labels and rejects invalid labels", () => {
    expect(normalizeAppSlug("  My-App  ")).toBe("my-app");
    expect(isValidAppSlug("my-app-2")).toBe(true);
    for (const invalid of ["", "two.parts", "-start", "end-", "white space", "a".repeat(64)]) {
      expect(isValidAppSlug(invalid)).toBe(false);
      expect(() => normalizeAppSlug(invalid)).toThrow();
    }
  });

  it("constructs exact root and immediate app origins including development ports", () => {
    expect(parseRootDomain("example.com").origin).toBe("https://example.com");
    expect(parseRootDomain("http://localhost:5173").origin).toBe("http://localhost:5173");
    expect(appOrigin("Violin", "https://Example.COM:8443")).toBe("https://violin.example.com:8443");
    expect(appSlugFromUrl("https://violin.example.com/path", "example.com")).toBe("violin");
    expect(appSlugFromUrl("https://nested.violin.example.com", "example.com")).toBeNull();
    expect(appSlugFromUrl("https://evil-example.com", "example.com")).toBeNull();
    expect(isExpectedAppOrigin("https://violin.example.com", "violin", "example.com")).toBe(true);
    expect(isExpectedAppOrigin("https://evil.example.com", "violin", "example.com")).toBe(false);
  });
});

describe("bridge protocol", () => {
  it("builds and recognizes messages by direction", () => {
    const requestId = createRequestId();
    expect(isValidId(requestId)).toBe(true);
    const execute = createBridgeMessage("violin", requestId, { type: "execute", code: "return 1" });
    const result = createBridgeMessage("violin", requestId, { type: "result", result: 1 });
    expect(isBridgeMessage(execute)).toBe(true);
    expect(isShellToAppMessage(execute)).toBe(true);
    expect(isAppToShellMessage(execute)).toBe(false);
    expect(isAppToShellMessage(result)).toBe(true);
  });

  it("rejects malformed, unknown, and mismatched messages", () => {
    const valid = createBridgeMessage("math", "req_1234", { type: "execute", code: "return 2" });
    expect(isBridgeMessage({ ...valid, type: "unknown" })).toBe(false);
    expect(isBridgeMessage({ ...valid, appSlug: "not.valid" })).toBe(false);
    expect(isBridgeMessage({ ...valid, requestId: "?" })).toBe(false);
    expect(isBridgeMessage({ ...valid, code: 42 })).toBe(false);
  });

  it("supports validated shell-to-app cron callback delivery", () => {
    const fire = createBridgeMessage("math", "req_cron123", { type: "cron.fire", callbackId: "daily-review" });
    expect(isShellToAppMessage(fire)).toBe(true);
    expect(isAppToShellMessage(fire)).toBe(false);
    expect(isBridgeMessage({ ...fire, callbackId: "" })).toBe(false);
    expect(isBridgeMessage({ ...fire, callbackId: 42 })).toBe(false);
  });

  it("validates the complete MessageEvent trust boundary", () => {
    const data = createBridgeMessage("math", "req_1234", { type: "result", result: 2 });
    const source = {} as MessageEventSource;
    const event = { data, origin: "https://math.example.com", source } as MessageEvent<unknown>;
    expect(validateMessageEvent(event, {
      expectedOrigin: "https://math.example.com/path",
      expectedAppSlug: "math",
      expectedSource: source,
      direction: "to-shell",
    })).toEqual(data);
    expect(validateMessageEvent({ ...event, origin: "https://evil.example" } as MessageEvent, {
      expectedOrigin: "https://math.example.com", expectedAppSlug: "math", expectedSource: source,
      direction: "to-shell",
    })).toBeNull();
  });
});

describe("bounded serialization", () => {
  it("serializes cycles, bigint, functions, symbols and errors without throwing", () => {
    const value: Record<string, unknown> = { count: 12n, fn() {}, symbol: Symbol("x"), error: new Error("nope") };
    value.self = value;
    const text = safeStringify(value);
    expect(text).toContain("12n");
    expect(text).toContain("[Circular]");
    expect(text).toContain("nope");
    expect(toBoundedClone(value)).toMatchObject({ count: "12n", self: "[Circular]" });
  });

  it("bounds text and error fields", () => {
    expect(truncateText("abcdef", 5)).toHaveLength(5);
    const serialized = serializeError(new Error("x".repeat(100)), 20);
    expect(serialized.message.length).toBeLessThanOrEqual(20);
    expect(serialized.name).toBe("Error");
  });
});

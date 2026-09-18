import { describe, expect, it } from "vitest";
import {
  ROOT_DOMAIN,
  appOrigin,
  appIdFromUrl,
  createBridgeMessage,
  createRequestId,
  isAppToShellMessage,
  isBridgeMessage,
  isExpectedAppOrigin,
  isShellToAppMessage,
  isValidAppId,
  isValidId,
  normalizeAppId,
  parseRootDomain,
  safeStringify,
  serializeError,
  toBoundedClone,
  truncateText,
  validateMessageEvent,
} from "../src/shared";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("domain helpers", () => {
  it("uses the canonical itsalive.org root domain", () => {
    expect(ROOT_DOMAIN).toBe("itsalive.org");
  });

  it("normalizes valid DNS labels and rejects invalid labels", () => {
    expect(normalizeAppId(`  ${APP_ID.toUpperCase()}  `)).toBe(APP_ID);
    expect(isValidAppId(APP_ID)).toBe(true);
    for (const invalid of ["", "two.parts", "-start", "end-", "white space", "a".repeat(64)]) {
      expect(isValidAppId(invalid)).toBe(false);
      expect(() => normalizeAppId(invalid)).toThrow();
    }
  });

  it("constructs exact root and immediate app origins including development ports", () => {
    expect(parseRootDomain("example.com").origin).toBe("https://example.com");
    expect(parseRootDomain("http://localhost:5173").origin).toBe("http://localhost:5173");
    expect(appOrigin(APP_ID, "https://Example.COM:8443")).toBe(`https://${APP_ID}.example.com:8443`);
    expect(appIdFromUrl(`https://${APP_ID}.example.com/path`, "example.com")).toBe(APP_ID);
    expect(appIdFromUrl(`https://nested.${APP_ID}.example.com`, "example.com")).toBeNull();
    expect(appIdFromUrl("https://evil-example.com", "example.com")).toBeNull();
    expect(isExpectedAppOrigin(`https://${APP_ID}.example.com`, APP_ID, "example.com")).toBe(true);
    expect(isExpectedAppOrigin("https://evil.example.com", APP_ID, "example.com")).toBe(false);
  });
});

describe("bridge protocol", () => {
  it("builds and recognizes messages by direction", () => {
    const requestId = createRequestId();
    expect(isValidId(requestId)).toBe(true);
    const execute = createBridgeMessage(APP_ID, requestId, { type: "execute", code: "return 1" });
    const result = createBridgeMessage(APP_ID, requestId, { type: "result", result: 1 });
    expect(isBridgeMessage(execute)).toBe(true);
    expect(isShellToAppMessage(execute)).toBe(true);
    expect(isAppToShellMessage(execute)).toBe(false);
    expect(isAppToShellMessage(result)).toBe(true);
  });

  it("uses the LLM request and response protocol without legacy AI message aliases", () => {
    const request = createBridgeMessage(APP_ID, "req_llm123", { type: "llm.request", prompt: "compose" });
    const response = createBridgeMessage(APP_ID, "req_llm123", { type: "llm.response", result: "done" });
    expect(isAppToShellMessage(request)).toBe(true);
    expect(isShellToAppMessage(response)).toBe(true);
    expect(isBridgeMessage({ ...request, type: "ai.request" })).toBe(false);
    expect(isBridgeMessage({ ...response, type: "ai.response" })).toBe(false);
  });

  it("rejects malformed, unknown, and mismatched messages", () => {
    const valid = createBridgeMessage(APP_ID, "req_1234", { type: "execute", code: "return 2" });
    expect(isBridgeMessage({ ...valid, type: "unknown" })).toBe(false);
    expect(isBridgeMessage({ ...valid, appId: "not.valid" })).toBe(false);
    expect(isBridgeMessage({ ...valid, requestId: "?" })).toBe(false);
    expect(isBridgeMessage({ ...valid, code: 42 })).toBe(false);
  });

  it("supports validated shell-to-app cron callback delivery", () => {
    const fire = createBridgeMessage(APP_ID, "req_cron123", { type: "cron.fire", callbackId: "daily-review" });
    expect(isShellToAppMessage(fire)).toBe(true);
    expect(isAppToShellMessage(fire)).toBe(false);
    expect(isBridgeMessage({ ...fire, callbackId: "" })).toBe(false);
    expect(isBridgeMessage({ ...fire, callbackId: 42 })).toBe(false);
  });

  it("validates the complete MessageEvent trust boundary", () => {
    const data = createBridgeMessage(APP_ID, "req_1234", { type: "result", result: 2 });
    const source = {} as MessageEventSource;
    const event = { data, origin: `https://${APP_ID}.example.com`, source } as MessageEvent<unknown>;
    expect(validateMessageEvent(event, {
      expectedOrigin: `https://${APP_ID}.example.com/path`,
      expectedAppId: APP_ID,
      expectedSource: source,
      direction: "to-shell",
    })).toEqual(data);
    expect(validateMessageEvent({ ...event, origin: "https://evil.example" } as MessageEvent, {
      expectedOrigin: `https://${APP_ID}.example.com`, expectedAppId: APP_ID, expectedSource: source,
      direction: "to-shell",
    })).toBeNull();
    const staleSource = {} as MessageEventSource;
    expect(validateMessageEvent({ ...event, source: staleSource } as MessageEvent, {
      expectedOrigin: `https://${APP_ID}.example.com`, expectedAppId: APP_ID, expectedSource: source,
      direction: "to-shell",
    })).toBeNull();
    expect(validateMessageEvent({ ...event, data: { ...data, appId: "old-app" } } as MessageEvent, {
      expectedOrigin: `https://${APP_ID}.example.com`, expectedAppId: APP_ID, expectedSource: source,
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

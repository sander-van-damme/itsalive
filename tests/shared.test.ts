import { describe, expect, it } from "vitest";
import {
  ROOT_DOMAIN,
  appIdFromShellUrl,
  appOrigin,
  shellUrlForApp,
  BRIDGE_VERSION,
  MAX_SEMANTIC_DOCUMENT_CHARACTERS,
  createBridgeMessage,
  createRequestId,
  isAppToShellMessage,
  isBridgeMessage,
  isShellToAppMessage,
  isValidAppId,
  isValidId,
  normalizeAppId,
  parseRootDomain,
  safeStringify,
  serializeError,
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
  });

  it("uses the URL fragment as the canonical client-side app route", () => {
    const canonical = shellUrlForApp("https://itsalive.org/?app=legacy&mode=full", APP_ID);
    expect(canonical.href).toBe(`https://itsalive.org/?mode=full#app=${APP_ID}`);
    expect(appIdFromShellUrl(canonical)).toBe(APP_ID);
    expect(appIdFromShellUrl(`https://itsalive.org/?app=${APP_ID}`)).toBe(APP_ID);
    expect(appIdFromShellUrl(`https://itsalive.org/?app=legacy#app=${APP_ID}`)).toBe(APP_ID);
  });
});

describe("bridge protocol", () => {
  it("uses bridge version 4 and recognizes messages by direction", () => {
    expect(BRIDGE_VERSION).toBe(4);
    const requestId = createRequestId();
    expect(isValidId(requestId)).toBe(true);
    const execute = createBridgeMessage(APP_ID, requestId, { type: "execute", code: "return 1" });
    const result = createBridgeMessage(APP_ID, requestId, { type: "result", result: 1 });
    expect(isBridgeMessage(execute)).toBe(true);
    expect(isBridgeMessage({ ...execute, version: 2 })).toBe(false);
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
    expect(isBridgeMessage({ ...request, options: { temperature: 1 } })).toBe(false);
  });

  it("rejects unused cron fields and runtime statuses", () => {
    const envelope = { protocol: "itsalive", version: 4, appId: APP_ID, requestId: "req_fields" };
    expect(isBridgeMessage({ ...envelope, type: "cron.register", registration: { callbackId: "daily", schedule: "0 8 * * *", description: "unused" } })).toBe(false);
    for (const status of ["booting", "busy", "saving", "error"]) expect(isBridgeMessage({ ...envelope, type: "status", status })).toBe(false);
    expect(isBridgeMessage({ ...envelope, type: "status", status: "ready" })).toBe(true);
  });

  it("bounds every Jev bridge field and rejects unexpected payload data", () => {
    const envelope = { protocol: "itsalive", version: 4, appId: APP_ID, requestId: "req_jev_bounds", type: "jev.request" };
    const interaction = { seq: 1, at: "2026-01-01T00:00:00Z", type: "click", target: { tag: "button", state: { role: "button" } }, actualTarget: { tag: "button" }, key: "Enter" };
    const valid = { ...envelope, state: { interaction, recentInteractions: [interaction], document: "<main>ok</main>" } };
    expect(isBridgeMessage(valid)).toBe(true);
    const patterned = { ...valid, state: { ...valid.state, pattern: { kind: "repeated-action", actionCount: 5, coalescedCount: 3, durationMs: 320, averageIntervalMs: 80, documentChangeCount: 0, likelyBenign: false, frustrationSignal: true } } };
    expect(isBridgeMessage(patterned)).toBe(true);
    expect(isBridgeMessage({ ...patterned, state: { ...patterned.state, pattern: { ...patterned.state.pattern, coalescedCount: 5 } } })).toBe(false);
    expect(isBridgeMessage({ ...valid, state: { ...valid.state, document: "x".repeat(MAX_SEMANTIC_DOCUMENT_CHARACTERS + 1) } })).toBe(false);
    expect(isBridgeMessage({ ...valid, state: { ...valid.state, interaction: { ...interaction, key: "x".repeat(31) } } })).toBe(false);
    expect(isBridgeMessage({ ...valid, state: { ...valid.state, interaction: { ...interaction, target: { tag: "button", id: "x".repeat(201) } } } })).toBe(false);
    expect(isBridgeMessage({ ...valid, state: { ...valid.state, paidProviderOption: true } })).toBe(false);
  });

  it("rejects removed legacy message types", () => {
    const envelope = createBridgeMessage(APP_ID, "req_legacy", { type: "execute", code: "" });
    for (const type of ["ready.request", "ready", "metadata.request", "metadata", "logs.request", "logs.response", "app.meta.update", "app.meta.response", "screenshot.request", "screenshot"]) {
      expect(isBridgeMessage({ ...envelope, type })).toBe(false);
    }
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
  });

  it("bounds text and error fields", () => {
    expect(truncateText("abcdef", 5)).toHaveLength(5);
    const serialized = serializeError(new Error("x".repeat(100)), 20);
    expect(serialized.message.length).toBeLessThanOrEqual(20);
    expect(serialized.name).toBe("Error");
  });
});

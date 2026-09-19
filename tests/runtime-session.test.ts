// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBootstrapError,
  createBootstrapReady,
  createBridgeMessage,
  isBootstrapInitMessage,
  serializeError,
} from "../src/shared";
import { RuntimeSession } from "../src/shell/core/runtime-session";

const APP_ID = "550e8400-e29b-41d4-a716-446655440004";
const ORIGIN = `https://${APP_ID}.itsalive.org`;
const RUNTIME_SOURCE = "globalThis.__runtimeInjected = true;";

function bootstrap(session: RuntimeSession) {
  const frame = session.frame;
  if (!frame?.contentWindow) throw new Error("frame missing");
  const post = vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(() => undefined);
  window.dispatchEvent(new MessageEvent("message", {
    data: createBootstrapReady(APP_ID),
    origin: ORIGIN,
    source: frame.contentWindow,
  }));
  expect(post).toHaveBeenCalledOnce();
  const [message, targetOrigin, transfer] = post.mock.calls[0]! as unknown as [unknown, string, Transferable[]];
  expect(isBootstrapInitMessage(message)).toBe(true);
  expect(message).toMatchObject({ appId: APP_ID, runtimeSource: RUNTIME_SOURCE });
  expect(targetOrigin).toBe(ORIGIN);
  const port = (transfer as Transferable[])[0] as MessagePort;
  expect(port).toBeTruthy();
  return { frame, post, port };
}

describe("RuntimeSession", () => {
  beforeEach(() => { document.body.innerHTML = '<div id="stage"></div>'; });

  const createSession = (onMessage = vi.fn(), onError = vi.fn()) => ({
    onMessage,
    onError,
    session: new RuntimeSession(
      frame => document.querySelector("#stage")!.replaceChildren(frame),
      onMessage,
      onError,
    ),
  });

  it("accepts exactly one bootstrap from the expected app window and origin", () => {
    const { session } = createSession();
    const frame = session.switchTo(APP_ID, ORIGIN, RUNTIME_SOURCE);
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined);

    window.dispatchEvent(new MessageEvent("message", {
      data: createBootstrapReady(APP_ID),
      origin: "https://evil.example",
      source: frame.contentWindow,
    }));
    expect(post).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      data: createBootstrapReady(APP_ID),
      origin: ORIGIN,
      source: window,
    }));
    expect(post).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      data: createBootstrapReady(APP_ID),
      origin: ORIGIN,
      source: frame.contentWindow,
    }));
    expect(post).toHaveBeenCalledOnce();
    expect(isBootstrapInitMessage(post.mock.calls[0]![0])).toBe(true);

    window.dispatchEvent(new MessageEvent("message", {
      data: createBootstrapReady(APP_ID),
      origin: ORIGIN,
      source: frame.contentWindow,
    }));
    expect(post).toHaveBeenCalledOnce();
  });

  it("uses the transferred MessagePort for runtime messages and execution", async () => {
    const onMessage = vi.fn();
    const { session } = createSession(onMessage);
    session.switchTo(APP_ID, ORIGIN, RUNTIME_SOURCE);
    const { port } = bootstrap(session);

    expect(() => session.requireReady()).toThrow("App runtime is not ready yet");

    port.postMessage(createBridgeMessage(APP_ID, "req_ready", { type: "status", status: "ready" }));
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "status", status: "ready" })));
    session.setState("ready");
    expect(session.requireReady()).toBe(session.executor);

    const received: unknown[] = [];
    port.addEventListener("message", event => received.push(event.data));
    port.start();
    session.post({ type: "reload" }, "req_reload");
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      protocol: "itsalive",
      appId: APP_ID,
      requestId: "req_reload",
      type: "reload",
    })));
  });

  it("surfaces authenticated bootstrap startup errors", () => {
    const { session, onError } = createSession();
    const frame = session.switchTo(APP_ID, ORIGIN, RUNTIME_SOURCE);
    window.dispatchEvent(new MessageEvent("message", {
      data: createBootstrapError(APP_ID, serializeError(new Error("runtime exploded"))),
      origin: ORIGIN,
      source: frame.contentWindow,
    }));

    expect(session.state).toBe("error");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "runtime exploded" }));
  });

  it("intentionally disposes the old iframe and channel when switching apps", () => {
    const { session } = createSession();
    const first = session.switchTo(APP_ID, ORIGIN, RUNTIME_SOURCE);
    bootstrap(session);
    const firstExecutor = session.executor;

    const secondId = "550e8400-e29b-41d4-a716-446655440002";
    const second = session.switchTo(secondId, `https://${secondId}.itsalive.org`, RUNTIME_SOURCE);

    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(firstExecutor).toBeDefined();
    expect(session.executor).toBeUndefined();
    expect(session.appId).toBe(secondId);
    expect(session.state).toBe("loading");
  });
});

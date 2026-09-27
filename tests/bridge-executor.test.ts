import { describe, expect, it, vi } from "vitest";
import { PostMessageExecutor } from "../src/shell/core/bridge-executor";
import { createBridgeMessage, type AppToShellPayload, type BridgeMessage } from "../src/shared";

const appId = "550e8400-e29b-41d4-a716-446655440140";

function fakePort(respond: (message: BridgeMessage) => BridgeMessage<AppToShellPayload>) {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const port = {
    addEventListener: vi.fn((_type: string, callback: EventListener) => {
      listener = callback as unknown as (event: MessageEvent<unknown>) => void;
    }),
    removeEventListener: vi.fn(),
    start: vi.fn(),
    postMessage: vi.fn((message: BridgeMessage) => {
      queueMicrotask(() => listener?.({ data: respond(message) } as MessageEvent<unknown>));
    }),
  };
  return port as unknown as MessagePort;
}

describe("PostMessageExecutor execution observations", () => {
  it("forwards console entries from successful execution responses", async () => {
    const port = fakePort(message => createBridgeMessage(appId, message.requestId, {
      type: "result",
      result: null,
      logs: [{ level: "log", args: ["scope", "<main>Ready</main>"] }],
    }));
    const executor = new PostMessageExecutor(port, appId);
    const result = await executor.execute(appId, "console.log('scope')", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      value: null,
      done: undefined,
      message: undefined,
      logs: [{ level: "log", args: ["scope", "<main>Ready</main>"] }],
    });
  });

  it("forwards console entries alongside execution errors", async () => {
    const port = fakePort(message => createBridgeMessage(appId, message.requestId, {
      type: "execution.error",
      error: { name: "Error", message: "boom" },
      logs: [{ level: "warn", args: ["before failure"] }],
    }));
    const executor = new PostMessageExecutor(port, appId);
    const result = await executor.execute(appId, "throw new Error('boom')", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      error: { name: "Error", message: "boom" },
      logs: [{ level: "warn", args: ["before failure"] }],
    });
  });
});

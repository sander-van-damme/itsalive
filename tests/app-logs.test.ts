// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLogging } from "../src/runtime/logs";

describe("app console logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards debug, grouped console output, structured arguments, and traces to the shell", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "trace").mockImplementation(() => undefined);
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);

    const post = vi.fn();
    const logging = installLogging({ post } as never);

    console.debug("debug message", { nested: "value" });
    console.groupCollapsed("phase one");
    console.info("inside group", { count: 2 });
    console.groupEnd();
    console.trace("trace message");

    logging.destroy();

    const records = post.mock.calls.map(([message]) => message.record);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "debug",
        message: 'debug message {"nested":"value"}',
        details: expect.objectContaining({ args: ["debug message", { nested: "value" }] }),
      }),
      expect.objectContaining({
        level: "info",
        message: 'inside group {"count":2}',
        details: expect.objectContaining({ groups: ["phase one"], args: ["inside group", { count: 2 }] }),
      }),
      expect.objectContaining({
        level: "debug",
        message: "trace message",
        details: expect.objectContaining({ stack: expect.any(String) }),
      }),
    ]));
  });
});

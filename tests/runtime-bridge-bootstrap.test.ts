// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createBridgeMessage, isAppToShellMessage } from "../src/shared";
import { startAppRuntime } from "../src/runtime/runtime";

const APP_ID = "550e8400-e29b-41d4-a716-446655440164";

describe("runtime bridge bootstrap", () => {
  it("completes a fresh-app document request over the real MessageChannel before reporting ready", async () => {
    document.body.innerHTML = '<main data-itsalive-bootstrap>Loading…</main>';
    const channel = new MessageChannel();
    const messages: unknown[] = [];

    channel.port1.addEventListener("message", event => {
      const message = event.data;
      if (!isAppToShellMessage(message) || message.appId !== APP_ID) return;
      messages.push(message);

      if (message.type === "document.request") {
        channel.port1.postMessage(createBridgeMessage(APP_ID, message.requestId, {
          type: "document.response",
        }));
      }
    });
    channel.port1.start();

    const runtime = await startAppRuntime({
      rootOrigin: "https://itsalive.org",
      appId: APP_ID,
      port: channel.port2,
      screenshot: async element => element.tagName,
    });

    try {
      await vi.waitFor(() => {
        expect(messages.some(message =>
          isAppToShellMessage(message) && message.type === "status" && message.status === "ready",
        )).toBe(true);
      });

      const typed = messages.filter(isAppToShellMessage);
      const documentRequestIndex = typed.findIndex(message => message.type === "document.request");
      const readyIndex = typed.findIndex(message => message.type === "status" && message.status === "ready");

      expect(documentRequestIndex).toBeGreaterThanOrEqual(0);
      expect(readyIndex).toBeGreaterThan(documentRequestIndex);
      expect(document.querySelector("[data-itsalive-bootstrap]")).toBeNull();
      expect(document.getElementById("itsalive-root")).not.toBeNull();
    } finally {
      runtime.destroy();
      channel.port1.close();
    }
  });
});

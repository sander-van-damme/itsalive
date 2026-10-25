import { test, expect, type Page } from "@playwright/test";
import { installGoalProvider } from "./fixtures/goal-provider";

async function voiceFixture(page: Page) {
  await page.addInitScript(() => {
    const state = {
      sent: [] as Record<string, any>[],
      muted: false,
      stopped: false,
      nativeCalls: 0,
      emit: (_event: unknown) => {},
    };
    Object.assign(window, { liveFixture: state });
    const track = {
      enabled: true,
      stop: () => {
        state.stopped = true;
      },
    };
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }),
      },
      configurable: true,
    });
    class Peer extends EventTarget {
      iceGatheringState = "complete";
      connectionState = "connected";
      localDescription = { sdp: "fixture-offer" };
      channel = {
        readyState: "open",
        onmessage: null as ((event: { data: string }) => void) | null,
        onclose: null,
        send: (raw: string) => {
          const event = JSON.parse(raw);
          state.sent.push(event);
          if (event.type === "session.close")
            queueMicrotask(() =>
              state.emit({ type: "session.closed", usage: { seconds: 30 } }),
            );
        },
        close: () => {},
      };
      constructor() {
        super();
        state.emit = (event) =>
          this.channel.onmessage?.({ data: JSON.stringify(event) });
      }
      addTrack() {}
      close() {}
      createDataChannel() {
        return this.channel;
      }
      async createOffer() {
        return { type: "offer", sdp: "fixture-offer" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        state.emit({ type: "session.started" });
      }
    }
    class Audio {
      autoplay = false;
      srcObject = null;
      set muted(value: boolean) {
        state.muted = value;
      }
      get muted() {
        return state.muted;
      }
      async play() {}
      pause() {}
    }
    Object.assign(window, {
      RTCPeerConnection: Peer,
      Audio,
      SpeechRecognition: class {
        constructor() {
          state.nativeCalls++;
          throw new Error("Native speech must not run");
        }
      },
    });
  });
  await page.route("**/api/voice/sessions", (route) =>
    route.fulfill({
      json: {
        session: { id: "voice-fixture" },
        transport: { sdp: "fixture-answer" },
      },
    }),
  );
}
const emit = (page: Page, event: Record<string, unknown>) =>
  page.evaluate((event) => (window as any).liveFixture.emit(event), event);
const sent = (page: Page) =>
  page.evaluate(
    () => (window as any).liveFixture.sent as Array<Record<string, any>>,
  );
test("live voice keeps a conversation going during verified app work, supports silent replies and closes media", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await voiceFixture(page);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.locator("#more-options > summary").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .locator("#settings-dialog")
    .getByLabel("OpenAI API key", { exact: true })
    .fill("voice-test-credential");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("#settings-dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Start voice conversation", exact: true })
    .click();
  await expect(page.locator("#voice-status")).toContainText("Listening");
  await page.getByLabel("Spoken replies", { exact: true }).uncheck();
  expect(await page.evaluate(() => (window as any).liveFixture.muted)).toBe(
    true,
  );
  let release!: () => void;
  provider.holdCoding = new Promise<void>((resolve) => {
    release = resolve;
  });
  await emit(page, {
    type: "session.input_transcript.delta",
    delta: "Create a violin practice app.",
    end_ms: 1000,
  });
  await emit(page, {
    type: "session.delegation.created",
    delegation: { id: "create", target: "client" },
    offset_ms: 1000,
  });
  await expect
    .poll(
      () =>
        provider.requests.filter((request) =>
          request.tools?.some((tool) => tool.function.name === "write_file"),
        ).length,
    )
    .toBeGreaterThan(0);
  await emit(page, {
    type: "session.output_transcript.delta",
    delta: "I am working on your app.",
    end_ms: 2000,
  });
  await expect(page.locator("#voice-captions")).toContainText(
    "I am working on your app.",
  );
  await emit(page, {
    type: "session.input_transcript.delta",
    delta: "Why is this chord difficult?",
    end_ms: 3000,
  });
  await emit(page, {
    type: "session.delegation.created",
    delegation: { id: "question", target: "client" },
    offset_ms: 3000,
  });
  await expect
    .poll(async () =>
      (await sent(page)).some((event) => event.delegation_id === "question"),
    )
    .toBe(true);
  expect(
    (await sent(page)).some((event) => event.delegation_id === "create"),
  ).toBe(false);
  // A second requested change waits for the first build, then uses its latest revision.
  await emit(page, {
    type: "session.input_transcript.delta",
    delta: "Add a chord progression exercise.",
    end_ms: 4000,
  });
  await emit(page, {
    type: "session.delegation.created",
    delegation: { id: "second-change", target: "client" },
    offset_ms: 4000,
  });
  await expect(page.locator("#status")).toContainText("queued");
  release();
  provider.holdCoding = undefined;
  await expect(
    page
      .frameLocator('iframe[data-mode="app"]')
      .getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await sent(page)).some(
        (event) => event.delegation_id === "second-change",
      ),
    )
    .toBe(true);
  await page.getByLabel("Spoken replies", { exact: true }).check();
  expect(await page.evaluate(() => (window as any).liveFixture.muted)).toBe(
    false,
  );
  await page
    .getByRole("button", { name: "End conversation", exact: true })
    .click();
  await expect(page.locator("#voice-panel")).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).liveFixture.stopped)).toBe(
    true,
  );
  expect(
    await page.evaluate(() => (window as any).liveFixture.nativeCalls),
  ).toBe(0);
});

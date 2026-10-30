import { test, expect, type Page } from "@playwright/test";
import { installGoalProvider } from "./fixtures/goal-provider";
import { openSettings, openSettingsSection } from "./fixtures/shell-controls";

async function voiceFixture(page: Page) {
  await page.addInitScript(() => {
    const state = {
      sent: [] as Record<string, any>[],
      muted: false,
      stopped: false,
      stopCount: 0,
      nativeCalls: 0,
      holdContext: false,
      microphoneActive: () => false,
      emit: (_event: unknown) => {},
    };
    Object.assign(window, { liveFixture: state });
    const track = {
      enabled: true,
      stop: () => {
        state.stopped = true;
        state.stopCount++;
      },
    };
    state.microphoneActive = () => track.enabled;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => {
          state.stopped = false;
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
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
          if (event.type.endsWith(".append") && !state.holdContext)
            queueMicrotask(() =>
              state.emit({
                type: event.type + "ed",
                client_event_id: event.event_id,
              }),
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
async function readyForVoice(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.locator("#welcome-settings").click();
  await page.locator("#connection-title").click();
  await page.locator("#ai-key").fill("voice-test-credential");
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-dialog")).not.toBeVisible();
  // A local starter exposes workspace conversation controls without AI work.
  await page.evaluate(() => window.__itsalive.createApp("Violin practice"));
  await expect(page.locator("#speak")).toBeVisible();
}
async function saveInstructions(page: Page, instructions: string) {
  const dialog = await openSettings(page);
  await openSettingsSection(dialog, "Your preferences");
  await dialog
    .getByLabel("General instructions", { exact: true })
    .fill(instructions);
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
test("live voice keeps a conversation going during verified app work, supports silent replies and closes media", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await voiceFixture(page);
  await readyForVoice(page);
  await saveInstructions(
    page,
    "Ask one focused question when my goal is unclear.",
  );
  await page.evaluate(() => {
    (window as any).liveFixture.holdContext = true;
  });
  await page
    .getByRole("button", { name: "Start voice conversation", exact: true })
    .click();
  await expect(page.locator("#voice-status")).toContainText("Restoring");
  const initialContext = (await sent(page)).filter(
    (event) => event.type === "session.thinking.append",
  );
  const initialText = initialContext.map((event) => event.content).join("");
  expect(initialText).toContain('"name":"Violin practice"');
  expect(initialText).toContain(
    "Ask one focused question when my goal is unclear.",
  );
  expect(
    await page.evaluate(() => (window as any).liveFixture.microphoneActive()),
  ).toBe(false);
  await page.evaluate(() => {
    (window as any).liveFixture.holdContext = false;
  });
  for (const command of initialContext)
    await emit(page, {
      type: "session.thinking.appended",
      client_event_id: command.event_id,
    });
  await expect(page.locator("#voice-status")).toContainText("Listening");
  expect(
    await page.evaluate(() => (window as any).liveFixture.microphoneActive()),
  ).toBe(true);
  const beforePreferenceChange = (await sent(page)).length;
  await saveInstructions(
    page,
    "Use concise explanations and keep useful musical instructions.",
  );
  await expect
    .poll(async () =>
      (await sent(page))
        .slice(beforePreferenceChange)
        .filter((event) => event.type === "session.thinking.append")
        .map((event) => event.content)
        .join(""),
    )
    .toContain(
      "Use concise explanations and keep useful musical instructions.",
    );
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

test("a rejected live connection releases the microphone, explains recovery and starts a fresh retry", async ({
  page,
  context,
}) => {
  await installGoalProvider(context);
  await voiceFixture(page);
  let attempts = 0;
  await page.route("**/api/voice/sessions", (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? {
            status: 401,
            headers: { "x-request-id": "req-rejected-voice" },
            json: {
              error: {
                code: "invalid_api_key",
                message:
                  "The OpenAI API key was not accepted. Check it in Settings.",
              },
            },
          }
        : {
            status: 201,
            json: {
              session: { id: "retry-session" },
              transport: { sdp: "retry-answer" },
            },
          },
    );
  });
  await readyForVoice(page);
  await page.locator("#speak").click();
  await expect(page.locator("#status")).toContainText(
    "API key was not accepted",
  );
  await expect(page.locator("#voice-panel")).toBeHidden();
  expect(await page.evaluate(() => (window as any).liveFixture.stopCount)).toBe(
    1,
  );
  await expect
    .poll(async () =>
      JSON.stringify(
        await page.evaluate(() => window.__itsalive.diagnostics()),
      ).includes("req-rejected-voice"),
    )
    .toBe(true);
  const diagnostic = await page.evaluate(() => window.__itsalive.diagnostics());
  expect(JSON.stringify(diagnostic)).not.toContain("voice-test-credential");
  await page.locator("#speak").click();
  await expect(page.locator("#voice-status")).toContainText("Listening");
  await emit(page, { type: "session.usage.updated", usage: { seconds: 15 } });
  await page.locator("#voice-stop").click();
  await expect(page.locator("#voice-panel")).toBeHidden();
  expect(await page.evaluate(() => (window as any).liveFixture.stopCount)).toBe(
    2,
  );
  expect(attempts).toBe(2);
});

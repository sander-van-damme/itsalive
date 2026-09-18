import { describe, expect, it, vi } from "vitest";
import { persistNewApp } from "../src/shell/core/app-creation";

describe("persistNewApp", () => {
  it("stores the durable brief and preserves it as the first visible user chat message", async () => {
    const put = vi.fn(async () => "app");
    const add = vi.fn(async () => 1);
    const db = { apps: { put }, history: { add } };
    const app = await persistNewApp(db as never, "550e8400-e29b-41d4-a716-446655440099", "I want an app that teaches me chords, musical chords, and use the violin as the model instrument.", 123);

    expect(app.name).toBe("Chords");
    expect(app.prompt).toContain("teaches me chords");
    expect(put).toHaveBeenCalledWith(app);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      appId: app.id,
      timestamp: 123,
      role: "user",
      kind: "chat",
      content: app.prompt,
    }));
  });
});

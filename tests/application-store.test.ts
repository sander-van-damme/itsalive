import { describe, expect, it, vi } from "vitest";
import { createApplicationStore } from "../src/runtime/application-store";

describe("application store", () => {
  it("restores JSON state and snapshots nested mutations", () => {
    const controller = createApplicationStore();
    controller.restore('{"counter":{"count":4},"tasks":[{"done":false}]}');
    const store = controller.store as Record<string, any>;

    store.counter.count++;
    store.tasks.push({ done: false });
    store.tasks[0].done = true;
    delete store.counter;

    expect(JSON.parse(controller.snapshot())).toEqual({
      tasks: [{ done: true }, { done: false }],
    });
  });

  it("marks nested object and array mutations dirty", () => {
    const controller = createApplicationStore();
    controller.restore('{"profile":{"name":"Ada"},"items":[]}');
    const dirty = vi.fn();
    controller.setOnDirty(dirty);
    const store = controller.store as Record<string, any>;

    store.profile.name = "Grace";
    store.items.push("one");
    store.items[0] = "two";
    delete store.profile.name;

    expect(dirty).toHaveBeenCalled();
  });

  it("schedules a save when state changed before the dirty callback was installed", () => {
    const controller = createApplicationStore();
    (controller.store as Record<string, any>).count = 1;
    const dirty = vi.fn();

    controller.setOnDirty(dirty);

    expect(dirty).toHaveBeenCalledTimes(1);
  });

  it("rejects values that cannot survive JSON-style persistence", () => {
    const controller = createApplicationStore();
    const store = controller.store as Record<string, any>;

    expect(() => { store.fn = () => undefined; }).toThrow(/JSON-like/);
    expect(() => { store.date = new Date(); }).toThrow(/arrays and plain objects/);
    expect(() => { store.nan = Number.NaN; }).toThrow(/finite numbers/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => { store.circular = circular; }).toThrow(/circular/);
  });

  it("rejects malformed persisted roots", () => {
    const controller = createApplicationStore();

    expect(() => controller.restore("not-json")).toThrow(/valid JSON/);
    expect(() => controller.restore("[]")).toThrow(/root must be an object/);
  });
});

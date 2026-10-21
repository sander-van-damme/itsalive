import { describe, expect, it } from "vitest";
import { MessageChannel } from "node:worker_threads";
import {
  appOriginFor,
  bootstrapIdentity,
  isWireMessage,
  PortRPC,
  validBootstrap,
} from "../src/shared/bridge";
import { ModuleGraph } from "../src/runtime/modules";
import type { BuildArtifact } from "../src/shared/types";

const appId = "1408de23-9d93-4b52-99c9-bc2908a6c4ac";
describe("authenticated bootstrap", () => {
  it("pins exact scheme, host, UUID and development port", () => {
    expect(appOriginFor(appId, "https://itsalive.org")).toBe(
      `https://${appId}.itsalive.org`,
    );
    expect(
      bootstrapIdentity({
        hostname: `${appId}.itsalive.localhost`,
        origin: `http://${appId}.itsalive.localhost:4174`,
      })?.rootOrigin,
    ).toBe("http://itsalive.localhost:4173");
    expect(
      bootstrapIdentity({
        hostname: `${appId}.itsalive.org`,
        origin: `http://${appId}.itsalive.org`,
      }),
    ).toBeNull();
    expect(
      bootstrapIdentity({
        hostname: `${appId}.itsalive.org.attacker.test`,
        origin: `https://${appId}.itsalive.org.attacker.test`,
      }),
    ).toBeNull();
    expect(() => appOriginFor(appId, "https://attacker.test")).toThrow(
      "Unrecognized",
    );
    expect(() => appOriginFor("not-an-id", "https://itsalive.org")).toThrow(
      "UUID",
    );
  });
  it("requires the protocol and matching immutable ID in the envelope and initialization", () => {
    const envelope = {
      kind: "itsalive:bootstrap",
      version: 2,
      appId,
      runtime: "start()",
      init: { appId, mode: "app", state: {}, observe: false },
    };
    expect(validBootstrap(envelope, appId)).toBe(true);
    expect(validBootstrap({ ...envelope, version: 1 }, appId)).toBe(false);
    expect(
      validBootstrap(
        { ...envelope, init: { ...envelope.init, appId: "another-id" } },
        appId,
      ),
    ).toBe(false);
    expect(validBootstrap({ ...envelope, runtime: "" }, appId)).toBe(false);
  });
});

describe("dedicated RPC channel", () => {
  it("correlates requests, propagates denied capabilities, and rejects pending calls on close", async () => {
    const channel = new MessageChannel();
    const shell = new PortRPC(
      channel.port1 as unknown as MessagePort,
      (method) => {
        if (method === "echo") return "hello";
        throw new Error("Not authorized");
      },
    );
    const app = new PortRPC(channel.port2 as unknown as MessagePort);
    await expect(app.request("echo")).resolves.toBe("hello");
    await expect(app.request("credentials")).rejects.toThrow("Not authorized");
    app.close();
    shell.close();
    await expect(app.request("echo")).rejects.toThrow("closed");
  });
  it("times out without treating arbitrary messages as responses", async () => {
    const channel = new MessageChannel();
    const app = new PortRPC(channel.port1 as unknown as MessagePort);
    await expect(app.request("missing", null, 20)).rejects.toThrow("timed out");
    app.close();
    channel.port2.close();
    expect(isWireMessage({ v: 1, kind: "response", id: "one" })).toBe(false);
    expect(
      isWireMessage({ v: 2, kind: "request", id: "one", method: {} }),
    ).toBe(false);
  });
  it("captures the port transport before app code can replace its methods", async () => {
    const channel = new MessageChannel();
    const shell = new PortRPC(
      channel.port1 as unknown as MessagePort,
      () => "kept private",
    );
    const app = new PortRPC(channel.port2 as unknown as MessagePort);
    channel.port1.postMessage = () => {
      throw new Error("intercepted");
    };
    channel.port2.postMessage = () => {
      throw new Error("intercepted");
    };
    await expect(app.request("echo")).resolves.toBe("kept private");
    shell.close();
    app.close();
  });
});

describe("hot module graph", () => {
  const artifact = (label: string): BuildArtifact => ({
    entry: "src/App.tsx",
    revisionId: label,
    css: "",
    metrics: {},
    modules: {
      "src/App.tsx": {
        code: 'exports.default = require("src/label.ts").value + require("src/store.ts").value;',
        hash: "unchanged-parent",
      },
      "src/label.ts": {
        code: `exports.value = ${JSON.stringify(label)};`,
        hash: label,
      },
      "src/store.ts": {
        code: "exports.value = { count: 42 };",
        hash: "stable-store",
      },
    },
  });
  it("invalidates changed modules and importers while preserving unrelated module instances", () => {
    const graph = new ModuleGraph(
      artifact("before"),
      {},
      { register() {}, signature() {} },
    );
    expect(graph.load("src/App.tsx").default).toBe("before[object Object]");
    const stable = graph.load("src/store.ts");
    expect(graph.update(artifact("after"))).toBe(2);
    expect(graph.load("src/App.tsx").default).toBe("after[object Object]");
    expect(graph.load("src/store.ts")).toBe(stable);
  });
  it("uses module-scoped refresh IDs and reports absent modules", () => {
    const registrations: string[] = [];
    const graph = new ModuleGraph(
      {
        ...artifact("x"),
        modules: {
          a: { code: '$RefreshReg$(function App(){},"App");', hash: "a" },
        },
      },
      {},
      {
        register(_value, id) {
          registrations.push(id);
        },
        signature() {},
      },
    );
    graph.load("a");
    expect(registrations).toEqual(["a App"]);
    expect(() => graph.load("missing")).toThrow("Module not found");
  });
});

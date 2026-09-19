import {
  RUNTIME_BOOTSTRAP_KEY,
  createBootstrapError,
  isValidAppId,
  serializeError,
} from "../shared";
import { installRuntimeAssets } from "./assets";
import { startAppRuntime } from "./runtime";
import type { RuntimeBootstrapContext } from "./types";

function takeBootstrapContext(): RuntimeBootstrapContext {
  const target = window as unknown as Record<string, unknown>;
  const value = target[RUNTIME_BOOTSTRAP_KEY];
  delete target[RUNTIME_BOOTSTRAP_KEY];

  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Injected runtime bootstrap context is missing");
  const record = value as Record<string, unknown>;
  if (!isValidAppId(record.appId)) throw new Error("Injected runtime app ID is invalid");
  if (typeof record.rootOrigin !== "string" || new URL(record.rootOrigin).origin !== record.rootOrigin) throw new Error("Injected runtime root origin is invalid");
  if (!(record.port instanceof MessagePort)) throw new Error("Injected runtime MessagePort is missing");
  return { appId: record.appId, rootOrigin: record.rootOrigin, port: record.port };
}

const context = takeBootstrapContext();

void (async () => {
  await installRuntimeAssets();
  await startAppRuntime(context);
})().catch(error => {
  try {
    context.port.close();
    window.parent.postMessage(createBootstrapError(context.appId, serializeError(error)), context.rootOrigin);
  } catch {
    // The bootstrap already has a visible fallback for fatal startup failures.
  }
  console.error("Injected app runtime failed to start", error);
});

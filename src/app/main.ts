import {
  ROOT_DOMAIN,
  RUNTIME_BOOTSTRAP_KEY,
  createBootstrapError,
  createBootstrapReady,
  isBootstrapInitMessage,
  isValidAppId,
  rootOrigin,
  serializeError,
  shellUrlForApp,
} from "../shared";

interface RuntimeBootstrapContext {
  appId: string;
  rootOrigin: string;
  port: MessagePort;
}

const root = rootOrigin(ROOT_DOMAIN, location.protocol === "http:" ? "http:" : "https:");
const rootUrl = new URL(root);
const suffix = `.${rootUrl.hostname}`;

function appIdFromLocation(): string {
  const host = location.hostname.toLowerCase();
  if (!host.endsWith(suffix) || host === rootUrl.hostname) throw new Error(`App hostname ${host} is not a subdomain of ${rootUrl.hostname}`);
  const id = host.slice(0, -suffix.length).split(".")[0] ?? "";
  if (!isValidAppId(id)) throw new Error("Unable to determine a valid app UUID from the hostname");
  return id;
}

function showBootstrapError(error: unknown): void {
  const pre = document.createElement("pre");
  pre.textContent = `The app bootstrap could not start.\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  document.body.replaceChildren(pre);
}

try {
  const appId = appIdFromLocation();

  if (window.parent === window) {
    location.replace(shellUrlForApp(`${root}/`, appId).href);
  } else {
    let accepted = false;

    const onMessage = (event: MessageEvent<unknown>) => {
      if (accepted || event.origin !== root || event.source !== window.parent) return;
      if (!isBootstrapInitMessage(event.data) || event.data.appId !== appId) return;
      const port = event.ports[0];
      if (!port || event.ports.length !== 1) {
        window.parent.postMessage(createBootstrapError(appId, serializeError(new Error("Bootstrap init requires exactly one MessagePort"))), root);
        return;
      }

      accepted = true;
      window.removeEventListener("message", onMessage);

      const context: RuntimeBootstrapContext = { appId, rootOrigin: root, port };
      Object.defineProperty(window, RUNTIME_BOOTSTRAP_KEY, {
        value: context,
        writable: false,
        configurable: true,
        enumerable: false,
      });

      try {
        const run = new Function(`"use strict";\n${event.data.runtimeSource}\n//# sourceURL=itsalive-shell-runtime.js`);
        run.call(window);
      } catch (error) {
        delete (window as unknown as Record<string, unknown>)[RUNTIME_BOOTSTRAP_KEY];
        port.close();
        window.parent.postMessage(createBootstrapError(appId, serializeError(error)), root);
        showBootstrapError(error);
      }
    };

    window.addEventListener("message", onMessage);
    window.parent.postMessage(createBootstrapReady(appId), root);
  }
} catch (error) {
  showBootstrapError(error);
}

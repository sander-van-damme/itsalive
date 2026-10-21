import {
  bootstrapIdentity,
  PROTOCOL_VERSION,
  validBootstrap,
} from "../shared/bridge";

// This deployment authenticates the shell and starts its runtime. No application
// source, platform policy, storage or runtime implementation belongs here.
const identity = bootstrapIdentity(window.location);
if (identity && window.parent !== window) {
  const { appId, rootOrigin } = identity;
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.origin !== rootOrigin ||
      event.source !== window.parent ||
      event.ports.length !== 1 ||
      !validBootstrap(event.data, appId)
    )
      return;
    window.removeEventListener("message", receive);
    const start = new Function(
      "port",
      "init",
      `${event.data.runtime}\nreturn __ITSALIVE_RUNTIME__.start(port, init);`,
    );
    start(event.ports[0], event.data.init);
  };
  window.addEventListener("message", receive);
  window.parent.postMessage(
    { kind: "itsalive:ready", version: PROTOCOL_VERSION, appId },
    rootOrigin,
  );
} else {
  document.body.textContent =
    "Open this application from the It’s Alive workspace.";
}

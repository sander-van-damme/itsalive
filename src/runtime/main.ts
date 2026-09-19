import { ROOT_DOMAIN, rootOrigin } from "../shared";
import { redirectStandaloneToShell, startAppRuntime } from "./runtime";

const origin = rootOrigin(ROOT_DOMAIN, location.protocol === "http:" ? "http:" : "https:");

if (!redirectStandaloneToShell(origin)) {
  startAppRuntime({ rootOrigin: origin }).catch(error => {
    console.error("App runtime failed to start", error);
    document.body.replaceChildren(Object.assign(document.createElement("pre"), {
      textContent: `The app runtime could not start.\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    }));
  });
}

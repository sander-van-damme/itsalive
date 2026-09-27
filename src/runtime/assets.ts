interface RuntimeScriptAsset {
  url: string;
  integrity: string;
}

/**
 * Tailwind Browser is the only default third-party generated-app asset.
 *
 * It is intentionally loaded as a pinned external browser runtime instead of being bundled
 * into the shell-delivered runtime source: generated apps add utility classes after build
 * time, so they need Tailwind's in-browser compiler, while keeping it as a separate asset
 * lets the browser cache that compiler independently of the per-shell runtime payload.
 */
export const TAILWIND_BROWSER_ASSET: RuntimeScriptAsset = {
  url: "https://cdnjs.cloudflare.com/ajax/libs/tailwindcss-browser/4.3.3/index.global.min.js",
  integrity: "sha512-hULGJIctuLmo0B/LLdCfni+smSwvSag6ZyCEVnJuX5lDBuxZMhCLZQ3kgN+d0ZP4Uu/VMYDKksb7m+7YpOhwfg==",
};

export const BUILDING_STYLE = `
:is(#itsalive-root[data-itsalive-building], #itsalive-root [data-itsalive-building]) {
  position: relative;
  isolation: isolate;
}
:is(#itsalive-root[data-itsalive-building], #itsalive-root [data-itsalive-building])::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2147483646;
  min-height: 48px;
  background:
    linear-gradient(135deg,
      color-mix(in srgb, Canvas 18%, transparent),
      color-mix(in srgb, CanvasText 4%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, CanvasText 10%, transparent);
  border-radius: inherit;
  pointer-events: none;
}
:is(#itsalive-root [data-itsalive-build-state="queued"])::after {
  opacity: .68;
}
:is(#itsalive-root [data-itsalive-build-state="building"],
    #itsalive-root [data-itsalive-build-state="repairing"],
    #itsalive-root [data-itsalive-build-state="verifying"])::after {
  opacity: .46;
}
:is(#itsalive-root [data-itsalive-build-state="failed"],
    #itsalive-root [data-itsalive-build-state="blocked"])::after {
  opacity: .26;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, CanvasText 24%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  :is(#itsalive-root[data-itsalive-building], #itsalive-root [data-itsalive-building])::after {
    animation: none !important;
    transition: none !important;
  }
}
`

function installBuildingStyle(ownerDocument: Document): void {
  if (ownerDocument.querySelector("style[data-itsalive-runtime-style]")) return;
  const style = ownerDocument.createElement("style");
  style.setAttribute("data-app-runtime", "");
  style.setAttribute("data-itsalive-runtime-style", "");
  style.textContent = BUILDING_STYLE;
  ownerDocument.head.append(style);
}

function loadScript(ownerDocument: Document, asset: RuntimeScriptAsset): Promise<void> {
  if (ownerDocument.querySelector(`script[data-itsalive-runtime-asset="${CSS.escape(asset.url)}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = ownerDocument.createElement("script");
    script.src = asset.url;
    script.integrity = asset.integrity;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.async = false;
    script.setAttribute("data-app-runtime", "");
    script.setAttribute("data-itsalive-runtime-asset", asset.url);
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load runtime script ${asset.url}`)), { once: true });
    ownerDocument.head.append(script);
  });
}

export async function installRuntimeAssets(ownerDocument: Document = document): Promise<void> {
  installBuildingStyle(ownerDocument);
  await loadScript(ownerDocument, TAILWIND_BROWSER_ASSET);
}

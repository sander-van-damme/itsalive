interface RuntimeAsset {
  kind: "script" | "style";
  url: string;
  integrity: string;
}

const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/tailwindcss-browser/4.3.3/index.global.min.js", integrity: "sha512-hULGJIctuLmo0B/LLdCfni+smSwvSag6ZyCEVnJuX5lDBuxZMhCLZQ3kgN+d0ZP4Uu/VMYDKksb7m+7YpOhwfg==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/feather-icons/4.29.2/feather.min.js", integrity: "sha512-zMm7+ZQ8AZr1r3W8Z8lDATkH05QG5Gm2xc6MlsCdBz9l6oE8Y7IXByMgSm/rdRQrhuHt99HAYfMljBOEZ68q5A==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js", integrity: "sha512-WoViKhKD4qI2WruSZqv9+kvM4WfFhUMQCLN4QlDTt5aU56fLQy2gYoxWIqlEnXqJy/+Ac5q/hk1oWfqnMDhwMA==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js", integrity: "sha512-vc58qvvBdrDR4etbxMdlTt4GBQk1qjvyORR2nrsPsFPyrs+/u5c3+1Ct6upOgdZoIl7eq6k3a1UPDSNAQi/32A==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.1/three.min.js", integrity: "sha512-vnmn/Qqn6aG0POAc9mIGzjq0IybrvxJXYDafNvp9JSnDGxeF3pbkSqLvf+YGd5ku63pT7sa/jxHn7/d0mU8+tA==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/marked/18.0.13/lib/marked.umd.min.js", integrity: "sha512-kHavuYjOa82OKvUxD8j04s+kMIH84FmETnuIgj0yFyY9LWU10sXNwU54Iozpewat8VxAzH4aXiwTEZMRrpwfBw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js", integrity: "sha512-HH52omhHpZF6RfVnGiQwYgYm4H/ya2xsZYLl5xJ4+tLfX+rN4+8zF7V/H/KLeicPrKZYi1g6iBmVkk2AhXTGlg==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/mathjs/15.2.0/math.min.js", integrity: "sha512-fXYcvkpBkUf6HH0SGZZT5vkzEnwrABdGem+z4oR5OaOXHHeyIN/Pf47liC6BgEY0rAqG+RR36O9wPzkeLwZjKw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/dayjs/1.11.23/dayjs.min.js", integrity: "sha512-XEVgwGep2YaTBuaL+NyliCBBiKVkMy4Rpa0Camg4MBsd5qfpAf6ZQYwBadQTDGtpEex+hFN9q2yOw0saY7mj/A==" },
  { kind: "style", url: "https://cdnjs.cloudflare.com/ajax/libs/Swiper/14.2.0/swiper-bundle.min.css", integrity: "sha512-o7Knr4VAyVWuQ+zWMXH8bbv8zhp2EAQQKSMTiM7S6KjoK5MXagmNbVhUdmojS94zr3cCIERxQyEOoqSdSk2bLA==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/Swiper/14.2.0/swiper-bundle.min.js", integrity: "sha512-nM1ZmLe8KJ0bEkxcoG3D09bO8YvrITjvqMRPqEj14rYoNH/Hdg+ZR3hC+ez1S08A5NxEkRDgyBWVTZZgLQLhaQ==" },
  { kind: "style", url: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css", integrity: "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js", integrity: "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" },
  { kind: "style", url: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.18.6/katex.min.css", integrity: "sha512-hlhL0Hg3cxOco8tCQqGSQJpKClqXth8ioVSeCyXoRBvcWvMJGlKAtgz6McECrKqrzwiTtZf/p8U+LPzShtmgVw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.18.6/katex.min.js", integrity: "sha512-R6ebU8e1iPsUu+8q3BMGd8M7DyKQcB2lVvWSyTC1RK7O3ywVWCbHDr4a9C10w3HNbYvhxiRtIwjE5w3hPRwzRw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.15.0/gsap.min.js", integrity: "sha512-oJ8QbaQThQoJZ7oEv+29jfPM6CcP+zUxh3PKJs1vyOhx0UraUrE7PQgeItu3dOuCJyrzWpoYMsVjkkPEBzbUqw==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.7.0/papaparse.min.js", integrity: "sha512-wyNDcNr/iqpMDH6ud/BVoy2SoWXnBZ6Bnq3kZa5XXYq7HZ4l8/ECCZkauMv5HDScNBYSl99P1fkiNOo74zig1Q==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/fuzzysort/4.0.2/fuzzysort.min.js", integrity: "sha512-9gCOJwnw2LcnouMQPX7EfUvl7czCbYjqZxnpsZ4lOeg4pTzuXwR0Cvbbl5V458murSo8SROgpe8mG43fCNJ0/A==" },
  { kind: "style", url: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/styles/github.min.css", integrity: "sha512-0aPQyyeZrWj9sCA46UlmWgKOP0mUipLQ6OZXu8l4IcAmD2u31EPEy9VcIMvl7SoAaKe8bLXZhYoMaE/in+gcgA==" },
  { kind: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js", integrity: "sha512-gzqHAlI1hVdzJ4wiQj/MkppDr6zgEdCoBsrXKRidcaZsSPvNQ3Fy5p7PpMt/8mltxTxMHj1Ur5NWbJdqIfpxgA==" },
] as const;

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

function loadStyle(ownerDocument: Document, asset: RuntimeAsset): Promise<void> {
  if (ownerDocument.querySelector(`link[data-itsalive-runtime-asset="${CSS.escape(asset.url)}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = ownerDocument.createElement("link");
    link.rel = "stylesheet";
    link.href = asset.url;
    link.integrity = asset.integrity;
    link.crossOrigin = "anonymous";
    link.referrerPolicy = "no-referrer";
    link.setAttribute("data-app-runtime", "");
    link.setAttribute("data-itsalive-runtime-asset", asset.url);
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error(`Failed to load runtime stylesheet ${asset.url}`)), { once: true });
    ownerDocument.head.append(link);
  });
}

function loadScript(ownerDocument: Document, asset: RuntimeAsset): Promise<void> {
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
  const styles = RUNTIME_ASSETS.filter(asset => asset.kind === "style");
  await Promise.all(styles.map(asset => loadStyle(ownerDocument, asset)));
  for (const asset of RUNTIME_ASSETS) {
    if (asset.kind === "script") await loadScript(ownerDocument, asset);
  }
}

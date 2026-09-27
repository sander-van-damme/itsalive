# Generated-app runtime assets

The default generated-app environment intentionally contains only:

- standard browser DOM/Web APIs;
- It's Alive's injected `application` and `agent` APIs;
- Tailwind Browser 4.3.3;
- small platform-owned runtime styles such as build-state treatment.

No icon, charting, visualization, markdown, diagram, math, date, carousel, map,
animation, CSV, fuzzy-search, or syntax-highlighting library is preloaded.

## Why Tailwind remains external

Generated applications can introduce new utility classes after the shell build has
already completed, so a normal build-time Tailwind scan cannot cover the generated
markup. Tailwind Browser provides the required in-browser compilation model.

The package is also published as `@tailwindcss/browser`, so local npm bundling is
technically possible. The runtime architecture, however, bundles `src/runtime/main.ts`
into the shell-owned `runtimeSource` string that is transferred into each app frame.
Bundling the browser compiler there would make that compiler part of the transferred
runtime payload instead of a separately cacheable asset. The current pinned CDN asset
therefore stays the smaller architectural choice for now.

Tailwind's own documentation describes the browser/Play CDN path as intended for
development rather than production. It's Alive is deliberately using the browser
compiler because generated class names are not knowable at shell build time; this
tradeoff should be revisited if the generated-app styling architecture changes.

## Adding dependencies later

Generated apps otherwise have normal browser capabilities and may load a resource when
a concrete app needs one, subject to browser/runtime security policy. Do not grow the
default preload catalog for speculative convenience. A new default asset needs a current
product-level reason to be present in every app.

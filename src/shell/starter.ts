import type { Project } from "../shared/types";
import platformTypes from "../runtime/platform.d.ts?raw";
/** A quiet pending document. Goal-specific behavior must come from the AI workflow. */
export function starterProject(name: string, _goal?: string): Project {
  return {
    entry: "src/App.tsx",
    dependencies: {},
    lock: {},
    files: {
      "src/itsalive.d.ts": platformTypes,
      "src/App.tsx": `import React from 'react';
import './styles.css';
export default function App() {
  return <main aria-busy="true"><div className="activity" aria-hidden="true"><i/><i/><i/><i/><i/></div><h1>{${JSON.stringify(name === "New app" ? "Your new app" : name)}}</h1><p role="status">Getting started…</p></main>;
}`,
      "src/styles.css": `:root{color-scheme:light dark;--surface:#fff;--ink:#202b2a;--muted:#586560;--accent:#246b58;--soft:#eaf0eb}html,body,#root{min-height:100%;height:100%}body{margin:0;background:var(--surface);color:var(--ink);font-family:system-ui,sans-serif}main{box-sizing:border-box;min-height:100dvh;width:100%;margin:0 auto;padding:32px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:radial-gradient(ellipse at 48% 46%,var(--soft),transparent 65%)}h1{font-size:clamp(24px,3vw,36px);line-height:1.25;font-weight:580;letter-spacing:-.03em;margin:0 0 12px;overflow-wrap:anywhere}p{font-size:15px;line-height:1.6;color:var(--muted);margin:0}.activity{position:relative;width:160px;height:120px;margin-bottom:30px}.activity i{position:absolute;left:50%;top:50%;width:14px;height:14px;border-radius:50%;background:var(--accent);animation:drift 5s ease-in-out infinite}.activity i:nth-child(1){margin:-20px 0 0 -40px;animation-delay:-.5s;opacity:.3}.activity i:nth-child(2){margin:15px 0 0 -18px;animation-delay:-1.3s;opacity:.8;width:23px;height:23px}.activity i:nth-child(3){margin:-27px 0 0 5px;animation-delay:-2.1s;opacity:.5;width:20px;height:20px}.activity i:nth-child(4){margin:7px 0 0 35px;animation-delay:-3s;opacity:.35}.activity i:nth-child(5){margin:-6px 0 0 -4px;animation-delay:-4s;opacity:.9;width:10px;height:10px}@keyframes drift{0%,100%{transform:translate(0,0) scale(.9)}40%{transform:translate(8px,-11px) scale(1.15)}70%{transform:translate(-7px,6px) scale(1)}}:root[data-shell-theme="dark"]{--surface:#18211e;--ink:#e5ece7;--muted:#afbbb3;--accent:#a4ddbd;--soft:#26362c}@media(prefers-reduced-motion:reduce){.activity i{animation:none}}@media(forced-colors:active){.activity i{background:CanvasText}}button,input,select,textarea{font:inherit}button{min-height:44px;cursor:pointer}`,
    },
  };
}

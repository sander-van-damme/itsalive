import type { Project } from "../shared/types";
import platformTypes from "../runtime/platform.d.ts?raw";
/** A quiet pending document. Goal-specific behavior must come from the AI workflow. */
export function starterProject(name: string, goal?: string): Project {
  return {
    entry: "src/App.tsx",
    dependencies: {},
    lock: {},
    files: {
      "src/itsalive.d.ts": platformTypes,
      "src/App.tsx": `import React from 'react';
import './styles.css';
export default function App() {
  return <main><h1>{${JSON.stringify(name === "New app" ? "Your application" : name)}}</h1><p>{${JSON.stringify(goal || "Your application will appear here.")}}</p><p className="pending-note">Follow its progress in the assistant.</p></main>;
}`,
      "src/styles.css": `html,body,#root{min-height:100%;height:100%}body{margin:0;background:#fff;color:#202723;font-family:system-ui,sans-serif}main{box-sizing:border-box;min-height:100dvh;width:100%;max-width:640px;margin:0 auto;padding:32px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}h1{font-size:24px;line-height:1.3;margin:0 0 12px}p{line-height:1.6;color:#56605a;margin:0;max-width:36ch}.pending-note{font-size:13px;margin-top:18px}button,input,select,textarea{font:inherit}button{min-height:40px;cursor:pointer}`,
    },
  };
}

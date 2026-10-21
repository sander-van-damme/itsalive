import type { Project } from "../shared/types";
import platformTypes from "../runtime/platform.d.ts?raw";
/** A quiet pending document. Goal-specific behavior must come from the AI workflow. */
export function starterProject(name: string): Project {
  return {
    entry: "src/App.tsx",
    dependencies: {},
    lock: {},
    files: {
      "src/itsalive.d.ts": platformTypes,
      "src/App.tsx": `import React from 'react';
import './styles.css';
export default function App() {
  return <main><h1>{${JSON.stringify(name)}}</h1><p>Your application will appear here. Continue with the assistant to get started.</p></main>;
}`,
      "src/styles.css": `body{margin:0;background:#fff;color:#202723;font-family:system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:32px}h1{font-size:24px;line-height:1.3}p{line-height:1.6;color:#56605a}button,input,select,textarea{font:inherit}button{min-height:40px;cursor:pointer}`,
    },
  };
}

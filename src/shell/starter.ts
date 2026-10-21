import type { Project } from "../shared/types";
import platformTypes from "../runtime/platform.d.ts?raw";
export function starterProject(name: string): Project {
  return {
    entry: "src/App.tsx",
    dependencies: {},
    lock: {},
    files: {
      "src/itsalive.d.ts": platformTypes,
      "src/App.tsx": `import React from 'react';
import Counter from './components/Counter';
import { useStore, setState } from '@itsalive/store';
import './styles.css';
export default function App() {
  const saved = useStore(state => Number(state.saved || 0));
  return <main><span className="eyebrow">A LITTLE SPACE FOR YOUR IDEAS</span><h1>${name.replace(/[<>{}&]/g, "")}</h1><p>This is your starting point. Tell the assistant what you would like to make.</p><section><Counter/><button onClick={() => setState({saved:saved+1})}>Saved: {saved}</button></section><small>The first counter keeps its state while you edit. The saved counter survives a reload.</small></main>;
}`,
      "src/components/Counter.tsx": `import React, { useState } from 'react';
export default function Counter() { const [count,setCount] = useState(0); return <button onClick={() => setCount(count+1)}>Count: {count}</button>; }`,
      "src/styles.css": `body{margin:0;background:#fafbf7;color:#253c30;font-family:system-ui,sans-serif}main{max-width:650px;margin:10vh auto;padding:40px}.eyebrow{font-size:11px;letter-spacing:2px;color:#69806b}h1{font-family:Georgia,serif;font-weight:400;font-size:46px;letter-spacing:-1px}p{line-height:1.8;color:#5b6d60}section{display:flex;gap:12px;margin:32px 0}button{border:1px solid #c4d0c2;border-radius:8px;background:#fff;padding:14px 24px;font:inherit;color:inherit;cursor:pointer}button:hover{background:#edf2e9}small{color:#7c877a;line-height:1.8;display:block}`,
    },
  };
}

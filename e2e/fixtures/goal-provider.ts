import type { BrowserContext, Route } from "@playwright/test";

/** Deterministic HTTP replay for acceptance tests, never shipped in the product.
 * It exercises the actual HTTP adapter, intent parser, tools, compiler, candidate
 * checks and runtime. It is not evidence of a real provider connection. */
interface Message {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}
export interface ProviderRequest {
  model?: string;
  reasoning?: { effort: string };
  messages: Message[];
  tools?: { function: { name: string } }[];
  response_format?: { json_schema?: { name: string } };
}
export const VIOLIN_SOURCE = `import React,{useState} from 'react';
import {useStore,setState} from '@itsalive/store';
import './styles.css';
export default function App(){
 const [started,setStarted]=useState(false);
 const [scale,setScale]=useState('D major');
 const completed=useStore(state=>Number(state.completed||0));
 return <main><header><p className="eyebrow">YOUR DAILY PRACTICE</p><h1>Violin practice</h1><p>Build confidence with scales and two-string chords.</p></header>
 <section><h2>Warm up with a scale</h2><label>Scale <select value={scale} onChange={e=>setScale(e.target.value)}><option>D major</option><option>G major</option></select></label><p>{scale==='D major'?'D · E · F♯ · G · A · B · C♯ · D':'G · A · B · C · D · E · F♯ · G'}</p><button onClick={()=>setStarted(true)}>Start practice</button><p role="status">{started?'Play each note slowly, using one bow per note.':'Choose a scale, then start when you are ready.'}</p><button onClick={()=>setState({completed:completed+1})}>Mark practice complete</button><p>Practice sessions: {completed}</p></section>
 <section><h2>Try a two-string chord</h2><p>Play the open D and A strings together gently. Keep the bow balanced across both strings.</p><p>This guide does not listen to or assess your pitch.</p></section></main>;
}`;
export const KNOT_SOURCE = `import React,{useState} from 'react';import './styles.css';
const steps=['Make a loop in the rope.','Pass the working end around the standing rope.','Follow the original path back through the loop.','Dress every strand neatly and have a qualified instructor check the knot.'];
export default function App(){const [step,setStep]=useState(0);return <main><h1>Climbing knot practice</h1><p>Figure-eight follow-through: a practice guide. Learn and verify with a qualified instructor before climbing.</p><section><h2>Step {step+1} of 4</h2><p>{steps[step]}</p><button disabled={step===0} onClick={()=>setStep(step-1)}>Previous step</button><button disabled={step===3} onClick={()=>setStep(step+1)}>Next step</button></section></main>}`;
export const GOAL_CSS = `:root{font-family:system-ui,sans-serif;color:#202a27;background:#fff}body{margin:0}main{max-width:780px;padding:clamp(24px,5vw,64px);margin:auto}h1{font-size:32px;line-height:1.2;margin:10px 0 16px}h2{font-size:21px}p{line-height:1.65;color:#45534e}.eyebrow{font-size:12px;letter-spacing:.09em;color:#486757}section{padding:22px 0;border-top:1px solid #dce4df;margin-top:24px}button,select{font:inherit;border:1px solid #8da097;border-radius:7px;padding:10px 14px;background:#f3f7f4;color:#172c21;cursor:pointer;margin:4px 8px 4px 0}button:focus-visible,select:focus-visible{outline:3px solid #275d41;outline-offset:3px}button:disabled{opacity:.5;cursor:default}label{display:block;font-weight:600}`;

function reply(content: string, tools: { name: string; args: unknown }[] = []) {
  return {
    id: "deterministic-product-acceptance",
    status: "completed",
    output: [
      ...(content
        ? [
            {
              type: "message",
              content: [{ type: "output_text", text: content }],
            },
          ]
        : []),
      ...tools.map((tool, index) => ({
        type: "function_call",
        call_id: `call-${index}-${tool.name}`,
        name: tool.name,
        arguments: JSON.stringify(tool.args),
      })),
    ],
    usage: { input_tokens: 30, output_tokens: 20 },
  };
}
function toolsFor(request: ProviderRequest) {
  const names = new Map(
    request.messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => [call.id, call.function.name]),
  );
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      name: names.get(message.tool_call_id ?? ""),
      value: JSON.parse(message.content) as Record<string, unknown>,
    }));
}
export function goalResponse(request: ProviderRequest): unknown {
  const latest =
    [...request.messages].reverse().find((message) => message.role === "user")
      ?.content ?? "";
  if (request.tools?.some((tool) => tool.function.name === "connection_check"))
    return reply("", [{ name: "connection_check", args: { ready: true } }]);
  if (request.tools?.some((tool) => tool.function.name === "write_file")) {
    const results = toolsFor(request);
    if (!results.some((result) => result.name === "list_files"))
      return reply("", [{ name: "list_files", args: {} }]);
    const read = results.find((result) => result.name === "read_files");
    if (!read)
      return reply("", [
        {
          name: "read_files",
          args: { paths: ["src/App.tsx", "src/styles.css"] },
        },
      ]);
    if (!results.some((result) => result.name === "write_file")) {
      const current =
        (read.value.files as Record<string, string>)?.["src/App.tsx"] ?? "";
      let source = VIOLIN_SOURCE;
      if (/knot|climbing/i.test(latest)) source = KNOT_SOURCE;
      else if (/progression/i.test(latest))
        source = current.replace(
          "</main>",
          "<section><h2>Chord progression</h2><p>Practice D → G → A → D, holding each chord for four slow beats.</p></section></main>",
        );
      else if (/start|click|respond/i.test(latest))
        source = current.replace(
          "onClick={()=>{}}",
          "onClick={()=>setStarted(true)}",
        );
      else if (/repair|fix/i.test(latest))
        source = current.replace(
          "Choose a scale, then start when you are ready.",
          "Choose a scale and press Start practice.",
        );
      else if (/Spoken idea/i.test(latest))
        source = current.replace(/<h1>.*?<\/h1>/, "<h1>Spoken idea</h1>");
      return reply("", [
        { name: "write_file", args: { path: "src/App.tsx", content: source } },
        {
          name: "write_file",
          args: { path: "src/styles.css", content: GOAL_CSS },
        },
      ]);
    }
    const checked = results.find((result) => result.name === "check");
    if (!checked) return reply("", [{ name: "check", args: {} }]);
    if (checked.value.ok !== true)
      throw new Error(
        `Acceptance fixture did not compile: ${JSON.stringify(checked.value)}`,
      );
    return reply("", [{ name: "finish", args: { summary: "Ready to try." } }]);
  }
  const schema = request.response_format?.json_schema?.name;
  if (schema === "connection_check")
    return reply(JSON.stringify({ ready: true }));
  if (schema === "conversation") {
    const question = /^(why|how|what|explain)\b/i.test(latest);
    const dangerous = /delete all/i.test(latest);
    return reply(
      JSON.stringify({
        reply: question
          ? "A two-string chord can feel difficult because the bow must contact both strings evenly. Try a slow bow on the open D and A strings."
          : dangerous
            ? "This would delete your saved practice history. Do you want to continue?"
            : "I’ll help with that.",
        intent: question ? "conversation" : dangerous ? "confirm" : "change",
        changeRequest: question ? null : latest,
        workLevel: /complex/i.test(latest) ? "high" : "medium",
        confirmationReason: dangerous
          ? "This deletes your saved practice history."
          : null,
      }),
    );
  }
  if (schema === "behavior_suggestion")
    return reply(
      JSON.stringify({
        suggest: true,
        explanation: "Would clearer feedback on this control help?",
        changeRequest:
          "Improve feedback on the practice control without changing its purpose.",
      }),
    );
  if (schema === "application_decision")
    return reply(JSON.stringify({ value: true }));
  return reply("OK");
}
export async function installGoalProvider(context: BrowserContext) {
  const requests: ProviderRequest[] = [];
  const control = {
    requests,
    failNext: false,
    holdCoding: undefined as Promise<void> | undefined,
  };
  const handler = async (route: Route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
        },
      });
    const raw = route.request().postDataJSON();
    const request: ProviderRequest = {
      model: raw.model,
      reasoning: raw.reasoning,
      messages: (raw.input ?? []).map((item: any) =>
        item.type === "function_call_output"
          ? { role: "tool", content: item.output, tool_call_id: item.call_id }
          : item.type === "function_call"
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: item.call_id,
                    function: { name: item.name, arguments: item.arguments },
                  },
                ],
              }
            : { role: item.role, content: item.content },
      ),
      tools: raw.tools?.flatMap((tool: any) =>
        (tool.type === "namespace" ? tool.tools : [tool]).map((item: any) => ({
          function: { name: item.name },
        })),
      ),
      response_format: raw.text?.format
        ? { json_schema: { name: raw.text.format.name } }
        : undefined,
    };
    requests.push(request);
    if (
      request.tools?.some((tool) => tool.function.name === "write_file") &&
      control.holdCoding
    )
      await control.holdCoding;
    if (control.failNext) {
      control.failNext = false;
      return route.fulfill({
        status: 401,
        json: { error: { message: "invalid test key" } },
      });
    }
    await route.fulfill({
      status: 200,
      json: goalResponse(request),
      headers: { "access-control-allow-origin": "*" },
    });
  };
  await context.route("**/api/ai/responses", handler);
  await context.route("http://127.0.0.1:1456/responses", handler);
  return control;
}

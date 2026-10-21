import type {
  AIResponse,
  GenerateInput,
  ModelRoute,
  Provider,
  ToolCall,
} from "./types";

const response = (text: string, toolCalls: ToolCall[] = []): AIResponse => ({
  text,
  toolCalls,
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0 },
  requestId: "demo-local",
});
const call = (name: string, args: unknown): ToolCall => ({
  id: crypto.randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
function toolResults(
  input: GenerateInput,
): Array<{ name: string; value: Record<string, unknown> }> {
  const names = new Map(
    input.messages
      .flatMap((message) => message.toolCalls ?? [])
      .map((tool) => [tool.id, tool.name]),
  );
  return input.messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      let value: Record<string, unknown> = {};
      try {
        value = JSON.parse(message.content) as Record<string, unknown>;
      } catch {
        /* treated as no data */
      }
      return { name: names.get(message.toolCallId ?? "") ?? "", value };
    });
}
function demoTitle(intent: string): string {
  const quoted = intent.match(/["“]([^"”]{1,100})["”]/)?.[1];
  const explicit = intent.match(
    /(?:title|heading|name)(?:\s+(?:it|this|the app))?\s+(?:to|as)\s+(.{1,100})/i,
  )?.[1];
  return (quoted ?? explicit ?? "Your living workspace")
    .trim()
    .replace(/[.!]$/, "");
}

/** Deliberately limited local demonstration, not a substitute for an external language model. */
export class DemoProvider implements Provider {
  async generate(
    _route: ModelRoute,
    input: GenerateInput,
    _credential: string,
    signal?: AbortSignal,
  ): Promise<AIResponse> {
    signal?.throwIfAborted();
    if (input.tools?.some((tool) => tool.name === "write_file")) {
      const results = toolResults(input);
      const listed = results.find(
        (result) => result.name === "list_files",
      )?.value;
      if (!listed) return response("", [call("list_files", {})]);
      const files = Array.isArray(listed.files)
        ? (listed.files as string[])
        : [];
      const entry =
        typeof listed.entry === "string" ? listed.entry : "src/App.tsx";
      const path =
        files.find((file) => /(?:^|\/)App\.tsx$/.test(file)) ?? entry;
      const read = results.find(
        (result) => result.name === "read_files",
      )?.value;
      if (!read) return response("", [call("read_files", { paths: [path] })]);
      const wrote = results.some(
        (result) => result.name === "write_file" && !result.value.error,
      );
      if (!wrote) {
        const intent =
          input.messages.find((message) => message.role === "user")?.content ??
          "";
        const source =
          (read.files as Record<string, string> | undefined)?.[path] ?? "";
        if (
          /\b(?:todo|to-do|task list|checklist)\b/i.test(intent) &&
          !/\b(?:title|heading|rename)\b/i.test(intent)
        ) {
          return response("", [
            call("write_file", {
              path: "src/components/Tasks.tsx",
              content: `import React, {useState} from 'react';\nimport {useStore,setState} from '@itsalive/store';\nexport default function Tasks(){\n const tasks=(useStore((s:any)=>s.tasks)??[]) as string[]; const [draft,setDraft]=useState('');\n return <section><form onSubmit={e=>{e.preventDefault();if(draft.trim()){setState({tasks:[...tasks,draft.trim()]});setDraft('')}}}><input aria-label="New task" value={draft} onChange={e=>setDraft(e.target.value)}/><button>Add task</button></form><ul>{tasks.map((task,i)=><li key={i}>{task} <button onClick={()=>setState({tasks:tasks.filter((_,index)=>index!==i)})}>Complete {task}</button></li>)}</ul></section>\n}`,
            }),
            call("write_file", {
              path,
              content: `import React from 'react';\nimport Tasks from './components/Tasks';\nexport default function App(){return <main><h1>My tasks</h1><p>A local demo built through the coding tools.</p><Tasks/></main>}`,
            }),
          ]);
        }
        const title = demoTitle(intent);
        const updated = /<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/.test(source)
          ? source.replace(
              /(<h1(?:\s[^>]*)?>)[\s\S]*?(<\/h1>)/,
              (_all, open: string, close: string) =>
                `${open}{${JSON.stringify(title)}}${close}`,
            )
          : `import React from 'react';\nexport default function App(){return <main><h1>{${JSON.stringify(title)}}</h1></main>}`;
        return response("", [call("write_file", { path, content: updated })]);
      }
      const checked = [...results]
        .reverse()
        .find((result) => result.name === "check");
      if (!checked) return response("", [call("check", {})]);
      if (checked.value.ok !== true)
        return response(
          "The demo could not verify this change. Select a configured coding model for repair.",
        );
      return response("", [
        call("finish", {
          summary:
            "Demo change compiled and passed isolated rendering. Use a configured provider for unrestricted app generation.",
        }),
      ]);
    }
    const schemaName = input.jsonSchema?.name;
    const latest =
      [...input.messages].reverse().find((message) => message.role === "user")
        ?.content ?? "";
    if (schemaName === "conversation") {
      const question =
        /^(?:what|why|how|explain|tell me|can you explain)\b/i.test(latest);
      const supported =
        /\b(?:title|heading|rename|todo|to-do|task list|checklist)\b/i.test(
          latest,
        );
      const vague = /^(?:not yet|no|it doesn't help|still wrong)[.!]?$/i.test(
        latest.trim(),
      );
      return response(
        JSON.stringify({
          reply: vague
            ? "What's still not working as you expected?"
            : question
              ? "This is a scripted test provider. Connect OpenAI or OpenRouter in Settings for answers about your application."
              : supported
                ? "I'll make that test change."
                : "This scripted test provider only supports heading changes and task lists. Connect OpenAI or OpenRouter in Settings to create an app for your goal.",
          intent: vague
            ? "clarify"
            : question || !supported
              ? "conversation"
              : "change",
          changeRequest: !vague && !question && supported ? latest : null,
          confirmationReason: null,
        }),
      );
    }
    if (schemaName === "behavior_suggestion")
      return response(
        JSON.stringify({
          suggest: true,
          explanation:
            "Several clicks on the same control might mean it needs clearer feedback.",
          changeRequest:
            "Inspect this control and improve its feedback, preserving its intended behavior.",
        }),
      );
    if (schemaName === "application_decision") {
      const schema = input.jsonSchema?.schema.properties as
        | Record<string, { type?: string; enum?: string[]; maximum?: number }>
        | undefined;
      const definition = schema?.value;
      return response(
        JSON.stringify({
          value:
            definition?.type === "boolean"
              ? true
              : definition?.type === "number"
                ? Math.min(1, definition.maximum ?? 1)
                : (definition?.enum?.[0] ?? "demo"),
        }),
      );
    }
    return response(`Demo response: ${latest.slice(0, 240)}`);
  }
}

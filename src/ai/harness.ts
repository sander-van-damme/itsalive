import type {
  BuildArtifact,
  BuildResult,
  Project,
  RuntimeInspection,
} from "../shared/types";
import type { AIContext, AIMessage, AIRole, ToolDefinition } from "./types";
import { AIService } from "./service";

export interface CodingCallbacks {
  compile(project: Project): Promise<BuildResult>;
  verify(artifact: BuildArtifact): Promise<RuntimeInspection>;
  commit(
    project: Project,
    artifact: BuildArtifact,
    baseRevisionId: string,
  ): Promise<string>;
  inspect?(): Promise<RuntimeInspection>;
  onTool?(event: {
    name: string;
    paths?: string[];
    ok: boolean;
    correlationId: string;
  }): void;
}
export interface CodingRequest {
  project: Project;
  baseRevisionId: string;
  intent: string;
  authorized: boolean;
  context: AIContext;
  role?: Extract<AIRole, `coding-${string}`>;
  signal?: AbortSignal;
}
export interface CodingResult {
  revisionId: string;
  project: Project;
  artifact: BuildArtifact;
  summary: string;
  turns: number;
  changedFiles: string[];
}
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
export const CODING_TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List project paths and pinned dependencies. Read only relevant source files next.",
    parameters: objectSchema({}, []),
  },
  {
    name: "read_files",
    description: "Read up to eight relevant source files.",
    parameters: objectSchema(
      { paths: { type: "array", items: string, maxItems: 8 } },
      ["paths"],
    ),
  },
  {
    name: "write_file",
    description:
      "Create or replace a candidate file. Does not touch the running application.",
    parameters: objectSchema({ path: string, content: string }, [
      "path",
      "content",
    ]),
  },
  {
    name: "patch_file",
    description:
      "Replace one exact matching source excerpt. Fails on missing or ambiguous match.",
    parameters: objectSchema({ path: string, find: string, replace: string }, [
      "path",
      "find",
      "replace",
    ]),
  },
  {
    name: "delete_file",
    description: "Delete a candidate file; the entry file cannot be deleted.",
    parameters: objectSchema({ path: string }, ["path"]),
  },
  {
    name: "set_dependency",
    description:
      "Pin an npm dependency to an exact semantic version. Browser-compatible packages only.",
    parameters: objectSchema({ name: string, version: string }, [
      "name",
      "version",
    ]),
  },
  {
    name: "check",
    description:
      "Compile and render the candidate in an isolated verification environment. Returns deterministic diagnostics.",
    parameters: objectSchema({}, []),
  },
  {
    name: "inspect",
    description:
      "Read the currently running application text and runtime errors without changing it.",
    parameters: objectSchema({}, []),
  },
  {
    name: "finish",
    description:
      "Finish the requested work. The shell verifies the candidate before applying it.",
    parameters: objectSchema({ summary: string }, ["summary"]),
  },
];
export const CODING_SYSTEM = `You edit an ordinary browser React/TypeScript project through file tools. Generated source is a candidate until the shell compiles and verifies it. Read relevant files first; use exact scoped patches for small edits. Never modify source outside the stated user request. React and ReactDOM are stable runtime modules. Entry exports a React component as default. Import {useStore,setState} from '@itsalive/store'; useStore(selector) reads durable JSON state and setState({...}) merges it. Ordinary useState is transient. Import {text,decide,choose,score} from '@itsalive/ai'; these proxy bounded AI calls and never expose provider keys. Use ordinary CSS imports. Add exact-version npm packages only when needed. No Node builtins. Never claim compilation succeeded unless check says it did. Repair deterministic failures. Create useful goal-specific application behavior, not a generic counter or scaffold. Replace pending starter content with meaningful tasks, practice material and working controls for the stated goal. Preserve existing durable store keys and relevant user activity during updates. Do not claim capabilities such as pitch recognition unless actually implemented. When repairing, inspect the active application and read relevant files before changing them. Finish once the requested change works. Keep work and tool arguments small. No arbitrary JavaScript execution tools exist.`;

function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f]/.test(value) ||
    value === "__proto__"
  )
    throw new Error("Use a relative project file path without traversal.");
  return value;
}
function text(value: unknown, field: string, limit = 100_000): string {
  if (typeof value !== "string" || value.length > limit)
    throw new Error(`${field} must be text of at most ${limit} characters.`);
  return value;
}
function argsObject(raw: string): Record<string, unknown> {
  if (raw.length > 120_000)
    throw new Error("Tool arguments exceed the size limit.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

export class CodingHarness {
  constructor(
    private readonly service: AIService,
    private readonly callbacks: CodingCallbacks,
  ) {}
  async run(request: CodingRequest): Promise<CodingResult> {
    if (request.authorized !== true)
      throw new Error(
        "Coding requires an explicit user request or accepted suggestion.",
      );
    if (!request.intent.trim() || request.intent.length > 12_000)
      throw new Error("Give a bounded coding request.");
    const candidate = structuredClone(request.project);
    const context = {
      ...request.context,
      signal: request.signal ?? request.context.signal,
    };
    const changed = new Set<string>();
    let artifact: BuildArtifact | undefined;
    let verified = false;
    let summary = "";
    let totalCalls = 0;
    const messages: AIMessage[] = [
      { role: "system", content: CODING_SYSTEM },
      {
        role: "user",
        content: `Authorized request: ${request.intent}\nEntry: ${candidate.entry}\nFiles: ${Object.keys(candidate.files).join(", ")}\nDependencies: ${JSON.stringify(candidate.dependencies)}`,
      },
    ];
    const check = async (): Promise<unknown> => {
      context.signal?.throwIfAborted();
      const result = await this.callbacks.compile(structuredClone(candidate));
      if (!result.ok) {
        artifact = undefined;
        verified = false;
        return { ok: false, diagnostics: result.diagnostics };
      }
      // Preserve the resolver's exact dependency lock in the accepted source snapshot.
      candidate.lock = structuredClone(result.project.lock);
      const inspection = await this.callbacks.verify(result.artifact);
      if (inspection.errors.length) {
        artifact = undefined;
        verified = false;
        return { ok: false, diagnostics: inspection.errors };
      }
      artifact = result.artifact;
      verified = true;
      return {
        ok: true,
        visibleText: inspection.text.slice(0, 8_000),
        metrics: result.artifact.metrics,
      };
    };
    const changedFile = (name: string): void => {
      changed.add(name);
      artifact = undefined;
      verified = false;
    };
    for (let turn = 1; turn <= 12; turn++) {
      context.signal?.throwIfAborted();
      const response = await this.service.generate(
        request.role ?? "coding-standard",
        { messages, tools: CODING_TOOLS },
        context,
      );
      messages.push({
        role: "assistant",
        content: response.text,
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
      });
      let finished = false;
      if (!response.toolCalls.length) {
        if (!changed.size)
          throw new Error(
            response.text ||
              "Coding agent finished without changing any source.",
          );
        summary = response.text || "Updated application";
        finished = true;
      }
      for (const call of response.toolCalls) {
        if (++totalCalls > 36)
          throw new Error(
            "Coding tool limit reached. The active application is unchanged.",
          );
        context.signal?.throwIfAborted();
        let result: unknown;
        let ok = true;
        const toolPaths: string[] = [];
        try {
          const args = argsObject(call.arguments);
          switch (call.name) {
            case "list_files":
              result = {
                files: Object.keys(candidate.files),
                dependencies: candidate.dependencies,
                entry: candidate.entry,
              };
              break;
            case "read_files": {
              if (!Array.isArray(args.paths) || args.paths.length > 8)
                throw new Error("Read at most eight files.");
              const files: Record<string, string> = {};
              for (const value of args.paths) {
                const name = path(value);
                if (!Object.hasOwn(candidate.files, name))
                  throw new Error(`File does not exist: ${name}`);
                files[name] = candidate.files[name]!;
                toolPaths.push(name);
              }
              if (JSON.stringify(files).length > 60_000)
                throw new Error(
                  "Read fewer files to keep the coding context bounded.",
                );
              result = { files };
              break;
            }
            case "write_file": {
              const name = path(args.path);
              const content = text(args.content, "content");
              if (name === "package.json")
                throw new Error(
                  "Use set_dependency for package changes; the shell owns the manifest.",
                );
              if (
                Object.keys(candidate.files).length >= 100 &&
                !Object.hasOwn(candidate.files, name)
              )
                throw new Error("Project file limit reached.");
              candidate.files[name] = content;
              changedFile(name);
              toolPaths.push(name);
              result = { written: name };
              break;
            }
            case "patch_file": {
              const name = path(args.path);
              const find = text(args.find, "find");
              const replacement = text(args.replace, "replace");
              const source = candidate.files[name];
              if (source === undefined || !find || !source.includes(find))
                throw new Error(
                  "Patch source did not match. Read the file before retrying.",
                );
              if (source.indexOf(find) !== source.lastIndexOf(find))
                throw new Error(
                  "Patch source is ambiguous. Include more context.",
                );
              candidate.files[name] = source.replace(find, () => replacement);
              changedFile(name);
              toolPaths.push(name);
              result = { patched: name };
              break;
            }
            case "delete_file": {
              const name = path(args.path);
              if (name === candidate.entry)
                throw new Error("Cannot delete the project entry.");
              if (!Object.hasOwn(candidate.files, name))
                throw new Error("File does not exist.");
              delete candidate.files[name];
              changedFile(name);
              toolPaths.push(name);
              result = { deleted: name };
              break;
            }
            case "set_dependency": {
              const name = text(args.name, "name", 160);
              const version = text(args.version, "version", 80);
              if (
                !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
                !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
              )
                throw new Error(
                  "Use an npm package name and exact version such as 1.2.3.",
                );
              candidate.dependencies[name] = version;
              candidate.lock = {};
              changedFile("package.json");
              result = { name, version };
              break;
            }
            case "check":
              result = await check();
              break;
            case "inspect":
              result = this.callbacks.inspect
                ? await this.callbacks.inspect()
                : { text: "", errors: [], note: "No active preview" };
              break;
            case "finish":
              summary = text(args.summary, "summary", 2_000);
              finished = true;
              result = { requested: "finish" };
              break;
            default:
              throw new Error(`Unknown coding tool: ${call.name}`);
          }
        } catch (error) {
          if (context.signal?.aborted) throw error;
          ok = false;
          result = {
            error: error instanceof Error ? error.message : "Tool failed",
          };
        }
        this.callbacks.onTool?.({
          name: call.name,
          ...(toolPaths.length ? { paths: toolPaths } : {}),
          ok,
          correlationId: context.correlationId,
        });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }
      if (finished) {
        if (!changed.size) throw new Error("No source changes were proposed.");
        if (!verified || !artifact) {
          const evidence = await check();
          if (!verified || !artifact) {
            messages.push({
              role: "user",
              content: `The candidate failed deterministic verification. Repair it before finishing: ${JSON.stringify(evidence)}`,
            });
            continue;
          }
        }
        context.signal?.throwIfAborted();
        const revisionId = await this.callbacks.commit(
          structuredClone(candidate),
          artifact,
          request.baseRevisionId,
        );
        return {
          revisionId,
          project: candidate,
          artifact,
          summary,
          turns: turn,
          changedFiles: [...changed],
        };
      }
    }
    throw new Error(
      "Coding repair limit reached. The working revision is unchanged; narrow the request and retry.",
    );
  }
}

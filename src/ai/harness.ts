import type {
  BuildArtifact,
  BuildResult,
  Project,
  RuntimeInspection,
  WorkActivity,
  WorkActivityResult,
} from "../shared/types";
import { failureEvidence } from "../shared/errors";
import { GENERATED_APP_DESIGN_POLICY } from "./generation-policy";
import type { AIContext, AIMessage, AIRole, ToolDefinition } from "./types";
import { AIService } from "./service";
import { AIError } from "./providers";
import type { CodingCheckpoint } from "./checkpoint";
export type { CodingCheckpoint } from "./checkpoint";

export interface CodingCallbacks {
  compile(project: Project): Promise<BuildResult>;
  verify(artifact: BuildArtifact): Promise<RuntimeInspection>;
  commit(
    project: Project,
    artifact: BuildArtifact,
    baseRevisionId: string,
  ): Promise<string>;
  inspect?(): Promise<RuntimeInspection>;
  onActivity?(
    activity: WorkActivity,
  ): Promise<WorkActivityResult | void> | WorkActivityResult | void;
  loadCheckpoint?(appId: string): Promise<CodingCheckpoint | undefined>;
  saveCheckpoint?(checkpoint: CodingCheckpoint): Promise<void>;
  clearCheckpoint?(appId: string, checkpointId: string): Promise<void>;
  onProgress?(event: {
    stage:
      | "understanding"
      | "building"
      | "checking"
      | "repairing"
      | "finishing"
      | "recovering";
    correlationId: string;
    /** A real, task-specific update from the worker, never a simulated percentage. */
    message?: string;
  }): void;
  onEvent?(event: {
    event: string;
    data: Record<string, unknown>;
    level?: "INFO" | "DEBUG";
  }): void;
  onTool?(event: {
    name: string;
    paths?: string[];
    ok: boolean;
    correlationId: string;
    durationMs: number;
    check?: { compiled: boolean; verified: boolean; diagnosticCount: number };
  }): void;
}
export interface CodingRequest {
  project: Project;
  baseRevisionId: string;
  intent: string;
  authorized: boolean;
  originalRequest?: string;
  /** Only an explicit retry may resume a different request string. */
  resume?: boolean;
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
      "List project paths and pinned dependencies. Initial source is already provided.",
    parameters: objectSchema({}, []),
  },
  {
    name: "read_files",
    description:
      "Read relevant source files when their latest contents are needed.",
    parameters: objectSchema({ paths: { type: "array", items: string } }, [
      "paths",
    ]),
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
    name: "report_progress",
    description:
      "Give the user a concise update about a real finding or the work now underway. To mark the precise parts being changed, include only region IDs from a recent inspect result. An empty targets list clears prior markers. Never guess IDs or claim completion before finish succeeds.",
    parameters: objectSchema(
      {
        message: string,
        targets: { type: "array", items: string },
      },
      ["message", "targets"],
    ),
  },
  {
    name: "finish",
    description:
      "Finish the requested work. The shell verifies the candidate before applying it.",
    parameters: objectSchema({ summary: string }, ["summary"]),
  },
];
export const CODING_SYSTEM = `You edit an ordinary browser React/TypeScript project through file tools. Generated source is a candidate until the shell compiles and verifies it. The initial request includes the complete current source. Reuse that context; read files only when needed. Batch independent file operations into the same response; use exact scoped patches for small edits. Never modify source outside the stated user request. React and ReactDOM are stable runtime modules. Entry exports a React component as default. Import {useStore,setState} from '@itsalive/store'; useStore(selector) reads durable JSON state and setState({...}) merges it. Ordinary useState is transient. Import {text,decide,choose,score} from '@itsalive/ai'; these proxy bounded AI calls and never expose provider keys. Use ordinary CSS imports. Add exact-version npm packages only when needed. No Node builtins. Never claim compilation succeeded unless check says it did. Repair deterministic failures. Create useful goal-specific application behavior, not a generic counter or scaffold. Replace pending starter content with meaningful tasks, practice material and working controls for the stated goal. Preserve existing durable store keys and relevant user activity during updates. Do not claim capabilities such as pitch recognition unless actually implemented. When repairing, inspect the active application and read relevant files before changing them. Use report_progress for real findings and the current task in ordinary language; identify exact current region IDs only after inspect, and use an empty targets list when no precise affected region is known. Once the requested behavior is implemented, call finish with a concise statement of what the app now does. finish performs verification itself; a separate check is optional. If check already passed and the goal is satisfied, call finish immediately instead of generating more changes. A successful check alone does not prove that the user goal is satisfied. Never finish a pending scaffold. Completed tool results are authoritative: do not repeat a successful patch or deletion after recovery. No arbitrary JavaScript execution tools exist.\n\n${GENERATED_APP_DESIGN_POLICY}`;

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
function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  return value;
}
function argsObject(raw: string): Record<string, unknown> {
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
    const locks = globalThis.navigator?.locks;
    if (!locks) return this.runSession(request);
    return locks.request(
      `itsalive:coding:${request.context.appId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new AIError(
            "This app is already being changed in another tab. Let it finish or cancel there before retrying.",
            "response",
            { reason: "coding_session_active" },
          );
        return this.runSession(request);
      },
    );
  }
  private async runSession(request: CodingRequest): Promise<CodingResult> {
    if (request.authorized !== true)
      throw new Error(
        "Coding requires an explicit user request or accepted suggestion.",
      );
    if (!request.intent.trim())
      throw new Error("Describe the requested change.");
    const loaded = await this.callbacks.loadCheckpoint?.(request.context.appId);
    const resumable =
      loaded &&
      loaded.baseRevisionId === request.baseRevisionId &&
      (request.resume === true || loaded.intent === request.intent);
    if (
      request.resume &&
      loaded &&
      loaded.baseRevisionId !== request.baseRevisionId
    )
      throw new Error(
        "The application changed after this draft was saved. Request the change again against the latest version.",
      );
    const now = Math.max(Date.now(), (loaded?.createdAt ?? 0) + 1);
    const draft: CodingCheckpoint = resumable
      ? structuredClone(loaded)
      : {
          version: 1,
          id: crypto.randomUUID(),
          appId: request.context.appId,
          baseRevisionId: request.baseRevisionId,
          intent: request.intent,
          originalRequest: request.originalRequest ?? request.intent,
          role: request.role ?? "coding-standard",
          correlationId: request.context.correlationId,
          createdAt: now,
          updatedAt: now,
          project: structuredClone(request.project),
          changedFiles: [],
          turns: 0,
          toolCalls: 0,
          finishRequested: false,
          summary: "",
          status: "working",
          messages: [
            { role: "system", content: CODING_SYSTEM },
            {
              role: "user",
              content: `Original user goal: ${request.originalRequest ?? request.intent}\nAuthorized request: ${request.intent}\nCurrent project (complete source): ${JSON.stringify(request.project)}`,
            },
          ],
        };
    const context = {
      ...request.context,
      signal: request.signal ?? request.context.signal,
    };
    const candidate = draft.project;
    const messages = draft.messages;
    const changed = new Set(draft.changedFiles);
    let artifact: BuildArtifact | undefined;
    let verified = false;
    let lastCheck:
      | { compiled: boolean; verified: boolean; diagnosticCount: number }
      | undefined;
    // Evidence-based loop detection: repeated identical operations against the same
    // source state, rather than a ceiling on productive turns or tools.
    const repetitions = new Map<string, number>();
    const failedChecks = new Map<string, number>();
    let incompleteWithoutProgress = 0;
    let rebuiltContext = false;
    const receipts = (draft.receipts ??= {});
    let sourceVersion = 0;
    const started = performance.now();
    const emit = (
      event: string,
      data: Record<string, unknown>,
      level: "INFO" | "DEBUG" = "INFO",
    ) =>
      this.callbacks.onEvent?.({
        event,
        data: {
          ...data,
          correlationId: context.correlationId,
          sessionId: draft.id,
        },
        level,
      });
    const progress = (
      stage: Parameters<NonNullable<CodingCallbacks["onProgress"]>>[0]["stage"],
      message?: string,
    ) => {
      emit("coding.progress", { stage, ...(message ? { message } : {}) });
      this.callbacks.onProgress?.({
        stage,
        correlationId: context.correlationId,
        ...(message ? { message } : {}),
      });
    };
    const save = async () => {
      draft.changedFiles = [...changed];
      draft.updatedAt = Date.now();
      await this.callbacks.saveCheckpoint?.(structuredClone(draft));
    };
    const changedFile = (name: string) => {
      changed.add(name);
      sourceVersion++;
      artifact = undefined;
      verified = false;
    };
    const rememberFailure = (evidence: unknown): void => {
      const key = JSON.stringify([
        candidate.files,
        candidate.dependencies,
        evidence,
      ]);
      const repeated = (failedChecks.get(key) ?? 0) + 1;
      failedChecks.set(key, repeated);
      if (repeated >= 3)
        throw new AIError(
          "The AI repeatedly checked the same failing application without repairing it. Your draft is saved; retry to continue.",
          "response",
          { reason: "nonprogress_verification" },
        );
    };
    const check = async (): Promise<unknown> => {
      context.signal?.throwIfAborted();
      progress("checking");
      const checkStarted = performance.now();
      lastCheck = { compiled: false, verified: false, diagnosticCount: 0 };
      try {
        const compiledAt = performance.now();
        const result = await this.callbacks.compile(structuredClone(candidate));
        const compileMs = performance.now() - compiledAt;
        if (!result.ok) {
          artifact = undefined;
          verified = false;
          lastCheck.diagnosticCount = result.diagnostics.length;
          emit("coding.check", {
            ...lastCheck,
            compileMs,
            durationMs: performance.now() - checkStarted,
          });
          emit(
            "coding.check.evidence",
            { stage: "compile", diagnostics: result.diagnostics },
            "DEBUG",
          );
          rememberFailure(result.diagnostics);
          progress("repairing");
          return {
            ok: false,
            stage: "compile",
            diagnostics: result.diagnostics,
          };
        }
        lastCheck.compiled = true;
        candidate.lock = structuredClone(result.project.lock);
        const verifyAt = performance.now();
        const inspection = await this.callbacks.verify(result.artifact);
        const verifyMs = performance.now() - verifyAt;
        const qualityErrors =
          inspection.quality?.issues.filter(
            (issue) => issue.severity === "error",
          ) ?? [];
        const diagnostics = [...inspection.errors, ...qualityErrors];
        if (diagnostics.length) {
          const stage = inspection.errors.length ? "runtime" : "quality";
          artifact = undefined;
          verified = false;
          lastCheck.diagnosticCount = diagnostics.length;
          emit("coding.check", {
            ...lastCheck,
            compileMs,
            verifyMs,
            durationMs: performance.now() - checkStarted,
          });
          emit("coding.check.evidence", { stage, inspection }, "DEBUG");
          rememberFailure(diagnostics);
          progress("repairing");
          return {
            ok: false,
            stage,
            diagnostics,
            quality: inspection.quality,
          };
        }
        artifact = result.artifact;
        verified = true;
        lastCheck.verified = true;
        emit("coding.check", {
          ...lastCheck,
          compileMs,
          verifyMs,
          durationMs: performance.now() - checkStarted,
        });
        emit(
          "coding.check.evidence",
          { stage: "verified", inspection },
          "DEBUG",
        );
        return {
          ok: true,
          visibleText: inspection.text,
          quality: inspection.quality,
          metrics: result.artifact.metrics,
          next: "If this implements the user's goal, call finish now. Do not repeat this check unless the source changes.",
        };
      } catch (error) {
        artifact = undefined;
        verified = false;
        if (
          context.signal?.aborted ||
          (error instanceof AIError &&
            error.detail.reason === "nonprogress_verification")
        )
          throw error;
        rememberFailure(
          error instanceof Error ? error.message : "Check failed",
        );
        lastCheck.diagnosticCount++;
        emit("coding.check", {
          ...lastCheck,
          durationMs: performance.now() - checkStarted,
        });
        emit(
          "coding.check.evidence",
          { error: failureEvidence(error) },
          "DEBUG",
        );
        progress("repairing");
        return {
          ok: false,
          stage: lastCheck.compiled ? "runtime" : "compile",
          diagnostics: [
            error instanceof Error ? error.message : "Candidate check failed",
          ],
        };
      }
    };
    if (resumable) {
      emit("coding.recovered", {
        previousCorrelationId: draft.correlationId,
        changedFiles: changed.size,
        pendingTools: draft.pending
          ? draft.pending.calls.length - draft.pending.next
          : 0,
      });
      progress("recovering");
      // An old checkpoint could have reached finish before a live-apply failure.
      // Its cold check passing again is not evidence that repeating the apply is safe.
      if (draft.finishRequested && draft.lastFailure?.kind === "workflow") {
        draft.finishRequested = false;
        messages.push({
          role: "user",
          content: `The previous candidate reached finish but failed during the application workflow. Do not simply finish again. Inspect the saved failure and the active app, then repair the cause while keeping the last working app safe. Failure evidence: ${JSON.stringify(draft.lastFailure)}`,
        });
      }
      if (!draft.pending && draft.lastFailure)
        messages.push({
          role: "user",
          content: `Resume the original goal from the saved candidate. The previous run stopped because ${JSON.stringify(draft.lastFailure)}. Inspect this obstacle and choose a different approach where necessary; do not repeat successful operations.`,
        });
    } else progress("understanding");
    draft.status = "working";
    await save();
    try {
      for (;;) {
        context.signal?.throwIfAborted();
        if (!draft.pending && draft.finishRequested) {
          if (!changed.size)
            throw new Error("No source changes were proposed.");
          if (!verified || !artifact) {
            const evidence = await check();
            if (!verified || !artifact) {
              draft.finishRequested = false;
              messages.push({
                role: "user",
                content: `The candidate failed deterministic verification. Repair it before finishing: ${JSON.stringify(evidence)}`,
              });
              await save();
              continue;
            }
          }
          context.signal?.throwIfAborted();
          progress("finishing");
          const commitAt = performance.now();
          let revisionId: string;
          try {
            revisionId = await this.callbacks.commit(
              structuredClone(candidate),
              artifact,
              request.baseRevisionId,
            );
          } catch (error) {
            const evidence = failureEvidence(error);
            draft.finishRequested = false;
            draft.lastFailure = {
              kind: "workflow",
              stage: "commit",
              error: evidence,
            };
            await save();
            // Only a confirmed safe rollback permits automatic repair. Revision
            // conflicts, persistence failures and unconfirmed rollback must stop.
            if (
              evidence.detail?.stage !== "live-apply" ||
              evidence.detail.rollbackSucceeded !== true
            )
              throw error;
            rememberFailure({
              stage: "live-apply",
              name: evidence.name,
              message: evidence.message,
            });
            artifact = undefined;
            verified = false;
            emit("coding.live_apply.repair", {
              error: evidence,
              strategy: "repair-saved-candidate",
              baseRevisionId: request.baseRevisionId,
            });
            progress(
              "repairing",
              "I found a problem when updating the app. Your previous version is safe while I fix it.",
            );
            messages.push({
              role: "user",
              content: `The candidate passed isolated verification but failed when applied to the actual running app. The previous app and durable state were restored successfully. Inspect the active app and repair this live-update problem before calling finish again. Do not repeat successful edits or replace the user's durable data. Exact failure: ${JSON.stringify(evidence)}`,
            });
            await save();
            continue;
          }
          // Repository commits atomically invalidate drafts. Optional callbacks also
          // support isolated harness hosts; cleanup failure cannot undo a commit.
          try {
            await this.callbacks.clearCheckpoint?.(draft.appId, draft.id);
          } catch {
            emit("coding.checkpoint.cleanup_failed", { revisionId });
          }
          emit("coding.committed", {
            revisionId,
            commitMs: performance.now() - commitAt,
            durationMs: performance.now() - started,
            turns: draft.turns,
            toolCalls: draft.toolCalls,
          });
          return {
            revisionId,
            project: candidate,
            artifact,
            summary: draft.summary,
            turns: draft.turns,
            changedFiles: [...changed],
          };
        }
        if (!draft.pending) {
          const before = sourceVersion;
          let response;
          let incomplete = false;
          const modelAt = performance.now();
          try {
            response = await this.service.generate(
              draft.role,
              { messages, tools: CODING_TOOLS },
              context,
            );
          } catch (error) {
            if (
              error instanceof AIError &&
              error.kind === "context" &&
              !rebuiltContext
            ) {
              rebuiltContext = true;
              // A provider-reported window overflow is the only trigger for compaction.
              // Keep the complete historical continuation locally. Current files replace
              // obsolete file reads; goal, failures and operation receipts remain explicit.
              (draft.archivedContexts ??= []).push(structuredClone(messages));
              const history = Object.entries(receipts).map(([id, receipt]) => {
                let output: Record<string, unknown> = {};
                try {
                  output = JSON.parse(receipt.output) as Record<
                    string,
                    unknown
                  >;
                } catch {
                  /* opaque output */
                }
                if (
                  receipt.ok &&
                  ["read_files", "list_files", "inspect"].includes(receipt.name)
                )
                  return {
                    id,
                    name: receipt.name,
                    ok: true,
                    note: "Source is in the current project; inspect again for current runtime state.",
                  };
                const { visibleText: _visibleText, ...evidence } = output;
                return { id, name: receipt.name, ok: receipt.ok, evidence };
              });
              messages.splice(
                0,
                messages.length,
                { role: "system", content: CODING_SYSTEM },
                {
                  role: "user",
                  content: `The provider reported its actual context window was exceeded. Full prior tool/reasoning history is archived locally. Continue without replaying successful operations.
Original user goal: ${draft.originalRequest}
Authorized coding request: ${draft.intent}
Complete current candidate: ${JSON.stringify(candidate)}
Completed operation receipts and diagnostic history: ${JSON.stringify(history)}
Last failure: ${JSON.stringify(draft.lastFailure ?? null)}
Verification and recovery instructions: ${JSON.stringify(
                    messages
                      .filter((message) => message.role === "user")
                      .slice(1)
                      .map((message) => message.content),
                  )}`,
                },
              );
              emit("coding.context.rebuilt", {
                reason: error.detail.reason,
                archivedMessages: draft.archivedContexts.at(-1)!.length,
                completeSourcePreserved: true,
                receipts: history.length,
              });
              progress("recovering");
              await save();
              continue;
            }
            if (
              !(error instanceof AIError) ||
              !error.response?.completion?.recoverable
            )
              throw error;
            response = error.response;
            incomplete = true;
            emit("coding.recovery", {
              reason: response.completion?.reason,
              completedTools: response.toolCalls.length,
              recoverable: true,
            });
            progress("recovering");
          }
          const ids = new Set<string>();
          for (const call of response.toolCalls) {
            if (ids.has(call.id) || Object.hasOwn(receipts, call.id))
              throw new AIError(
                "The AI repeated a completed action identifier. Your draft is saved; retry to continue safely.",
                "response",
                { reason: "duplicate_tool_call_id" },
              );
            ids.add(call.id);
          }
          draft.turns++;
          emit(
            "coding.model",
            {
              turn: draft.turns,
              durationMs: performance.now() - modelAt,
              toolCalls: response.toolCalls.length,
              completion: response.completion?.status ?? "completed",
            },
            "DEBUG",
          );
          messages.push({
            role: "assistant",
            content: response.text,
            ...(response.responseItems
              ? { responseItems: response.responseItems }
              : {}),
            ...(response.toolCalls.length
              ? { toolCalls: response.toolCalls }
              : {}),
          });
          draft.pending = { calls: response.toolCalls, next: 0, incomplete };
          await save();
          // A text-only response is not a completion contract. Ask for an explicit
          // finish after assessing the actual goal, then verify deterministically.
          if (!response.toolCalls.length) {
            messages.push({
              role: "user",
              content: incomplete
                ? "The provider interrupted the previous response. Continue the original goal from the saved candidate. Do not repeat completed operations."
                : "If the requested application behavior is complete, call finish. Otherwise continue implementing the original goal. A successful compile alone is not completion.",
            });
          }
          // Preserve this turn's source baseline while the pending tools execute.
          sourceVersion = before;
        }
        const pending = draft.pending;
        const beforeTools = sourceVersion;
        const operationKey = JSON.stringify([
          candidate.files,
          candidate.dependencies,
          pending.calls.map(({ name, arguments: args }) => [name, args]),
        ]);
        const seen = (repetitions.get(operationKey) ?? 0) + 1;
        repetitions.set(operationKey, seen);
        if (seen >= 3) {
          emit("coding.nonprogress", {
            repeats: seen,
            changedFiles: changed.size,
          });
          throw new AIError(
            "The AI repeated the same work without progress. Your draft is saved; retry to continue from it.",
            "response",
            { reason: "nonprogress" },
          );
        }
        for (; pending.next < pending.calls.length; ) {
          const call = pending.calls[pending.next]!;
          context.signal?.throwIfAborted();
          const toolAt = performance.now();
          let result: unknown;
          let ok = true;
          const toolPaths: string[] = [];
          try {
            const previous = Object.hasOwn(receipts, call.id)
              ? receipts[call.id]
              : undefined;
            if (previous) {
              if (
                previous.name !== call.name ||
                previous.arguments !== call.arguments
              )
                throw new Error(
                  "A completed tool call ID was reused for a different operation. Issue a new call ID.",
                );
              result = JSON.parse(previous.output);
              ok = previous.ok;
              emit(
                "coding.tool.replayed",
                { name: call.name, reusedResult: true },
                "DEBUG",
              );
            } else {
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
                  if (!Array.isArray(args.paths))
                    throw new Error("paths must be a list of project paths.");
                  const files: Record<string, string> = {};
                  for (const value of args.paths) {
                    const name = path(value);
                    if (!Object.hasOwn(candidate.files, name))
                      throw new Error(`File does not exist: ${name}`);
                    files[name] = candidate.files[name]!;
                    toolPaths.push(name);
                  }
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
                  if (candidate.files[name] !== content) {
                    candidate.files[name] = content;
                    changedFile(name);
                  }
                  progress("building");
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
                  if (find !== replacement) {
                    candidate.files[name] = source.replace(
                      find,
                      () => replacement,
                    );
                    changedFile(name);
                  }
                  progress("building");
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
                  const name = text(args.name, "name");
                  const version = text(args.version, "version");
                  if (
                    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
                    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
                  )
                    throw new Error(
                      "Use an npm package name and exact version such as 1.2.3.",
                    );
                  if (candidate.dependencies[name] !== version) {
                    candidate.dependencies[name] = version;
                    candidate.lock = {};
                    changedFile("package.json");
                  }
                  result = { name, version };
                  break;
                }
                case "check":
                  result =
                    verified && artifact
                      ? {
                          ok: true,
                          cached: true,
                          next: "Call finish if the original goal is satisfied.",
                        }
                      : await check();
                  break;
                case "inspect":
                  result = this.callbacks.inspect
                    ? await this.callbacks.inspect()
                    : { text: "", errors: [], note: "No active preview" };
                  break;
                case "report_progress": {
                  const message = text(args.message, "message").trim();
                  if (
                    !message ||
                    !Array.isArray(args.targets) ||
                    args.targets.some((target) => typeof target !== "string")
                  )
                    throw new Error(
                      "Progress needs a concise message and a list of inspected region IDs.",
                    );
                  const activity = {
                    message,
                    targets: args.targets as string[],
                  };
                  result = (await this.callbacks.onActivity?.(activity)) ?? {
                    resolved: [],
                    rejected: activity.targets,
                  };
                  progress("building", message);
                  break;
                }
                case "finish":
                  draft.summary = text(args.summary, "summary");
                  if (!draft.summary.trim())
                    throw new Error(
                      "Explain which requested behavior is now complete.",
                    );
                  draft.finishRequested = true;
                  result = { requested: "finish" };
                  break;
                default:
                  throw new Error(`Unknown coding tool: ${call.name}`);
              }
            }
          } catch (error) {
            if (
              context.signal?.aborted ||
              (error instanceof AIError &&
                error.detail.reason === "nonprogress_verification")
            )
              throw error;
            ok = false;
            result = {
              error: error instanceof Error ? error.message : "Tool failed",
            };
          }
          draft.toolCalls++;
          this.callbacks.onTool?.({
            name: call.name,
            ...(toolPaths.length ? { paths: toolPaths } : {}),
            ok,
            correlationId: context.correlationId,
            durationMs: performance.now() - toolAt,
            ...(call.name === "check" && lastCheck ? { check: lastCheck } : {}),
          });
          const output = JSON.stringify(result);
          emit(
            "coding.tool.content",
            {
              name: call.name,
              toolCallId: call.id,
              arguments: call.arguments,
              output,
              ok,
            },
            "DEBUG",
          );
          if (!Object.hasOwn(receipts, call.id))
            Object.defineProperty(receipts, call.id, {
              value: {
                name: call.name,
                arguments: call.arguments,
                output,
                ok,
              },
              enumerable: true,
              configurable: true,
              writable: true,
            });
          messages.push({ role: "tool", content: output, toolCallId: call.id });
          pending.next++;
          // Atomically persist source plus the completed operation's receipt before
          // executing another operation. Reload resumes at the first missing receipt.
          await save();
        }
        if (pending.incomplete) {
          incompleteWithoutProgress =
            sourceVersion === beforeTools ? incompleteWithoutProgress + 1 : 0;
          if (incompleteWithoutProgress > 1 && !draft.finishRequested) {
            emit("coding.recovery.blocked", {
              reason: "repeated_incomplete_without_progress",
            });
            throw new AIError(
              "The provider repeatedly interrupted its response without progress. Your draft is saved; retry when the provider is available.",
              "response",
              { reason: "repeated_incomplete_without_progress" },
            );
          }
          messages.push({
            role: "user",
            content:
              "The provider interrupted the response. Completed tool results above have been saved. Continue from this candidate without replaying successful operations; finish when the original goal is implemented.",
          });
        } else if (sourceVersion !== beforeTools) incompleteWithoutProgress = 0;
        delete draft.pending;
        await save();
      }
    } catch (error) {
      draft.status = "paused";
      draft.lastFailure = {
        kind: context.signal?.aborted
          ? "cancelled"
          : error instanceof AIError
            ? error.kind
            : "workflow",
        error: failureEvidence(error),
        ...(failureEvidence(error).detail?.stage
          ? { stage: String(failureEvidence(error).detail?.stage) }
          : {}),
        ...(error instanceof AIError && typeof error.detail.reason === "string"
          ? { reason: error.detail.reason }
          : {}),
      };
      try {
        await save();
      } catch {
        emit("coding.checkpoint.failed", { changedFiles: changed.size });
      }
      emit("coding.paused", {
        ...draft.lastFailure,
        changedFiles: changed.size,
        turns: draft.turns,
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
}

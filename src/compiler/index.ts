import type { BuildResult, Project } from "../shared/types";
import type { CompilerBenchmark } from "./benchmark";
export type { CompilerBenchmark } from "./benchmark";
export class BrowserCompiler {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "itsalive-compiler",
  });
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = (
      event: MessageEvent<{ id: number; value?: unknown; error?: string }>,
    ) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.value);
    };
    this.worker.onerror = (event) =>
      this.fail(new Error(`Compiler worker failed: ${event.message}`));
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  private request<T>(
    type: "compile" | "benchmark" | "compile-comparison",
    payload: object = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Compilation timed out after 120 seconds. The previous application is unchanged.",
          ),
        );
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  compile(project: Project, revisionId: string): Promise<BuildResult> {
    return this.request("compile", { project, revisionId });
  }
  /** Research only: no Refresh transform; not used by ordinary app editing. */
  compileComparison(
    project: Project,
    revisionId: string,
  ): Promise<BuildResult> {
    return this.request("compile-comparison", { project, revisionId });
  }
  benchmark(): Promise<CompilerBenchmark> {
    return this.request("benchmark");
  }
  dispose(): void {
    this.worker.terminate();
    this.fail(new Error("Compiler disposed"));
  }
}

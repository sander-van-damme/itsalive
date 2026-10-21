import { CompilerCore } from "./core";
import type { Project } from "../shared/types";
const compiler = new CompilerCore();
// Serialize jobs so each candidate observes a coherent compiler/cache state.
let queue = Promise.resolve();
self.onmessage = (
  event: MessageEvent<{
    id: number;
    type: "compile" | "benchmark" | "compile-comparison";
    project?: Project;
    revisionId?: string;
  }>,
) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      const value =
        request.type === "benchmark"
          ? await (await import("./benchmark")).benchmarkCompilers()
          : request.type === "compile-comparison"
            ? await (
                await import("./benchmark")
              ).compileEsbuildComparison(request.project!, request.revisionId!)
            : await compiler.compile(request.project!, request.revisionId!);
      self.postMessage({ id: request.id, value });
    } catch (error) {
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};

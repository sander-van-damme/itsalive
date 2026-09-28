import type { ApplicationStoreController } from "./application-store";
import { restoreAppDocument, serializeAppDocument } from "./persistence";

export interface AgentTransactionAutosave {
  suspend(): void;
  resume(): void;
  schedule(): void;
}

export interface AgentTransactionDurability {
  checkpoint(): () => void;
}

export interface AgentTransactionOptions {
  applicationStore: ApplicationStoreController;
  autosave: AgentTransactionAutosave;
  durability: AgentTransactionDurability;
  onRollbackError?: (error: unknown) => void;
}

export interface AgentTransactionController {
  runCommand<T>(work: () => Promise<T>): Promise<T>;
  verify<T>(work: () => T | Promise<T>): Promise<T>;
}

interface CapturedAgentState {
  document: ReturnType<typeof serializeAppDocument>;
  rollbackDurability: () => void;
}

export function createAgentTransactionController(
  options: AgentTransactionOptions,
): AgentTransactionController {
  let activeCommandDepth = 0;

  const capture = (): CapturedAgentState => ({
    document: serializeAppDocument(options.applicationStore.snapshot()),
    rollbackDurability: options.durability.checkpoint(),
  });

  const rollback = async (captured: CapturedAgentState): Promise<void> => {
    captured.rollbackDurability();
    options.applicationStore.restore(captured.document.store);
    await restoreAppDocument(captured.document);
  };

  const rollbackPreserving = async (
    captured: CapturedAgentState,
    originalError?: unknown,
  ): Promise<unknown | undefined> => {
    try {
      await rollback(captured);
      return originalError;
    } catch (rollbackError) {
      options.onRollbackError?.(rollbackError);
      return originalError ?? rollbackError;
    }
  };

  return {
    async runCommand<T>(work: () => Promise<T>): Promise<T> {
      options.autosave.suspend();
      const captured = capture();
      activeCommandDepth++;
      try {
        return await work();
      } catch (error) {
        const failure = await rollbackPreserving(captured, error);
        throw failure;
      } finally {
        activeCommandDepth--;
        options.autosave.resume();
        options.autosave.schedule();
      }
    },

    async verify<T>(work: () => T | Promise<T>): Promise<T> {
      if (activeCommandDepth < 1) {
        throw new Error("agent.verify() is available only while an agent command is executing");
      }

      options.autosave.suspend();
      const captured = capture();
      let result: T | undefined;
      let failure: unknown;
      try {
        result = await work();
      } catch (error) {
        failure = error;
      }

      failure = await rollbackPreserving(captured, failure);
      options.autosave.resume();

      if (failure !== undefined) throw failure;
      return result as T;
    },
  };
}

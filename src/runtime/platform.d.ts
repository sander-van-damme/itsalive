/** Typed modules supplied by the shell runtime; no credential or coding capabilities. */
declare module "@itsalive/ai" {
  type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json };
  export function text(prompt: string): Promise<string>;
  export function decide(prompt: string, context?: Json): Promise<boolean>;
  export function choose<T extends string>(
    prompt: string,
    options: T[],
    context?: Json,
  ): Promise<T>;
  /** Returns a finite score from zero through levels.length - 1. */
  export function score(
    prompt: string,
    levels?: string[],
    context?: Json,
  ): Promise<number>;
}
declare module "@itsalive/store" {
  export type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json };
  export type DurableState = Record<string, Json>;
  export function useStore<T>(selector: (state: DurableState) => T): T;
  export function getState(): DurableState;
  export function setState(
    next: DurableState | ((previous: DurableState) => DurableState),
  ): void;
  export const store: {
    getState: typeof getState;
    getInitialState(): DurableState;
    setState(next: DurableState): void;
    subscribe(
      listener: (state: DurableState, previous: DurableState) => void,
    ): () => void;
  };
}

import runtimeSourceUrl from "../runtime/main.ts?worker&url";

let source: Promise<string> | undefined;

export function loadRuntimeSource(): Promise<string> {
  if (!source) {
    source = fetch(runtimeSourceUrl).then(async response => {
      if (!response.ok) throw new Error(`Could not load injected runtime source (${response.status})`);
      const text = await response.text();
      if (!text.trim()) throw new Error("Injected runtime source is empty");
      return text;
    });
  }
  return source;
}

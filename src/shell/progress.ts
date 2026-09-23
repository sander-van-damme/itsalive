import type { CodingLifecycleSummary } from "./core";

export function codingLifecycleLabel(summary: CodingLifecycleSummary, initialBuild: boolean): string {
  if (summary.phase === "planning") return initialBuild ? "Planning the first version…" : "Planning the change…";

  const regionWord = summary.total === 1 ? "region" : "regions";
  const ready = summary.total ? `${summary.ready}/${summary.total} ${regionWord} ready` : "Preparing the work";
  const needsAttention = summary.failed + summary.blocked;
  const active = summary.building + summary.repairing + summary.verifying;

  if (summary.phase === "integration-verification") {
    return needsAttention
      ? `${ready} · checking what still needs attention…`
      : `${ready} · checking everything together…`;
  }
  if (needsAttention) return `${ready} · ${needsAttention} ${needsAttention === 1 ? "needs" : "need"} attention…`;
  if (active) return `${ready} · ${active} still taking shape…`;
  if (summary.queued) return `${ready} · ${summary.queued} waiting…`;
  return `${ready} · checking everything together…`;
}

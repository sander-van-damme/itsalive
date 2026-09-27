import type { CodingLifecycleSummary } from "./core";

function countLabel(count: number, singular: string, plural = singular + "s"): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function codingLifecycleLabel(summary: CodingLifecycleSummary, initialBuild: boolean): string {
  if (summary.phase === "planning") return initialBuild ? "Planning the first version…" : "Planning the change…";
  if (!summary.total) return summary.phase === "integration-verification" ? "Checking the app…" : "Preparing the app…";

  const completed = `${summary.ready} of ${summary.total} ${summary.total === 1 ? "part" : "parts"} complete`;
  const active = summary.building + summary.repairing + summary.verifying;
  const attention = summary.failed + summary.blocked;

  if (summary.phase === "integration-verification") {
    return attention
      ? `Checking the app · ${completed} · ${countLabel(attention, "part")} ${attention === 1 ? "needs" : "need"} attention…`
      : `Checking the app · ${completed}…`;
  }

  const details: string[] = [];
  if (active) details.push(`${active} in progress`);
  if (summary.queued) details.push(`${summary.queued} waiting`);
  if (attention) details.push(`${countLabel(attention, "part")} ${attention === 1 ? "needs" : "need"} attention`);

  return `Building app · ${completed}${details.length ? " · " + details.join(" · ") : ""}…`;
}

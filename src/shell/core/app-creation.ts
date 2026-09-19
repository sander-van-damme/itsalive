import { deriveAppName } from "./app-metadata";
import type { ShellDatabase } from "./database";
import { appendHistory } from "./history";
import type { AppRecord } from "./types";

export async function persistNewApp(db: ShellDatabase, id: string, prompt: string, now = Date.now()): Promise<AppRecord> {
  const brief = prompt.trim();
  if (!brief) throw new Error("App brief cannot be empty");
  const app: AppRecord = { id, name: deriveAppName(brief), prompt: brief, createdAt: now, updatedAt: now };
  await db.apps.put(app);
  await appendHistory(db, { appId: id, timestamp: now, role: "user", kind: "chat", content: brief });
  return app;
}

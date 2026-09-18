import { dbAll, dbDelete, dbGet, dbSet, STORES } from "./db";
import type { LogEntry, ToolRecord } from "./types";

const validName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function createToolsApi(log: (level: LogEntry["level"], args: unknown[], source?: LogEntry["source"], stack?: string) => void) {
  return {
    async create(input: { name: string; description: string; parameters?: unknown; code: string }) {
      if (!validName.test(input.name)) throw new Error("Tool names must be 1-64 letters, numbers, underscores, or hyphens and start with a letter");
      if (!input.description.trim() || typeof input.code !== "string") throw new Error("Tool description and code are required");
      const existing = await dbGet<ToolRecord>(STORES.tools, input.name);
      const now = new Date().toISOString();
      const record: ToolRecord = { ...input, description: input.description.trim().slice(0, 240), createdAt: existing?.createdAt ?? now, updatedAt: now };
      // Compile before persisting, so syntax errors cannot poison the registry.
      compile(record);
      await dbSet(STORES.tools, record.name, record);
      return { name: record.name, description: record.description, parameters: record.parameters };
    },
    async get(name: string) { return dbGet<ToolRecord>(STORES.tools, name); },
    async search(query = "") {
      const needle = query.toLocaleLowerCase();
      const rows = await dbAll<ToolRecord>(STORES.tools);
      return rows.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(needle))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
    async call(name: string, args: unknown = {}) {
      const record = await dbGet<ToolRecord>(STORES.tools, name);
      if (!record) throw new Error(`Unknown tool: ${name}`);
      try {
        const tool = await compile(record);
        return await tool(args, { itsalive: window.itsalive, document, window, fetch });
      } catch (error) {
        log("error", [`Tool ${name} failed`, error], "tool", error instanceof Error ? error.stack : undefined);
        throw error;
      }
    },
    async delete(name: string) { await dbDelete(STORES.tools, name); },
  };
}

async function compile(record: ToolRecord): Promise<(args: unknown, env: unknown) => unknown> {
  const factory = new Function(`"use strict";\n${record.code}`);
  const result = factory();
  if (typeof result !== "function") throw new Error(`Tool ${record.name} code must return a function`);
  return result;
}

export const MAX_APP_NAME_LENGTH = 60;

export function validateAppName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('App name must be text');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('App name cannot be empty');
  if (name.length > MAX_APP_NAME_LENGTH) throw new Error(`App name must be ${MAX_APP_NAME_LENGTH} characters or fewer`);
  return name;
}

export function renameAppRecord<T extends { id: string; name: string; updatedAt: number }>(app: T, value: unknown, now = Date.now()): T {
  return { ...app, name: validateAppName(value), updatedAt: now };
}


const APP_INTENT_PREFIX = /^(?:please\s+)?(?:i\s+(?:want|would\s+like|need)\s+(?:(?:an?|the)\s+)?(?:(?:app|application|tool)\s+)?(?:(?:that|which|to)\s+)?|(?:build|make|create|design)\s+(?:me\s+)?(?:an?\s+)?|an?\s+(?:app|application|tool)\s+(?:(?:that|which|to)\s+)?)/i;
const LEADING_HELPER = /^(?:that\s+)?(?:teaches?|helps?|shows?|gives?|lets?|allows?)\s+(?:me|us|users?|people)\s+/i;
const TITLE_STOP_WORDS = new Set(["a","an","the","my","our","your","and","or","for","to","of","in","on","with","that","this","app","application","tool","build","make","create","design"]);

export function deriveAppName(goal: string): string {
  const compact = goal.replace(/\s+/g, " ").trim();
  if (!compact) return "New app";
  let subject = compact.replace(APP_INTENT_PREFIX, "").replace(LEADING_HELPER, "").trim();
  subject = subject.replace(/^(?:build|make|create|design)\s+(?:me\s+)?(?:an?\s+)?/i, "").trim();
  const clause = subject.split(/[,.!?;]/, 1)[0]?.trim() || subject;
  const words = clause.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const meaningful = words.filter(word => !TITLE_STOP_WORDS.has(word.toLocaleLowerCase())).slice(0, 4);
  const chosen = meaningful.length ? meaningful : words.slice(0, 4);
  if (!chosen.length) return "New app";
  const title = chosen.map(word => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ").slice(0, MAX_APP_NAME_LENGTH).trim();
  return title || "New app";
}

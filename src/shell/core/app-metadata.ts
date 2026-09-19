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

const CREATION_PREFIXES = [
  /^(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:build|make|create|design)\s+(?:me\s+)?(?:(?:an?|the)\s+)?(?:(?:app|application|tool|something)\s+)?(?:(?:that|which|to|for)\s+)?/i,
  /^(?:please\s+)?help\s+me\s+(?:build|make|create|design)\s+(?:me\s+)?(?:(?:an?|the)\s+)?(?:(?:app|application|tool|something)\s+)?(?:(?:that|which|to|for)\s+)?/i,
  /^(?:please\s+)?i\s+(?:want|would\s+like|need)\s+(?:(?:you\s+)?to\s+)?(?:(?:build|make|create|design)\s+(?:me\s+)?)?(?:(?:an?|the)\s+)?(?:(?:app|application|tool|something)\s+)?(?:(?:that|which|to|for)\s+)?/i,
  /^(?:please\s+)?(?:build|make|create|design)\s+(?:me\s+)?(?:(?:an?|the)\s+)?(?:(?:app|application|tool|something)\s+)?(?:(?:that|which|to|for)\s+)?/i,
  /^(?:an?|the)\s+(?:app|application|tool)\s+(?:(?:that|which|to|for)\s+)?/i,
];

const HELPER_PREFIXES = [
  /^(?:that\s+)?(?:helps?|teaches?|shows?|gives?)\s+(?:me|us|users?|people)\s+(?:(?:with|to)\s+)?/i,
  /^(?:that\s+)?helps?\s+(?:with|to)\s+/i,
  /^(?:that\s+)?(?:lets?|allows?)\s+(?:me|us|users?|people)\s+(?:to\s+)?/i,
];

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'that', 'this',
  'app', 'application', 'tool', 'something', 'build', 'make', 'create', 'design', 'me', 'us', 'users', 'people',
]);

const ACTION_TITLE_RULES: Array<{ pattern: RegExp; suffix: string }> = [
  { pattern: /^(?:learn|learning|study|studying)\s+(.+)$/i, suffix: 'Trainer' },
  { pattern: /^(?:track|tracking)\s+(.+)$/i, suffix: 'Tracker' },
  { pattern: /^(?:plan|planning)\s+(.+)$/i, suffix: 'Planner' },
  { pattern: /^(?:organize|organizing)\s+(.+)$/i, suffix: 'Organizer' },
  { pattern: /^(?:manage|managing)\s+(.+)$/i, suffix: 'Manager' },
];

function stripCreationIntent(value: string): string {
  let subject = value;
  for (let pass = 0; pass < 3; pass++) {
    const before = subject;
    for (const prefix of CREATION_PREFIXES) subject = subject.replace(prefix, '').trim();
    for (const prefix of HELPER_PREFIXES) subject = subject.replace(prefix, '').trim();
    subject = subject.replace(/^(?:how\s+to|a\s+way\s+to)\s+/i, '').trim();
    if (subject === before) break;
  }
  return subject;
}

function wordsFrom(value: string): string[] {
  return (value.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [])
    .filter(word => !TITLE_STOP_WORDS.has(word.toLocaleLowerCase()));
}

function titleCaseWord(word: string): string {
  if (word.length > 1 && word === word.toLocaleUpperCase()) return word;
  return word.charAt(0).toLocaleUpperCase() + word.slice(1);
}

function singularizeCompoundNoun(word: string): string {
  const lower = word.toLocaleLowerCase();
  if (lower === 'news' || lower === 'series' || lower === 'species') return word;
  if (lower.length > 4 && lower.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|sses)$/i.test(word)) return word.slice(0, -2);
  if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function formatTitle(words: string[]): string {
  return words.map(titleCaseWord).join(' ').slice(0, MAX_APP_NAME_LENGTH).trim();
}

function deriveActionTitle(subject: string): string | undefined {
  for (const rule of ACTION_TITLE_RULES) {
    const match = subject.match(rule.pattern);
    if (!match?.[1]) continue;
    const topicWords = wordsFrom(match[1]).slice(0, 3);
    if (!topicWords.length) continue;
    topicWords[topicWords.length - 1] = singularizeCompoundNoun(topicWords[topicWords.length - 1]!);
    if (topicWords.at(-1)?.toLocaleLowerCase() !== rule.suffix.toLocaleLowerCase()) topicWords.push(rule.suffix);
    return formatTitle(topicWords);
  }
  return undefined;
}

export function deriveAppName(goal: string): string {
  const compact = goal.replace(/\s+/g, ' ').trim();
  if (!compact) return 'New app';

  const subject = stripCreationIntent(compact);
  const clause = subject.split(/[,.!?;]/, 1)[0]?.trim() || subject;
  const actionTitle = deriveActionTitle(clause);
  if (actionTitle) return actionTitle;

  const meaningful = wordsFrom(clause).slice(0, 4);
  const fallback = meaningful.length ? meaningful : wordsFrom(compact).slice(0, 4);
  const title = formatTitle(fallback);
  return title || 'New app';
}

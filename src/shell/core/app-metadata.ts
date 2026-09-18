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

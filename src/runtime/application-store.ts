export type ApplicationStore = Record<string, unknown>;

export interface ApplicationStoreController {
  readonly store: ApplicationStore;
  restore(snapshot: string): void;
  snapshot(): string;
  setOnDirty(callback: () => void): void;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDurableValue(value: unknown, path = "application.store", stack = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} only accepts finite numbers`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} only accepts JSON-like values`);
  }
  if (stack.has(value)) throw new TypeError(`${path} cannot contain circular references`);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(`${path} only accepts arrays and plain objects`);
  }

  stack.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDurableValue(entry, `${path}[${index}]`, stack));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertDurableValue(entry, `${path}.${key}`, stack);
    }
  }
  stack.delete(value);
}

function createProxy(
  target: object,
  markDirty: () => void,
  cache: WeakMap<object, object>,
): object {
  const existing = cache.get(target);
  if (existing) return existing;

  const proxy = new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (value && typeof value === "object" && (Array.isArray(value) || isPlainObject(value))) {
        return createProxy(value, markDirty, cache);
      }
      return value;
    },
    set(current, property, value, receiver) {
      assertDurableValue(value, `application.store.${String(property)}`);
      const previous = Reflect.get(current, property, receiver);
      const changed = !Object.is(previous, value);
      const result = Reflect.set(current, property, value, receiver);
      if (result && changed) markDirty();
      return result;
    },
    deleteProperty(current, property) {
      const existed = Reflect.has(current, property);
      const result = Reflect.deleteProperty(current, property);
      if (result && existed) markDirty();
      return result;
    },
    defineProperty(current, property, descriptor) {
      if ("get" in descriptor || "set" in descriptor) {
        throw new TypeError("application.store does not support accessor properties");
      }
      if ("value" in descriptor) {
        assertDurableValue(descriptor.value, `application.store.${String(property)}`);
      }
      const result = Reflect.defineProperty(current, property, descriptor);
      if (result) markDirty();
      return result;
    },
    setPrototypeOf() {
      throw new TypeError("application.store does not support prototype changes");
    },
  });

  cache.set(target, proxy);
  return proxy;
}

export function createApplicationStore(): ApplicationStoreController {
  const root = Object.create(null) as ApplicationStore;
  const cache = new WeakMap<object, object>();
  let onDirty: () => void = () => undefined;
  let dirty = false;
  let restoring = false;

  const markDirty = () => {
    if (restoring) return;
    dirty = true;
    onDirty();
  };

  const store = createProxy(root, markDirty, cache) as ApplicationStore;

  return {
    store,
    restore(snapshot: string) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshot);
      } catch {
        throw new TypeError("Persisted application.store is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !isPlainObject(parsed)) {
        throw new TypeError("Persisted application.store root must be an object");
      }
      assertDurableValue(parsed);

      restoring = true;
      try {
        for (const key of Object.keys(root)) Reflect.deleteProperty(root, key);
        for (const [key, value] of Object.entries(parsed)) Reflect.set(root, key, value);
        dirty = false;
      } finally {
        restoring = false;
      }
    },
    snapshot() {
      assertDurableValue(root);
      return JSON.stringify(root);
    },
    setOnDirty(callback: () => void) {
      onDirty = callback;
      if (dirty) callback();
    },
  };
}

/** Portable structured-clone graph. No eval, constructors from input, or prototype assignment. */
export type EncodedGraph = { root: Atom; nodes: Node[] };
type Atom =
  | null
  | boolean
  | string
  | number
  | { ref: number }
  | {
      scalar: "undefined" | "nan" | "infinity" | "-infinity" | "-0" | "bigint";
      value?: string;
    };
type Node = {
  type: string;
  value?: unknown;
  entries?: [Atom, Atom][];
  values?: Atom[];
  properties?: [string, Atom][];
  mime?: string;
  name?: string;
  lastModified?: number;
};
const byteLimit = 128 * 1024 * 1024;
function base64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 24576)
    result += btoa(
      String.fromCharCode(...bytes.subarray(offset, offset + 24576)),
    );
  return result;
}
function unbase64(value: string): Uint8Array {
  if (
    value.length > byteLimit * 1.4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4
  )
    throw new Error("Invalid binary backup value");
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
export async function encodeGraph(input: unknown): Promise<EncodedGraph> {
  const nodes: Node[] = [];
  const seen = new Map<object, number>();
  async function encode(value: unknown): Promise<Atom> {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return value;
    if (typeof value === "number")
      return Number.isNaN(value)
        ? { scalar: "nan" }
        : value === Infinity
          ? { scalar: "infinity" }
          : value === -Infinity
            ? { scalar: "-infinity" }
            : Object.is(value, -0)
              ? { scalar: "-0" }
              : value;
    if (value === undefined) return { scalar: "undefined" };
    if (typeof value === "bigint")
      return { scalar: "bigint", value: String(value) };
    if (typeof value !== "object")
      throw new Error(`Unsupported stored value: ${typeof value}`);
    const existing = seen.get(value);
    if (existing !== undefined) return { ref: existing };
    if (nodes.length > 1_000_000)
      throw new Error("Backup graph exceeds node limit");
    const ref = nodes.length;
    seen.set(value, ref);
    const node: Node = { type: "" };
    nodes.push(node);
    if (value instanceof Date) {
      node.type = "Date";
      node.value = value.getTime();
    } else if (value instanceof RegExp) {
      node.type = "RegExp";
      node.value = [value.source, value.flags];
    } else if (value instanceof Blob) {
      if (value.size > byteLimit)
        throw new Error("A stored file exceeds the 128 MiB backup limit");
      node.type = "Blob";
      node.value = base64(new Uint8Array(await value.arrayBuffer()));
      node.mime = value.type;
      if (typeof File !== "undefined" && value instanceof File) {
        node.type = "File";
        node.name = value.name;
        node.lastModified = value.lastModified;
      }
    } else if (value instanceof ArrayBuffer) {
      if (value.byteLength > byteLimit)
        throw new Error("Stored buffer exceeds backup limit");
      node.type = "ArrayBuffer";
      node.value = base64(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      node.type =
        value instanceof DataView ? "DataView" : value.constructor.name;
      node.values = [await encode(value.buffer)];
      node.value = [value.byteOffset, value.byteLength];
    } else if (value instanceof Map) {
      node.type = "Map";
      node.entries = [];
      for (const [k, v] of value)
        node.entries.push([await encode(k), await encode(v)]);
    } else if (value instanceof Set) {
      node.type = "Set";
      node.values = [];
      for (const v of value) node.values.push(await encode(v));
    } else if (Array.isArray(value)) {
      node.type = "Array";
      node.value = value.length;
      node.properties = [];
      for (const key of Object.keys(value))
        node.properties.push([key, await encode(value[Number(key)])]);
    } else if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      node.type = "Object";
      node.properties = [];
      for (const [key, v] of Object.entries(value))
        node.properties.push([key, await encode(v)]);
    } else
      throw new Error(
        `Unsupported structured-clone type: ${Object.prototype.toString.call(value)}`,
      );
    return { ref };
  }
  return { root: await encode(input), nodes };
}
const typedArrays: Record<
  string,
  {
    new (
      buffer: ArrayBuffer,
      byteOffset: number,
      length: number,
    ): ArrayBufferView;
    BYTES_PER_ELEMENT: number;
  }
> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
export function decodeGraph(graph: EncodedGraph): unknown {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length > 1_000_000)
    throw new Error("Invalid backup graph");
  const objects: unknown[] = [];
  const building = new Set<number>();
  function decode(atom: Atom): unknown {
    if (
      atom === null ||
      typeof atom === "boolean" ||
      typeof atom === "string" ||
      typeof atom === "number"
    )
      return atom;
    if (!atom || typeof atom !== "object")
      throw new Error("Invalid graph atom");
    if ("scalar" in atom) {
      switch (atom.scalar) {
        case "undefined":
          return undefined;
        case "nan":
          return NaN;
        case "infinity":
          return Infinity;
        case "-infinity":
          return -Infinity;
        case "-0":
          return -0;
        case "bigint":
          if (typeof atom.value !== "string" || !/^-?\d+$/.test(atom.value))
            throw new Error("Invalid bigint");
          return BigInt(atom.value);
        default:
          throw new Error("Invalid scalar");
      }
    }
    const id = atom.ref;
    if (!Number.isInteger(id) || id < 0 || id >= graph.nodes.length)
      throw new Error("Invalid graph reference");
    if (id in objects) return objects[id];
    if (building.has(id)) throw new Error("Invalid circular buffer reference");
    building.add(id);
    const node = graph.nodes[id]!;
    if (!node || typeof node.type !== "string")
      throw new Error("Invalid graph node");
    let result: unknown;
    switch (node.type) {
      case "Object":
        result = {};
        break;
      case "Array":
        if (
          !Number.isInteger(node.value) ||
          (node.value as number) < 0 ||
          (node.value as number) > 10_000_000
        )
          throw new Error("Invalid array length");
        result = new Array(node.value as number);
        break;
      case "Date":
        result = new Date(node.value as number);
        break;
      case "RegExp": {
        const [source, flags] = node.value as string[];
        result = new RegExp(source!, flags);
        break;
      }
      case "Map":
        result = new Map();
        break;
      case "Set":
        result = new Set();
        break;
      case "ArrayBuffer":
        result = unbase64(String(node.value)).buffer;
        break;
      case "Blob":
        result = new Blob([unbase64(String(node.value)) as BlobPart], {
          type: node.mime,
        });
        break;
      case "File":
        result = new File(
          [unbase64(String(node.value)) as BlobPart],
          node.name ?? "",
          { type: node.mime, lastModified: node.lastModified },
        );
        break;
      default: {
        const [offset, length] = node.value as number[];
        const buffer = decode(node.values![0]!) as ArrayBuffer;
        if (
          !(buffer instanceof ArrayBuffer) ||
          !Number.isInteger(offset) ||
          !Number.isInteger(length)
        )
          throw new Error("Invalid binary view");
        if (node.type === "DataView")
          result = new DataView(buffer, offset, length);
        else {
          const constructor = typedArrays[node.type];
          if (!constructor)
            throw new Error(`Unsupported graph node: ${node.type}`);
          result = new constructor(
            buffer,
            offset!,
            length! / constructor.BYTES_PER_ELEMENT,
          );
        }
      }
    }
    objects[id] = result;
    building.delete(id);
    if (node.type === "Object" || node.type === "Array") {
      if (!Array.isArray(node.properties))
        throw new Error("Invalid object properties");
      for (const [key, value] of node.properties) {
        if (
          typeof key !== "string" ||
          (node.type === "Array" && key === "length")
        )
          throw new Error("Invalid property");
        Object.defineProperty(result, key, {
          value: decode(value),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    if (node.type === "Map") {
      if (!Array.isArray(node.entries)) throw new Error("Invalid map");
      for (const [k, v] of node.entries)
        (result as Map<unknown, unknown>).set(decode(k), decode(v));
    }
    if (node.type === "Set") {
      if (!Array.isArray(node.values)) throw new Error("Invalid set");
      for (const value of node.values)
        (result as Set<unknown>).add(decode(value));
    }
    return result;
  }
  return decode(graph.root);
}

import type { BuildArtifact } from "../shared/types";

type ModuleExports = Record<string, unknown>;
interface Module {
  exports: ModuleExports;
}
export interface RefreshHooks {
  register(value: unknown, id: string): void;
  signature(): unknown;
}

/** CommonJS is only the in-memory execution format. The project remains ordinary TS/ESM. */
export class ModuleGraph {
  private cache = new Map<string, Module>();
  private imports = new Map<string, Set<string>>();

  constructor(
    private artifact: BuildArtifact,
    private readonly builtins: Record<string, unknown>,
    private readonly refresh: RefreshHooks,
  ) {}

  update(artifact: BuildArtifact): number {
    const changed = new Set(
      Object.keys(this.artifact.modules).filter(
        (id) => this.artifact.modules[id]?.hash !== artifact.modules[id]?.hash,
      ),
    );
    for (const id of Object.keys(artifact.modules))
      if (!this.artifact.modules[id]) changed.add(id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, deps] of this.imports) {
        if (!changed.has(id) && [...deps].some((dep) => changed.has(dep))) {
          changed.add(id);
          grew = true;
        }
      }
    }
    for (const id of changed) {
      this.cache.delete(id);
      this.imports.delete(id);
    }
    this.artifact = artifact;
    return changed.size;
  }

  load(id: string): ModuleExports {
    if (Object.hasOwn(this.builtins, id))
      return this.builtins[id] as ModuleExports;
    const cached = this.cache.get(id);
    if (cached) return cached.exports;
    const source = this.artifact.modules[id];
    if (!source)
      throw new Error(
        `Module not found: ${id}. Recompile the complete project dependency graph.`,
      );
    const module: Module = { exports: {} };
    this.cache.set(id, module); // CommonJS cycles receive the partially initialized export object.
    const deps = new Set<string>();
    this.imports.set(id, deps);
    const require = (specifier: string): unknown => {
      deps.add(specifier);
      return this.load(specifier);
    };
    try {
      const execute = new Function(
        "module",
        "exports",
        "require",
        "$RefreshReg$",
        "$RefreshSig$",
        `${source.code}\n//# sourceURL=itsalive:///${id.replace(/[\r\n]/g, "")}`,
      );
      execute(
        module,
        module.exports,
        require,
        (value: unknown, name: string) =>
          this.refresh.register(value, `${id} ${name}`),
        () => this.refresh.signature(),
      );
      return module.exports;
    } catch (error) {
      this.cache.delete(id);
      throw error;
    }
  }
}

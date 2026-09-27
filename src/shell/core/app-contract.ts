export interface AppSharedContract {
  ref: string;
  /** Stable cross-scope application.store fields with compact type/meaning descriptions. */
  state: string[];
  /** application.store namespaces intentionally shared across worker scopes. */
  stores: string[];
  /** Stable DOM ids that later modifications/repairs should reuse rather than reinvent. */
  stableDomIds: string[];
  /** Other cross-worker semantics that must remain stable across replans. */
  semantics: string[];
}

export interface AppTechnicalContract {
  revision: number;
  shared: AppSharedContract;
}

export type SharedContractChangeKind = "reference" | "store" | "state" | "dom" | "semantic";

export interface SharedContractChange {
  kind: SharedContractChangeKind;
  /** Machine-readable target such as application.store.sharedStore.movies or #movie-shortlist. */
  path: string;
  description: string;
  from?: string;
  to?: string;
}

export interface CodingContractChange {
  reason: string;
  affectedScopes: string[];
  changes: SharedContractChange[];
}

export interface SharedContractDiff {
  reference: boolean;
  state: boolean;
  stores: boolean;
  dom: boolean;
  semantic: boolean;
}

function normalizedList(values: readonly string[]): string[] {
  return values.map(value => value.trim()).filter(Boolean);
}

function comparableList(values: readonly string[]): string[] {
  return [...new Set(normalizedList(values))].sort();
}

export function normalizeAppSharedContract(contract: AppSharedContract): AppSharedContract {
  return {
    ref: contract.ref.trim(),
    state: normalizedList(contract.state),
    stores: [...new Set(normalizedList(contract.stores))],
    stableDomIds: [...new Set(normalizedList(contract.stableDomIds))],
    semantics: normalizedList(contract.semantics),
  };
}

export function normalizeAppTechnicalContract(contract: AppTechnicalContract): AppTechnicalContract {
  return {
    revision: Math.max(1, Math.floor(contract.revision)),
    shared: normalizeAppSharedContract(contract.shared),
  };
}

export function sharedContractDiff(
  established: AppSharedContract,
  proposed: AppSharedContract,
): SharedContractDiff {
  const left = normalizeAppSharedContract(established);
  const right = normalizeAppSharedContract(proposed);
  return {
    reference: left.ref !== right.ref,
    state: JSON.stringify(comparableList(left.state)) !== JSON.stringify(comparableList(right.state)),
    stores: JSON.stringify(comparableList(left.stores)) !== JSON.stringify(comparableList(right.stores)),
    dom: JSON.stringify(comparableList(left.stableDomIds)) !== JSON.stringify(comparableList(right.stableDomIds)),
    semantic: JSON.stringify(comparableList(left.semantics)) !== JSON.stringify(comparableList(right.semantics)),
  };
}

export function sharedContractsEqual(
  established: AppSharedContract,
  proposed: AppSharedContract,
): boolean {
  const diff = sharedContractDiff(established, proposed);
  return !diff.reference && !diff.state && !diff.stores && !diff.dom && !diff.semantic;
}

export function technicalContractForPlan(
  established: AppTechnicalContract | undefined,
  proposed: AppSharedContract,
): AppTechnicalContract {
  const shared = normalizeAppSharedContract(proposed);
  if (!established) return { revision: 1, shared };
  const normalizedEstablished = normalizeAppTechnicalContract(established);
  if (sharedContractsEqual(normalizedEstablished.shared, shared)) return established;
  return { revision: normalizedEstablished.revision + 1, shared };
}

export function contractChangeCoversDiff(
  change: CodingContractChange,
  diff: SharedContractDiff,
): boolean {
  const kinds = new Set(change.changes.map(entry => entry.kind));
  return (!diff.reference || kinds.has("reference"))
    && (!diff.state || kinds.has("state"))
    && (!diff.stores || kinds.has("store"))
    && (!diff.dom || kinds.has("dom"))
    && (!diff.semantic || kinds.has("semantic"));
}

export interface AppSharedContract {
  ref: string;
  state: string[];
  stores: string[];
}

export interface AppTechnicalContract {
  revision: number;
  shared: AppSharedContract;
}

export type SharedContractChangeKind = "reference" | "store" | "state" | "dom" | "semantic";

export interface SharedContractChange {
  kind: SharedContractChangeKind;
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
  };
}

export function sharedContractsEqual(
  established: AppSharedContract,
  proposed: AppSharedContract,
): boolean {
  const diff = sharedContractDiff(established, proposed);
  return !diff.reference && !diff.state && !diff.stores;
}

export function technicalContractForPlan(
  established: AppTechnicalContract | undefined,
  proposed: AppSharedContract,
): AppTechnicalContract {
  const shared = normalizeAppSharedContract(proposed);
  if (!established) return { revision: 1, shared };
  if (sharedContractsEqual(established.shared, shared)) return established;
  return { revision: Math.max(1, Math.floor(established.revision)) + 1, shared };
}

export function contractChangeCoversDiff(
  change: CodingContractChange,
  diff: SharedContractDiff,
): boolean {
  const kinds = new Set(change.changes.map(entry => entry.kind));
  return (!diff.reference || kinds.has("reference"))
    && (!diff.state || kinds.has("state"))
    && (!diff.stores || kinds.has("store"));
}

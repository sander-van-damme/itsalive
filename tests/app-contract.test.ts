import { describe, expect, it } from "vitest";
import {
  contractChangeCoversDiff,
  sharedContractDiff,
  sharedContractsEqual,
  technicalContractForPlan,
  type AppSharedContract,
} from "../src/shell/core/app-contract";

const movieContract: AppSharedContract = {
  ref: "movie-v1",
  stores: ["sharedStore"],
  state: [
    "application.store.sharedStore.movies: array of { id, title, genre, durationMin }",
    "application.store.sharedStore.tonightId: movie id or null",
  ],
  stableDomIds: ["movie-night-app", "add-movie-form", "movie-shortlist", "tonight-section"],
  semantics: ["durationMin is a whole number of minutes"],
};

describe("app technical contract", () => {
  it("keeps the same revision when a replan preserves the canonical contract", () => {
    const established = technicalContractForPlan(undefined, movieContract);
    const repeated = technicalContractForPlan(established, {
      ...movieContract,
      stores: ["sharedStore"],
      stableDomIds: [...movieContract.stableDomIds].reverse(),
    });

    expect(repeated).toBe(established);
    expect(repeated.revision).toBe(1);
    expect(sharedContractsEqual(established.shared, repeated.shared)).toBe(true);
  });

  it("increments exactly once when a declared shared contract actually changes", () => {
    const established = technicalContractForPlan(undefined, movieContract);
    const proposed: AppSharedContract = {
      ...movieContract,
      state: [
        ...movieContract.state,
        "application.store.sharedStore.ratingByMovieId: object mapping movie ids to 1..5",
      ],
      semantics: [...movieContract.semantics, "ratings are integers from 1 through 5"],
    };
    const diff = sharedContractDiff(established.shared, proposed);

    expect(diff).toMatchObject({ state: true, semantic: true, stores: false, dom: false, reference: false });
    expect(contractChangeCoversDiff({
      reason: "Add ratings",
      affectedScopes: ["#movie-shortlist"],
      changes: [
        { kind: "state", path: "application.store.sharedStore.ratingByMovieId", description: "Add persisted ratings" },
        { kind: "semantic", path: "rating", description: "Ratings use integer values 1 through 5" },
      ],
    }, diff)).toBe(true);

    const revised = technicalContractForPlan(established, proposed);
    expect(revised.revision).toBe(2);
    expect(revised.shared.state).toContain("application.store.sharedStore.ratingByMovieId: object mapping movie ids to 1..5");
  });
});

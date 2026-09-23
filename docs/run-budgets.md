# Agent run budgets

The coding runner no longer uses a normal turn limit. Turns are telemetry.

A run stops because it completes, is cancelled, reaches its working-time or idle budget, reaches a configured dollar budget, repeatedly fails, stalls without changing the app, or reaches the 1000-turn emergency runaway guard.

## Cost semantics

Provider-reported cost is accumulated after every generation. A configured dollar cap is strict: once the accumulated spend reaches the cap, the run stops and already-applied changes are preserved.

Missing provider cost is never treated as zero. When a dollar cap is active, the first request without reliable cost stops with `cost-unknown`. When no dollar cap is configured, unknown-cost requests may continue under the time/progress safety budgets and remain visible in telemetry.

## Parent and child budgets

`RunBudgetController.fork()` creates a controller with local worker limits while sharing the root cost ledger. Future parallel workers therefore contribute to the same parent spend. A child may have a stricter local cap, but it cannot hide spend from the manager/root budget.

## Failure and progress budgets

Generation, runtime, and completion-verification failures have independent consecutive counters. Successful work resets the corresponding counter. Repeated low-signal verification uses the stall budget.

The emergency turn ceiling is intentionally very high and exists only as a final runaway guard. Product behavior must not depend on reaching it.

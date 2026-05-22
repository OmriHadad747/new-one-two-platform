# Runtime example: `compute_workflow`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { workflow } from "../lib/workflow.js";

// One-shot lifecycle: atomic claim → run callback → mark complete (or
// persist failure_reason and re-throw on callback error). Returns
// `null` immediately when the row is already claimed / in the wrong
// state / missing — callback NEVER runs in that case.
const result = await workflow.attempt<RuleRun, void>(
  "rule_runs",
  runId,
  { from: "pending" },
  async (row) => {
    // Side effects here. If this throws, helper persists status='failed'
    // with err.message (truncated) and re-throws so the cron-runner sees it.
    await processRow(row);
  },
);
if (!result) return; // someone else claimed it

// Primitives for non-canonical flows (multi-step, branching terminals):
const claimed = await workflow.claim<Approval>(
  "approvals",
  approvalId,
  { from: "draft", to: "submitted" },
);
if (!claimed) return;
// … do work …
await workflow.complete("approvals", approvalId, { to: "approved" });
// or:
await workflow.fail("approvals", approvalId, "policy violation: …");

// Stale sweeper — call from a low-frequency cron tick (every ~10 min):
const swept = await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
console.log(JSON.stringify({ event: "sweep", count: swept.count }));
```

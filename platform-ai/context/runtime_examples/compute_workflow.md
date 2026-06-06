# Helper: `workflow`

Use the `workflow` helper for every multi-state row lifecycle (`pending → running
→ done/failed`, `draft → submitted → approved`, …). Storage: the table needs a
`status TEXT` column; optional `started_at`/`finished_at TIMESTAMPTZ`,
`failure_reason TEXT` are written when present. State names are yours.

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
    await processRow(row); // side effects; on throw → status='failed' + re-throw
  },
);
if (!result) return; // someone else claimed it

// Primitives for non-canonical flows (multi-step, branching terminals):
const claimed = await workflow.claim<Approval>(
  "approvals", approvalId, { from: "draft", to: "submitted" },
);
if (!claimed) return;
await workflow.complete("approvals", approvalId, { to: "approved" });
// or: await workflow.fail("approvals", approvalId, "policy violation: …");

// Stale sweeper — call from a low-frequency cron tick (every ~10 min):
const swept = await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
```

Rules:
- Wrap the work in `workflow.attempt(...)` — do NOT hand-roll
  `claim → try/catch → update`. The helper persists `failure_reason` and
  re-throws so the cron-runner can retry.
- Custom state names are fine: `claim(t, id, { from: "approved", to: "shipped" })`.
- **Every** workflow-bearing table needs a `sweepStale` cron (e.g. `*/10 * * * *`),
  or crashed rows stay `running` forever.

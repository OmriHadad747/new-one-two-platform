# Platform helpers — index

The template ships finished helpers under `scaffold/src/lib/`. **Import and reuse
them — never re-implement what a helper already does.** This is the menu of every
platform primitive; read the linked detail doc (via `read_file`) for the API and
rules of the one you're using.

| Primitive | Use it for | Import | Detail doc |
|---|---|---|---|
| **workflow** | any multi-state row lifecycle (`pending→running→done/failed`) | `workflow` from `../lib/workflow.js` | `context/runtime_examples/compute_workflow.md` |
| **config** | any app setting (rate, threshold, toggle) — no settings table | `config` from `../lib/config.js` | `context/runtime_examples/compute_config.md` |
| **money** | any monetary value (currency-correct minor-unit math) | `money` from `../lib/money.js` | `context/runtime_examples/compute_money.md` |
| **paginate** | any offset-paginated list route | `paginate` from `../lib/paginate.js` | `context/runtime_examples/paginate_offset.md` |
| **queue** | offload heavy work off the request path (background jobs) | `enqueueJob` from `../lib/cron-enqueue.js` | `context/runtime_examples/enqueue.md` |
| **email** | send transactional email | `platform` from `../lib/platform.js` (`platform.email.send`) | `context/runtime_examples/email_send.md` (+ `email_send_batch.md`) |
| **files** | store / serve a file | `platform` from `../lib/platform.js` (`platform.files.upload`) | `context/runtime_examples/files_upload_small.md` (+ `files_upload_large.md`) |
| **db** | query the tenant DB | `sql` from `../lib/db.js` | `context/component_rules/db.md` |
| **shopify ops** | any Shopify Admin/Storefront GraphQL, bulk, Ajax | `shopifyClientFor` from `../lib/shopify.js` | catalog tools (`get_shopify_op`) + `context/runtime_examples/shopify_*.md` |

How each primitive is signalled in the HLD plan (so the coding agent reuses it):
- workflow / config / money / paginate → the capability flags
  `usesWorkflow` / `usesConfig` / `touchesMoney` / `returnsList`.
- queue → a `schedule` trigger (`cron:<job>`) that the work is offloaded to.
- email → a capability with `integration: "email"`.
- shopify ops → the capability's `shopifySteps` (resolved op sequence).
- files / db → described in the capability / persistence (no dedicated flag).

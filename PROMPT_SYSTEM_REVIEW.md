# Prompt System Review — post-restructure

Snapshot after commits `55dad28` (consolidate into core / topics / capabilities) and `582a5d0` (platform.* SDK integration).

## Current shape

```
platform-ai/subagents/prompts/
  core/                       always-on per-agent system prompts
    architect.py, handler(→topics), validator.py, revision.py,
    migration.py, product.py, explanation.py, admin.py, widget.py
  topics/                     JIT-injected by handler/architect agents
    handler.py, webhook.py, cron.py, admin_ui.py, widget.py,
    state_machine.py, db_contracts.py, shopify_loop.py,
    shopify_rest_vs_graphql.py
  capabilities/               JIT-injected per declared capability
    email.py, files.py, npm.py,
    shopify_rest.py, shopify_graphql.py, shopify_storefront.py
```

Three tiers. `core/` is always in the prompt. `topics/` are conditional on the architect plan (has webhook topics? has cron? has state machine?). `capabilities/` are conditional on declared `handlerCapabilities`. This matches what a JIT prompt system should look like.

## What's working well

- **Clean separation of concerns.** Per-agent core is stable; topics and capabilities move independently.
- **Webhook promotion propagated correctly.** Every grep result points at `webhook-handlers.ts`. No stale references to `webhook.ts` (the template-owned file) asking the generator to edit it.
- **`platform.*` SDK is the canonical call pattern.** Email capability doc shows `platform.email.send` + `QuotaExceeded` try/catch, not manual 3-branch status checks. Handler topic explicitly says *"Do NOT import or call callPlatformService directly"*.
- **Files capability is honest about the gap.** `files.py` documents that `callPlatformService` is the right call *until* a `platform.files` wrapper ships. No pretending the SDK exists.
- **Cross-agent agreement on file contracts.** Validator, revision, and handler all reference the same export names (`webhookHandlers`, `adminRouter`, `widgetRouter`) and the same file paths.

## Remaining small items (low severity)

1. **Files capability will drift once `/services/files/upload` ships.** The moment a `platform.files.upload` wrapper lands in `platform.ts`, `capabilities/files.py` needs to flip from `callPlatformService` to the SDK call, same as email did. Worth adding a TODO comment at the top of that file so it's not missed.

2. **No static-validator gate for the email-metadata sidecar.** The capability doc says handler must emit the JSON sidecar when email is declared; if the generator forgets, nothing blocks deploy. Low priority (one bad gen, caught by merchant testing) but cheap to add a regex check.

3. **`topics/shopify_loop.py:117`** describes *"a large enrichment"* in webhook-handlers.ts — this phrasing is a validator Q-check reference. Works, but slightly cryptic to a generator reading only topics. Consider making it concrete: *"e.g. a per-event Shopify lookup inside a webhook handler body"*.

4. **`topics/handler.py:265` and `:322`** still reference `callPlatformService directly for /services/files/upload` — consistent with the honest `files.py` caveat but will need a coordinated update when the wrapper lands. Tracking these in one `TODO(platform.files)` grep makes the future change a one-shot edit.

## Architecture decisions worth calling out

**The core/topics/capabilities split is the right shape.** It encodes three axes of variability:

- **Agent** — architect, handler, validator, revision, etc. have different responsibilities, different system prompts.
- **Archetype** — a webhook-only app needs nothing from `cron.py` or `admin_ui.py`. A cron-only app needs nothing from `webhook.py`.
- **Capability** — an app declaring `["shopify_rest", "email"]` doesn't need `shopify_graphql.py` or `files.py`.

Crossing the three gives a clean matrix: assemble each run's prompt from `[core for this agent] + [relevant topics] + [relevant capabilities]`. Nothing always-included that could be conditional; nothing conditionally-included that should always be there.

## Size discipline

Rough line counts:
- `core/*.py` — per-agent system prompts, all small-to-medium (20–200 lines each)
- `topics/handler.py` — 322 lines; the largest topic, covers the handler-file layout and absolute rules
- `topics/*.py` (other) — 50–150 lines each
- `capabilities/*.py` — 50–150 lines each

No file is bloated. The 322-line `topics/handler.py` is a fair upper bound for a central teaching doc.

## Summary

The restructure cleaned up essentially everything the prior audit flagged. What's left is cosmetic: two `TODO(platform.files)` comments to seed the future SDK flip, one static-validation check to enforce the email sidecar, and one phrasing polish. The prompt system is now in a shape that tracks the architecture well and allows archetype + capability additions without growing global prompt size.

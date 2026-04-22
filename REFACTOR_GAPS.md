# Refactor Gap Analysis

**Branches compared**
- **OLD (authoritative)**: `claude/architect-required-capabilities` — single-harness architecture, under `platform/`
- **NEW (current)**: `feature/refactor-to-standalone-app-backends` — per-app Cloud Run services, under `platform-back/`

**Goal of this doc.** Enumerate every feature the refactor silently dropped so we can
schedule catch-up work deliberately. Not every gap must be closed before shipping —
some features (billing, compliance webhooks) were never end-to-end live on OLD either.
Items closed by recent commits have been removed; what remains is real outstanding work.

> Out of scope here: doc drift (`docs/*.md` may still describe OLD behaviour),
> prompt-system changes that don't affect the refactor itself, and UI-only cleanup.

---


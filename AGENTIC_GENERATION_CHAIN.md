# Agentic Generation Chain

Full pipeline executed by `generator/crews/feature_generator/crew.py` for every
`GenerationRequest`. Progress events are published at every stage transition;
the frontend subscribes to these to drive the live generation UI.

---

## Pipeline Overview

```
run_feature_generation(request)
│
├─ _phase_product          → intent
│    Agent: product        Model: Haiku
│    (skipped if preComputedIntent is present)
│
├─ _phase_architect        → (architect_output, api_context)
│    Agent: architect      Model: Sonnet
│    ├─ prefetch_for_run()            broad resource docs from MCP
│    ├─ run_architect_agent()         up to 2 attempts w/ validation
│    ├─ validate_architect_plan()     rule-based gate
│    ├─ feasibility gate              fails fast if "blocked"
│    └─ refetch_for_operations()     precise schemas for locked API ops
│
├─ _phase_codespec         → plan
│    Agent: codespec       Model: Sonnet
│    ├─ run_codespec_agent()          up to 2 attempts w/ validation
│    └─ validate_codespec_plan()      rule-based gate
│
├─ build base_ctx
│    CodegenContext assembled here (intent + plan + prior bundle if revision run)
│    Shared by _phase_codegen and _phase_llm_validation
│
├─ _phase_codegen          → artifacts
│    Agents: handler, migration, widget_js?, admin_ui?   Model: Sonnet each
│    └─ retry loop (max 3 attempts):
│         ├─ attempt 1 + priorBundle  → run_revision_agent()   holistic, 1 LLM call
│         │    fallback               → run_codegen_parallel()
│         ├─ attempt 1 (fresh run)    → run_codegen_parallel()
│         ├─ retry attempts           → run_codegen_parallel() (failing gens only)
│         │    coupled retries: handler ↔ widget_js, handler ↔ admin_ui
│         ├─ validate_artifacts()     per-generator static checks
│         └─ validate_widget/admin_handler_contract()   cross-artifact field checks
│
├─ _phase_llm_validation   → artifacts (possibly revised)
│    Agent: validator      Model: Haiku   [LLM_VALIDATION_ENABLED=true required]
│    ├─ run_validator_agent()          7 targeted semantic questions:
│    │    Q1  table names            — migration DDL ↔ handler SQL
│    │    Q2  column names           — migration DDL ↔ handler SQL
│    │    Q3  widget body→handler    — host.call() body ↔ ctx.widgetBody destructuring
│    │    Q4  handler response→widget — handler return value ↔ widgetApiCatalog responseShape
│    │    Q5  admin body→handler     — bridge.call() body ↔ ctx.adminBody destructuring
│    │    Q6  handler response→admin — handler return value ↔ what admin_ui reads
│    │    Q7  codespec coverage      — codeSpec steps ↔ handler implementation
│    ├─ HIGH confidence issue  → run_revision_agent(validation_issues=[...])
│    │    one revision pass, capped (no loops)
│    └─ MEDIUM confidence      → logged only (false positive mitigation)
│
├─ _phase_explanation      → explanation
│    Agent: explanation    Model: Haiku
│    └─ run_explanation_agent()
│
└─ _publish_success
     Assembles Bundle + GenerationMeta → FeatureBundleMessage → generation.completed
```

---

## Agent Models

All agent models are configured centrally in `generator/models/agent_models.py`.
Override any individual agent by setting `AGENT_<NAME>_MODEL` in the environment.

| Agent       | Default model              | Env var override              |
|-------------|----------------------------|-------------------------------|
| product     | claude-haiku-4-5-20251001  | AGENT_PRODUCT_MODEL           |
| architect   | claude-sonnet-4-6          | AGENT_ARCHITECT_MODEL         |
| codespec    | claude-sonnet-4-6          | AGENT_CODESPEC_MODEL          |
| handler     | claude-sonnet-4-6          | AGENT_HANDLER_MODEL           |
| migration   | claude-sonnet-4-6          | AGENT_MIGRATION_MODEL         |
| widget_js   | claude-sonnet-4-6          | AGENT_WIDGET_JS_MODEL         |
| admin_ui    | claude-sonnet-4-6          | AGENT_ADMIN_UI_MODEL          |
| revision    | claude-sonnet-4-6          | AGENT_REVISION_MODEL          |
| explanation | claude-haiku-4-5-20251001  | AGENT_EXPLANATION_MODEL       |
| validator   | claude-haiku-4-5-20251001  | AGENT_VALIDATOR_MODEL         |

---

## Retry & Failure Policy

| Phase      | Max attempts | On exhaustion     |
|------------|-------------|-------------------|
| architect  | 2           | `_PipelineAbort`  |
| codespec   | 2           | `_PipelineAbort`  |
| codegen    | 3           | `_PipelineAbort`  |
| validator  | 1 revision  | keep originals (fail-open) |

---

## App Archetypes

The `product` agent classifies every request into one of three archetypes.
This controls which generators run.

| Archetype                  | handler | migration | widget_js | admin_ui |
|----------------------------|:-------:|:---------:|:---------:|:--------:|
| `storefront_backend`       | ✓       | ✓         | ✓         |          |
| `backend_admin`            | ✓       | ✓         |           | ✓        |
| `storefront_backend_admin` | ✓       | ✓         | ✓         | ✓        |

---

## Feature Flags

| Env var                  | Default | Effect                                              |
|--------------------------|---------|-----------------------------------------------------|
| `LLM_VALIDATION_ENABLED` | `false` | Enables semantic alignment check + auto-revision    |

---

## Key Source Files

| File | Role |
|------|------|
| `generator/crews/feature_generator/crew.py` | Pipeline orchestrator |
| `generator/models/agent_models.py` | Central model registry |
| `generator/subagents/product_agent.py` | Intent classification |
| `generator/subagents/architect_agent.py` | Structural planning |
| `generator/subagents/codespec_agent.py` | Algorithm spec |
| `generator/subagents/revision_agent.py` | Holistic revision (prior bundle + LLM validation) |
| `generator/subagents/validator_agent.py` | Semantic alignment checker |
| `generator/subagents/explanation_agent.py` | Merchant-facing summary |
| `generator/subagents/registry.py` | Generator registration |
| `generator/subagents/validation.py` | Static + cross-artifact checks |
| `generator/shopify_mcp/client.py` | MCP prefetch + operation re-fetch |

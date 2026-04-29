"""
Single source of truth for the state-machine rule.

Three views — one per consumer, imported directly:

  ARCHITECT       — architect prompt: when to declare stateMachine and required fields.
  ARCHITECT_SHAPE — architect NON-NULL SHAPES snippet.
  HANDLER         — handler prompt: null-as-never-observed + atomic RETURNING claim.
"""

# ── Architect view ─────────────────────────────────────────────────────────────

ARCHITECT = """\
stateMachine: null unless the handler must detect a field-value transition in an
  incoming Shopify event by comparing it to the last-observed value stored in the DB.
  Use ONLY for change-detection on DISCRETE string/enum fields (e.g. fulfillment_status
  flipped from "unfulfilled" → "fulfilled", financial_status changed to "paid").
  Do NOT use stateMachine for:
  - Numeric threshold comparisons (e.g. available > 0, quantity >= 10).
    → Output stateMachine: null. Document the numeric comparison logic in
    webhookContract.handlerMustProduce or cronContract.handlerMustProduce as plain prose.
    The handler implements numeric comparisons directly — no state machine scaffolding is emitted.
    A platformGaps entry acknowledging the numeric nature is fine, but stateMachine itself must be null.
  - Application workflow states (e.g. pending/sent/expired queue columns) —
    those are plain DB columns updated directly by the handler; no stateMachine needed.
  Required fields when non-null:
  - entity: the Shopify resource being tracked (e.g. "order", "product")
  - trackedField: the DB column that stores the observed state. When the Shopify payload
    delivers a numeric field and the handler derives a string status from it, trackedField
    must name the column that holds the derived string, not the raw numeric payload field.
    The transitions' from/to values must be exact stored column values.
  - transitions: array of { from, to, action } objects. "from" and "to" MUST be EXACT
    string values as stored in the DB column — never descriptive range labels.
    ✅ { "from": "<prior_stored_value>", "to": "<new_stored_value>", "action": "<handler_action>" }
    ❌ { "from": "zero_or_negative", "to": "positive", "action": "notify" }  — range labels, not stored values
  - unknownSentinel MUST always be the string "null" — never 0, false, or "".
    Reason: 0 is a valid real state value; null means "never observed".
  - skipWhenUnknown MUST be consistent with handlerMustProduce — they cannot contradict.
    true  → first event is skipped; only a state change from a known prior value triggers action.
             Use when there is no meaningful action to take without a prior baseline.
    false → first event triggers the action immediately (current state is itself actionable).
             Use only when acting on the very first observation makes sense for the feature.\
"""

ARCHITECT_SHAPE = """\
stateMachine (non-null) — only for DISCRETE string/enum transitions:
  { "entity": "<shopify_resource>", "trackedField": "<enum_field_name>",
    "unknownSentinel": "null", "skipWhenUnknown": true,
    "transitions": [{ "from": "<prior_enum_value>", "to": "<new_enum_value>", "action": "<handler_action>" }] }

  The dbContracts column for `trackedField` MUST be NULLABLE — no NOT NULL,
  no DEFAULT — because null encodes "never observed". The discrete-value
  enum rule still applies (declare `enum`), but the constraints differ
  from a normal status column:
    ✅ { "name": "<enum_field_name>", "type": "TEXT", "constraints": "NULL",
         "enum": ["<value_a>", "<value_b>", "<value_c>"] }
    ❌ { "name": "<enum_field_name>", "type": "TEXT",
         "constraints": "NOT NULL DEFAULT '<value_a>'",
         "enum": ["<value_a>", "<value_b>", "<value_c>"] }
        — NOT NULL DEFAULT coerces the first INSERT past the unknown
        state, so the handler's null-as-never-observed check never fires
        and the very first event is silently treated as a real transition.\
"""

# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE TRANSITION PATTERNS — this handler detects state changes across events:

Rule: null in the state column means "never observed" — it is NOT a real state
value. Never fire the transition action when prevState is null:
  ✅ const isTransition = prevState !== null && prevState === <FROM> && current === <TO>;
  ❌ const isTransition = prevState === <FROM> && current === <TO>;   // fires on null→<TO> too

Rule: When applying Invariant 1 (atomic claim) to a state machine, include the
prior state in the WHERE clause: cron and webhook paths can both observe the
same transition, and the prior-state predicate ensures only the first claimer
proceeds. A zero-row result means another path beat you to it — bail.
  ✅ const claimed = await sql`
       UPDATE <table_1>
       SET <state_col> = ${newState}, updated_at = NOW()
       WHERE <entity_id_col> = ${id} AND <state_col> = ${prevState}
       RETURNING <entity_id_col>
     `;
     if (claimed.length === 0) continue;   // other path handled this — skip

Rule: State transitions must log prev + new values so operators can
reconstruct timelines from stdout:
  console.log(
    { <entity_id_col>: id, prevState, newState },
    "state transition",
  );
"""

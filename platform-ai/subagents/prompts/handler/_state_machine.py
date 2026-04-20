"""
State-transition handler patterns.

Injected by handler_agent.py's JIT when ``appContracts.stateMachine`` is
non-null. Covers the null-as-never-observed semantics and the
RETURNING-based atomic claim that lets cron and webhook paths race safely
against each other.
"""

HARNESS_SECTION_STATE_MACHINE = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE TRANSITION PATTERNS — this handler detects state changes across events:

Rule: null means "never observed" — it is NOT a real state value. Never
fire the transition action when prevState is null:
  ✅ const isTransition = prevState !== null && prevState === <FROM> && current === <TO>;
  ❌ const isTransition = prevState === <FROM> && current === <TO>;   // fires on null→<TO> too

Rule: Cron jobs (see _cron.py) and webhook routes can both observe the
same transition. Atomically claim the transition with RETURNING and bail
on a zero-row result — the other path may have already processed it:
  ✅ const claimed = await sql`
       UPDATE <table_1>
       SET <state_col> = ${newState}, updated_at = NOW()
       WHERE <entity_id_col> = ${id} AND <state_col> = ${prevState}
       RETURNING <entity_id_col>
     `;
     if (claimed.length === 0) continue;   // other path handled this — skip
  ❌ UPDATE without RETURNING + length check — cron and webhook paths double-fire.

Rule: State transitions must log prev + new values so operators can
reconstruct timelines from stdout:
  console.log(
    { <entity_id_col>: id, prevState, newState },
    "state transition",
  );
"""

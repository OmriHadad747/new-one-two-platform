"""
State-transition handler patterns.

Injected by handler_agent.py's JIT when ``appContracts.stateMachine`` is
non-null. Covers the null-as-never-observed semantics and the RETURNING-based
atomic claim that lets cron and webhook paths race safely.
"""

HARNESS_SECTION_STATE_MACHINE = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE TRANSITION PATTERNS — this handler detects state changes across events:

Rule: null means "never observed" — it is NOT a real state value. Never fire the
transition action when prevState is null:
  ✅ const isTransition = prevState !== null && prevState === FROM && current === TO
  ❌ const isTransition = prevState === FROM && current === TO  // fires on null→TO too

Rule: In the cron path, atomically claim the transition with RETURNING and check row
count before acting — the webhook path may have already processed the same transition:
  ✅ const claimed = await ctx.db`
       UPDATE state_table
       SET state_col = ${newVal}, updated_at = NOW()
       WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${id} AND state_col = ${prevVal}
       RETURNING id
     `
     if (claimed.length === 0) continue  // webhook already handled this — skip
  ❌ UPDATE without RETURNING + length check — cron and webhook paths double-fire
"""

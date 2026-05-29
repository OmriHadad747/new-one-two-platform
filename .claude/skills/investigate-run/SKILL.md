---
name: investigate-run
description: Investigate ONE generation run dir (a test_results/<run>) to root-cause a specific bug or issue — trace it from the symptom (in scaffold / tsc / tool-calls) back through the coding agent and the HLD/product stages to the EARLIEST stage that caused it. Use when asked to investigate, debug, diagnose, or find the root cause of something a generation got wrong (a compile error, a faked/missing capability, a wrong webhook topic, a bad summary, a cap hit). For grading/scoring a run instead, use evaluate-generation.
---

# Investigate a run — find the root cause of one bug

Given a run dir and a specific bug, find its **root cause**: the earliest
stage or decision that produced the defect — not just where it surfaced.
A coding bug may be born in the plan; a plan bug in the intent; an intent
bug in an ambiguous merchant prompt. Fix the source, not the symptom.

(Complement of `evaluate-generation`: that one *grades* a run; this one
*diagnoses* one defect.)

## The pipeline (where a bug can be born)

```
inputs/user.txt  →  product  →  hld (→ hld_revise)  →  hld_v  →  coding agent loop  →  scaffold + tsc
   merchant         intent       plan + bindings       review     tool_calls/            final files
```

A defect at any stage is inherited downstream unless a later stage catches
it. The root cause is the **first** stage whose artifact already contains
the defect.

## Run dir map (read on demand — don't read it all)

- `inputs/user.txt` — the original merchant prompt. Ground truth of what
  was actually asked; start most traces here.
- `inputs/<stage>/attempt_N/{system,user,output}` — each stage's exact run.
  `system.txt` = the prompt it ran under, `user.txt` = what it got from
  upstream, `output.*` = what it produced. Stages: `product`, `hld`,
  `hld_revise`, `hld_v`. **`attempt_N > 1` = a retry** (prior output failed
  validation) — itself a signal.
- `state.json` — the structured carry-through: `intent`, `plan` (incl.
  Phase-2 bindings: `shopifyTopic`, `payloadBindings`, `shopifySteps`),
  `hld_v_findings`, per-stage `tokens_*`. Fastest way to see what each
  stage *decided*.
- `tool_calls/NNN_<tool>/{input,output}.json` — the coding agent's ordered
  actions. `run_tsc` outputs hold compile errors; `write_file` inputs hold
  what it wrote (and when); `read_file` shows what context it consulted and
  in what order.
- `scaffold/**` — the final generated files (end state).
- `_tsc/`, `_tsc_ui/` — the dirs that were actually type-checked. A mismatch
  between these and `scaffold/` can itself be the bug.
- `manifest.jsonl` — ordered event log of the whole run.
- `token_usage.json` — cost; also reveals cap hits / truncation.
- `../generation.log` — cross-run log (one level up, shared by all runs).

## Principles (no fixed step order — drive it yourself)

- **Locate the symptom first**, concretely: the bad `file:line`, the exact
  tsc error, the wrong field. Don't theorize before you've seen it.
- **Trace upstream to the earliest stage that already contains it.** Where
  it *surfaced* (e.g. a compile error in coding) is rarely where it was
  *born* (e.g. an ambiguous plan binding).
- **Read that stage's `system.txt`** to decide: could the stage have done
  better with the instructions it had? This separates a prompt/instruction
  gap from a model miss — they need different fixes.
- **For coding-agent bugs, the `tool_calls/` sequence is the timeline.**
  What did it read before it wrote? Which `run_tsc` introduced vs cleared
  errors? Did it consult the right doc before or after writing the code?
  Order is the evidence.
- **Separate cause from inheritance.** If every downstream stage faithfully
  carried an upstream defect, the fix is upstream — don't patch the symptom.
- **Name the cheapest stage to fix the bug class**: plan instruction →
  prevention rule → downstream validator. (Same philosophy as the rest of
  the generator.)
- **Evidence or it didn't happen.** Cite the exact file + line / tool-call
  number / json path. If you can't quote it, you haven't found it.
- **Artifacts only.** Reason from what's recorded; don't re-run the pipeline.

## Pointers (detail lives here)

- `GENERATION_QUALITY_PLAN.md` (repo root) — §3 bug classes (use this
  vocabulary so findings are comparable), §6 invariants.
- `platform-ai/subagents/<stage>_agent/prompt.py` — the authoritative stage
  prompt, when `system.txt` isn't enough.
- `evaluate-generation` skill — the complementary tool when the ask is
  "grade/score" rather than "why did this break".

## Output

A short root-cause writeup, not a graded report:

- **Symptom** — the concrete defect + where it shows (`file:line` / tsc /
  tool-call #).
- **Root cause** — the earliest stage and the specific decision/instruction
  that produced it, with the quoted evidence.
- **Why it propagated** — which later stages should have caught it and why
  they didn't (if relevant).
- **Cheapest fix** — the stage and the smallest change that prevents the
  whole class, per the philosophy above.

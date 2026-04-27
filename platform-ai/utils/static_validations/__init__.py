"""
Reusable building blocks for the static validators in `validation/`.

Submodules
----------
  js_parse        — JS/TS source parsing primitives (no rules, no error
                    messages — just structural extraction).
  sql_parse       — SQL source parsing primitives.
  cron            — cron expression validation.
  shared_checks   — CHECK functions reused by 2+ artifact validators
                    (return findings).
"""

"""
Shared infrastructure for the LLM validator layer.

  Finding              — uniform shape every validator returns.
  run_llm_validators   — fans out the three validators in parallel and merges
                          their findings. Drop-in replacement for the legacy
                          run_validator_agent.

The Finding shape is intentionally narrow:

  validator    — which validator emitted the finding ("agent_rules" |
                  "bug_finder" | "quality_brief_coverage").
  artifact     — which artifact is wrong; drives the revision-locking policy.
  location     — file:symbol or plan-field path; for human triage only.
  issue        — what is wrong, one sentence.
  failure_mode — how it fails at runtime, one sentence.
  confidence   — "high" or "medium". The crew acts only on HIGH.

Compatibility with the prior validator_agent: the crew used to read
issue["question"] (Part A keys like "q1_table_names") and issue["artifact"]
(Part B). Findings emitted here always carry `artifact` and a synthetic
"question" field of the form `<validator>[<artifact>]` so the existing
revision-locking logic can be expressed with ~the same predicates.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from subagents.base import CodegenContext

log = logging.getLogger(__name__)


# Allowed values for Finding.artifact. Driving constants for the revision-
# locking predicates in the crew.
VALID_ARTIFACTS = frozenset(
    {"plan", "handler", "db", "storefront", "admin_ui"}
)

VALID_VALIDATORS = frozenset(
    {"agent_rules", "bug_finder", "quality_brief_coverage"}
)


@dataclass
class Finding:
    """A single rule violation or runtime-bug detection."""

    validator: str
    artifact: str
    issue: str
    failure_mode: str
    confidence: str = "high"
    location: str = ""

    def to_issue_dict(self) -> Dict[str, Any]:
        """
        Render to the dict shape the crew's revision logic consumes.

        Mirrors the legacy validator_agent's Part B output shape so
        _revision_locked_artifacts can read `question` + `artifact` without
        changes.
        """
        composed = (
            f"[{self.location}] {self.issue} — {self.failure_mode}"
            if self.location
            else f"{self.issue} — {self.failure_mode}"
        )
        return {
            "question": f"{self.validator}[{self.artifact}]",
            "issue": composed,
            "confidence": self.confidence,
            "artifact": self.artifact,
            "validator": self.validator,
        }


@dataclass
class ValidatorRunResult:
    """Per-validator return from a single fan-out slot."""

    validator: str
    findings: List[Finding] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    error: Optional[str] = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _normalize_finding(
    raw: Dict[str, Any], validator: str
) -> Optional[Finding]:
    """
    Convert one raw finding dict (from JSON parse) into a Finding.
    Returns None if the entry is malformed or low-quality (medium confidence,
    missing required fields, non-canonical artifact name, etc.).
    """
    if not isinstance(raw, dict):
        return None

    artifact = (raw.get("artifact") or "").strip()
    issue = (raw.get("issue") or "").strip()
    failure_mode = (raw.get("failure_mode") or "").strip()
    location = (raw.get("location") or "").strip()
    confidence = (raw.get("confidence") or "medium").strip().lower()

    if artifact not in VALID_ARTIFACTS:
        if artifact:
            log.info(
                "%s: skipping finding with non-canonical artifact=%r",
                validator,
                artifact,
            )
        return None

    if not issue or not failure_mode:
        log.info(
            "%s: skipping finding missing issue or failure_mode (artifact=%s)",
            validator,
            artifact,
        )
        return None

    # Only HIGH confidence acts on the revision loop. MEDIUM is logged and
    # dropped — same false-positive-mitigation policy as the legacy validator.
    if confidence != "high":
        log.info(
            "%s: %s medium confidence (skipped) — %s",
            validator,
            artifact,
            issue,
        )
        return None

    return Finding(
        validator=validator,
        artifact=artifact,
        issue=issue,
        failure_mode=failure_mode,
        confidence="high",
        location=location,
    )


def _normalize_findings(
    raw_list: Any, validator: str, cap: int
) -> List[Finding]:
    """Normalize a list of raw finding dicts into Findings, capped."""
    if not isinstance(raw_list, list):
        return []
    out: List[Finding] = []
    for entry in raw_list:
        normalized = _normalize_finding(entry, validator)
        if normalized is not None:
            out.append(normalized)
            if len(out) >= cap:
                break
    return out


def _dedup_issues(
    issues: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Remove duplicate findings emitted by different validators that point at
    the same `(artifact, normalized issue text)`. Validators run in parallel
    and the prompts ask the model not to overlap, but the rule is best-effort
    — this is the cheap structural backstop that prevents the same problem
    from being reported twice to the revision agent and from inflating the
    log line below.

    The first occurrence wins; later duplicates are dropped silently. The
    issue text is normalized to a lowercase, whitespace-collapsed key so
    minor wording differences ("missing currency col" vs "missing currency
    column") still collapse when the artifact + issue prefix match closely
    enough — but punctuation and casing are otherwise preserved on output.
    """
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for issue in issues:
        artifact = issue.get("artifact") or ""
        text = " ".join((issue.get("issue") or "").lower().split())
        key = (artifact, text)
        if key in seen:
            continue
        seen.add(key)
        out.append(issue)
    return out


def run_llm_validators(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Tuple[List[Dict[str, Any]], int, int, Dict[str, ValidatorRunResult]]:
    """
    Fan out the three LLM validators in parallel and return merged findings.

    Drop-in superset of the legacy run_validator_agent: the first three
    return slots — issues, input_tokens, output_tokens — match the legacy
    contract. The fourth slot is the per-validator ValidatorRunResult map
    (latency, error, raw findings) so the call site can write per-validator
    metrics into agent_trace without re-doing the timing.

    Issues from different validators that point at the same
    (artifact, normalized issue text) are de-duplicated — the prompts ask
    the model to stay in lane but parallel runs can't see each other.

    quality_brief_coverage is FROZEN as of 2026-04-28. Its findings track
    scope-class concerns (the brief said "respect rate limits"; the handler
    didn't add backoff) that often need an architect re-plan rather than a
    handler patch — pushing them through the codegen revision agent
    produced churn without resolution. Disabled by skipping the dispatch
    here. Module + prompt left in place for easy re-enablement: flip the
    `_QUALITY_BRIEF_FROZEN` constant below to `False` (or wrap with a
    feature flag) when there's a clear case for re-running it. See
    REVISION_RULES.md Q1/Q2 deferred questions and the image-optimizer
    run trace for the rationale.
    """
    # Imports are local to avoid a circular import at module load — these
    # validators import from subagents.base which transitively imports here.
    from subagents.validators.agent_rules import run_agent_rules_validator
    from subagents.validators.bug_finder import run_bug_finder_validator
    from subagents.validators.quality_brief_coverage import (
        run_quality_brief_coverage_validator,
    )

    _QUALITY_BRIEF_FROZEN = True

    quality_brief = (ctx.intent or {}).get("qualityBrief") or ""
    quality_brief = quality_brief.strip()

    runners = [
        ("agent_rules", run_agent_rules_validator),
        ("bug_finder", run_bug_finder_validator),
    ]
    if quality_brief and not _QUALITY_BRIEF_FROZEN:
        runners.append(
            ("quality_brief_coverage", run_quality_brief_coverage_validator)
        )

    results: Dict[str, ValidatorRunResult] = {}

    # `_safe_run` is total-catch on Exception, so future.result() can only
    # raise BaseException (KeyboardInterrupt, SystemExit) — we deliberately
    # let those propagate so the parent pipeline sees the cancellation.
    with ThreadPoolExecutor(max_workers=len(runners)) as pool:
        futures = {
            pool.submit(
                _safe_run, name, fn, artifacts, ctx, is_storefront, is_admin_ui
            ): name
            for name, fn in runners
        }
        for future in as_completed(futures):
            name = futures[future]
            results[name] = future.result()

    merged_issues: List[Dict[str, Any]] = []
    in_total = 0
    out_total = 0
    # Iterate in declared order so merged_issues is deterministic regardless
    # of which future finished first.
    for name in [n for n, _ in runners]:
        result = results.get(name)
        if not result:
            continue
        in_total += result.input_tokens
        out_total += result.output_tokens
        if result.error:
            log.warning(
                "validator=%s failed open (latency=%dms): %s",
                name,
                result.latency_ms,
                result.error,
            )
        for finding in result.findings:
            merged_issues.append(finding.to_issue_dict())
            log.info(
                "%s[%s] HIGH confidence — %s",
                name,
                finding.artifact,
                finding.issue,
            )

    merged_issues = _dedup_issues(merged_issues)
    return merged_issues, in_total, out_total, results


def _safe_run(
    name: str,
    fn: Any,
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> ValidatorRunResult:
    """
    Wrapper that catches per-validator exceptions and times the call.

    Each individual validator already fails open on parse / API errors;
    this is the outermost net so a crash in one validator never blocks the
    other two. By design this is the only catch site — the harness above
    relies on `future.result()` never raising for normal `Exception`s.
    """
    t0 = _now_ms()
    try:
        return fn(artifacts, ctx, is_storefront, is_admin_ui)
    except Exception as exc:
        log.warning("validator=%s raised: %s", name, exc)
        return ValidatorRunResult(
            validator=name,
            latency_ms=_now_ms() - t0,
            error=str(exc),
        )

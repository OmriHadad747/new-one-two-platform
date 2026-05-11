"""
Admin shape registry — single source of truth for the admin agent's
example library and the LLD agent's adminShapes classification.

Mirrors `e_storefront_agent/widget_shapes.py`: a dict keyed by stable
bucket names, plus a dumb dispatcher that maps LLD inputs → bucket
names. The codegen agent (`agent.py`) appends the dispatched example
bodies to its user message — it never imports this file's internals.

Design — micro-shapes, not whole apps
-------------------------------------
Each shape teaches ONE pattern (dirty-tracking, polling, pagination
control choice, etc.) in 30–80 lines. Real admin apps compose 2–4
shapes — e.g. Back-in-Stock is `[settings_form, kpi_stats_row,
paginated_table]`. This matches widget_shapes' composition model
(Cart Drawer = `[cart_aware, modal_overlay]`).

Anchor: `settings_form` establishes the shared scaffold conventions
(container.innerHTML skeleton + `data-region` lookup + bridge.notify
usage + dirty-state tracking). Other snippets reference the anchor
instead of repeating it.

Adding a new shape: add ONE entry to `ADMIN_SHAPES`. The LLD prompt's
enum section, the schema validator, and the admin dispatcher all
pick it up automatically.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

# ── Route-shape predicates (mechanical dispatch from lld.httpRoutes.admin) ──
#
# Predicates fire only for unambiguous signals. Most micro-shapes lean
# on lld.uxExpectations.adminShapes (declared) + text_keywords; the LLD
# is the authoritative signal source.


def _group_methods_by_path(routes: List[Dict[str, Any]]) -> Dict[str, set]:
    by_path: Dict[str, set] = {}
    for r in routes:
        path = r.get("path", "")
        method = (r.get("method") or "POST").upper()
        by_path.setdefault(path, set()).add(method)
    return by_path


def _has_get_post_pair(routes: List[Dict[str, Any]]) -> bool:
    """GET+POST on the same path — the load-then-save settings shape."""
    by_path = _group_methods_by_path(routes)
    return any({"GET", "POST"}.issubset(m) for m in by_path.values())


def _has_paginated_route(routes: List[Dict[str, Any]]) -> bool:
    """Any route that needs a table-style render — paginationKind
    offset or cursor, OR paginationKind=inline with a list value in
    the responseShape (bounded embedded collection that still needs
    the table skeleton even though there are no pagination controls).
    Inline-only feeds without a paginated_table snippet would
    otherwise leave the model improvising the table render."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        kind = r.get("paginationKind")
        if kind in ("offset", "cursor"):
            return True
        if kind == "inline" and any(
            str(v).rstrip().endswith("[]")
            for v in (r.get("responseShape") or {}).values()
        ):
            return True
    return False


def _has_multiple_mutation_paths(routes: List[Dict[str, Any]]) -> bool:
    """Mutations spread across ≥2 distinct paths — record-authoring CRUD
    where create / update / delete use separate endpoints. Implies
    editor_modal + confirm_modal."""
    by_path = _group_methods_by_path(routes)
    mut = {p for p, m in by_path.items() if m & {"POST", "PUT", "DELETE"}}
    return len(mut) >= 2


def _has_delete_path(routes: List[Dict[str, Any]]) -> bool:
    """A POST path that looks like a delete endpoint — `/delete`,
    `/remove`, `*-delete`. The method guard rejects GET routes that
    happen to contain those tokens (e.g. `/listings/deleted-recently`
    is read-only, not destructive). The LLD avoids `:param` segments
    so deletes are named paths."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "POST":
            continue
        path = (r.get("path") or "").lower()
        if "/delete" in path or "/remove" in path or path.endswith("-delete"):
            return True
    return False


def _has_kpi_response(routes: List[Dict[str, Any]]) -> bool:
    """A GET route whose responseShape is ≥3 scalar fields, NO list
    values, AND no paired POST on the same path — the KPI summary
    endpoint shape (revenue, orders, AOV, repeat_rate, etc.). The
    no-paired-POST rule disambiguates from settings GET, which also
    returns ≥3 scalars."""
    posted_paths = {
        r.get("path")
        for r in routes
        if isinstance(r, dict) and (r.get("method") or "").upper() == "POST"
    }
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "GET":
            continue
        if r.get("path") in posted_paths:
            continue  # settings-pair, not KPI
        shape = r.get("responseShape") or {}
        if len(shape) < 3:
            continue
        has_list = any(str(v).rstrip().endswith("[]") for v in shape.values())
        if not has_list:
            return True
    return False


def _has_series_response(routes: List[Dict[str, Any]]) -> bool:
    """A route whose responseShape carries a `points` / `series` /
    `trend` list — inline_chart territory."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        for key in (r.get("responseShape") or {}).keys():
            if key.lower() in ("points", "series", "trend", "trends", "timeseries"):
                return True
    return False


def _has_blob_response(routes: List[Dict[str, Any]]) -> bool:
    """A response shape with a `csv` / `pdf` / `download_url` field —
    file_download territory."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        for key in (r.get("responseShape") or {}).keys():
            k = key.lower()
            if k in ("csv", "pdf", "xml", "download_url", "blob", "file_url"):
                return True
    return False


def _has_id_array_request(routes: List[Dict[str, Any]]) -> bool:
    """A POST request shape with an `ids` / `<x>_ids` array — implies
    bulk_select_actions on the source list. POST-only because a GET
    that accepts an ids array is a filtered list, not a bulk
    mutation."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "POST":
            continue
        for key, val in (r.get("requestShape") or {}).items():
            k = key.lower()
            v = str(val).rstrip()
            if (k == "ids" or k.endswith("_ids")) and v.endswith("[]"):
                return True
    return False


def _has_update_field_route(routes: List[Dict[str, Any]]) -> bool:
    """A POST whose requestShape carries an `id` + a `field` (or
    similar single-column update) — inline_edit territory. The
    canonical path shape is `/<resource>/update-field`."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "POST":
            continue
        path = (r.get("path") or "").lower()
        if path.endswith("/update-field") or path.endswith("-update-field"):
            return True
        req = {k.lower() for k in (r.get("requestShape") or {}).keys()}
        if "id" in req and "field" in req and "value" in req:
            return True
    return False


def _has_detail_route(routes: List[Dict[str, Any]]) -> bool:
    """A GET path ending in `/detail` or `/details` — the canonical
    detail_drawer backend (fetches one record's full attributes by
    id)."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "GET":
            continue
        path = (r.get("path") or "").lower()
        if path.endswith("/detail") or path.endswith("/details"):
            return True
    return False


def _has_search_route(routes: List[Dict[str, Any]]) -> bool:
    """A GET path that ends in `/search` or `-search` — the canonical
    resource_picker backend (an autocomplete that returns a bounded
    set of matches for a typed query).

    The previous version also fired on any GET with a `q` / `query`
    requestShape key, which over-triggered: every paginated list with
    a search box has those keys and is NOT a resource picker. Path-
    based matching is precise; LLDs name picker routes `*/search` by
    convention. For the rare picker that doesn't follow the
    convention, the LLD declares `resource_picker` in
    `uxExpectations.adminShapes` and the keyword fallback fires."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "GET":
            continue
        path = (r.get("path") or "").lower()
        if path.endswith("/search") or path.endswith("-search"):
            return True
    return False


def _has_file_upload_request(routes: List[Dict[str, Any]]) -> bool:
    """A POST whose requestShape carries a file-content field —
    `file_base64`, `file_bytes`, `csv_text`, `image_base64`. The bridge
    has no FormData affordance; uploads are base64-or-text strings
    inside JSON."""
    for r in routes:
        if not isinstance(r, dict):
            continue
        if (r.get("method") or "").upper() != "POST":
            continue
        for key in (r.get("requestShape") or {}).keys():
            k = key.lower()
            if (k.endswith("_base64") or k.endswith("_bytes") or
                    k in ("csv_text", "file_content")):
                return True
    return False


# empty_state_cta has no route predicate — every paginated_table needs
# it. Driven entirely by lld.uxExpectations.adminShapes declaration +
# text keywords ("first", "get started", "onboarding"). Cheap to attach.


def _has_many_path_prefixes(routes: List[Dict[str, Any]]) -> bool:
    """≥3 distinct top-level path prefixes — suggests a tabbed layout
    is worth the navigation affordance. Coarse signal; the LLD's
    declared adminShapes wins."""
    prefixes: set[str] = set()
    for r in routes:
        path = r.get("path") or ""
        seg = path.lstrip("/").split("/")[0] if path else ""
        if seg:
            prefixes.add(seg)
    return len(prefixes) >= 3


# ── Example bodies — micro-snippets, ≤80 lines each ─────────────────────────
#
# Anchor: settings_form. Establishes the scaffold every other snippet
# inherits (container.innerHTML skeleton with data-region selectors,
# bridge.notify for toasts, banner for fatal errors, esc() for HTML
# safety, fmt helpers for display). Other snippets reference the
# anchor for those conventions — they do NOT repeat them.


_EXAMPLE_SETTINGS_FORM = r"""// SHAPE: settings_form  (ANCHOR — other snippets inherit these conventions)
//
// Teaches: dirty-tracking + load-then-save + bridge.notify + the
// NATIVE contextual save bar. Establishes the shared scaffold pattern
// (data-region selectors, banner for fatal errors, esc/fmt helpers).
// Other snippets reference this.
//
// SAVE BAR LIFECYCLE (bridge.saveBar — see API SURFACE in the prompt):
//   - First dirty input event   → bridge.saveBar.show()
//   - Successful POST           → bridge.saveBar.hide()
//   - Discard (draft = saved)   → bridge.saveBar.hide()
// The native save bar floats above the panel, survives merchant
// navigation attempts (clicking another nav link prompts a confirm),
// and is the merchant-expected experience. Inline Save/Discard buttons
// inside the card remain as the primary click targets — the save bar
// is the visual indicator + navigation guard.
//
// Hypothetical catalog:
//   GET  /settings  → { enabled, label, placement }
//   POST /settings  → { enabled, label, placement }

export function mount(container, bridge) {
  let saved = null;             // last server-acknowledged values
  let draft = null;             // current form state (dirty when !== saved)
  let fatalError = null;
  let saveBarShown = false;     // tracks whether the save bar is visible

  // Scaffold — declarative regions; renderers target them by data-region.
  container.innerHTML = `
    <div class="shell-root">
      <header class="shell-header"><h1 class="shell-title">Settings</h1></header>
      <div data-region="banner"></div>
      <section data-region="form" class="shell-card"></section>
    </div>`;
  const region = (n) => container.querySelector(`[data-region="${n}"]`);

  function renderBanner() {
    region("banner").innerHTML = fatalError
      ? `<div class="shell-error-banner">${esc(fatalError)}</div>` : "";
  }

  function isDirty() {
    return saved && draft && JSON.stringify(saved) !== JSON.stringify(draft);
  }

  function syncSaveBar() {
    // Show on first dirty edit; hide once draft matches saved again.
    // Call this from every input handler AND after every Save / Discard.
    const dirty = isDirty();
    if (dirty && !saveBarShown) { bridge.saveBar.show(); saveBarShown = true; }
    else if (!dirty && saveBarShown) { bridge.saveBar.hide(); saveBarShown = false; }
  }

  async function onSave() {
    try {
      const ack = await bridge.call("/settings", draft);
      saved = ack; draft = { ...ack };       // server-normalised values win
      syncSaveBar();                          // dirty=false → hides
      bridge.notify("Settings saved", "success");
      renderForm();
    } catch (_) {
      bridge.notify("Could not save", "error");
    }
  }

  function onDiscard() {
    draft = { ...saved };
    syncSaveBar();                            // dirty=false → hides
    renderForm();
  }

  function renderForm() {
    if (!draft) { region("form").innerHTML = `<div class="shell-loading">Loading…</div>`; return; }
    region("form").innerHTML = /* form using shell-field / shell-input / shell-select
      with name= attributes matching the requestShape keys, plus a
      Save (btn-primary, type=submit) and Discard (btn-secondary). See
      the prompt's DESIGN SYSTEM section for the exact class list. */ "";
    const form = region("form").querySelector("form");
    // Hydrate fields from `draft`. On every input event:
    //   draft[name] = value; syncSaveBar();
    // On Save click: onSave().  On Discard click: onDiscard().
    // syncSaveBar is the ONLY hook needed for the save bar — it
    // flips on the first dirty edit and off after a clean state.
  }

  async function init() {
    renderForm();
    try {
      saved = await bridge.call("/settings");
      draft = { ...saved };
    } catch (_) {
      fatalError = "Could not load settings. Refresh to try again.";
    }
    renderBanner();
    renderForm();
  }

  // Shared helpers — emit esc(), fmtInt(), fmtMoney(), fmtDate(),
  // fmtRelative() VERBATIM from the prompt's DATA FORMATTING section
  // at the bottom of mount(). Every snippet in this library assumes
  // they exist; do NOT redefine them per-snippet (you'd ship two
  // copies and the second declaration throws).

  init();
}
"""


_EXAMPLE_PAGINATED_TABLE = r"""// SHAPE: paginated_table
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: paginationKind dispatch. The control choice MUST match the
// route's declared paginationKind — offset → page numbers + total;
// cursor → Prev/Next with a stack, NO total; inline → no controls.
//
// CURSOR PAGINATION: two cursors, not one.
//   pageCursor — the cursor that LOADED the visible page (this is
//                what bridge.call sends every time).
//   nextCursor — res.next_cursor from the last fetch (this is what
//                the Next button uses; null on the last page).
// Collapsing both into one variable reuses the next-page cursor as
// if it were the current-page cursor — Prev re-loads the page the
// merchant is already on.
//
// Catalog: GET /rows  paginationKind: "cursor"
//          → { rows: [...], next_cursor }

// State held in closure (anchor pattern).
let rows = [], pageCursor = null, nextCursor = null;
let cursorStack = [], loading = false;

async function loadList() {
  loading = true; renderList();
  try {
    const res = await bridge.call("/rows", { cursor: pageCursor });
    rows = res.rows || [];
    nextCursor = res.next_cursor || null;   // for the Next button
  } catch (_) {
    bridge.notify("Could not load list", "error");
  } finally { loading = false; renderList(); }
}

function renderList() {
  if (loading && rows.length === 0) {
    // Initial-load skeleton — placeholder rows match the data table's
    // column count + row height so swap-in doesn't shift the layout.
    region("list").innerHTML = `
      <div class="shell-table-wrap"><table class="shell-table">
        <thead><tr><th>...</th><th>...</th><th>...</th></tr></thead>
        <tbody>
          ${Array(5).fill(
            '<tr><td colspan="3"><div class="shell-loading">&nbsp;</div></td></tr>',
          ).join("")}
        </tbody>
      </table></div>`;
    return;
  }
  if (rows.length === 0) {
    region("list").innerHTML = `<div class="shell-empty">No rows yet.</div>`;
    return;
  }
  region("list").innerHTML = `
    <div class="shell-table-wrap"><table class="shell-table">
      <thead>...</thead>
      <tbody>${rows.map((r) => `<tr>...</tr>`).join("")}</tbody>
    </table></div>
    <nav class="shell-pagination">
      <div class="shell-pagination-btns">
        <button class="btn-secondary" data-act="prev"
          ${cursorStack.length === 0 ? "disabled" : ""}>← Previous</button>
        <button class="btn-secondary" data-act="next"
          ${nextCursor ? "" : "disabled"}>Next →</button>
      </div>
    </nav>`;
  region("list").querySelector('[data-act="next"]')?.addEventListener("click", () => {
    // Push the cursor that loaded the CURRENT page, then advance.
    cursorStack.push(pageCursor);
    pageCursor = nextCursor;
    loadList();
  });
  region("list").querySelector('[data-act="prev"]')?.addEventListener("click", () => {
    // Restore the cursor that loaded the previous page.
    pageCursor = cursorStack.pop() ?? null;
    loadList();
  });
}

// paginationKind=offset variant — render page numbers + total, drive
// off `total` returned by the GET; the offset on each request is
// page*PAGE_SIZE. paginationKind=inline — drop the <nav> entirely and
// render the bounded list directly.
"""


_EXAMPLE_KPI_STATS_ROW = r"""// SHAPE: kpi_stats_row
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: independent per-card fetch. Promise.all would block the
// fastest card on the slowest endpoint — render each as its own
// fetch resolves so the merchant sees data progressively.
//
// Currency formatting reads `bridge.context.currency` (e.g. "USD",
// "EUR") and `bridge.context.locale` (e.g. "en-US", "fr-CA"). Do NOT
// hardcode "USD" — it breaks every non-US shop.
//
// Catalog: GET /kpis     → { revenue_minor, order_count, aov_minor }
//          GET /trend    → { points: [...] }     (paginationKind=inline)
//          GET /top      → { rows: [...] }

let kpis = null;

// fmtMoney / fmtInt come from the anchor's shared helpers — see the
// prompt's DATA FORMATTING section. Do NOT redeclare them here; a
// second `const fmtMoney` in the same mount scope throws SyntaxError.

function renderKpis() {
  if (!kpis) {
    region("kpis").innerHTML = Array(3).fill(
      `<div class="shell-stat-card"><div class="shell-loading">···</div></div>`
    ).join("");
    return;
  }
  region("kpis").innerHTML = `
    <div class="shell-stat-card">
      <div class="shell-stat-label">Revenue</div>
      <div class="shell-stat-value">${fmtMoney(kpis.revenue_minor)}</div>
    </div>
    <div class="shell-stat-card">
      <div class="shell-stat-label">Orders</div>
      <div class="shell-stat-value">${fmtInt(kpis.order_count)}</div>
    </div>
    <div class="shell-stat-card">
      <div class="shell-stat-label">AOV</div>
      <div class="shell-stat-value">${fmtMoney(kpis.aov_minor)}</div>
    </div>`;
}

// Fire each fetch independently. DO NOT await them as a Promise.all —
// the trend chart and top-products table render in their own regions
// the moment their data arrives.
bridge.call("/kpis").then((r) => { kpis = r; renderKpis(); })
  .catch(() => bridge.notify("Could not load KPIs", "error"));
"""


_EXAMPLE_INLINE_CHART = r"""// SHAPE: inline_chart
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: dependency-free chart rendering. No D3 / Chart.js / SVG
// libraries — admin bundles must stay small. Flex-stacked bars cover
// the common time-series case; switch to inline SVG <path> for line
// charts. Both are ≤30 lines.
//
// PASS THE FORMATTER, never hardcode `fmtMoney`. A trend of order
// counts is integers, not minor-unit money — fmtMoney(42) would
// render "$0.42" because it divides by 100. The caller picks:
//   fmtMoney for revenue, fmtInt for counts, fmtPct for ratios.
//
// Use `--p-color-bg-fill-success` for the bar fill (a FILL token).
// `--p-color-text-success` is for success copy and is tuned for
// legibility, not chart fills — it renders wrong in dark mode.
//
// Catalog: GET /trend → { points: [{ day, value }] }  (paginationKind=inline)

function renderChart(points, fmtValue) {
  if (!points || points.length === 0) {
    region("chart").innerHTML = `<div class="shell-empty">No data in this range.</div>`;
    return;
  }
  const max = Math.max(...points.map((p) => p.value || 0), 1);
  const bars = points.map((p) => {
    const h = ((p.value || 0) / max) * 100;
    return `<div title="${esc(p.day)}: ${esc(fmtValue(p.value || 0))}"
              style="flex: 1; min-width: 0; height: ${h.toFixed(1)}%;
                     background: var(--p-color-bg-fill-success);"></div>`;
  }).join("");
  region("chart").innerHTML = `
    <div style="display: flex; align-items: flex-end; gap: 2px; height: 160px;">
      ${bars}
    </div>`;
}

// Usage (caller picks the formatter that matches the series):
//   renderChart(trend.points, fmtMoney);   // revenue-by-day
//   renderChart(trend.points, fmtInt);     // orders-by-day
//   renderChart(trend.points, fmtPct);     // conversion-by-day
"""


_EXAMPLE_EDITOR_MODAL = r"""// SHAPE: editor_modal
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: ONE modal scaffold reused for create AND edit. Differs only
// in the initial values + which POST path is called. Uses the
// shell-confirm-* classes the admin shell pre-injects. After a
// successful save: close + bridge.notify + refetch the current page
// (NOT page 1 — the merchant is mid-task).
//
// Focus management (required by UX QUALITY MINIMUM):
//   - Capture document.activeElement BEFORE opening, restore on close
//   - Focus the first interactive element on open so keyboard users
//     can start typing and screen readers announce the dialog
//
// Catalog: POST /items         (create)
//          POST /items/update  (update)

let modal = null;     // currently-open modal element OR null

function openEditor(record) {
  closeModal();
  const isEdit = record !== null;
  const previouslyFocused = document.activeElement;   // restore on close
  const overlay = document.createElement("div");
  overlay.className = "shell-confirm-overlay";
  overlay.innerHTML = `
    <div class="shell-confirm-dialog" role="dialog" aria-modal="true">
      <h2 class="shell-confirm-title">${isEdit ? "Edit item" : "New item"}</h2>
      <div class="shell-confirm-body">
        <form data-form="editor">${/* shell-field inputs per the requestShape */ ""}</form>
      </div>
      <div class="shell-confirm-actions">
        <button class="btn-secondary" data-act="cancel">Cancel</button>
        <button class="btn-primary" data-act="save">Save</button>
      </div>
    </div>`;
  container.appendChild(overlay);
  const form = overlay.querySelector("form");
  if (isEdit) { /* hydrate inputs from record */ }
  const onKey = (e) => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);
  modal = { el: overlay, onKey, previouslyFocused };
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
  overlay.querySelector('[data-act="save"]').addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const saveBtn = overlay.querySelector('[data-act="save"]');
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      const payload = /* read inputs into object matching requestShape */ {};
      if (isEdit) await bridge.call("/items/update", { id: record.id, ...payload });
      else await bridge.call("/items", payload);
      closeModal();
      bridge.notify(isEdit ? "Item updated" : "Item added", "success");
      await loadList();                          // refetch current page
    } catch (_) {
      saveBtn.disabled = false; saveBtn.textContent = "Save";
      bridge.notify("Could not save", "error");
    }
  });
  // Focus the first interactive after the overlay is in the DOM. Defer
  // with rAF so layout has run — focusing a not-yet-laid-out element
  // can fail silently on some browsers.
  requestAnimationFrame(() => {
    (form.querySelector("input, textarea, select")
      || overlay.querySelector("button[data-act='save']")).focus();
  });
}

function closeModal() {
  if (!modal) return;
  document.removeEventListener("keydown", modal.onKey);
  modal.el.remove();
  // Restore focus to the trigger element (typically the row's Edit
  // button) so keyboard users land where they left off.
  modal.previouslyFocused?.focus?.();
  modal = null;
}
"""


_EXAMPLE_CONFIRM_MODAL = r"""// SHAPE: confirm_modal
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply. closeModal + the
//  modal closure live in the editor_modal snippet — keep both shapes
//  together in the same mount() body.)
//
// Teaches: destructive-action confirmation. Three non-obvious bits:
//   1. Cancel is the focused default (autofocus) — protects against
//      stray Enter keypresses on a destructive action.
//   2. Capture previouslyFocused before opening; closeModal in
//      editor_modal restores it on close so keyboard users land back
//      on the row's Delete button.
//   3. If the deleted row was the LAST on the current page, rewind
//      pagination BEFORE refetching — otherwise the refetch returns
//      an empty list even though earlier pages still have data. The
//      rewind variable depends on the active paginationKind:
//        offset → page--
//        cursor → pageCursor = cursorStack.pop() ?? null
//
// Catalog: POST /items/delete  → { id }

function confirmDelete(record) {
  closeModal();
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "shell-confirm-overlay";
  overlay.innerHTML = `
    <div class="shell-confirm-dialog" role="dialog" aria-modal="true">
      <h2 class="shell-confirm-title">Delete "${esc(record.label)}"?</h2>
      <div class="shell-confirm-body">This cannot be undone.</div>
      <div class="shell-confirm-actions">
        <button class="btn-secondary" data-act="cancel" autofocus>Cancel</button>
        <button class="btn-danger" data-act="confirm">Delete</button>
      </div>
    </div>`;
  container.appendChild(overlay);
  const onKey = (e) => { if (e.key === "Escape") closeModal(); };
  document.addEventListener("keydown", onKey);
  modal = { el: overlay, onKey, previouslyFocused };
  // The autofocus attribute fires the moment the element enters the
  // DOM. If a browser ignores autofocus inside dynamically-injected
  // markup, the rAF fallback below guarantees the Cancel button is
  // focused before the merchant's next keypress.
  requestAnimationFrame(() => {
    overlay.querySelector('[data-act="cancel"]').focus();
  });
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
  overlay.querySelector('[data-act="confirm"]').addEventListener("click", async () => {
    const btn = overlay.querySelector('[data-act="confirm"]');
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      await bridge.call("/items/delete", { id: record.id });
      closeModal();
      bridge.notify("Deleted", "success");
      // Last-row-on-page rewind. Pick the path for the active
      // paginationKind — the surrounding paginated_table snippet
      // declares whichever of {page, pageCursor} is in scope.
      if (rows.length === 1) {
        // typeof guards both branches — `page` and `cursorStack` are
        // declared by the paginated_table snippet's chosen mode.
        // Reading an undeclared identifier directly is a ReferenceError;
        // typeof returns "undefined" without throwing.
        if (typeof page === "number" && page > 0) page--;
        else if (typeof cursorStack !== "undefined" && cursorStack.length > 0)
          pageCursor = cursorStack.pop() ?? null;
      }
      await loadList();
    } catch (_) {
      btn.disabled = false; btn.textContent = "Delete";
      bridge.notify("Could not delete", "error");
    }
  });
}
"""


_EXAMPLE_ASYNC_RUNNER = r"""// SHAPE: async_runner
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: the documented async-polling escape hatch. Admins default-
// ban setInterval; long-running merchant actions (enqueue → cron job
// → completion) use a setTimeout chain instead. Rules:
//   - setTimeout chain, NOT setInterval (back-pressure on the handler)
//   - minimum 1500ms between ticks
//   - pause when the iframe is hidden (visibilitychange)
//   - capture the handle on `container.__appPollHandle` so a re-mount
//     can clear the prior chain
//   - stop unconditionally on terminal state (done / failed)
//
// Catalog: POST /run     → { job_id }
//          GET  /status  → { job_id, state, processed, total }
//          state ∈ {"queued","processing","done","failed"}

if (container.__appPollHandle) {       // re-mount idempotency
  clearTimeout(container.__appPollHandle);
  container.__appPollHandle = null;
}

let job = null;

async function start(config) {
  const res = await bridge.call("/run", config);
  job = { job_id: res.job_id, state: "queued", processed: 0, total: 0 };
  renderStatus(); scheduleTick();
}

function scheduleTick() {
  if (document.hidden) {                // pause while hidden
    const onVis = () => {
      if (!document.hidden) {
        document.removeEventListener("visibilitychange", onVis);
        scheduleTick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return;
  }
  container.__appPollHandle = setTimeout(tick, 1500);
}

async function tick() {
  if (!job) return;
  try { job = await bridge.call("/status", { job_id: job.job_id }); renderStatus(); }
  catch (_) { /* soft: keep last state, retry next tick */ }
  if (job.state === "queued" || job.state === "processing") scheduleTick();
  else {
    container.__appPollHandle = null;
    // Both terminal states deserve explicit feedback — silent failure
    // leaves the merchant staring at a "processing" pill in their head.
    if (job.state === "done") bridge.notify("Done", "success");
    else if (job.state === "failed") bridge.notify("Job failed", "error");
  }
}
"""


_EXAMPLE_FILE_DOWNLOAD = r"""// SHAPE: file_download
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: how to trigger a browser download from a bridge.call()
// response. The handler returns the file body as a string field
// (responseShape has `csv` / `pdf` / `xml`); the admin wraps it in a
// Blob and dispatches a synthetic anchor click. NEVER use window.open
// with a data: URL — Safari blocks it.
//
// Catalog: POST /export  → { csv, filename }
//
// `button` is closed over so the disable / re-enable / label-swap
// dance works without juggling event arguments — call bindDownload
// once on mount and the click handler is wired for the page.

function bindDownload(button, params) {
  button.addEventListener("click", async () => {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing…";
    try {
      const res = await bridge.call("/export", params);
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename || "export.csv";
      container.appendChild(a);
      a.click();
      a.remove();
      // Release the object URL on the next tick — Safari needs the click
      // to dispatch BEFORE revocation, otherwise the download cancels.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      bridge.notify("Download started", "success");
    } catch (_) {
      bridge.notify("Could not export", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
}

// Usage at mount time:
//   bindDownload(region("toolbar").querySelector('[data-act="export"]'),
//                { range: "30d" });
"""


_EXAMPLE_TABLE_FILTERS = r"""// SHAPE: table_filters
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply. Requires
//  paginated_table earlier in the same mount() body — cursor /
//  cursorStack / loadList come from there.)
//
// Teaches: search + enum-dropdown filters above a paginated table.
// Two non-obvious bits:
//   1. The status dropdown options come from the LLD's COLUMN ENUM
//      VOCABULARY block — NEVER hardcode statuses (they drift from
//      the handler and render dead options).
//   2. Any filter change resets the cursor / page to start — staying
//      on page 5 of the prior filter set returns the wrong slice.
//
// Catalog: GET /rows  requestShape: { q, status, cursor }
//          → { rows, next_cursor }   (paginationKind: "cursor")

let q = "", statusFilter = "";
let searchTimer = null;

function renderToolbar() {
  region("toolbar").innerHTML = `
    <div class="shell-toolbar">
      <input class="shell-search" data-act="search" placeholder="Search…" value="${esc(q)}" />
      <select class="shell-select" data-act="status">
        <option value="">All statuses</option>
        ${/* ONE <option> per value in the LLD column enum for this table.status */ ""}
      </select>
    </div>`;
  region("toolbar").querySelector('[data-act="search"]').addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {                // 250ms debounce
      q = e.target.value.trim();
      resetAndReload();
    }, 250);
  });
  region("toolbar").querySelector('[data-act="status"]').addEventListener("change", (e) => {
    statusFilter = e.target.value;
    resetAndReload();
  });
}

function resetAndReload() {
  // Match the two-cursor model from paginated_table — `cursor` alone
  // is the legacy single-variable name and is NOT declared once the
  // updated paginated_table snippet is in scope.
  pageCursor = null; nextCursor = null; cursorStack = [];
  loadList();
}

// In loadList, pass q + statusFilter alongside the page cursor:
//   await bridge.call("/rows", { q, status: statusFilter, cursor: pageCursor });
"""


_EXAMPLE_BULK_SELECT_ACTIONS = r"""// SHAPE: bulk_select_actions
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply. Requires
//  paginated_table earlier in the same mount() body — rows / loadList
//  come from there.)
//
// Teaches: checkbox column + selection-aware action bar. Three
// non-obvious bits:
//   1. "Select all" toggles only the VISIBLE page, not the whole
//      dataset — clarify in the action bar count ("3 of 142 selected
//      on this page").
//   2. Selection is keyed by `id`, not by row index — pagination /
//      refetch reorders rows, but ids are stable.
//   3. After a successful bulk action: clear selection, refetch.
//
// Catalog: POST /bulk-action  requestShape: { ids: "string[]", action: "string" }

let selectedIds = new Set();

function renderActionBar() {
  if (selectedIds.size === 0) { region("actions").innerHTML = ""; return; }
  region("actions").innerHTML = `
    <div class="shell-toolbar">
      <span>${selectedIds.size} of ${rows.length} selected on this page</span>
      <button class="btn-primary" data-act="run">Apply action</button>
      <button class="btn-secondary" data-act="clear">Clear</button>
    </div>`;
  region("actions").querySelector('[data-act="run"]').addEventListener("click", runBulk);
  region("actions").querySelector('[data-act="clear"]').addEventListener("click", () => {
    selectedIds.clear(); renderActionBar(); renderList();
  });
}

// In renderList: prepend a <th><input type="checkbox" data-act="select-all" ...>
// and per-row <td><input type="checkbox" data-id="${esc(r.id)}" ...>; the
// click handler flips entries in `selectedIds`, then re-renders the bar.

async function runBulk() {
  try {
    await bridge.call("/bulk-action", { ids: [...selectedIds], action: "tag" });
    bridge.notify(`Applied to ${selectedIds.size} items`, "success");
    selectedIds.clear(); renderActionBar();
    await loadList();
  } catch (_) {
    bridge.notify("Could not apply action", "error");
  }
}
"""


_EXAMPLE_RESOURCE_PICKER = r"""// SHAPE: resource_picker
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: selecting Shopify resources inside an editor_modal field.
//
// TWO PATHS — pick the right one for the resource type:
//
//   1. Native (PREFERRED) — bridge.pickResource() opens Shopify's
//      own ResourcePicker. Use for products / collections / variants.
//      Zero Admin GraphQL spend, native merchant UX. The handler
//      receives gids (gid://shopify/Product/123) and persists them
//      verbatim.
//
//   2. Custom search (FALLBACK) — debounced /search backend call.
//      Use ONLY for customer picking (App Bridge doesn't expose a
//      native customer picker) or for app-internal records that
//      aren't Shopify resources. Costs Admin GraphQL units on every
//      keystroke, so 250ms debounce is mandatory.
//
// Persistence (both paths): store BOTH the external id (what the
// handler keys on) AND the display label (what the merchant sees on
// reload) so re-opening the editor doesn't re-search.

// ── PATH 1: Native ResourcePicker (the common case) ─────────────────────
async function pickProducts(host) {
  const picked = await bridge.pickResource({
    type: "product",
    multiple: 10,                                     // cap at 10 picks
    selectionIds: [...selected.values()].map((m) => ({ id: m.id })),
  });
  if (!picked) return;                                // merchant cancelled
  selected.clear();
  for (const p of picked) {
    selected.set(p.id, { id: p.id, label: p.title || p.id });
  }
  renderChips(host);
}

// ── PATH 2: Custom search (customers, app-internal records) ─────────────
let searchTimer = null;
let selected = new Map();      // id → { id, label, image_url? }

function renderCustomSearch(host) {
  host.innerHTML = `
    <input class="shell-input" data-act="q" placeholder="Search customers…" />
    <div data-region="results"></div>
    <div data-region="chips"></div>`;
  host.querySelector('[data-act="q"]').addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (!q) { host.querySelector('[data-region="results"]').innerHTML = ""; return; }
    searchTimer = setTimeout(() => doSearch(host, q), 250);
  });
  renderChips(host);
}

async function doSearch(host, q) {
  let res;
  try { res = await bridge.call("/customers/search", { q }); }
  catch (_) { bridge.notify("Search failed", "error"); return; }
  const results = host.querySelector('[data-region="results"]');
  results.innerHTML = (res.rows || []).map((r) => `
    <button class="btn-secondary" data-id="${esc(r.external_id)}"
            data-label="${esc(r.title)}"
            style="display:block; text-align:left; width:100%;">
      ${esc(r.title)}
    </button>`).join("");
  results.querySelectorAll("[data-id]").forEach((b) =>
    b.addEventListener("click", () => {
      selected.set(b.dataset.id, { id: b.dataset.id, label: b.dataset.label });
      host.querySelector('[data-act="q"]').value = "";
      results.innerHTML = "";
      renderChips(host);
    }));
}

// ── Shared chip render (both paths feed `selected`) ─────────────────────
function renderChips(host) {
  const chips = host.querySelector('[data-region="chips"]');
  chips.innerHTML = [...selected.values()].map(({ id, label }) => `
    <span class="badge badge-neutral" style="display:inline-flex; gap:6px;">
      ${esc(label)}
      <button data-rm="${esc(id)}" aria-label="Remove">×</button>
    </span>`).join("");
  chips.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      selected.delete(b.dataset.rm);
      renderChips(host);
    }));
}

// On editor_modal save, persist [...selected.keys()] as the ids and
// the labels alongside (e.g. on the record's JSONB column) so
// re-opening the editor can rehydrate `selected` without re-fetching.
"""


_EXAMPLE_FILE_UPLOAD = r"""// SHAPE: file_upload
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: file input → base64-or-text string in the POST body. The
// bridge has NO FormData affordance; uploads ride inside JSON.
//
// Non-obvious bits:
//   1. Enforce a max size client-side (e.g. 2MB) before reading the
//      file — large reads block the iframe.
//   2. Use FileReader.readAsText for CSV / readAsDataURL for images;
//      strip the `data:image/...;base64,` prefix before sending.
//   3. Show a preview row count (CSV) or thumbnail (image) before
//      the merchant clicks Upload — silent uploads scare them.
//
// Catalog: POST /import-csv  requestShape: { csv_text }
//                            → { imported_count, errors: ["..."] }

const MAX_BYTES = 2 * 1024 * 1024;

function renderUploader() {
  region("upload").innerHTML = `
    <div class="shell-field">
      <label class="shell-label" for="csv">Choose CSV file</label>
      <input class="shell-input" id="csv" type="file" accept=".csv,text/csv" />
    </div>
    <div data-region="preview"></div>
    <button class="btn-primary" data-act="upload" disabled>Upload</button>`;
  let csvText = null;
  region("upload").querySelector("#csv").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      bridge.notify("File too large (max 2MB)", "error"); return;
    }
    csvText = await file.text();
    const rowCount = (csvText.match(/\n/g) || []).length;
    region("upload").querySelector('[data-region="preview"]').textContent =
      `${file.name} — ${fmtInt(rowCount)} rows`;
    region("upload").querySelector('[data-act="upload"]').disabled = false;
  });
  region("upload").querySelector('[data-act="upload"]').addEventListener("click", async (e) => {
    if (!csvText) return;
    e.target.disabled = true; e.target.textContent = "Uploading…";
    try {
      const res = await bridge.call("/import-csv", { csv_text: csvText });
      bridge.notify(`Imported ${res.imported_count} rows`, "success");
      if (res.errors && res.errors.length > 0) {
        // Show errors inline — merchant needs the row numbers to fix.
        // appendChild (NOT innerHTML +=) so the preview region's
        // existing content keeps its listeners; += re-parses the
        // region and destroys them.
        const banner = document.createElement("div");
        banner.className = "shell-warning-banner";
        banner.innerHTML = res.errors.map(esc).join("<br>");
        region("preview").appendChild(banner);
      }
      await loadList();              // refetch wherever the rows show up
    } catch (_) {
      bridge.notify("Import failed", "error");
    } finally {
      e.target.disabled = false; e.target.textContent = "Upload";
    }
  });
}

// For image upload (e.g. Lookbook), swap to readAsDataURL and slice
// off the prefix:
//   const dataUrl = await new Promise((r) => {
//     const fr = new FileReader();
//     fr.onload = () => r(fr.result); fr.readAsDataURL(file);
//   });
//   const base64 = dataUrl.split(",", 2)[1];
//   await bridge.call("/upload-image", { image_base64: base64, mime: file.type });
"""


_EXAMPLE_EMPTY_STATE_CTA = r"""// SHAPE: empty_state_cta
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply. References
//  openEditor from editor_modal — keep both shapes in the same
//  mount() body.)
//
// Teaches: first-run empty state with a primary action. Used WHEREVER
// a paginated_table or list region could be empty on day one (FAQ
// builder before any questions, Locator before any stores, Returns
// before any requests).
//
// Distinction (matters for copy):
//   - Empty (no data ever)      → "Add your first X" with btn-primary
//   - Empty (after filtering)   → "No matches. Clear filters?" link
// shell-empty styles the wrapper; the action lives inside it.
//
// One non-obvious bit: the CTA's click handler is the same one
// triggered by the page header's "New X" button — share it.

function renderEmpty(kind /* "first-run" | "filtered" */) {
  if (kind === "filtered") {
    region("list").innerHTML = `
      <div class="shell-empty">
        <p>No matches for the current filters.</p>
        <button class="btn-secondary" data-act="clear-filters">Clear filters</button>
      </div>`;
    region("list").querySelector('[data-act="clear-filters"]').addEventListener("click", () => {
      // Reset filter state and reload — see table_filters' resetAndReload.
      q = ""; statusFilter = ""; renderToolbar(); resetAndReload();
    });
    return;
  }
  // First-run: same primary affordance as the header's "New X" button.
  region("list").innerHTML = `
    <div class="shell-empty">
      <h2 class="shell-section-title">No questions yet</h2>
      <p>Questions appear here once you add them. Start with the most common one your customers ask.</p>
      <button class="btn-primary" data-act="new">Add your first question</button>
    </div>`;
  region("list").querySelector('[data-act="new"]').addEventListener("click", () => openEditor(null));
}

// Caller picks the kind based on whether ANY filter is active:
//   const isFiltered = q !== "" || statusFilter !== "";
//   renderEmpty(isFiltered ? "filtered" : "first-run");
"""


_EXAMPLE_DATE_RANGE_PICKER = r"""// SHAPE: date_range_picker
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: preset-range buttons + custom date pair, with all
// downstream regions refetched on change. Two non-obvious bits:
//   1. Presets (7d / 30d / 90d) post a SYMBOLIC range string, not
//      a computed date pair — the handler does the arithmetic
//      relative to "now" server-side. Otherwise client clock skew
//      shifts the window.
//   2. Custom mode posts ISO date strings (YYYY-MM-DD) — never
//      Date objects, never locale-formatted dates.
//
// Catalog: GET /kpis  requestShape: { range, from, to }
//          range ∈ {"7d","30d","90d","custom"}; from/to required iff
//          range="custom"

let range = "30d";
let fromDate = "", toDate = "";

function renderRange() {
  region("range").innerHTML = `
    <div class="shell-toolbar">
      ${["7d","30d","90d","custom"].map((r) => `
        <button class="${r === range ? "btn-primary" : "btn-secondary"}"
                data-range="${r}">${r === "custom" ? "Custom" : "Last " + r.replace("d"," days")}</button>`).join("")}
      ${range === "custom" ? `
        <input class="shell-input" type="date" data-act="from" value="${esc(fromDate)}" />
        <input class="shell-input" type="date" data-act="to"   value="${esc(toDate)}" />` : ""}
    </div>`;
  region("range").querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => { range = b.dataset.range; renderRange(); maybeReload(); }));
  if (range === "custom") {
    region("range").querySelector('[data-act="from"]').addEventListener("change", (e) => {
      fromDate = e.target.value; maybeReload();
    });
    region("range").querySelector('[data-act="to"]').addEventListener("change", (e) => {
      toDate = e.target.value; maybeReload();
    });
  }
}

function maybeReload() {
  // Custom mode requires both endpoints — don't fire until the merchant
  // has chosen them. A half-defined custom range hits the handler with
  // a 400 every keystroke.
  if (range === "custom" && (!fromDate || !toDate)) return;
  reloadAll();   // refetches every region driven by range (kpis, chart, top)
}

// In each downstream loader:
//   bridge.call("/kpis", range === "custom" ? { range, from: fromDate, to: toDate }
//                                            : { range })
"""


_EXAMPLE_DRAG_REORDER = r"""// SHAPE: drag_reorder
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: HTML5 native drag-and-drop to reorder list items. No
// libraries. Four non-obvious bits:
//   1. Optimistic — reorder rows[] locally on drop, render
//      immediately, then POST. On failure, snapshot+restore the
//      pre-drag order. Server is the source of truth; UI feels
//      instant.
//   2. The dragover handler MUST call e.preventDefault() — without
//      it the drop event never fires. This is a browser quirk that
//      bites every first implementation.
//   3. Persist the merchant's chosen sequence as `position` indexes
//      (0, 1, 2, ...) — NOT timestamps, NOT swap pairs. The handler
//      stores `position INT NOT NULL` on each row.
//   4. NO refetch after a successful /reorder — documented exception
//      to the lifecycle's "refetch after mutation" rule. The locally
//      reordered rows[] already matches what the server stored;
//      refetching would only mask races with concurrent edits, which
//      this app doesn't model.
//
// Catalog: POST /reorder  requestShape: { ordered_ids: "string[]" }

function renderReorderableList() {
  region("list").innerHTML = `
    <ul class="shell-table" style="list-style:none; padding:0;">
      ${rows.map((r) => `
        <li draggable="true" data-id="${esc(r.id)}"
            style="padding: var(--p-space-300); border-bottom: 1px solid var(--p-color-border); cursor: grab;">
          ⠿  ${esc(r.label)}
        </li>`).join("")}
    </ul>`;
  let draggedId = null;
  region("list").querySelectorAll("li").forEach((li) => {
    li.addEventListener("dragstart", (e) => {
      draggedId = li.dataset.id;
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => e.preventDefault());  // critical
    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!draggedId || draggedId === li.dataset.id) return;
      const snapshot = [...rows];
      const from = rows.findIndex((r) => String(r.id) === draggedId);
      const to = rows.findIndex((r) => String(r.id) === li.dataset.id);
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      renderReorderableList();
      try {
        await bridge.call("/reorder", {
          ordered_ids: rows.map((r) => String(r.id)),
        });
      } catch (_) {
        rows = snapshot;
        renderReorderableList();
        bridge.notify("Could not save order", "error");
      }
      draggedId = null;
    });
  });
}
"""


_EXAMPLE_INLINE_EDIT = r"""// SHAPE: inline_edit
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: edit one cell on a row without opening a modal. Click the
// cell → swap to <select>/<input> → save on change/blur → revert on
// Escape. Three non-obvious bits:
//   1. The displayed cell carries the row id AND the field name as
//      data-attributes — click handler reads both, no closures over
//      the loop variable.
//   2. Save uses the field's CHANGE event (not blur) so Escape can
//      restore without firing a save. Bind both: change → save,
//      keydown(Escape) → cancel.
//   3. Optimistic + rollback. Update rows[idx][field] locally first,
//      render, then POST. On failure, restore from snapshot. The
//      cell never sits in a "saving…" indeterminate state.
//
// Catalog: POST /items/update-field
//          requestShape: { id, field, value }

function onCellClick(td) {
  const id = td.dataset.id;
  const field = td.dataset.field;
  const row = rows.find((r) => String(r.id) === id);
  if (!row) return;
  const snapshot = row[field];

  // Look up enum options from the LLD's COLUMN ENUM VOCABULARY — the
  // ONLY legal values for an enum column. The caller passes a lookup
  // dict from the rendered db_contracts (e.g.
  //   ENUM_VALUES_FOR.status = ["pending","completed","failed"]).
  // Non-enum (free-text) columns fall through to a text input.
  const options = ENUM_VALUES_FOR[field];
  if (options && options.length) {
    td.innerHTML = `
      <select class="shell-select" data-act="edit">
        ${options.map((v) => `
          <option value="${esc(v)}" ${v === snapshot ? "selected" : ""}>${esc(v)}</option>`).join("")}
      </select>`;
  } else {
    td.innerHTML = `
      <input class="shell-input" type="text" data-act="edit"
             value="${esc(snapshot ?? "")}" />`;
  }
  const control = td.querySelector('[data-act="edit"]');
  control.focus();
  if (control.tagName === "INPUT") control.select();

  // Commit on BOTH change (select pick / Enter on input) AND blur
  // (tab-out / click-away). Without blur, picking a value and clicking
  // another cell loses the edit. `committed` guards against a double
  // fire when both events trigger.
  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const value = control.value;
    if (value === String(snapshot ?? "")) { renderList(); return; }   // no-op edit
    row[field] = value;
    renderList();
    try {
      await bridge.call("/items/update-field", { id, field, value });
      bridge.notify("Updated", "success");
    } catch (_) {
      row[field] = snapshot;
      renderList();
      bridge.notify("Could not update", "error");
    }
  }
  control.addEventListener("change", commit);
  control.addEventListener("blur", commit);
  control.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { committed = true; renderList(); }       // revert
    else if (e.key === "Enter" && control.tagName === "INPUT") control.blur();
  });
}

// In renderList, give each editable cell:
//   <td data-id="${esc(r.id)}" data-field="status">${esc(r.status)}</td>
// and wire region("list").addEventListener("click", (e) => {
//   const td = e.target.closest("td[data-field]");
//   if (td) onCellClick(td);
// });
"""


_EXAMPLE_WIZARD = r"""// SHAPE: wizard
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: linear multi-step setup with Back/Next/Skip and a final
// Submit. Distinct from tabs_layout (non-linear): wizard enforces
// order, validates per step before advancing, and persists once at
// the end. Three non-obvious bits:
//   1. Step state lives in a single `formState` object — not one
//      <form> per step. Each step renders its slice of formState and
//      reads/writes the same keys.
//   2. Forward navigation runs the step's `validate()` returning a
//      boolean. Failed validation does NOT advance.
//   3. Step indicator (1/4, 2/4...) lives at the top so the merchant
//      always knows where they are. Back is disabled on step 0.
//
// Catalog: POST /setup  requestShape: { …all keys collected across steps }

const STEPS = ["Basics", "Trigger", "Audience", "Review"];
let step = 0;
let formState = { name: "", trigger: "manual", audience: "all" };

function renderWizard() {
  region("wizard").innerHTML = `
    <div class="shell-toolbar">
      ${STEPS.map((label, i) => `
        <span class="${i === step ? "badge badge-success" : "badge badge-neutral"}">
          ${i + 1}. ${esc(label)}
        </span>`).join("")}
    </div>
    <div data-region="step-body" class="shell-card"></div>
    <div class="shell-toolbar">
      <button class="btn-secondary" data-act="back" ${step === 0 ? "disabled" : ""}>← Back</button>
      <button class="btn-primary"   data-act="next">
        ${step === STEPS.length - 1 ? "Submit" : "Next →"}
      </button>
    </div>`;
  renderStepBody();
  region("wizard").querySelector('[data-act="back"]').addEventListener("click", () => {
    if (step > 0) { step--; renderWizard(); }
  });
  region("wizard").querySelector('[data-act="next"]').addEventListener("click", async () => {
    if (!validateCurrentStep()) return;
    if (step < STEPS.length - 1) { step++; renderWizard(); }
    else await submit();
  });
}

function renderStepBody() {
  const body = region("wizard").querySelector('[data-region="step-body"]');
  // One render branch per step — each reads/writes formState in place.
  // Inputs use `oninput`-style listeners that mutate formState directly
  // (no separate state-update plumbing for a 3-key wizard).
  if (step === 0) { body.innerHTML = /* basics fields */ ""; }
  else if (step === 1) { body.innerHTML = /* trigger fields */ ""; }
  else if (step === 2) { body.innerHTML = /* audience fields */ ""; }
  else { body.innerHTML = /* review: render formState as a labelled list */ ""; }
}

function validateCurrentStep() {
  // Clear prior aria-invalid before re-checking — a field that's been
  // fixed since the last attempt shouldn't keep the invalid marker.
  region("wizard").querySelectorAll('[aria-invalid="true"]').forEach((el) =>
    el.removeAttribute("aria-invalid"));

  // Per-step validation pattern: mark the failing input aria-invalid,
  // focus it (so the merchant lands on the problem), notify, return
  // false. The prompt's accessibility minimum requires aria-invalid;
  // a toast alone is not enough for screen-reader users.
  if (step === 0 && !formState.name.trim()) {
    const nameInput = region("wizard").querySelector('[name="name"]');
    if (nameInput) {
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.focus();
    }
    bridge.notify("Name is required", "error");
    return false;
  }
  // ... add a branch per step using the same pattern
  return true;
}

async function submit() {
  try {
    await bridge.call("/setup", formState);
    bridge.notify("Setup complete", "success");
    // Reset the wizard OR navigate the merchant to the next screen.
  } catch (_) {
    bridge.notify("Could not save setup", "error");
  }
}
"""


_EXAMPLE_DETAIL_DRAWER = r"""// SHAPE: detail_drawer
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: slide-in side panel showing one record's full details
// without leaving the list. The Shopify-native pattern for "click a
// row → see more". Three non-obvious bits:
//   1. The drawer is a single instance reused across rows — fetch
//      the detail GET on open, replace the body, restore focus on
//      close. NOT a new DOM node per row.
//   2. The list stays interactive behind the drawer (no backdrop) —
//      this is what makes drawers different from modals. The
//      merchant can scan the list and pick another row without
//      closing.
//   3. ESC closes; a click anywhere outside the drawer closes. Track
//      mousedown OUTSIDE the drawer to avoid the "click started
//      inside, drag selection ended outside" case from closing
//      unexpectedly.
//
// Catalog: GET /items/detail  requestShape: { id }
//          → { id, full_details_shape }

let drawer = null;     // currently-open drawer OR null

function openDrawer(record) {
  closeDrawer();
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement("aside");
  overlay.setAttribute("role", "complementary");
  overlay.setAttribute("aria-label", `Details for ${record.label}`);
  overlay.style.cssText = `
    position: fixed; top: 0; right: 0; bottom: 0;
    width: min(480px, 100vw); background: var(--p-color-bg-surface);
    border-left: 1px solid var(--p-color-border-emphasis);
    box-shadow: var(--p-shadow-300); padding: var(--p-space-500);
    overflow-y: auto; z-index: 100;`;
  overlay.innerHTML = `
    <div class="shell-toolbar">
      <h2 class="shell-section-title">${esc(record.label)}</h2>
      <button class="btn-secondary" data-act="close" aria-label="Close">✕</button>
    </div>
    <div data-region="detail-body" class="shell-loading">Loading details…</div>`;
  container.appendChild(overlay);
  const onKey = (e) => { if (e.key === "Escape") closeDrawer(); };
  const onMouseDown = (e) => { if (!overlay.contains(e.target)) closeDrawer(); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onMouseDown);
  drawer = { el: overlay, onKey, onMouseDown, previouslyFocused };
  overlay.querySelector('[data-act="close"]').addEventListener("click", closeDrawer);
  bridge.call("/items/detail", { id: record.id })
    .then((detail) => {
      overlay.querySelector('[data-region="detail-body"]').innerHTML =
        /* render the labelled-list view from detail */ "";
    })
    .catch(() => bridge.notify("Could not load details", "error"));
  requestAnimationFrame(() => {
    overlay.querySelector('[data-act="close"]').focus();
  });
}

function closeDrawer() {
  if (!drawer) return;
  document.removeEventListener("keydown", drawer.onKey);
  document.removeEventListener("mousedown", drawer.onMouseDown);
  drawer.el.remove();
  drawer.previouslyFocused?.focus?.();
  drawer = null;
}
"""


_EXAMPLE_TABS_LAYOUT = r"""// SHAPE: tabs_layout
//
// (Everything below sits INSIDE mount(container, bridge); the anchor's
//  scaffold + helpers from DATA FORMATTING apply.)
//
// Teaches: top-level tab navigation for multi-screen admins. Tabs are
// the right affordance when ≥3 distinct surfaces share the same
// merchant context (e.g. Newsletter Popup: Copy / Discount / Triggers
// / Subscribers). Lazy-load each tab's data on first activation —
// don't fire every tab's fetches on mount.
//
// One non-obvious bit: persist the active tab on `container.dataset` so
// a re-mount (e.g. Shopify nav re-renders the panel) lands the merchant
// back on the tab they were using.

const TABS = ["copy", "discount", "triggers", "subscribers"];
const loaded = new Set();     // tab names whose data has been fetched
let active = container.dataset.activeTab || "copy";

function renderTabs() {
  container.querySelector('[data-region="tabs"]').innerHTML = `
    <nav class="shell-toolbar">
      ${TABS.map((t) => `
        <button class="${t === active ? "btn-primary" : "btn-secondary"}"
                data-tab="${esc(t)}">${cap(t)}</button>`).join("")}
    </nav>`;
  container.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => activate(b.dataset.tab)));
}

async function activate(tab) {
  active = tab; container.dataset.activeTab = tab;
  renderTabs(); renderPanel();
  if (!loaded.has(tab)) {
    loaded.add(tab);
    await loadTabData(tab);   // GET specific to this tab
    renderPanel();
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
"""


# ── Registry ────────────────────────────────────────────────────────────────


ADMIN_SHAPES: Dict[str, Dict[str, Any]] = {
    "settings_form": {
        "description": (
            "Anchor shape — dirty-tracked load-then-save form. Establishes "
            "the scaffold (data-region selectors, banner, esc/fmt helpers, "
            "bridge.notify) that every other snippet inherits."
        ),
        "example_js": _EXAMPLE_SETTINGS_FORM,
        "route_predicate": _has_get_post_pair,
        "text_keywords": ["settings", "configuration", "config"],
    },
    "tabs_layout": {
        "description": (
            "Top-level tabs for multi-screen admins. Lazy-load each tab's "
            "data on first activation; persist active tab on container "
            "dataset so re-mount restores position."
        ),
        "example_js": _EXAMPLE_TABS_LAYOUT,
        "route_predicate": _has_many_path_prefixes,
        "text_keywords": ["tabs", "sections"],
    },
    "wizard": {
        "description": (
            "Linear multi-step setup (Back / Next / Skip → Submit). "
            "One formState across all steps; per-step validate() gates "
            "Next. Use ONLY for genuinely sequential flows; otherwise "
            "tabs_layout."
        ),
        "example_js": _EXAMPLE_WIZARD,
        "route_predicate": None,
        "text_keywords": [
            "wizard",
            "step by step",
            "guided setup",
            "onboarding flow",
            "multi-step",
        ],
    },
    "date_range_picker": {
        "description": (
            "Preset-range buttons (7d / 30d / 90d) plus a custom "
            "from/to pair. Presets post a symbolic range so the "
            "handler does date arithmetic relative to its own clock; "
            "custom posts ISO date strings."
        ),
        "example_js": _EXAMPLE_DATE_RANGE_PICKER,
        "route_predicate": None,
        "text_keywords": [
            "date range",
            "last 7 days",
            "last 30 days",
            "time range",
            "from date",
        ],
    },
    "paginated_table": {
        "description": (
            "Paginated record list. paginationKind dispatch is the core "
            "rule — offset → page numbers + total, cursor → Load-more / "
            "Prev-Next (no totals), inline → no controls."
        ),
        "example_js": _EXAMPLE_PAGINATED_TABLE,
        "route_predicate": _has_paginated_route,
        "text_keywords": ["list", "subscribers", "history", "log", "activity"],
    },
    "table_filters": {
        "description": (
            "Search + enum-dropdown filters above a paginated table. "
            "Dropdown options come from the LLD's COLUMN ENUM VOCABULARY "
            "— never hardcode statuses. Any filter change resets "
            "pagination to the start."
        ),
        "example_js": _EXAMPLE_TABLE_FILTERS,
        "route_predicate": None,
        "text_keywords": ["filter", "search", "filtering"],
    },
    "bulk_select_actions": {
        "description": (
            "Row checkboxes + selection-aware action bar. Select-all "
            "covers the visible page only; selection is keyed by stable "
            "id; clear selection + refetch on successful action."
        ),
        "example_js": _EXAMPLE_BULK_SELECT_ACTIONS,
        "route_predicate": _has_id_array_request,
        "text_keywords": ["bulk", "select multiple", "batch"],
    },
    "inline_edit": {
        "description": (
            "Edit one cell on a row without opening a modal. Click → "
            "swap to <select>/<input> → optimistic update + POST → "
            "rollback from snapshot on failure. Escape cancels."
        ),
        "example_js": _EXAMPLE_INLINE_EDIT,
        "route_predicate": _has_update_field_route,
        "text_keywords": [
            "inline edit",
            "edit in place",
            "toggle status",
            "change status",
        ],
    },
    "drag_reorder": {
        "description": (
            "HTML5 drag-and-drop to reorder list items. Optimistic "
            "local reorder + POST ordered_ids; snapshot-restore on "
            "failure. The dragover handler MUST preventDefault — "
            "without it the drop never fires."
        ),
        "example_js": _EXAMPLE_DRAG_REORDER,
        "route_predicate": None,
        "text_keywords": [
            "reorder",
            "drag to reorder",
            "drag and drop",
            "ordering",
            "prioritise",
        ],
    },
    # ── Modal pair ────────────────────────────────────────────────────────
    # editor_modal defines the closeModal / modal closure that
    # confirm_modal references. Both must precede any shape that calls
    # openEditor (currently empty_state_cta). Keep this ordering.
    "editor_modal": {
        "description": (
            "Reusable create+edit modal. Same scaffold for both flows; "
            "differs only in initial values and POST path. After save: "
            "close, notify, refetch the current page (not page 1)."
        ),
        "example_js": _EXAMPLE_EDITOR_MODAL,
        "route_predicate": _has_multiple_mutation_paths,
        "text_keywords": ["create", "edit", "new entry", "add new"],
    },
    "confirm_modal": {
        "description": (
            "Destructive-action confirmation dialog. Cancel is the "
            "focused default; if the deleted row is the last on its "
            "page, rewind to the previous page BEFORE refetching."
        ),
        "example_js": _EXAMPLE_CONFIRM_MODAL,
        "route_predicate": _has_delete_path,
        "text_keywords": ["delete", "remove", "destroy"],
    },
    "detail_drawer": {
        "description": (
            "Slide-in side panel showing one record's full details "
            "without leaving the list. No backdrop (list stays "
            "interactive). One drawer instance reused across rows; "
            "fetched on open, cleared on close."
        ),
        "example_js": _EXAMPLE_DETAIL_DRAWER,
        "route_predicate": _has_detail_route,
        "text_keywords": [
            "drawer",
            "side panel",
            "details panel",
            "inspector",
            "preview row",
        ],
    },
    "resource_picker": {
        "description": (
            "Debounced search-as-you-type picker for selecting Shopify "
            "resources (products, collections, customers) inside a "
            "form. Stores both external id (persist) and display label "
            "(rehydrate without re-searching)."
        ),
        "example_js": _EXAMPLE_RESOURCE_PICKER,
        "route_predicate": _has_search_route,
        "text_keywords": [
            "pick product",
            "pick collection",
            "select product",
            "select collection",
            "assign to product",
        ],
    },
    "file_upload": {
        "description": (
            "File input → base64/text string in JSON body (bridge has no "
            "FormData). Client-side size cap, preview before upload, "
            "inline row-by-row errors after CSV import."
        ),
        "example_js": _EXAMPLE_FILE_UPLOAD,
        "route_predicate": _has_file_upload_request,
        "text_keywords": ["csv import", "upload", "import file"],
    },
    "empty_state_cta": {
        "description": (
            "First-run empty state with primary CTA. Distinct copy + "
            "affordance for empty-no-data vs empty-after-filtering. "
            "Calls openEditor — requires editor_modal earlier in the "
            "registry."
        ),
        "example_js": _EXAMPLE_EMPTY_STATE_CTA,
        "route_predicate": None,
        "text_keywords": ["first", "get started", "onboarding"],
    },
    "kpi_stats_row": {
        "description": (
            "Stat cards driven by independent per-card fetches. Promise."
            "all would block the fastest card on the slowest endpoint — "
            "render each as its own promise resolves."
        ),
        "example_js": _EXAMPLE_KPI_STATS_ROW,
        "route_predicate": _has_kpi_response,
        "text_keywords": ["kpi", "metrics", "stats", "summary"],
    },
    "inline_chart": {
        "description": (
            "Dependency-free chart rendering. Flex-stacked bars for time-"
            "series; inline SVG path for line charts. No D3 / Chart.js "
            "— admin bundles stay small."
        ),
        "example_js": _EXAMPLE_INLINE_CHART,
        "route_predicate": _has_series_response,
        "text_keywords": ["chart", "graph", "trend", "over time"],
    },
    "async_runner": {
        "description": (
            "Long-running merchant action via enqueue + cron + poll. "
            "Documented escape hatch from the setInterval ban: "
            "setTimeout chain ≥1500ms, pause while iframe hidden, "
            "handle captured on container, stop on terminal state."
        ),
        "example_js": _EXAMPLE_ASYNC_RUNNER,
        "route_predicate": None,
        "text_keywords": [
            "run now",
            "bulk",
            "generate",
            "process all",
            "trigger",
            "manual run",
            "enqueue",
        ],
    },
    "file_download": {
        "description": (
            "Trigger a browser download from a bridge.call() response. "
            "Wrap response field in a Blob + synthetic anchor click; "
            "revoke object URL on next tick (Safari). Never window.open "
            "a data: URL — Safari blocks it."
        ),
        "example_js": _EXAMPLE_FILE_DOWNLOAD,
        "route_predicate": _has_blob_response,
        "text_keywords": ["export", "download", "csv", "pdf"],
    },
}


# ── Public API (mirror of widget_shapes.py) ─────────────────────────────────


def is_known_shape(name: str) -> bool:
    """Schema validator hook — the LLD's adminShapes field accepts only
    keys present in ADMIN_SHAPES."""
    return name in ADMIN_SHAPES


def all_shape_names() -> List[str]:
    """Used by the LLD prompt's enum description."""
    return list(ADMIN_SHAPES.keys())


def admin_shapes_section() -> str:
    """Render the LLD prompt's enum section from the registry. Adding a
    new shape to ADMIN_SHAPES regenerates this automatically — the LLD
    prompt does not hardcode the list."""
    lines = []
    for name, meta in ADMIN_SHAPES.items():
        lines.append(f"  {name}")
        words = meta["description"].split()
        line = "      "
        for w in words:
            if len(line) + 1 + len(w) > 76:
                lines.append(line)
                line = "      " + w
            else:
                line = (line + " " + w).strip() if line.strip() else line + w
                if not line.startswith("      "):
                    line = "      " + line.lstrip()
        if line.strip():
            lines.append(line)
    return "\n".join(lines)


def examples_for_admin(lld: Dict[str, Any], intent: Dict[str, Any]) -> List[str]:
    """
    Return the list of example JS bodies to append to the admin agent's
    user message, picked by the dispatcher.

    Three signal sources for SELECTION, combined (same hierarchy as
    widget_shapes):

      1. Structured  — `lld.uxExpectations.adminShapes`. When non-empty,
         this is the primary signal; the KEYWORD fallback (source 3)
         is suppressed. Route predicates (source 2) still run regardless
         — they catch shapes the LLD missed declaring.
      2. Mechanical  — apply each shape's `route_predicate` to the
         admin's HTTP route catalog.
      3. Heuristic   — keyword match on `uxExpectations.admin` +
         `intent.qualityBrief` + `intent.desiredOutcome`. Suppressed
         when `adminShapes` is declared (source 1 wins).

    ORDERING. Emitted bodies follow registry insertion order
    (`ADMIN_SHAPES`), NOT alphabetical sort. Some snippets reference
    helpers defined in earlier snippets (e.g. `confirm_modal` calls
    the `closeModal` / `modal` closure that lives in `editor_modal`).
    The registry is curated so earlier entries are dependencies of
    later ones; alphabetical sort breaks that.

    Shapes whose `example_js` is None are skipped — they exist in the
    registry (for LLD classification) but no body has been authored yet.
    """
    routes = (lld.get("httpRoutes") or {}).get("admin") or []
    ux = lld.get("uxExpectations") or {}
    declared = set(ux.get("adminShapes") or [])

    text = " ".join(
        [
            ux.get("admin") or "",
            intent.get("qualityBrief") or "",
            intent.get("desiredOutcome") or "",
        ]
    ).lower()

    chosen: set[str] = set(declared)

    for name, meta in ADMIN_SHAPES.items():
        pred: Optional[Callable[[List[Dict[str, Any]]], bool]] = meta.get(
            "route_predicate"
        )
        if pred is not None and pred(routes):
            chosen.add(name)
        if not declared:
            for kw in meta.get("text_keywords") or []:
                if kw in text:
                    chosen.add(name)
                    break

    # Emit in registry insertion order (dependency-correct) — NOT
    # alphabetical. See ORDERING note in the docstring.
    bodies: List[str] = []
    for name, meta in ADMIN_SHAPES.items():
        if name not in chosen:
            continue
        body = meta.get("example_js")
        if body:
            bodies.append(body)
    return bodies

import type { AdminBridge } from "@platform/admin-sdk";
import type {
  AdminDashboardRequest,
  AdminDashboardResponse,
  AdminSubscribersRequest,
  AdminSubscribersResponse,
  AdminSubscribersExportRequest,
  AdminSubscribersExportResponse,
  AdminSettingsResponse,
  AdminSaveTemplateRequest,
  AdminSaveTemplateResponse,
  AdminSaveQuietHoursRequest,
  AdminSaveQuietHoursResponse,
  DashboardItem,
  SubscriberItem,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // ── CSS ─────────────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bis-nav { display: flex; gap: 8px; margin-bottom: 16px; }
    .bis-section { display: none; }
    .bis-section.active { display: block; }
    .bis-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .bis-table th, .bis-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--p-color-bg-surface); }
    .bis-metrics-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .bis-metric-card { flex: 1 1 120px; padding: 12px; background: var(--p-color-bg-surface); border-radius: 4px; }
    .bis-metric-card .value { font-size: 24px; font-weight: bold; }
    .bis-metric-card .label { font-size: 12px; color: var(--p-color-text-subdued); }
    .bis-pagination { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .bis-form-row { margin-bottom: 12px; }
    .bis-form-row label { display: block; font-weight: 500; margin-bottom: 4px; }
    .bis-form-row input, .bis-form-row textarea, .bis-form-row select { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    .bis-form-row textarea { min-height: 120px; font-family: monospace; }
    .bis-preview-box { background: var(--p-color-bg-surface); border: 1px solid #e0e0e0; padding: 12px; border-radius: 4px; margin-top: 8px; }
    .bis-preview-subject { font-weight: bold; margin-bottom: 6px; }
    .bis-back-btn { margin-bottom: 12px; }
  `;
  container.appendChild(style);

  // ── Nav ──────────────────────────────────────────────────────────────────────
  const nav = document.createElement("div");
  nav.className = "bis-nav";

  const dashBtn = document.createElement("button");
  dashBtn.className = "btn-primary";
  dashBtn.textContent = "Dashboard";

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "btn-secondary";
  settingsBtn.textContent = "Settings";

  nav.appendChild(dashBtn);
  nav.appendChild(settingsBtn);
  container.appendChild(nav);

  // ── Sections ─────────────────────────────────────────────────────────────────
  const dashSection = document.createElement("div");
  dashSection.className = "bis-section active";
  dashSection.id = "bis-dash";

  const subscribersSection = document.createElement("div");
  subscribersSection.className = "bis-section";
  subscribersSection.id = "bis-subscribers";

  const settingsSection = document.createElement("div");
  settingsSection.className = "bis-section";
  settingsSection.id = "bis-settings";

  container.appendChild(dashSection);
  container.appendChild(subscribersSection);
  container.appendChild(settingsSection);

  // ── State ────────────────────────────────────────────────────────────────────
  type Section = "dashboard" | "subscribers" | "settings";
  let currentSection: Section = "dashboard";

  // Dashboard pagination state
  let dashNextCursor: string | null = null;
  let dashPrevCursors: string[] = [];

  // Subscribers pagination state
  let subsProductId: string | null = null;
  let subsVariantId: string | null = null;
  let subsNextCursor: string | null = null;
  let subsPrevCursors: string[] = [];

  function showSection(s: Section): void {
    currentSection = s;
    dashSection.className = "bis-section" + (s === "dashboard" ? " active" : "");
    subscribersSection.className = "bis-section" + (s === "subscribers" ? " active" : "");
    settingsSection.className = "bis-section" + (s === "settings" ? " active" : "");
  }

  dashBtn.addEventListener("click", () => {
    showSection("dashboard");
    loadDashboard(null);
  });

  settingsBtn.addEventListener("click", () => {
    showSection("settings");
    loadSettings();
  });

  // ── Dashboard ────────────────────────────────────────────────────────────────

  function loadDashboard(cursor: string | null): void {
    dashSection.innerHTML = "";
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    dashSection.appendChild(loading);

    const req: AdminDashboardRequest = cursor ? { cursor } : {};

    bridge.call("/admin/dashboard", req).then((raw) => {
      const data = raw as AdminDashboardResponse;
      renderDashboard(data, cursor);
      dashNextCursor = data.next_cursor;
    }).catch((err: unknown) => {
      dashSection.innerHTML = "";
      const errBanner = document.createElement("div");
      errBanner.className = "shell-error-banner";
      errBanner.textContent = "Failed to load dashboard: " + String(err);
      dashSection.appendChild(errBanner);
    });
  }

  function renderDashboard(data: AdminDashboardResponse, cursor: string | null): void {
    dashSection.innerHTML = "";

    // Metrics row
    const m = data.overall_metrics;
    const metricsRow = document.createElement("div");
    metricsRow.className = "bis-metrics-row";

    const metricCards: Array<{ label: string; value: string }> = [
      { label: "Total Signups", value: String(m.total_signups) },
      { label: "Total Notified", value: String(m.total_notified) },
      { label: "Total Conversions", value: String(m.total_conversions) },
      { label: "Conversion Rate", value: m.conversion_rate.toFixed(1) + "%" },
    ];

    for (const card of metricCards) {
      const cardEl = document.createElement("div");
      cardEl.className = "bis-metric-card";
      const valEl = document.createElement("div");
      valEl.className = "value";
      valEl.textContent = card.value;
      const labelEl = document.createElement("div");
      labelEl.className = "label";
      labelEl.textContent = card.label;
      cardEl.appendChild(valEl);
      cardEl.appendChild(labelEl);
      metricsRow.appendChild(cardEl);
    }
    dashSection.appendChild(metricsRow);

    // Table
    const totalEl = document.createElement("p");
    totalEl.textContent = `Showing ${data.items.length} of ${data.total_count} items`;
    dashSection.appendChild(totalEl);

    const table = document.createElement("table");
    table.className = "bis-table shell-card";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const h of ["Item", "Active Waitlist", "Total Signups", "Notified", "Conversions", "Conv. Rate", "Last Restock", "Actions"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const item of data.items) {
      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.textContent = item.item_display_name;
      tr.appendChild(tdName);

      const tdActive = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = item.active_waitlist_count > 0 ? "badge badge-warning" : "badge";
      badge.textContent = String(item.active_waitlist_count);
      tdActive.appendChild(badge);
      tr.appendChild(tdActive);

      const tdSignups = document.createElement("td");
      tdSignups.textContent = String(item.total_signups);
      tr.appendChild(tdSignups);

      const tdNotified = document.createElement("td");
      tdNotified.textContent = String(item.total_notified);
      tr.appendChild(tdNotified);

      const tdConv = document.createElement("td");
      tdConv.textContent = String(item.total_conversions);
      tr.appendChild(tdConv);

      const tdRate = document.createElement("td");
      tdRate.textContent = item.conversion_rate.toFixed(1) + "%";
      tr.appendChild(tdRate);

      const tdRestock = document.createElement("td");
      tdRestock.textContent = item.last_restock_at
        ? new Intl.DateTimeFormat(bridge.context.locale, { dateStyle: "medium" }).format(new Date(item.last_restock_at))
        : "—";
      tr.appendChild(tdRestock);

      const tdActions = document.createElement("td");
      const viewBtn = document.createElement("button");
      viewBtn.className = "btn-secondary";
      viewBtn.textContent = "View Subscribers";
      viewBtn.addEventListener("click", () => {
        subsProductId = item.product_external_id;
        subsVariantId = item.variant_external_id;
        subsNextCursor = null;
        subsPrevCursors = [];
        showSection("subscribers");
        loadSubscribers(item.product_external_id, item.variant_external_id, null);
      });
      tdActions.appendChild(viewBtn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    dashSection.appendChild(table);

    // Pagination
    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";

    if (dashPrevCursors.length > 0) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Previous";
      prevBtn.addEventListener("click", () => {
        const prev = dashPrevCursors.pop() ?? null;
        loadDashboard(prev);
      });
      pagination.appendChild(prevBtn);
    }

    if (dashNextCursor) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        dashPrevCursors.push(cursor ?? "");
        loadDashboard(dashNextCursor);
      });
      pagination.appendChild(nextBtn);
    }

    const pageInfo = document.createElement("span");
    pageInfo.style.color = "var(--p-color-text-subdued)";
    pageInfo.textContent = `Total: ${data.total_count}`;
    pagination.appendChild(pageInfo);

    dashSection.appendChild(pagination);
  }

  // ── Subscribers ───────────────────────────────────────────────────────────────

  function loadSubscribers(productId: string, variantId: string | null, cursor: string | null): void {
    subscribersSection.innerHTML = "";
    const loading = document.createElement("p");
    loading.textContent = "Loading…";
    subscribersSection.appendChild(loading);

    const req: AdminSubscribersRequest = cursor
      ? { product_id: productId, cursor }
      : { product_id: productId };
    if (variantId !== null) {
      req.variant_id = variantId;
    }

    bridge.call("/admin/subscribers", req).then((raw) => {
      const data = raw as AdminSubscribersResponse;
      renderSubscribers(data, productId, variantId, cursor);
      subsNextCursor = data.next_cursor;
    }).catch((err: unknown) => {
      subscribersSection.innerHTML = "";
      const errBanner = document.createElement("div");
      errBanner.className = "shell-error-banner";
      errBanner.textContent = "Failed to load subscribers: " + String(err);
      subscribersSection.appendChild(errBanner);
    });
  }

  function renderSubscribers(
    data: AdminSubscribersResponse,
    productId: string,
    variantId: string | null,
    cursor: string | null,
  ): void {
    subscribersSection.innerHTML = "";

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary bis-back-btn";
    backBtn.textContent = "← Back to Dashboard";
    backBtn.addEventListener("click", () => {
      showSection("dashboard");
      loadDashboard(null);
    });
    subscribersSection.appendChild(backBtn);

    const heading = document.createElement("h2");
    heading.textContent = `Subscribers (${data.total_count} total)`;
    subscribersSection.appendChild(heading);

    // Export button
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn-secondary";
    exportBtn.textContent = "Export CSV";
    exportBtn.addEventListener("click", () => {
      exportSubscribers(productId, variantId, null);
    });
    subscribersSection.appendChild(exportBtn);

    // Table
    const table = document.createElement("table");
    table.className = "bis-table shell-card";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const h of ["Email", "Item", "Level", "Status", "Signed Up", "Notified At", "Batch ID"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const sub of data.subscribers) {
      const tr = document.createElement("tr");

      appendTd(tr, sub.shopper_email);
      appendTd(tr, sub.item_display_name);
      appendTd(tr, sub.signup_level);

      const tdStatus = document.createElement("td");
      const statusBadge = document.createElement("span");
      statusBadge.className = statusBadgeClass(sub.status);
      statusBadge.textContent = sub.status;
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      appendTd(tr, formatDate(sub.signed_up_at, bridge.context.locale));

      // notified_at — nullable-with-purpose: shows when this entry was last notified
      appendTd(tr, sub.notified_at ? formatDate(sub.notified_at, bridge.context.locale) : "—");

      // notification_batch_id — nullable-with-purpose: shows which batch last notified this entry
      appendTd(tr, sub.notification_batch_id ? sub.notification_batch_id.slice(0, 8) + "…" : "—");

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    subscribersSection.appendChild(table);

    // Pagination
    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";

    if (subsPrevCursors.length > 0) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Previous";
      prevBtn.addEventListener("click", () => {
        const prev = subsPrevCursors.pop() ?? null;
        loadSubscribers(productId, variantId, prev);
      });
      pagination.appendChild(prevBtn);
    }

    if (subsNextCursor) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        subsPrevCursors.push(cursor ?? "");
        loadSubscribers(productId, variantId, subsNextCursor);
      });
      pagination.appendChild(nextBtn);
    }

    const pageInfo = document.createElement("span");
    pageInfo.style.color = "var(--p-color-text-subdued)";
    pageInfo.textContent = `Total: ${data.total_count}`;
    pagination.appendChild(pageInfo);

    subscribersSection.appendChild(pagination);
  }

  function exportSubscribers(productId: string, variantId: string | null, cursor: string | null): void {
    const req: AdminSubscribersExportRequest = cursor
      ? { product_id: productId, cursor }
      : { product_id: productId };
    if (variantId !== null) {
      req.variant_id = variantId;
    }

    bridge.call("/admin/subscribers/export", req).then((raw) => {
      const data = raw as AdminSubscribersExportResponse;

      // Download CSV
      const blob = new Blob([data.csv_data], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "subscribers.csv";
      a.click();
      URL.revokeObjectURL(url);

      bridge.notify("CSV exported successfully", "success");
    }).catch((err: unknown) => {
      bridge.notify("Export failed: " + String(err), "error");
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  function loadSettings(): void {
    settingsSection.innerHTML = "";
    const loading = document.createElement("p");
    loading.textContent = "Loading settings…";
    settingsSection.appendChild(loading);

    bridge.call("/admin/settings", {}).then((raw) => {
      const data = raw as AdminSettingsResponse;
      renderSettings(data);
    }).catch((err: unknown) => {
      settingsSection.innerHTML = "";
      const errBanner = document.createElement("div");
      errBanner.className = "shell-error-banner";
      errBanner.textContent = "Failed to load settings: " + String(err);
      settingsSection.appendChild(errBanner);
    });
  }

  function renderSettings(data: AdminSettingsResponse): void {
    settingsSection.innerHTML = "";

    const card = document.createElement("div");
    card.className = "shell-card";
    settingsSection.appendChild(card);

    // ── Email Template Section ────────────────────────────────────────────────
    const templateHeading = document.createElement("h3");
    templateHeading.textContent = "Email Template";
    card.appendChild(templateHeading);

    const subjectRow = document.createElement("div");
    subjectRow.className = "bis-form-row";
    const subjectLabel = document.createElement("label");
    subjectLabel.textContent = "Subject Template";
    const subjectInput = document.createElement("input");
    subjectInput.type = "text";
    subjectInput.value = data.notification_subject_template;
    subjectInput.placeholder = "{{product_name}} is back in stock!";
    subjectRow.appendChild(subjectLabel);
    subjectRow.appendChild(subjectInput);
    card.appendChild(subjectRow);

    const bodyRow = document.createElement("div");
    bodyRow.className = "bis-form-row";
    const bodyLabel = document.createElement("label");
    bodyLabel.textContent = "Body Template (HTML — use {{product_name}}, {{item_detail}}, {{item_url}}, {{unsubscribe_url}})";
    const bodyTextarea = document.createElement("textarea");
    bodyTextarea.value = data.notification_body_template;
    bodyRow.appendChild(bodyLabel);
    bodyRow.appendChild(bodyTextarea);
    card.appendChild(bodyRow);

    // Preview box
    const previewBox = document.createElement("div");
    previewBox.className = "bis-preview-box";
    const previewLabel = document.createElement("p");
    previewLabel.textContent = "Preview:";
    previewLabel.style.fontWeight = "bold";
    const previewSubjectEl = document.createElement("div");
    previewSubjectEl.className = "bis-preview-subject";
    const previewBodyEl = document.createElement("div");
    card.appendChild(previewLabel);
    previewBox.appendChild(previewSubjectEl);
    previewBox.appendChild(previewBodyEl);
    card.appendChild(previewBox);

    function updatePreview(subject: string, body: string): void {
      previewSubjectEl.textContent = subject;
      previewBodyEl.innerHTML = body; // safe: merchant-controlled content
    }

    const saveTemplateBtn = document.createElement("button");
    saveTemplateBtn.className = "btn-primary";
    saveTemplateBtn.textContent = "Save Template";
    card.appendChild(saveTemplateBtn);

    bridge.saveBar.show("template");

    saveTemplateBtn.addEventListener("click", () => {
      const req: AdminSaveTemplateRequest = {
        notification_subject_template: subjectInput.value,
        notification_body_template: bodyTextarea.value,
      };

      bridge.call("/admin/settings/template", req).then((raw) => {
        const result = raw as AdminSaveTemplateResponse;
        if (result.success) {
          updatePreview(result.preview_subject, result.preview_body);
          bridge.notify("Template saved", "success");
          bridge.saveBar.hide("template");
        }
      }).catch((err: unknown) => {
        bridge.notify("Failed to save template: " + String(err), "error");
      });
    });

    subjectInput.addEventListener("input", () => bridge.saveBar.show("template"));
    bodyTextarea.addEventListener("input", () => bridge.saveBar.show("template"));

    // ── Quiet Hours Section ───────────────────────────────────────────────────
    const qhHeading = document.createElement("h3");
    qhHeading.textContent = "Quiet Hours";
    qhHeading.style.marginTop = "24px";
    card.appendChild(qhHeading);

    const qhDesc = document.createElement("p");
    qhDesc.textContent = "No notification emails are sent during the quiet hours window. Handles midnight wrap-around (e.g. 22:00–07:00).";
    qhDesc.style.color = "var(--p-color-text-subdued)";
    card.appendChild(qhDesc);

    const qhStartRow = document.createElement("div");
    qhStartRow.className = "bis-form-row";
    const qhStartLabel = document.createElement("label");
    qhStartLabel.textContent = "Quiet Hours Start (HH:MM)";
    const qhStartInput = document.createElement("input");
    qhStartInput.type = "text";
    qhStartInput.value = data.quiet_hours_start;
    qhStartInput.placeholder = "22:00";
    qhStartInput.pattern = "\\d{2}:\\d{2}";
    qhStartRow.appendChild(qhStartLabel);
    qhStartRow.appendChild(qhStartInput);
    card.appendChild(qhStartRow);

    const qhEndRow = document.createElement("div");
    qhEndRow.className = "bis-form-row";
    const qhEndLabel = document.createElement("label");
    qhEndLabel.textContent = "Quiet Hours End (HH:MM)";
    const qhEndInput = document.createElement("input");
    qhEndInput.type = "text";
    qhEndInput.value = data.quiet_hours_end;
    qhEndInput.placeholder = "08:00";
    qhEndInput.pattern = "\\d{2}:\\d{2}";
    qhEndRow.appendChild(qhEndLabel);
    qhEndRow.appendChild(qhEndInput);
    card.appendChild(qhEndRow);

    const tzRow = document.createElement("div");
    tzRow.className = "bis-form-row";
    const tzLabel = document.createElement("label");
    tzLabel.textContent = "Timezone (IANA)";
    const tzInput = document.createElement("input");
    tzInput.type = "text";
    tzInput.value = data.timezone;
    tzInput.placeholder = "America/New_York";
    tzRow.appendChild(tzLabel);
    tzRow.appendChild(tzInput);
    card.appendChild(tzRow);

    const saveQhBtn = document.createElement("button");
    saveQhBtn.className = "btn-primary";
    saveQhBtn.textContent = "Save Quiet Hours";
    card.appendChild(saveQhBtn);

    saveQhBtn.addEventListener("click", () => {
      const req: AdminSaveQuietHoursRequest = {
        quiet_hours_start: qhStartInput.value,
        quiet_hours_end: qhEndInput.value,
        timezone: tzInput.value,
      };

      bridge.call("/admin/settings/quiet-hours", req).then((raw) => {
        const result = raw as AdminSaveQuietHoursResponse;
        if (result.success) {
          bridge.notify("Quiet hours saved", "success");
          bridge.saveBar.hide("settings");
        }
      }).catch((err: unknown) => {
        bridge.notify("Failed to save quiet hours: " + String(err), "error");
      });
    });

    qhStartInput.addEventListener("input", () => bridge.saveBar.show("settings"));
    qhEndInput.addEventListener("input", () => bridge.saveBar.show("settings"));
    tzInput.addEventListener("input", () => bridge.saveBar.show("settings"));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function appendTd(tr: HTMLTableRowElement, text: string): void {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  }

  function statusBadgeClass(status: SubscriberItem["status"]): string {
    switch (status) {
      case "active": return "badge badge-warning";
      case "notified": return "badge badge-success";
      case "converted": return "badge badge-success";
      case "unsubscribed": return "badge";
      default: return "badge";
    }
  }

  function formatDate(iso: string, locale: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  }

  // ── Initial load ──────────────────────────────────────────────────────────────
  loadDashboard(null);
}

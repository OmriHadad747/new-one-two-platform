import type { AdminBridge } from "@platform/admin-sdk";
import type {
  AdminDashboardRequest,
  AdminDashboardResponse,
  AdminSubscribersRequest,
  AdminSubscribersResponse,
  AdminSubscribersExportRequest,
  AdminSubscribersExportResponse,
  AdminSettingsResponse,
  AdminSettingsSaveRequest,
  AdminSettingsSaveResponse,
  DemandStatsSnapshotRow,
  WaitlistSignupRow,
  AppSettings,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // ── Styles ───────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    .bis-app { font-family: sans-serif; padding: 16px; }
    .bis-nav { display: flex; gap: 8px; margin-bottom: 16px; }
    .bis-page { display: none; }
    .bis-page.active { display: block; }
    .bis-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .bis-table th, .bis-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--p-color-bg-surface); }
    .bis-table th { font-weight: 600; color: var(--p-color-text-subdued); }
    .bis-pagination { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .bis-form-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .bis-form-row label { font-weight: 500; font-size: 14px; }
    .bis-form-row input { padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
    .bis-empty { color: var(--p-color-text-subdued); padding: 24px 0; text-align: center; }
    .bis-back-btn { margin-bottom: 12px; cursor: pointer; }
    .bis-page-info { font-size: 13px; color: var(--p-color-text-subdued); }
  `;
  container.appendChild(style);

  // ── Root wrapper ─────────────────────────────────────────
  const app = document.createElement("div");
  app.className = "bis-app";
  container.appendChild(app);

  // ── Navigation ───────────────────────────────────────────
  const nav = document.createElement("div");
  nav.className = "bis-nav";

  const navDashboard = document.createElement("button");
  navDashboard.className = "btn-primary";
  navDashboard.textContent = "Dashboard";

  const navSettings = document.createElement("button");
  navSettings.className = "btn-secondary";
  navSettings.textContent = "Settings";

  nav.appendChild(navDashboard);
  nav.appendChild(navSettings);
  app.appendChild(nav);

  // ── Pages ────────────────────────────────────────────────
  const dashboardPage = document.createElement("div");
  dashboardPage.className = "bis-page active";
  dashboardPage.id = "page-dashboard";

  const subscribersPage = document.createElement("div");
  subscribersPage.className = "bis-page";
  subscribersPage.id = "page-subscribers";

  const settingsPage = document.createElement("div");
  settingsPage.className = "bis-page";
  settingsPage.id = "page-settings";

  app.appendChild(dashboardPage);
  app.appendChild(subscribersPage);
  app.appendChild(settingsPage);

  // ── Page switch ──────────────────────────────────────────
  function showPage(id: string): void {
    for (const page of [dashboardPage, subscribersPage, settingsPage]) {
      page.classList.toggle("active", page.id === id);
    }
  }

  navDashboard.addEventListener("click", () => {
    showPage("page-dashboard");
    loadDashboard(1);
  });

  navSettings.addEventListener("click", () => {
    showPage("page-settings");
    loadSettings();
  });

  // ══════════════════════════════════════════════════════════
  // DASHBOARD PAGE (offset-paginated)
  // ══════════════════════════════════════════════════════════

  let dashboardPage_ = 1;
  const DASH_PAGE_SIZE = 20;

  function renderDashboard(data: AdminDashboardResponse): void {
    dashboardPage.innerHTML = "";

    const heading = document.createElement("h2");
    heading.textContent = "Waitlist Demand Dashboard";
    dashboardPage.appendChild(heading);

    const countText = document.createElement("p");
    countText.style.color = "var(--p-color-text-subdued)";
    countText.textContent = `${data.total} tracked item${data.total !== 1 ? "s" : ""}`;
    dashboardPage.appendChild(countText);

    if (data.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "bis-empty";
      empty.textContent =
        "No waitlist data yet. Shoppers will appear here once they sign up for out-of-stock items.";
      dashboardPage.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "bis-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const h of [
      "Product / Variant",
      "Waiting",
      "Total Signups",
      "Notified",
      "Conversions",
      "Last Refreshed",
      "",
    ]) {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const fmt = new Intl.DateTimeFormat(bridge.context.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    for (const row of data.items) {
      const tr = document.createElement("tr");

      const tdItem = document.createElement("td");
      const titleText = row.product_title ?? "(loading…)";
      tdItem.appendChild(document.createTextNode(titleText));
      if (row.variant_title) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.style.marginLeft = "6px";
        badge.textContent = row.variant_title;
        tdItem.appendChild(badge);
      }
      tr.appendChild(tdItem);

      const tdWaiting = document.createElement("td");
      const waitBadge = document.createElement("span");
      waitBadge.className =
        row.waitlist_count > 0 ? "badge badge-warning" : "badge";
      waitBadge.textContent = String(row.waitlist_count);
      tdWaiting.appendChild(waitBadge);
      tr.appendChild(tdWaiting);

      const tdSignups = document.createElement("td");
      tdSignups.textContent = String(row.total_signups);
      tr.appendChild(tdSignups);

      const tdNotified = document.createElement("td");
      tdNotified.textContent = String(row.total_notified);
      tr.appendChild(tdNotified);

      const tdConversions = document.createElement("td");
      const pct =
        row.total_notified > 0
          ? Math.round((row.total_conversions / row.total_notified) * 100)
          : 0;
      tdConversions.appendChild(
        document.createTextNode(`${row.total_conversions} (${pct}%)`),
      );
      tr.appendChild(tdConversions);

      const tdRefreshed = document.createElement("td");
      tdRefreshed.textContent = fmt.format(new Date(row.last_refreshed_at));
      tr.appendChild(tdRefreshed);

      const tdAction = document.createElement("td");
      const drillBtn = document.createElement("button");
      drillBtn.className = "btn-secondary";
      drillBtn.textContent = "View Subscribers";
      drillBtn.addEventListener("click", () => {
        showPage("page-subscribers");
        loadSubscribers(row.item_external_id, row.product_title, row.variant_title, 1);
      });
      tdAction.appendChild(drillBtn);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    dashboardPage.appendChild(table);

    // Pagination
    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";

    const totalPages = Math.ceil(data.total / data.page_size);

    if (data.page > 1) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Previous";
      prevBtn.addEventListener("click", () => {
        loadDashboard(data.page - 1);
      });
      pagination.appendChild(prevBtn);
    }

    const pageInfo = document.createElement("span");
    pageInfo.className = "bis-page-info";
    pageInfo.textContent = `Page ${data.page} of ${totalPages}`;
    pagination.appendChild(pageInfo);

    if (data.page < totalPages) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-primary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        loadDashboard(data.page + 1);
      });
      pagination.appendChild(nextBtn);
    }

    if (pagination.children.length > 0) {
      dashboardPage.appendChild(pagination);
    }
  }

  async function loadDashboard(page: number): Promise<void> {
    dashboardPage_ = page;
    dashboardPage.innerHTML = "<p>Loading…</p>";

    try {
      const req: AdminDashboardRequest = { page, page_size: DASH_PAGE_SIZE };
      const data = (await bridge.call("/admin/dashboard", req)) as AdminDashboardResponse;
      renderDashboard(data);
    } catch {
      dashboardPage.innerHTML = "";
      const banner = document.createElement("div");
      banner.className = "shell-error-banner";
      banner.textContent = "Failed to load dashboard. Please try again.";
      dashboardPage.appendChild(banner);
    }
  }

  // ══════════════════════════════════════════════════════════
  // SUBSCRIBERS PAGE (offset-paginated)
  // ══════════════════════════════════════════════════════════

  const SUB_PAGE_SIZE = 20;

  function renderSubscribers(
    data: AdminSubscribersResponse,
    itemExternalId: string,
    productTitle: string | null,
    variantTitle: string | null,
  ): void {
    subscribersPage.innerHTML = "";

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary bis-back-btn";
    backBtn.textContent = "← Back to Dashboard";
    backBtn.addEventListener("click", () => {
      showPage("page-dashboard");
      loadDashboard(dashboardPage_);
    });
    subscribersPage.appendChild(backBtn);

    const heading = document.createElement("h2");
    const headingText =
      productTitle
        ? variantTitle
          ? `${productTitle} — ${variantTitle}`
          : productTitle
        : "Subscribers";
    heading.textContent = headingText;
    subscribersPage.appendChild(heading);

    const meta = document.createElement("p");
    meta.style.color = "var(--p-color-text-subdued)";
    meta.textContent = `${data.total} subscriber${data.total !== 1 ? "s" : ""}`;
    subscribersPage.appendChild(meta);

    // Export button
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn-secondary";
    exportBtn.style.marginBottom = "12px";
    exportBtn.textContent = "Export CSV";
    exportBtn.addEventListener("click", () => {
      exportSubscribers(itemExternalId);
    });
    subscribersPage.appendChild(exportBtn);

    if (data.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "bis-empty";
      empty.textContent = "No subscribers yet.";
      subscribersPage.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "bis-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const h of ["Email", "Status", "Signed Up", "Deleted At"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const fmt = new Intl.DateTimeFormat(bridge.context.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });

    for (const sub of data.items) {
      const tr = document.createElement("tr");

      const tdEmail = document.createElement("td");
      tdEmail.textContent = sub.email;
      tr.appendChild(tdEmail);

      const tdStatus = document.createElement("td");
      const statusBadge = document.createElement("span");
      statusBadge.className =
        sub.status === "pending"
          ? "badge badge-warning"
          : sub.status === "notified"
          ? "badge badge-success"
          : "badge";
      statusBadge.textContent = sub.status;
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      const tdSignedUp = document.createElement("td");
      tdSignedUp.textContent = fmt.format(new Date(sub.signed_up_at));
      tr.appendChild(tdSignedUp);

      // Nullable-with-purpose: deleted_at — Set when the parent product is deleted; null means active
      const tdDeleted = document.createElement("td");
      tdDeleted.textContent = sub.deleted_at ? fmt.format(new Date(sub.deleted_at)) : "—";
      tr.appendChild(tdDeleted);

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    subscribersPage.appendChild(table);

    // Pagination
    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";

    const totalPages = Math.ceil(data.total / data.page_size);

    if (data.page > 1) {
      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Previous";
      prevBtn.addEventListener("click", () => {
        loadSubscribers(itemExternalId, productTitle, variantTitle, data.page - 1);
      });
      pagination.appendChild(prevBtn);
    }

    const pageInfo = document.createElement("span");
    pageInfo.className = "bis-page-info";
    pageInfo.textContent = `Page ${data.page} of ${totalPages}`;
    pagination.appendChild(pageInfo);

    if (data.page < totalPages) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-primary";
      nextBtn.textContent = "Next →";
      nextBtn.addEventListener("click", () => {
        loadSubscribers(itemExternalId, productTitle, variantTitle, data.page + 1);
      });
      pagination.appendChild(nextBtn);
    }

    if (pagination.children.length > 0) {
      subscribersPage.appendChild(pagination);
    }
  }

  async function loadSubscribers(
    itemExternalId: string,
    productTitle: string | null,
    variantTitle: string | null,
    page: number,
  ): Promise<void> {
    subscribersPage.innerHTML = "<p>Loading…</p>";

    try {
      const req: AdminSubscribersRequest = {
        item_external_id: itemExternalId,
        page,
        page_size: SUB_PAGE_SIZE,
      };
      const data = (await bridge.call(
        "/admin/products/subscribers",
        req,
      )) as AdminSubscribersResponse;
      renderSubscribers(data, itemExternalId, productTitle, variantTitle);
    } catch {
      subscribersPage.innerHTML = "";
      const banner = document.createElement("div");
      banner.className = "shell-error-banner";
      banner.textContent = "Failed to load subscribers. Please try again.";
      subscribersPage.appendChild(banner);
    }
  }

  async function exportSubscribers(itemExternalId: string): Promise<void> {
    try {
      const req: AdminSubscribersExportRequest = { item_external_id: itemExternalId };
      const data = (await bridge.call(
        "/admin/products/subscribers/export",
        req,
      )) as AdminSubscribersExportResponse;

      // Open the CSV URL for download
      const link = document.createElement("a");
      link.href = data.csv_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.click();

      bridge.notify("CSV export ready — downloading now.", "success");
    } catch {
      bridge.notify("Failed to generate CSV export.", "error");
    }
  }

  // ══════════════════════════════════════════════════════════
  // SETTINGS PAGE
  // ══════════════════════════════════════════════════════════

  function renderSettings(settings: AppSettings): void {
    settingsPage.innerHTML = "";

    const heading = document.createElement("h2");
    heading.textContent = "Notification Settings";
    settingsPage.appendChild(heading);

    const card = document.createElement("div");
    card.className = "shell-card";
    settingsPage.appendChild(card);

    const form = document.createElement("form");
    card.appendChild(form);

    // batch_size
    const batchRow = document.createElement("div");
    batchRow.className = "bis-form-row";
    const batchLabel = document.createElement("label");
    batchLabel.textContent = "Batch size (max signups notified per restock)";
    batchLabel.htmlFor = "setting-batch-size";
    const batchInput = document.createElement("input");
    batchInput.type = "number";
    batchInput.id = "setting-batch-size";
    batchInput.name = "batch_size";
    batchInput.min = "1";
    batchInput.max = "10000";
    batchInput.value = String(settings.batch_size);
    batchRow.appendChild(batchLabel);
    batchRow.appendChild(batchInput);
    form.appendChild(batchRow);

    // quiet_hours_start
    const quietStartRow = document.createElement("div");
    quietStartRow.className = "bis-form-row";
    const quietStartLabel = document.createElement("label");
    quietStartLabel.textContent = "Quiet hours start (UTC, HH:MM)";
    quietStartLabel.htmlFor = "setting-quiet-start";
    const quietStartInput = document.createElement("input");
    quietStartInput.type = "time";
    quietStartInput.id = "setting-quiet-start";
    quietStartInput.name = "quiet_hours_start";
    quietStartInput.value = settings.quiet_hours_start;
    quietStartRow.appendChild(quietStartLabel);
    quietStartRow.appendChild(quietStartInput);
    form.appendChild(quietStartRow);

    // quiet_hours_end
    const quietEndRow = document.createElement("div");
    quietEndRow.className = "bis-form-row";
    const quietEndLabel = document.createElement("label");
    quietEndLabel.textContent = "Quiet hours end (UTC, HH:MM)";
    quietEndLabel.htmlFor = "setting-quiet-end";
    const quietEndInput = document.createElement("input");
    quietEndInput.type = "time";
    quietEndInput.id = "setting-quiet-end";
    quietEndInput.name = "quiet_hours_end";
    quietEndInput.value = settings.quiet_hours_end;
    quietEndRow.appendChild(quietEndLabel);
    quietEndRow.appendChild(quietEndInput);
    form.appendChild(quietEndRow);

    // conversion_attribution_window_days
    const attrRow = document.createElement("div");
    attrRow.className = "bis-form-row";
    const attrLabel = document.createElement("label");
    attrLabel.textContent = "Conversion attribution window (days)";
    attrLabel.htmlFor = "setting-attr-days";
    const attrInput = document.createElement("input");
    attrInput.type = "number";
    attrInput.id = "setting-attr-days";
    attrInput.name = "conversion_attribution_window_days";
    attrInput.min = "1";
    attrInput.max = "90";
    attrInput.value = String(settings.conversion_attribution_window_days);
    attrRow.appendChild(attrLabel);
    attrRow.appendChild(attrInput);
    form.appendChild(attrRow);

    // Dirty tracking
    let isDirty = false;
    const onInput = (): void => {
      if (!isDirty) {
        isDirty = true;
        bridge.saveBar.show("settings");
      }
    };
    batchInput.addEventListener("input", onInput);
    quietStartInput.addEventListener("input", onInput);
    quietEndInput.addEventListener("input", onInput);
    attrInput.addEventListener("input", onInput);

    // Save button
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save Settings";
    saveBtn.style.marginTop = "16px";
    form.appendChild(saveBtn);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const body: AdminSettingsSaveRequest = {
        batch_size: parseInt(batchInput.value, 10),
        quiet_hours_start: quietStartInput.value,
        quiet_hours_end: quietEndInput.value,
        conversion_attribution_window_days: parseInt(attrInput.value, 10),
      };

      try {
        const resp = (await bridge.call(
          "/admin/settings",
          body,
        )) as AdminSettingsSaveResponse;
        isDirty = false;
        bridge.saveBar.hide("settings");
        bridge.notify("Settings saved.", "success");
        renderSettings(resp.settings);
      } catch {
        bridge.notify("Failed to save settings. Please try again.", "error");
      }
    });
  }

  async function loadSettings(): Promise<void> {
    settingsPage.innerHTML = "<p>Loading…</p>";

    try {
      const data = (await bridge.call("/admin/settings", {})) as AdminSettingsResponse;
      renderSettings(data.settings);
    } catch {
      settingsPage.innerHTML = "";
      const banner = document.createElement("div");
      banner.className = "shell-error-banner";
      banner.textContent = "Failed to load settings. Please try again.";
      settingsPage.appendChild(banner);
    }
  }

  // ── Initial load ─────────────────────────────────────────
  loadDashboard(1);
}

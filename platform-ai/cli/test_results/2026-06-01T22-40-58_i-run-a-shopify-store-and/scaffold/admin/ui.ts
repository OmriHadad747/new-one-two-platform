import type { AdminBridge } from "@platform/admin-sdk";
import type {
  AdminDashboardResponse,
  AdminWaitlistResponse,
  AdminWaitlistExportResponse,
  AdminSettingsResponse,
  AdminSettingsSaveRequest,
  AdminSettingsSaveResponse,
  AdminStatsResponse,
  DashboardItem,
  WaitlistEntryRow,
  WaitlistStatus,
  ItemScope,
} from "../src/types/contracts.js";

export function mount(container: HTMLElement, bridge: AdminBridge): void {
  // Inject base styles
  const style = document.createElement("style");
  style.textContent = `
    .bis-nav { display: flex; gap: 8px; margin-bottom: 16px; }
    .bis-nav button { }
    .bis-section { margin-bottom: 24px; }
    .bis-table { width: 100%; border-collapse: collapse; }
    .bis-table th, .bis-table td { padding: 8px; text-align: left; border-bottom: 1px solid var(--p-color-bg-surface); }
    .bis-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .bis-stat-card { padding: 16px; }
    .bis-stat-num { font-size: 2rem; font-weight: bold; color: #008060; }
    .bis-pagination { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .bis-form-row { margin-bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
    .bis-form-row label { font-weight: 600; }
    .bis-form-row input, .bis-form-row textarea, .bis-form-row select {
      padding: 8px; border: 1px solid var(--p-color-bg-surface); border-radius: 4px; width: 100%;
    }
    .bis-form-row textarea { min-height: 100px; resize: vertical; }
    .bis-filter-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
  `;
  container.appendChild(style);

  // ─── State ─────────────────────────────────────────────────────────────
  type View = "dashboard" | "waitlist" | "settings" | "stats";
  let currentView: View = "dashboard";

  // Dashboard pagination
  let dashCursor: string | null = null;
  let dashNextCursor: string | null = null;
  const dashCursorStack: string[] = [];

  // Waitlist state
  let waitlistItemExternalId: number | null = null;
  let waitlistItemScope: ItemScope = "variant";
  let waitlistStatusFilter: WaitlistStatus | "" = "";
  let waitlistCursor: string | null = null;
  let waitlistNextCursor: string | null = null;
  const waitlistCursorStack: string[] = [];

  // Settings state
  let settingsDirty = false;

  // ─── Root layout ────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "shell-stack";
  container.appendChild(root);

  // Nav bar
  const nav = document.createElement("div");
  nav.className = "bis-nav";
  root.appendChild(nav);

  const viewNames: { id: View; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "waitlist", label: "Waitlist" },
    { id: "settings", label: "Settings" },
    { id: "stats", label: "Stats" },
  ];

  const navButtons: Map<View, HTMLButtonElement> = new Map();
  for (const { id, label } of viewNames) {
    const btn = document.createElement("button");
    btn.className = "btn-secondary";
    btn.textContent = label;
    btn.addEventListener("click", () => showView(id));
    nav.appendChild(btn);
    navButtons.set(id, btn);
  }

  // Content area
  const content = document.createElement("div");
  content.className = "shell-card";
  root.appendChild(content);

  // ─── View routing ────────────────────────────────────────────────────────
  function showView(view: View): void {
    currentView = view;
    for (const [id, btn] of navButtons) {
      btn.className = id === view ? "btn-primary" : "btn-secondary";
    }
    content.innerHTML = "";
    if (view === "dashboard") renderDashboard();
    else if (view === "waitlist") renderWaitlist();
    else if (view === "settings") renderSettings();
    else if (view === "stats") renderStats();
  }

  // ─── Dashboard ──────────────────────────────────────────────────────────
  function renderDashboard(): void {
    const section = document.createElement("div");
    section.className = "shell-section";
    content.appendChild(section);

    const heading = document.createElement("h2");
    heading.textContent = "Products by Waitlist Size";
    section.appendChild(heading);

    const tableWrap = document.createElement("div");
    section.appendChild(tableWrap);

    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";
    section.appendChild(pagination);

    async function loadDashboard(): Promise<void> {
      tableWrap.innerHTML = "<p>Loading…</p>";
      pagination.innerHTML = "";

      const resp = (await bridge.call("/admin/dashboard", {
        cursor: dashCursor,
      })) as AdminDashboardResponse;

      dashNextCursor = resp.next_cursor;

      if (resp.items.length === 0) {
        tableWrap.innerHTML = "<p>No waitlist entries yet.</p>";
        return;
      }

      const table = document.createElement("table");
      table.className = "bis-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Item ID</th>
            <th>Scope</th>
            <th>Active</th>
            <th>Notified</th>
            <th>Converted</th>
            <th>Actions</th>
          </tr>
        </thead>
      `;
      const tbody = document.createElement("tbody");
      for (const item of resp.items) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${item.item_external_id}</td>
          <td><span class="badge">${item.item_scope}</span></td>
          <td>${item.active_count}</td>
          <td>${item.notified_count}</td>
          <td>${item.converted_count}</td>
          <td></td>
        `;
        const actionTd = tr.querySelector("td:last-child") as HTMLTableCellElement;
        const drillBtn = document.createElement("button");
        drillBtn.className = "btn-secondary";
        drillBtn.textContent = "View Waitlist";
        drillBtn.addEventListener("click", () => {
          waitlistItemExternalId = item.item_external_id;
          waitlistItemScope = item.item_scope;
          waitlistCursor = null;
          waitlistNextCursor = null;
          waitlistCursorStack.length = 0;
          waitlistStatusFilter = "";
          showView("waitlist");
        });
        actionTd.appendChild(drillBtn);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      tableWrap.innerHTML = "";
      tableWrap.appendChild(table);

      renderDashboardPagination();
    }

    function renderDashboardPagination(): void {
      pagination.innerHTML = "";

      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Prev";
      prevBtn.disabled = dashCursorStack.length === 0;
      prevBtn.addEventListener("click", () => {
        dashNextCursor = dashCursor;
        dashCursor = dashCursorStack.pop() ?? null;
        loadDashboard();
      });

      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.disabled = dashNextCursor === null;
      nextBtn.addEventListener("click", () => {
        if (dashNextCursor === null) return;
        dashCursorStack.push(dashCursor ?? "");
        dashCursor = dashNextCursor;
        loadDashboard();
      });

      pagination.appendChild(prevBtn);
      pagination.appendChild(nextBtn);
    }

    loadDashboard();
  }

  // ─── Waitlist Drill-in ──────────────────────────────────────────────────
  function renderWaitlist(): void {
    const section = document.createElement("div");
    section.className = "shell-section";
    content.appendChild(section);

    const heading = document.createElement("h2");
    heading.textContent = "Waitlist Entries";
    section.appendChild(heading);

    // Item picker if no item is selected
    if (waitlistItemExternalId === null) {
      const pickerSection = document.createElement("div");
      pickerSection.className = "bis-section";

      const pickVariantBtn = document.createElement("button");
      pickVariantBtn.className = "btn-secondary";
      pickVariantBtn.textContent = "Pick a Variant";
      pickVariantBtn.addEventListener("click", async () => {
        const picked = await bridge.pickResource({ type: "variant" });
        if (!picked || picked.length === 0) return;
        const resource = picked[0];
        if (!resource) return;
        // variant GID: "gid://shopify/ProductVariant/123"
        const variantId = parseInt(resource.id.split("/").pop() ?? "", 10);
        if (isNaN(variantId)) {
          bridge.notify("Invalid variant selected", "error");
          return;
        }
        waitlistItemExternalId = variantId;
        waitlistItemScope = "variant";
        waitlistCursor = null;
        waitlistNextCursor = null;
        waitlistCursorStack.length = 0;
        renderWaitlist();
      });

      const pickProductBtn = document.createElement("button");
      pickProductBtn.className = "btn-secondary";
      pickProductBtn.textContent = "Pick a Product";
      pickProductBtn.style.marginLeft = "8px";
      pickProductBtn.addEventListener("click", async () => {
        const picked = await bridge.pickResource({ type: "product" });
        if (!picked || picked.length === 0) return;
        const resource = picked[0];
        if (!resource) return;
        // product GID: "gid://shopify/Product/123"
        const productId = parseInt(resource.id.split("/").pop() ?? "", 10);
        if (isNaN(productId)) {
          bridge.notify("Invalid product selected", "error");
          return;
        }
        waitlistItemExternalId = productId;
        waitlistItemScope = "product";
        waitlistCursor = null;
        waitlistNextCursor = null;
        waitlistCursorStack.length = 0;
        renderWaitlist();
      });

      pickerSection.appendChild(pickVariantBtn);
      pickerSection.appendChild(pickProductBtn);
      section.appendChild(pickerSection);
      return;
    }

    // Controls row
    const controls = document.createElement("div");
    controls.className = "bis-filter-row";
    section.appendChild(controls);

    const itemLabel = document.createElement("span");
    itemLabel.textContent = `${waitlistItemScope} #${waitlistItemExternalId}`;
    itemLabel.style.fontWeight = "600";
    controls.appendChild(itemLabel);

    // Status filter
    const statusSelect = document.createElement("select");
    const statusOptions: Array<{ value: string; label: string }> = [
      { value: "", label: "All statuses" },
      { value: "active", label: "Active" },
      { value: "notified", label: "Notified" },
      { value: "converted", label: "Converted" },
      { value: "unsubscribed", label: "Unsubscribed" },
      { value: "purged", label: "Purged" },
    ];
    for (const opt of statusOptions) {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === waitlistStatusFilter) el.selected = true;
      statusSelect.appendChild(el);
    }
    statusSelect.addEventListener("change", () => {
      waitlistStatusFilter = statusSelect.value as WaitlistStatus | "";
      waitlistCursor = null;
      waitlistNextCursor = null;
      waitlistCursorStack.length = 0;
      loadWaitlist();
    });
    controls.appendChild(statusSelect);

    // Export button
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn-secondary";
    exportBtn.textContent = "Export CSV";
    exportBtn.addEventListener("click", async () => {
      if (waitlistItemExternalId === null) return;
      const resp = (await bridge.call("/admin/waitlist/export", {
        item_external_id: String(waitlistItemExternalId),
        item_scope: waitlistItemScope,
      })) as AdminWaitlistExportResponse;

      // Download CSV
      const blob = new Blob([resp.csv_data], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `waitlist-${waitlistItemExternalId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
    controls.appendChild(exportBtn);

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "btn-secondary";
    backBtn.textContent = "← Back to Dashboard";
    backBtn.addEventListener("click", () => {
      waitlistItemExternalId = null;
      showView("dashboard");
    });
    controls.appendChild(backBtn);

    const tableWrap = document.createElement("div");
    section.appendChild(tableWrap);

    const pagination = document.createElement("div");
    pagination.className = "bis-pagination";
    section.appendChild(pagination);

    async function loadWaitlist(): Promise<void> {
      if (waitlistItemExternalId === null) return;
      tableWrap.innerHTML = "<p>Loading…</p>";
      pagination.innerHTML = "";

      const requestBody: {
        item_external_id: string;
        item_scope: ItemScope;
        cursor: string | null;
        status_filter?: WaitlistStatus;
      } = {
        item_external_id: String(waitlistItemExternalId),
        item_scope: waitlistItemScope,
        cursor: waitlistCursor,
      };
      if (waitlistStatusFilter !== "") {
        requestBody.status_filter = waitlistStatusFilter as WaitlistStatus;
      }

      const resp = (await bridge.call("/admin/waitlist", requestBody)) as AdminWaitlistResponse;
      waitlistNextCursor = resp.next_cursor;

      if (resp.entries.length === 0) {
        tableWrap.innerHTML = "<p>No entries found.</p>";
        renderWaitlistPagination();
        return;
      }

      const table = document.createElement("table");
      table.className = "bis-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Email</th>
            <th>Queue #</th>
            <th>Status</th>
            <th>Restock Event</th>
            <th>Notified At</th>
            <th>Converted At</th>
            <th>Signed Up</th>
          </tr>
        </thead>
      `;
      const tbody = document.createElement("tbody");
      for (const entry of resp.entries) {
        const tr = document.createElement("tr");
        const badgeClass = entry.status === "converted"
          ? "badge-success"
          : entry.status === "notified"
          ? "badge-warning"
          : entry.status === "active"
          ? "badge"
          : "badge-critical";

        const restockEventDisplay = entry.restock_event_id
          ? entry.restock_event_id.slice(0, 8) + "…"
          : "—";

        const notifiedAtDisplay = entry.notified_at
          ? new Intl.DateTimeFormat(bridge.context.locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(entry.notified_at))
          : "—";

        const convertedAtDisplay = entry.converted_at
          ? new Intl.DateTimeFormat(bridge.context.locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(entry.converted_at))
          : "—";

        const createdAtDisplay = new Intl.DateTimeFormat(bridge.context.locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(entry.created_at));

        tr.innerHTML = `
          <td>${entry.email}</td>
          <td>${entry.queue_position}</td>
          <td><span class="badge ${badgeClass}">${entry.status}</span></td>
          <td>${restockEventDisplay}</td>
          <td>${notifiedAtDisplay}</td>
          <td>${convertedAtDisplay}</td>
          <td>${createdAtDisplay}</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      tableWrap.innerHTML = "";
      tableWrap.appendChild(table);

      renderWaitlistPagination();
    }

    function renderWaitlistPagination(): void {
      pagination.innerHTML = "";

      const prevBtn = document.createElement("button");
      prevBtn.className = "btn-secondary";
      prevBtn.textContent = "← Prev";
      prevBtn.disabled = waitlistCursorStack.length === 0;
      prevBtn.addEventListener("click", () => {
        waitlistNextCursor = waitlistCursor;
        waitlistCursor = waitlistCursorStack.pop() ?? null;
        loadWaitlist();
      });

      const nextBtn = document.createElement("button");
      nextBtn.className = "btn-secondary";
      nextBtn.textContent = "Next →";
      nextBtn.disabled = waitlistNextCursor === null;
      nextBtn.addEventListener("click", () => {
        if (waitlistNextCursor === null) return;
        waitlistCursorStack.push(waitlistCursor ?? "");
        waitlistCursor = waitlistNextCursor;
        loadWaitlist();
      });

      pagination.appendChild(prevBtn);
      pagination.appendChild(nextBtn);
    }

    loadWaitlist();
  }

  // ─── Settings ────────────────────────────────────────────────────────────
  function renderSettings(): void {
    const section = document.createElement("div");
    section.className = "shell-section";
    content.appendChild(section);

    const heading = document.createElement("h2");
    heading.textContent = "Notification Settings";
    section.appendChild(heading);

    const form = document.createElement("form");
    section.appendChild(form);

    const subjectRow = document.createElement("div");
    subjectRow.className = "bis-form-row";
    const subjectLabel = document.createElement("label");
    subjectLabel.textContent = "Email Subject (use {{product_name}}, {{item_details}})";
    const subjectInput = document.createElement("input");
    subjectInput.type = "text";
    subjectInput.name = "template_subject";
    subjectRow.appendChild(subjectLabel);
    subjectRow.appendChild(subjectInput);
    form.appendChild(subjectRow);

    const bodyRow = document.createElement("div");
    bodyRow.className = "bis-form-row";
    const bodyLabel = document.createElement("label");
    bodyLabel.textContent = "Email Body (use {{product_name}}, {{item_details}}, {{unsubscribe_url}})";
    const bodyTextarea = document.createElement("textarea");
    bodyTextarea.name = "template_body";
    bodyRow.appendChild(bodyLabel);
    bodyRow.appendChild(bodyTextarea);
    form.appendChild(bodyRow);

    const quietStartRow = document.createElement("div");
    quietStartRow.className = "bis-form-row";
    const quietStartLabel = document.createElement("label");
    quietStartLabel.textContent = "Quiet Hours Start (0–23, UTC hour)";
    const quietStartInput = document.createElement("input");
    quietStartInput.type = "number";
    quietStartInput.min = "0";
    quietStartInput.max = "23";
    quietStartInput.name = "quiet_hours_start";
    quietStartRow.appendChild(quietStartLabel);
    quietStartRow.appendChild(quietStartInput);
    form.appendChild(quietStartRow);

    const quietEndRow = document.createElement("div");
    quietEndRow.className = "bis-form-row";
    const quietEndLabel = document.createElement("label");
    quietEndLabel.textContent = "Quiet Hours End (0–23, UTC hour)";
    const quietEndInput = document.createElement("input");
    quietEndInput.type = "number";
    quietEndInput.min = "0";
    quietEndInput.max = "23";
    quietEndInput.name = "quiet_hours_end";
    quietEndRow.appendChild(quietEndLabel);
    quietEndRow.appendChild(quietEndInput);
    form.appendChild(quietEndRow);

    const btnRow = document.createElement("div");
    btnRow.className = "bis-form-row";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save Settings";
    btnRow.appendChild(saveBtn);
    form.appendChild(btnRow);

    // Mark dirty on input
    const markDirty = (): void => {
      if (!settingsDirty) {
        settingsDirty = true;
        bridge.saveBar.show("settings");
      }
    };
    subjectInput.addEventListener("input", markDirty);
    bodyTextarea.addEventListener("input", markDirty);
    quietStartInput.addEventListener("input", markDirty);
    quietEndInput.addEventListener("input", markDirty);

    // Load current settings
    async function loadSettings(): Promise<void> {
      const resp = (await bridge.call("/admin/settings", {})) as AdminSettingsResponse;
      if (resp.settings) {
        subjectInput.value = resp.settings.template_subject;
        bodyTextarea.value = resp.settings.template_body;
        quietStartInput.value = String(resp.settings.quiet_hours_start);
        quietEndInput.value = String(resp.settings.quiet_hours_end);
      } else {
        // Defaults
        subjectInput.value = "You're back in luck! {{product_name}} is back in stock";
        bodyTextarea.value =
          "Good news! {{item_details}} is now back in stock.\n\nShop now before it sells out again.\n\nTo unsubscribe, click: {{unsubscribe_url}}";
        quietStartInput.value = "22";
        quietEndInput.value = "8";
      }
    }

    saveBtn.addEventListener("click", async () => {
      const subject = subjectInput.value.trim();
      const body = bodyTextarea.value.trim();
      const quietStart = parseInt(quietStartInput.value, 10);
      const quietEnd = parseInt(quietEndInput.value, 10);

      if (!subject) {
        bridge.notify("Subject is required", "error");
        return;
      }
      if (!body) {
        bridge.notify("Body is required", "error");
        return;
      }
      if (isNaN(quietStart) || quietStart < 0 || quietStart > 23) {
        bridge.notify("Quiet hours start must be 0–23", "error");
        return;
      }
      if (isNaN(quietEnd) || quietEnd < 0 || quietEnd > 23) {
        bridge.notify("Quiet hours end must be 0–23", "error");
        return;
      }

      const saveBody: AdminSettingsSaveRequest = {
        template_subject: subject,
        template_body: body,
        quiet_hours_start: quietStart,
        quiet_hours_end: quietEnd,
      };

      const resp = (await bridge.call("/admin/settings", saveBody)) as AdminSettingsSaveResponse;
      if (resp.success) {
        bridge.notify("Settings saved");
        settingsDirty = false;
        bridge.saveBar.hide("settings");
        await loadSettings();
      } else {
        bridge.notify("Failed to save settings", "error");
      }
    });

    loadSettings();
  }

  // ─── Stats ───────────────────────────────────────────────────────────────
  function renderStats(): void {
    const section = document.createElement("div");
    section.className = "shell-section";
    content.appendChild(section);

    const heading = document.createElement("h2");
    heading.textContent = "Recovered Demand Stats";
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "bis-stat-grid";
    section.appendChild(grid);

    async function loadStats(): Promise<void> {
      grid.innerHTML = "<p>Loading…</p>";

      const resp = (await bridge.call("/admin/stats", {})) as AdminStatsResponse;

      grid.innerHTML = "";

      const stats: Array<{ label: string; value: string }> = [
        { label: "Total Signups", value: String(resp.total_signups) },
        { label: "Total Notified", value: String(resp.total_notified) },
        { label: "Total Converted", value: String(resp.total_converted) },
        {
          label: "Conversion Rate",
          value: `${(resp.conversion_rate * 100).toFixed(1)}%`,
        },
      ];

      for (const stat of stats) {
        const card = document.createElement("div");
        card.className = "shell-card bis-stat-card";
        const num = document.createElement("div");
        num.className = "bis-stat-num";
        num.textContent = stat.value;
        const lbl = document.createElement("div");
        lbl.textContent = stat.label;
        lbl.style.color = "var(--p-color-text-subdued)";
        card.appendChild(num);
        card.appendChild(lbl);
        grid.appendChild(card);
      }
    }

    loadStats();
  }

  // ─── Initial render ──────────────────────────────────────────────────────
  showView("dashboard");
}

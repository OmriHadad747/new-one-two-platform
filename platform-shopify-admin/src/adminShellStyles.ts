/**
 * Base stylesheet injected into every admin UI module container before mount().
 * The generator is told these classes exist — it only writes app-specific CSS.
 *
 * Class contract (must stay in sync with admin_ui_agent.py SHELL_CSS_CLASSES):
 *   Layout:   .shell-root  .shell-header  .shell-title  .shell-stats-row  .shell-stat-card
 *             .shell-stat-label  .shell-stat-value  .shell-card  .shell-toolbar  .shell-section-title
 *   Table:    .shell-table-wrap  .shell-table
 *   Form:     .shell-search  .shell-field  .shell-label  .shell-help  .shell-error
 *             .shell-input  .shell-textarea  .shell-select
 *   Buttons:  .btn-primary  .btn-secondary  .btn-danger
 *   Badges:   .badge  .badge-success  .badge-neutral  .badge-error  .badge-warning
 *   Feedback: .shell-loading  .shell-spinner  .shell-empty  .shell-error-banner
 *             .shell-success-banner  .shell-info-banner  .shell-warning-banner
 *   Pagination: .shell-pagination  .shell-pagination-btns
 *   Modal:    .shell-confirm-overlay  .shell-confirm-dialog  .shell-confirm-title
 *             .shell-confirm-body  .shell-confirm-actions
 */
export const ADMIN_SHELL_CSS = `
  .shell-root {
    font-family: var(--p-font-family-sans);
    color: var(--p-color-text);
    padding: var(--p-space-400);
    max-width: 1200px;
  }
  .shell-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--p-space-400);
  }
  .shell-title {
    font-size: var(--p-font-size-500);
    font-weight: var(--p-font-weight-bold);
    margin: 0;
  }
  .shell-section-title {
    font-size: var(--p-font-size-350);
    font-weight: var(--p-font-weight-semibold);
    color: var(--p-color-text-secondary);
    margin-bottom: var(--p-space-300);
  }
  .shell-card {
    background: var(--p-color-bg-surface);
    border: 1px solid var(--p-color-border);
    border-radius: var(--p-border-radius-200);
    padding: var(--p-space-400);
    box-shadow: var(--p-shadow-100);
    margin-bottom: var(--p-space-400);
  }
  .shell-stats-row {
    display: flex;
    gap: var(--p-space-400);
    margin-bottom: var(--p-space-400);
  }
  .shell-stat-card {
    flex: 1;
    background: var(--p-color-bg-surface);
    border: 1px solid var(--p-color-border);
    border-radius: var(--p-border-radius-200);
    padding: var(--p-space-400);
    box-shadow: var(--p-shadow-100);
  }
  .shell-stat-label {
    font-size: var(--p-font-size-300);
    color: var(--p-color-text-secondary);
    margin-bottom: var(--p-space-100);
    font-weight: var(--p-font-weight-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .shell-stat-value {
    font-size: var(--p-font-size-500);
    font-weight: var(--p-font-weight-bold);
    color: var(--p-color-text);
  }
  .shell-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--p-space-300);
    gap: var(--p-space-300);
  }
  .shell-search {
    padding: var(--p-space-200) var(--p-space-300);
    border: 1px solid var(--p-color-border);
    border-radius: var(--p-border-radius-100);
    font-size: var(--p-font-size-350);
    font-family: var(--p-font-family-sans);
    color: var(--p-color-text);
    background: var(--p-color-bg-surface);
    width: 280px;
  }
  .shell-search:focus {
    outline: 2px solid #008060;
    outline-offset: 1px;
    border-color: #008060;
  }
  /* ── Form fields ────────────────────────────────────────────────────
     Wrap a label / control / help-or-error trio in .shell-field for
     consistent vertical spacing. Use .shell-input / .shell-textarea /
     .shell-select for the control itself. Disabled state ships built-in.
     Pattern:
       <div class="shell-field">
         <label class="shell-label">Email</label>
         <input class="shell-input" type="email" />
         <div class="shell-help">We only use this for receipts.</div>
         <div class="shell-error">Required.</div>
       </div>
  */
  .shell-field {
    display: flex;
    flex-direction: column;
    gap: var(--p-space-100);
    margin-bottom: var(--p-space-300);
  }
  .shell-label {
    font-size: var(--p-font-size-300);
    font-weight: var(--p-font-weight-medium);
    color: var(--p-color-text);
  }
  .shell-help {
    font-size: var(--p-font-size-300);
    color: var(--p-color-text-secondary);
  }
  .shell-error {
    font-size: var(--p-font-size-300);
    color: var(--p-color-text-critical);
  }
  .shell-input,
  .shell-textarea,
  .shell-select {
    padding: var(--p-space-200) var(--p-space-300);
    border: 1px solid var(--p-color-border);
    border-radius: var(--p-border-radius-100);
    font-size: var(--p-font-size-350);
    font-family: var(--p-font-family-sans);
    color: var(--p-color-text);
    background: var(--p-color-bg-surface);
    width: 100%;
    box-sizing: border-box;
  }
  .shell-textarea {
    min-height: 80px;
    resize: vertical;
  }
  .shell-select {
    appearance: none;
    -webkit-appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--p-color-icon) 50%),
                      linear-gradient(135deg, var(--p-color-icon) 50%, transparent 50%);
    background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    padding-right: var(--p-space-800);
  }
  .shell-input:focus,
  .shell-textarea:focus,
  .shell-select:focus {
    outline: 2px solid #008060;
    outline-offset: 1px;
    border-color: #008060;
  }
  .shell-input:disabled,
  .shell-textarea:disabled,
  .shell-select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    background: var(--p-color-bg-surface-secondary);
  }
  .shell-table-wrap { overflow-x: auto; }
  .shell-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--p-font-size-350);
  }
  .shell-table th {
    text-align: left;
    padding: var(--p-space-200) var(--p-space-300);
    font-size: var(--p-font-size-300);
    font-weight: var(--p-font-weight-semibold);
    color: var(--p-color-text-secondary);
    border-bottom: 1px solid var(--p-color-border);
    background: var(--p-color-bg-surface-secondary);
    white-space: nowrap;
  }
  .shell-table td {
    padding: var(--p-space-300);
    border-bottom: 1px solid var(--p-color-border);
    vertical-align: middle;
    color: var(--p-color-text);
  }
  .shell-table tr:last-child td { border-bottom: none; }
  .shell-table tr:hover td { background: var(--p-color-bg-surface-secondary); }
  .btn-primary {
    background: #008060;
    color: #fff;
    border: none;
    border-radius: var(--p-border-radius-100);
    padding: var(--p-space-200) var(--p-space-400);
    font-size: var(--p-font-size-350);
    font-weight: var(--p-font-weight-medium);
    cursor: pointer;
    font-family: var(--p-font-family-sans);
  }
  .btn-primary:hover:not(:disabled) { background: #006e52; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary {
    background: var(--p-color-bg-surface);
    color: var(--p-color-text);
    border: 1px solid var(--p-color-border-emphasis);
    border-radius: var(--p-border-radius-100);
    padding: var(--p-space-200) var(--p-space-400);
    font-size: var(--p-font-size-350);
    font-weight: var(--p-font-weight-medium);
    cursor: pointer;
    font-family: var(--p-font-family-sans);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--p-color-bg-surface-secondary); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger {
    background: var(--p-color-bg-surface);
    color: var(--p-color-text-critical);
    border: 1px solid var(--p-color-border);
    border-radius: var(--p-border-radius-100);
    padding: var(--p-space-100) var(--p-space-300);
    font-size: var(--p-font-size-300);
    font-weight: var(--p-font-weight-medium);
    cursor: pointer;
    font-family: var(--p-font-family-sans);
  }
  .btn-danger:hover:not(:disabled) { background: var(--p-color-bg-fill-critical); }
  .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--p-space-200);
    border-radius: var(--p-border-radius-full);
    font-size: var(--p-font-size-300);
    font-weight: var(--p-font-weight-semibold);
  }
  .badge-success { background: var(--p-color-bg-fill-success); color: var(--p-color-text-success); }
  .badge-error   { background: var(--p-color-bg-fill-critical); color: var(--p-color-text-critical); }
  .badge-warning { background: var(--p-color-bg-fill-warning); color: var(--p-color-text-warning); }
  .badge-neutral { background: var(--p-color-bg-surface-secondary); color: var(--p-color-text-secondary); }
  .shell-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--p-space-800);
    color: var(--p-color-text-secondary);
    font-size: var(--p-font-size-350);
    gap: var(--p-space-200);
  }
  .shell-spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--p-color-border);
    border-top-color: #008060;
    border-radius: 50%;
    animation: shell-spin 0.7s linear infinite;
  }
  @keyframes shell-spin { to { transform: rotate(360deg); } }
  .shell-empty {
    text-align: center;
    padding: var(--p-space-800);
    color: var(--p-color-text-secondary);
    font-size: var(--p-font-size-350);
  }
  .shell-error-banner,
  .shell-success-banner,
  .shell-info-banner,
  .shell-warning-banner {
    border-radius: var(--p-border-radius-100);
    padding: var(--p-space-300) var(--p-space-400);
    margin-bottom: var(--p-space-400);
    font-size: var(--p-font-size-350);
  }
  .shell-error-banner {
    background: var(--p-color-bg-fill-critical);
    color: var(--p-color-text-critical);
  }
  .shell-success-banner {
    background: var(--p-color-bg-fill-success);
    color: var(--p-color-text-success);
  }
  .shell-info-banner {
    background: var(--p-color-bg-surface-secondary);
    color: var(--p-color-text);
  }
  .shell-warning-banner {
    background: var(--p-color-bg-fill-warning);
    color: var(--p-color-text);
  }
  .shell-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--p-space-300);
    font-size: var(--p-font-size-300);
    color: var(--p-color-text-secondary);
  }
  .shell-pagination-btns { display: flex; gap: var(--p-space-200); }
  .shell-confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .shell-confirm-dialog {
    background: var(--p-color-bg-surface);
    border-radius: var(--p-border-radius-200);
    padding: var(--p-space-600);
    box-shadow: var(--p-shadow-300);
    max-width: 400px;
    width: 90%;
  }
  .shell-confirm-title {
    font-size: var(--p-font-size-400);
    font-weight: var(--p-font-weight-semibold);
    margin-bottom: var(--p-space-200);
  }
  .shell-confirm-body {
    font-size: var(--p-font-size-350);
    color: var(--p-color-text-secondary);
    margin-bottom: var(--p-space-400);
  }
  .shell-confirm-actions {
    display: flex;
    gap: var(--p-space-200);
    justify-content: flex-end;
  }
`;

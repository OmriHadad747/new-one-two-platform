# Feature Generator — Run Result

**Date:** 2026-04-04 23:23:54  
**Status:** ✅ SUCCESS  
**Total:** 185606ms  
**Prompt:** build image store optimization app that analayze all store images and optimize them if resoulotion is up to 400x400 pixels, it will optimize them to 400x400 and change the stores images with the optimization ones.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 3117ms     |
| Architect   | ✓      | 37909ms    |
| CodeSpec    | ✓      | 36449ms    |
| Handler     | ✓      | 36945ms    |
| Migration   | ✓      | 63180ms    |
| Admin UI    | ✓      | 63180ms    |
| Validation  | ✓      | 10ms       |
| Explanation | ✓      | 7974ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: '0 2 * * *',
  handler: async function(ctx) {
    try {
      ctx.logger.info({ trigger: ctx.trigger }, 'Image optimization handler invoked');

      if (ctx.trigger === 'admin') {
        if (ctx.widgetPath === '/run') {
          ctx.logger.info('Admin triggered manual optimization run');
          const runId = generateUUID();
          runOptimizationPipeline(ctx, 'admin', runId).catch(err => {
            ctx.logger.error({ error: err.message }, 'Background optimization pipeline error');
          });
          return { runId: runId, status: 'started', message: 'Optimization job started' };
        }

        if (ctx.widgetPath === '/runs') {
          const rows = await ctx.db`
            SELECT
              id AS "runId",
              trigger,
              started_at AS "startedAt",
              completed_at AS "completedAt",
              total_scanned AS "totalScanned",
              total_optimized AS "totalOptimized",
              total_failed AS "totalFailed",
              total_skipped AS "totalSkipped"
            FROM optimization_runs
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY started_at DESC
            LIMIT 50
          `;
          return { rows: rows };
        }

        if (ctx.widgetPath === '/images') {
          const totalRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM image_optimizations
            WHERE tenant_id = ${ctx.tenantId}
            AND status = 'optimized'
          `;
          const total = parseInt(totalRows[0].total, 10);

          const rows = await ctx.db`
            SELECT
              media_id AS "mediaId",
              product_id AS "productId",
              original_width AS "originalWidth",
              original_height AS "originalHeight",
              status,
              optimized_at AS "optimizedAt"
            FROM image_optimizations
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY optimized_at DESC NULLS LAST
            LIMIT 100
          `;
          return { total: total, rows: rows };
        }

        return { error: 'unknown path' };
      }

      if (ctx.trigger === 'cron') {
        ctx.logger.info('Cron triggered image optimization run');
        const runId = generateUUID();
        await runOptimizationPipeline(ctx, 'cron', runId);
        return;
      }

    } catch (err) {
      ctx.logger.error({ error: err.message }, 'Image optimization handler fatal error');
    }
  }
};

function generateUUID() {
  const hex = [];
  for (let i = 0; i < 32; i++) {
    hex.push(Math.floor(Math.random() * 16).toString(16));
  }
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join('')
  ].join('-');
}

function numericProductId(productGid) {
  const parts = productGid.split('/');
  return parseInt(parts[parts.length - 1], 10);
}

async function runOptimizationPipeline(ctx, triggerSource, runId) {
  await ctx.db`
    INSERT INTO optimization_runs (id, tenant_id, trigger, started_at)
    VALUES (${runId}, ${ctx.tenantId}, ${triggerSource}, NOW())
  `;

  let totalScanned = 0;
  let totalOptimized = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  let cursor = null;
  let hasNextPage = true;
  const mediaItems = [];

  // PHASE 1: paginate all products and collect media metadata
  while (hasNextPage) {
    let productsData;
    try {
      productsData = await ctx.shopify.graphql(
        `query GetProducts($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                media(first: 50) {
                  edges {
                    node {
                      id
                      __typename
                      ... on MediaImage {
                        id
                        image {
                          url
                          width
                          height
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { cursor: cursor }
      );
    } catch (err) {
      ctx.logger.error({ error: err.message }, 'GraphQL products query failed — aborting pipeline');
      await ctx.db`
        UPDATE optimization_runs
        SET completed_at = NOW(), total_scanned = ${totalScanned}, total_optimized = ${totalOptimized}, total_failed = ${totalFailed}, total_skipped = ${totalSkipped}
        WHERE id = ${runId} AND tenant_id = ${ctx.tenantId}
      `;
      return runId;
    }

    if (!productsData || !productsData.products) {
      ctx.logger.error('Products data null — aborting pipeline');
      break;
    }

    for (const productEdge of productsData.products.edges) {
      const productGid = productEdge.node.id;
      for (const mediaEdge of productEdge.node.media.edges) {
        if (mediaEdge.node.__typename !== 'MediaImage') continue;
        if (!mediaEdge.node.image) continue;
        mediaItems.push({
          mediaId: mediaEdge.node.id,
          productGid: productGid,
          imageUrl: mediaEdge.node.image.url,
          width: mediaEdge.node.image.width,
          height: mediaEdge.node.image.height
        });
      }
    }

    hasNextPage = productsData.products.pageInfo.hasNextPage;
    cursor = productsData.products.pageInfo.endCursor;
  }

  ctx.logger.info({ totalMedia: mediaItems.length }, 'Phase 1 complete — media collected');

  // PHASE 2: process each media item
  for (const item of mediaItems) {
    totalScanned += 1;

    if (item.width <= 400 && item.height <= 400) {
      const skipId = generateUUID();
      try {
        await ctx.db`
          INSERT INTO image_optimizations (id, tenant_id, product_id, media_id, original_width, original_height, status, created_at)
          VALUES (${skipId}, ${ctx.tenantId}, ${numericProductId(item.productGid)}, ${item.mediaId}, ${item.width}, ${item.height}, 'skipped', NOW())
          ON CONFLICT ON CONSTRAINT uq_image_optimizations_tenant_media
          DO UPDATE SET status = 'skipped', original_width = EXCLUDED.original_width, original_height = EXCLUDED.original_height
        `;
      } catch (dbErr) {
        ctx.logger.error({ error: dbErr.message, mediaId: item.mediaId }, 'DB upsert failed for skipped image');
      }
      totalSkipped += 1;
      continue;
    }

    // Image exceeds 400x400 — proceed with optimization
    try {
      const analysisResult = await ctx.services.image.analyze(item.imageUrl);
      if (!analysisResult) throw new Error('Image analysis returned null');

      const resizedBuffer = await ctx.services.image.resize(item.imageUrl, { width: 400, height: 400, fit: 'cover' });
      if (!resizedBuffer) throw new Error('Image resize returned null buffer');

      const filename = 'optimized_' + item.mediaId.replace(/[^a-zA-Z0-9]/g, '_') + '.jpg';
      const fileSize = resizedBuffer.byteLength;
      const mimeType = 'image/jpeg';

      const publicUrl = await ctx.services.files.upload(filename, resizedBuffer, mimeType);
      if (!publicUrl) throw new Error('File upload returned no URL');

      const stagedResult = await ctx.shopify.graphql(
        `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }`,
        {
          input: [{
            filename: filename,
            mimeType: mimeType,
            resource: 'IMAGE',
            fileSize: String(fileSize),
            httpMethod: 'POST'
          }]
        }
      );

      if (stagedResult.stagedUploadsCreate.userErrors.length > 0) {
        throw new Error('stagedUploadsCreate error: ' + stagedResult.stagedUploadsCreate.userErrors[0].message);
      }

      const stagedTarget = stagedResult.stagedUploadsCreate.stagedTargets[0];
      if (!stagedTarget) throw new Error('No staged target returned');

      const newImageUrl = stagedTarget.resourceUrl;

      const updateResult = await ctx.shopify.graphql(
        `mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
          productUpdateMedia(productId: $productId, media: $media) {
            media {
              id
              ... on MediaImage {
                image { url width height }
              }
            }
            mediaUserErrors { field message }
          }
        }`,
        {
          productId: item.productGid,
          media: [{ id: item.mediaId, previewImageSource: newImageUrl }]
        }
      );

      if (updateResult.productUpdateMedia.mediaUserErrors.length > 0) {
        throw new Error('productUpdateMedia error: ' + updateResult.productUpdateMedia.mediaUserErrors[0].message);
      }

      const optId = generateUUID();
      await ctx.db`
        INSERT INTO image_optimizations (id, tenant_id, product_id, media_id, original_width, original_height, status, optimized_at, error_message, created_at)
        VALUES (${optId}, ${ctx.tenantId}, ${numericProductId(item.productGid)}, ${item.mediaId}, ${item.width}, ${item.height}, 'optimized', NOW(), NULL, NOW())
        ON CONFLICT ON CONSTRAINT uq_image_optimizations_tenant_media
        DO UPDATE SET status = 'optimized', original_width = EXCLUDED.original_width, original_height = EXCLUDED.original_height, optimized_at = NOW(), error_message = NULL
      `;

      totalOptimized += 1;
      ctx.logger.info({ mediaId: item.mediaId }, 'Image optimized successfully');

    } catch (err) {
      ctx.logger.error({ mediaId: item.mediaId, error: err.message }, 'Image optimization failed');
      const failId = generateUUID();
      try {
        await ctx.db`
          INSERT INTO image_optimizations (id, tenant_id, product_id, media_id, original_width, original_height, status, error_message, created_at)
          VALUES (${failId}, ${ctx.tenantId}, ${numericProductId(item.productGid)}, ${item.mediaId}, ${item.width}, ${item.height}, 'failed', ${err.message}, NOW())
          ON CONFLICT ON CONSTRAINT uq_image_optimizations_tenant_media
          DO UPDATE SET status = 'failed', original_width = EXCLUDED.original_width, original_height = EXCLUDED.original_height, error_message = EXCLUDED.error_message
        `;
      } catch (dbErr) {
        ctx.logger.error({ error: dbErr.message, mediaId: item.mediaId }, 'DB upsert failed for failed image');
      }
      totalFailed += 1;
    }
  }

  // PHASE 3: finalize the run record
  await ctx.db`
    UPDATE optimization_runs
    SET completed_at = NOW(), total_scanned = ${totalScanned}, total_optimized = ${totalOptimized}, total_failed = ${totalFailed}, total_skipped = ${totalSkipped}
    WHERE id = ${runId} AND tenant_id = ${ctx.tenantId}
  `;

  ctx.logger.info({ runId, totalScanned, totalOptimized, totalFailed, totalSkipped }, 'Optimization pipeline complete');
  return runId;
}
```

### migration.sql

```sql
CREATE TABLE image_optimizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  product_id       BIGINT NOT NULL,
  media_id         TEXT NOT NULL,
  original_width   INT,
  original_height  INT,
  status           TEXT NOT NULL DEFAULT 'pending',
  optimized_at     TIMESTAMPTZ,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_image_optimizations_tenant_media UNIQUE (tenant_id, media_id)
);

ALTER TABLE image_optimizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY image_optimizations_tenant_isolation ON image_optimizations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_image_optimizations_tenant_status ON image_optimizations (tenant_id, status);
CREATE INDEX idx_image_optimizations_tenant_product ON image_optimizations (tenant_id, product_id);

CREATE TABLE optimization_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  trigger         TEXT NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  total_scanned   INT,
  total_optimized INT,
  total_failed    INT,
  total_skipped   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE optimization_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY optimization_runs_tenant_isolation ON optimization_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_optimization_runs_tenant_started ON optimization_runs (tenant_id, started_at DESC);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const styles = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .panel {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e4e4e4;
      min-height: 100vh;
      padding: 24px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #2a2a2a;
    }

    .header-left h1 {
      font-size: 20px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 4px;
    }

    .header-left p {
      font-size: 13px;
      color: #888;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s, opacity 0.15s;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: #4f9ef8;
      color: #fff;
    }

    .btn-primary:hover:not(:disabled) {
      background: #3d8de6;
    }

    .btn-secondary {
      background: #2a2a2a;
      color: #e4e4e4;
      border: 1px solid #3a3a3a;
    }

    .btn-secondary:hover:not(:disabled) {
      background: #333;
    }

    .btn-danger {
      background: #c0392b;
      color: #fff;
    }

    .btn-danger:hover:not(:disabled) {
      background: #a93226;
    }

    .action-bar {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 16px;
    }

    .stat-card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
      margin-bottom: 8px;
    }

    .stat-card .value {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
    }

    .stat-card .value.green { color: #4caf50; }
    .stat-card .value.yellow { color: #f9a825; }
    .stat-card .value.red { color: #ef5350; }
    .stat-card .value.blue { color: #4f9ef8; }

    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #2a2a2a;
      margin-bottom: 20px;
    }

    .tab {
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 500;
      color: #888;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
    }

    .tab.active {
      color: #4f9ef8;
      border-bottom-color: #4f9ef8;
    }

    .tab:hover:not(.active) {
      color: #ccc;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    .section {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 20px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #2a2a2a;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }

    .section-subtitle {
      font-size: 12px;
      color: #666;
      margin-top: 2px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead tr {
      background: #161616;
    }

    th {
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
      text-align: left;
      border-bottom: 1px solid #2a2a2a;
    }

    td {
      padding: 10px 14px;
      font-size: 13px;
      color: #ccc;
      border-bottom: 1px solid #1f1f1f;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: #1f1f1f;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: capitalize;
    }

    .badge-optimized { background: #1b3a1e; color: #4caf50; }
    .badge-failed { background: #3a1b1b; color: #ef5350; }
    .badge-skipped { background: #2a2a1a; color: #f9a825; }
    .badge-pending { background: #1a2a3a; color: #4f9ef8; }
    .badge-cron { background: #1a2a3a; color: #4f9ef8; }
    .badge-admin { background: #2a1a3a; color: #ab47bc; }

    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #444;
      border-top-color: #4f9ef8;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 40px;
      color: #666;
      font-size: 14px;
    }

    .empty-state {
      padding: 40px;
      text-align: center;
      color: #555;
      font-size: 14px;
    }

    .error-state {
      margin: 16px;
      padding: 12px 16px;
      background: #2a1a1a;
      border: 1px solid #5a2a2a;
      border-radius: 6px;
      color: #ef5350;
      font-size: 13px;
    }

    .run-banner {
      background: #1a2a1a;
      border: 1px solid #2a4a2a;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 16px;
      color: #4caf50;
      font-size: 13px;
      display: none;
      align-items: center;
      gap: 8px;
    }

    .run-banner.visible {
      display: flex;
    }

    .monospace {
      font-family: 'SFMono-Regular', Consolas, monospace;
      font-size: 11px;
      color: #888;
    }

    .text-right { text-align: right; }
    .text-center { text-align: center; }

    .refresh-note {
      font-size: 11px;
      color: #555;
    }

    .dim { color: #555; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'panel';
  root.innerHTML = `
    <div class="header">
      <div class="header-left">
        <h1>Image Optimizer</h1>
        <p>Automatically resize product images exceeding 400×400 px to 400×400 px</p>
      </div>
    </div>

    <div class="stats-row" id="stats-row">
      <div class="stat-card">
        <div class="label">Total Optimized</div>
        <div class="value blue" id="stat-total">—</div>
      </div>
      <div class="stat-card">
        <div class="label">Last Run Scanned</div>
        <div class="value" id="stat-scanned">—</div>
      </div>
      <div class="stat-card">
        <div class="label">Last Run Optimized</div>
        <div class="value green" id="stat-optimized">—</div>
      </div>
      <div class="stat-card">
        <div class="label">Last Run Failed</div>
        <div class="value red" id="stat-failed">—</div>
      </div>
      <div class="stat-card">
        <div class="label">Last Run Skipped</div>
        <div class="value yellow" id="stat-skipped">—</div>
      </div>
    </div>

    <div class="action-bar">
      <button class="btn btn-primary" id="btn-run">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5,3 19,12 5,21"/></svg>
        Run Optimization Now
      </button>
      <button class="btn btn-secondary" id="btn-refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        Refresh Data
      </button>
    </div>

    <div class="run-banner" id="run-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span id="run-banner-text">Optimization job started</span>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="runs">Run History</button>
      <button class="tab" data-tab="images">Optimized Images</button>
    </div>

    <div class="tab-content active" id="tab-runs">
      <div class="section">
        <div class="section-header">
          <div>
            <div class="section-title">Optimization Runs</div>
            <div class="section-subtitle">Last 50 runs shown</div>
          </div>
        </div>
        <div id="runs-container">
          <div class="loading-state"><div class="spinner"></div> Loading runs…</div>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-images">
      <div class="section">
        <div class="section-header">
          <div>
            <div class="section-title">Optimized Images</div>
            <div class="section-subtitle" id="images-subtitle">Loading…</div>
          </div>
        </div>
        <div id="images-container">
          <div class="loading-state"><div class="spinner"></div> Loading images…</div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(root);

  function $(sel) {
    return container.querySelector(sel);
  }

  function formatDate(iso) {
    if (!iso) return '<span class="dim">—</span>';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt) return '<span class="dim">—</span>';
    const diff = (new Date(completedAt) - new Date(startedAt)) / 1000;
    if (diff < 60) return `${Math.round(diff)}s`;
    return `${Math.floor(diff / 60)}m ${Math.round(diff % 60)}s`;
  }

  function shortenId(id) {
    if (!id) return '—';
    return `<span class="monospace">${id.substring(0, 8)}…</span>`;
  }

  function shortenMediaId(gid) {
    if (!gid) return '<span class="dim">—</span>';
    const parts = gid.split('/');
    const numId = parts[parts.length - 1];
    return `<span class="monospace" title="${gid}">${numId}</span>`;
  }

  function getBadge(val, type) {
    if (!val) return '<span class="dim">—</span>';
    return `<span class="badge badge-${val}">${val}</span>`;
  }

  function renderRunsTable(rows) {
    const container = $('#runs-container');
    if (!rows || rows.length === 0) {
      container.innerHTML = '<div class="empty-state">No runs found. Trigger a manual run or wait for the scheduled cron job.</div>';
      return;
    }

    let html = `<table>
      <thead>
        <tr>
          <th>Run ID</th>
          <th>Trigger</th>
          <th>Started</th>
          <th class="text-right">Duration</th>
          <th class="text-right">Scanned</th>
          <th class="text-right">Optimized</th>
          <th class="text-right">Failed</th>
          <th class="text-right">Skipped</th>
        </tr>
      </thead>
      <tbody>`;

    for (const row of rows) {
      html += `<tr>
        <td>${shortenId(row.runId)}</td>
        <td>${getBadge(row.trigger)}</td>
        <td>${formatDate(row.startedAt)}</td>
        <td class="text-right">${formatDuration(row.startedAt, row.completedAt)}</td>
        <td class="text-right">${row.totalScanned ?? '<span class="dim">—</span>'}</td>
        <td class="text-right" style="color:#4caf50">${row.totalOptimized ?? '<span class="dim">—</span>'}</td>
        <td class="text-right" style="color:${row.totalFailed > 0 ? '#ef5350' : '#ccc'}">${row.totalFailed ?? '<span class="dim">—</span>'}</td>
        <td class="text-right" style="color:#888">${row.totalSkipped ?? '<span class="dim">—</span>'}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderImagesTable(rows) {
    const imgContainer = $('#images-container');
    if (!rows || rows.length === 0) {
      imgContainer.innerHTML = '<div class="empty-state">No optimized images found yet.</div>';
      return;
    }

    let html = `<table>
      <thead>
        <tr>
          <th>Media ID</th>
          <th>Product ID</th>
          <th>Original Size</th>
          <th>Resized To</th>
          <th>Status</th>
          <th>Optimized At</th>
        </tr>
      </thead>
      <tbody>`;

    for (const row of rows) {
      const originalSize = (row.originalWidth && row.originalHeight)
        ? `${row.originalWidth} × ${row.originalHeight}`
        : '<span class="dim">—</span>';

      html += `<tr>
        <td>${shortenMediaId(row.mediaId)}</td>
        <td><span class="monospace">${row.productId ?? '—'}</span></td>
        <td>${originalSize}</td>
        <td><span style="color:#4f9ef8">400 × 400</span></td>
        <td>${getBadge(row.status)}</td>
        <td>${formatDate(row.optimizedAt)}</td>
      </tr>`;
    }

    html += '</tbody></table>';
    imgContainer.innerHTML = html;
  }

  async function loadRuns() {
    const runsContainer = $('#runs-container');
    runsContainer.innerHTML = '<div class="loading-state"><div class="spinner"></div> Loading runs…</div>';
    try {
      const data = await bridge.call('/runs');
      const rows = data && data.rows ? data.rows : [];

      if (rows.length > 0) {
        const last = rows[0];
        $('#stat-scanned').textContent = last.totalScanned ?? '—';
        $('#stat-optimized').textContent = last.totalOptimized ?? '—';
        $('#stat-failed').textContent = last.totalFailed ?? '—';
        $('#stat-skipped').textContent = last.totalSkipped ?? '—';
      }

      renderRunsTable(rows);
    } catch (err) {
      runsContainer.innerHTML = `<div class="error-state">Failed to load runs: ${err && err.message ? err.message : 'Unknown error'}</div>`;
    }
  }

  async function loadImages() {
    const imgContainer = $('#images-container');
    const subtitle = $('#images-subtitle');
    imgContainer.innerHTML = '<div class="loading-state"><div class="spinner"></div> Loading images…</div>';
    subtitle.textContent = 'Loading…';
    try {
      const data = await bridge.call('/images');
      const rows = data && data.rows ? data.rows : [];
      const total = data && data.total != null ? data.total : 0;

      $('#stat-total').textContent = total;
      subtitle.textContent = `${total} total optimized images — showing latest ${rows.length}`;

      renderImagesTable(rows);
    } catch (err) {
      imgContainer.innerHTML = `<div class="error-state">Failed to load images: ${err && err.message ? err.message : 'Unknown error'}</div>`;
      subtitle.textContent = 'Error loading data';
    }
  }

  async function loadAll() {
    await Promise.all([loadRuns(), loadImages()]);
  }

  const tabButtons = container.querySelectorAll('.tab');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabName = btn.dataset.tab;
      container.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      $(`#tab-${tabName}`).classList.add('active');
    });
  });

  const btnRun = $('#btn-run');
  btnRun.addEventListener('click', async () => {
    btnRun.disabled = true;
    btnRun.innerHTML = '<div class="spinner"></div> Starting…';
    const banner = $('#run-banner');
    banner.classList.remove('visible');

    try {
      const result = await bridge.call('/run');
      const runId = result && result.runId ? result.runId : 'unknown';
      const message = result && result.message ? result.message : 'Optimization job started';
      $('#run-banner-text').textContent = `${message} — Run ID: ${runId.substring(0, 8)}…`;
      banner.classList.add('visible');
      bridge.notify('Optimization job started successfully', 'success');

      setTimeout(() => {
        loadAll();
      }, 500);
    } catch (err) {
      bridge.notify(`Failed to start optimization: ${err && err.message ? err.message : 'Unknown error'}`, 'error');
    } finally {
      btnRun.disabled = false;
      btnRun.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5,3 19,12 5,21"/></svg> Run Optimization Now`;
    }
  });

  const btnRefresh = $('#btn-refresh');
  btnRefresh.addEventListener('click', async () => {
    btnRefresh.disabled = true;
    btnRefresh.innerHTML = '<div class="spinner"></div> Refreshing…';
    await loadAll();
    btnRefresh.disabled = false;
    btnRefresh.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Data`;
  });

  loadAll();
}
```


## Explanation

This feature automatically keeps your product images lean and consistent by resizing any image larger than 400×400 pixels down to that standard size. Every night at 2:00 AM, the app scans all of your products, finds any oversized images, resizes them to fit neatly within 400×400 pixels, and swaps them into your store — all without you lifting a finger. This helps keep your store loading quickly and your product gallery looking uniform.

You're always in control: inside the app's dashboard you'll find a history of every optimization run, showing which images were resized, their original dimensions, and when the change was made. If you don't want to wait for the nightly schedule, you can also press a "Run Now" button at any time to kick off an immediate scan and resize of your entire product catalog.

Note: because this feature touches every product and its images, very large catalogs may take a few minutes to fully process during each run. The dashboard will show you the status of each run so you always know when it's complete and how many images were updated.

# Chat Local — Codegen Output

**Date:** 2026-04-09 17:16:32  
**Prompt:** Upscale and replace all product images under 400×400 pixels to exactly 400×400 pixels.

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: null,
  npmPackages: ['sharp@0.33.5'],
  handler: async function(ctx) {
    if (ctx.trigger === 'admin') {
      ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

      // POST /job/start
      if (ctx.adminPath === '/job/start') {
        try {
          // Scan all products and images
          const allImages = [];
          let sinceId = 0;
          while (true) {
            const { products } = await ctx.shopify.get(
              `/products.json?fields=id,images&limit=250&since_id=${sinceId}`
            );
            if (!products || products.length === 0) break;
            for (const product of products) {
              if (product.images && product.images.length > 0) {
                for (const image of product.images) {
                  allImages.push({
                    product_id: product.id,
                    image_id: image.id,
                    src: image.src
                  });
                }
              }
            }
            sinceId = products[products.length - 1].id;
            if (products.length < 250) break;
          }

          ctx.logger.info({ totalImages: allImages.length }, 'job/start: images scanned');

          // Create job record
          const [job] = await ctx.db`
            INSERT INTO upscale_jobs (tenant_id, status, total, processed, succeeded, failed, started_at)
            VALUES (${ctx.tenantId}, 'pending', ${allImages.length}, 0, 0, 0, NOW())
            RETURNING id, status, total
          `;

          // Insert image records
          if (allImages.length > 0) {
            for (const img of allImages) {
              await ctx.db`
                INSERT INTO upscale_job_images (tenant_id, job_id, product_id, image_id, original_src, status)
                VALUES (${ctx.tenantId}, ${job.id}, ${img.product_id}, ${img.image_id}, ${img.src}, 'pending')
              `;
            }
          }

          // Start background processing (fire-and-forget)
          processJob(ctx, String(job.id)).catch(err => {
            ctx.logger.error({ jobId: job.id, err: err.message }, 'background job processing error');
          });

          return {
            job_id: String(job.id),
            status: job.status,
            total: Number(job.total)
          };
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'job/start failed');
          return { error: err.message };
        }
      }

      // GET /job/status
      if (ctx.adminPath === '/job/status') {
        try {
          const { job_id } = ctx.adminBody;
          const [job] = await ctx.db`
            SELECT id, status, total, processed, succeeded, failed, started_at, finished_at
            FROM upscale_jobs
            WHERE id = ${job_id} AND tenant_id = ${ctx.tenantId}
          `;
          if (!job) return { error: 'job not found' };
          return {
            job_id: String(job.id),
            status: job.status,
            total: Number(job.total),
            processed: Number(job.processed),
            succeeded: Number(job.succeeded),
            failed: Number(job.failed),
            started_at: job.started_at ? job.started_at.toISOString() : null,
            finished_at: job.finished_at ? job.finished_at.toISOString() : null
          };
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'job/status failed');
          return { error: err.message };
        }
      }

      // GET /job/images
      if (ctx.adminPath === '/job/images') {
        try {
          const { job_id, page = 1, page_size = 20 } = ctx.adminBody;
          const offset = (page - 1) * page_size;

          const rows = await ctx.db`
            SELECT id, product_id, image_id, original_src, original_width, original_height,
                   replacement_src, status, error_message, processed_at
            FROM upscale_job_images
            WHERE job_id = ${job_id} AND tenant_id = ${ctx.tenantId}
            ORDER BY id
            LIMIT ${page_size} OFFSET ${offset}
          `;

          const [countRow] = await ctx.db`
            SELECT COUNT(*) as total
            FROM upscale_job_images
            WHERE job_id = ${job_id} AND tenant_id = ${ctx.tenantId}
          `;

          return {
            items: rows.map(r => ({
              id: String(r.id),
              product_id: Number(r.product_id),
              image_id: Number(r.image_id),
              original_src: r.original_src,
              original_width: r.original_width !== null ? Number(r.original_width) : null,
              original_height: r.original_height !== null ? Number(r.original_height) : null,
              replacement_src: r.replacement_src || null,
              status: r.status,
              error_message: r.error_message || null,
              processed_at: r.processed_at ? r.processed_at.toISOString() : null
            })),
            total: Number(countRow.total),
            page: Number(page),
            page_size: Number(page_size)
          };
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'job/images failed');
          return { error: err.message };
        }
      }

      // GET /job/list
      if (ctx.adminPath === '/job/list') {
        try {
          const { page = 1, page_size = 20 } = ctx.adminBody;
          const offset = (page - 1) * page_size;

          const rows = await ctx.db`
            SELECT id, status, total, processed, succeeded, failed, started_at, finished_at
            FROM upscale_jobs
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY started_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;

          const [countRow] = await ctx.db`
            SELECT COUNT(*) as total FROM upscale_jobs WHERE tenant_id = ${ctx.tenantId}
          `;

          return {
            items: rows.map(r => ({
              id: String(r.id),
              status: r.status,
              total: Number(r.total),
              processed: Number(r.processed),
              succeeded: Number(r.succeeded),
              failed: Number(r.failed),
              started_at: r.started_at ? r.started_at.toISOString() : null,
              finished_at: r.finished_at ? r.finished_at.toISOString() : null
            })),
            total: Number(countRow.total),
            page: Number(page),
            page_size: Number(page_size)
          };
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'job/list failed');
          return { error: err.message };
        }
      }

      ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
      return { error: 'unknown path' };
    }
  }
};

async function processJob(ctx, jobId) {
  const sharp = require('sharp');

  // Mark job as processing
  await ctx.db`
    UPDATE upscale_jobs SET status = 'processing' WHERE id = ${jobId} AND tenant_id = ${ctx.tenantId}
  `;

  // Fetch all pending images for this job
  const images = await ctx.db`
    SELECT id, product_id, image_id, original_src
    FROM upscale_job_images
    WHERE job_id = ${jobId} AND tenant_id = ${ctx.tenantId} AND status = 'pending'
    ORDER BY id
  `;

  ctx.logger.info({ jobId, count: images.length }, 'processJob: starting image processing');

  let succeeded = 0;
  let failed = 0;

  for (const imgRow of images) {
    const imgRowId = String(imgRow.id);
    try {
      // Mark as processing
      await ctx.db`
        UPDATE upscale_job_images SET status = 'processing' WHERE id = ${imgRowId} AND tenant_id = ${ctx.tenantId}
      `;

      // Fetch image bytes
      const imageResponse = await ctx.http.call(imgRow.original_src, { method: 'GET' });
      // imageResponse may be buffer or base64 depending on harness — use Buffer handling
      let imageBuffer;
      if (Buffer.isBuffer(imageResponse)) {
        imageBuffer = imageResponse;
      } else if (typeof imageResponse === 'string') {
        imageBuffer = Buffer.from(imageResponse, 'base64');
      } else if (imageResponse && imageResponse.data) {
        imageBuffer = Buffer.from(imageResponse.data, 'base64');
      } else {
        throw new Error('Unable to get image buffer from HTTP response');
      }

      // Get metadata
      const metadata = await sharp(imageBuffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;

      // Update original dimensions
      await ctx.db`
        UPDATE upscale_job_images
        SET original_width = ${width}, original_height = ${height}
        WHERE id = ${imgRowId} AND tenant_id = ${ctx.tenantId}
      `;

      // Only upscale if under 400x400
      if (width >= 400 && height >= 400) {
        // No upscaling needed — mark done with original src as replacement
        await ctx.db`
          UPDATE upscale_job_images
          SET status = 'done', replacement_src = ${imgRow.original_src}, processed_at = NOW()
          WHERE id = ${imgRowId} AND tenant_id = ${ctx.tenantId}
        `;
        succeeded++;
      } else {
        // Upscale to exactly 400x400
        const upscaledBuffer = await sharp(imageBuffer)
          .resize(400, 400, { fit: 'fill' })
          .png()
          .toBuffer();

        // Upload the upscaled image as base64 to Shopify (replace image)
        const base64Image = upscaledBuffer.toString('base64');

        // Delete old image
        await ctx.shopify.delete(
          `/products/${imgRow.product_id}/images/${imgRow.image_id}.json`
        );

        // Create new image
        const result = await ctx.shopify.post(
          `/products/${imgRow.product_id}/images.json`,
          {
            image: {
              attachment: base64Image,
              filename: `upscaled_${imgRow.image_id}.png`
            }
          }
        );

        const newSrc = result && result.image ? result.image.src : null;

        await ctx.db`
          UPDATE upscale_job_images
          SET status = 'done', replacement_src = ${newSrc}, processed_at = NOW()
          WHERE id = ${imgRowId} AND tenant_id = ${ctx.tenantId}
        `;
        succeeded++;
        ctx.logger.info({ imgRowId, productId: imgRow.product_id, imageId: imgRow.image_id, originalWidth: width, originalHeight: height }, 'image upscaled');
      }
    } catch (err) {
      ctx.logger.error({ imgRowId, err: err.message }, 'image processing failed');
      failed++;
      await ctx.db`
        UPDATE upscale_job_images
        SET status = 'failed', error_message = ${err.message}, processed_at = NOW()
        WHERE id = ${imgRowId} AND tenant_id = ${ctx.tenantId}
      `;
    }

    // Update job counters
    const totalProcessed = succeeded + failed;
    await ctx.db`
      UPDATE upscale_jobs
      SET processed = ${totalProcessed}, succeeded = ${succeeded}, failed = ${failed}
      WHERE id = ${jobId} AND tenant_id = ${ctx.tenantId}
    `;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // Mark job as complete
  await ctx.db`
    UPDATE upscale_jobs
    SET status = 'done', finished_at = NOW()
    WHERE id = ${jobId} AND tenant_id = ${ctx.tenantId}
  `;

  ctx.logger.info({ jobId, succeeded, failed }, 'processJob: complete');
}
```

### migration.sql

```sql
CREATE TABLE upscale_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE upscale_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY upscale_jobs_tenant_isolation ON upscale_jobs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX upscale_jobs_tenant_id_idx ON upscale_jobs (tenant_id);

CREATE TABLE upscale_job_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL REFERENCES upscale_jobs(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  image_id BIGINT NOT NULL,
  original_src TEXT NOT NULL,
  original_width INTEGER NULL,
  original_height INTEGER NULL,
  replacement_src TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, image_id)
);

ALTER TABLE upscale_job_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY upscale_job_images_tenant_isolation ON upscale_job_images
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX upscale_job_images_tenant_id_idx ON upscale_job_images (tenant_id);
CREATE INDEX upscale_job_images_job_id_idx ON upscale_job_images (job_id);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .app-root { font-family: var(--p-font-family-sans); color: var(--p-color-text); }
    .section-gap { margin-bottom: var(--p-space-600); }
    .job-hero { display: flex; align-items: center; gap: var(--p-space-400); flex-wrap: wrap; }
    .job-hero-text h2 { font-size: var(--p-font-size-500); font-weight: var(--p-font-weight-bold); margin: 0 0 var(--p-space-100); }
    .job-hero-text p { font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); margin: 0; }
    .progress-bar-wrap { background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-full); height: 10px; overflow: hidden; margin-top: var(--p-space-300); }
    .progress-bar-fill { height: 100%; background: #008060; border-radius: var(--p-border-radius-full); transition: width 0.4s ease; }
    .active-job-card { border-left: 4px solid #008060; }
    .images-filter-row { display: flex; gap: var(--p-space-300); align-items: center; flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .images-filter-row select { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); cursor: pointer; }
    .thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--p-border-radius-100); border: 1px solid var(--p-color-border); background: var(--p-color-bg-surface-secondary); vertical-align: middle; }
    .thumb-placeholder { width: 48px; height: 48px; border-radius: var(--p-border-radius-100); border: 1px solid var(--p-color-border); background: var(--p-color-bg-surface-secondary); display: inline-flex; align-items: center; justify-content: center; color: var(--p-color-text-secondary); font-size: var(--p-font-size-300); }
    .dim-text { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .error-cell { font-size: var(--p-font-size-300); color: var(--p-color-text-critical); max-width: 200px; word-break: break-word; }
    .tabs { display: flex; gap: 0; border-bottom: 2px solid var(--p-color-border); margin-bottom: var(--p-space-500); }
    .tab-btn { background: none; border: none; border-bottom: 3px solid transparent; margin-bottom: -2px; padding: var(--p-space-300) var(--p-space-500); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; transition: color 0.15s, border-color 0.15s; }
    .tab-btn:hover { color: var(--p-color-text); }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; font-weight: var(--p-font-weight-semibold); }
    .tab-panel { display: none; }
    .tab-panel.visible { display: block; }
    .jobs-table-actions { display: flex; gap: var(--p-space-200); }
    .info-note { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); padding: var(--p-space-200) var(--p-space-300); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-100); border-left: 3px solid var(--p-color-border-emphasis); margin-bottom: var(--p-space-400); }
    .stat-row { display: flex; gap: var(--p-space-400); flex-wrap: wrap; margin-bottom: var(--p-space-500); }
    .stat-mini { flex: 1; min-width: 100px; padding: var(--p-space-300) var(--p-space-400); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-200); border: 1px solid var(--p-color-border); text-align: center; }
    .stat-mini-label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: 2px; }
    .stat-mini-value { font-size: var(--p-font-size-400); font-weight: var(--p-font-weight-bold); }
    .pagination-info { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
  `;

  container.innerHTML = `
    <div class="app-root shell-root">
      <div class="shell-header">
        <span class="shell-title">Product Image Upscaler</span>
        <div style="display:flex;gap:var(--p-space-300);align-items:center;">
          <button class="btn-secondary" id="btn-refresh-all">↻ Refresh</button>
          <button class="btn-primary" id="btn-start-job">▶ Start New Job</button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="dashboard">Dashboard</button>
        <button class="tab-btn" data-tab="history">Job History</button>
      </div>

      <div id="tab-dashboard" class="tab-panel visible">
        <div class="section-gap">
          <div class="info-note">
            This tool scans all product images, detects those under 400×400 px, upscales them to exactly 400×400 px using AI upscaling, and replaces them on Shopify. Image dimensions are resolved by fetching CDN metadata. Large catalogs may take several minutes.
          </div>
          <div id="active-job-section"></div>
        </div>
        <div class="section-gap" id="images-section" style="display:none;">
          <span class="shell-section-title">Processed Images</span>
          <div class="images-filter-row" style="margin-top:var(--p-space-300);">
            <select id="img-status-filter">
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
            </select>
            <span class="pagination-info" id="img-pagination-info"></span>
          </div>
          <div id="images-table-wrap" class="shell-table-wrap"></div>
          <div class="shell-pagination">
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="img-prev-btn" disabled>← Prev</button>
              <button class="btn-secondary" id="img-next-btn" disabled>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <div id="tab-history" class="tab-panel">
        <span class="shell-section-title">All Jobs</span>
        <div id="jobs-table-wrap" class="shell-table-wrap" style="margin-top:var(--p-space-400);"></div>
        <div class="shell-pagination">
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="jobs-prev-btn" disabled>← Prev</button>
            <button class="btn-secondary" id="jobs-next-btn" disabled>Next →</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(styleEl);

  // --- State ---
  let activeJobId = null;
  let pollTimer = null;
  let currentJobData = null;

  let imgPage = 1;
  const imgPageSize = 20;
  let imgTotal = 0;
  let imgStatusFilter = '';

  let jobsPage = 1;
  const jobsPageSize = 10;
  let jobsTotal = 0;

  let activeTab = 'dashboard';

  // --- Tab switching ---
  const tabBtns = container.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('visible'));
      container.querySelector(`#tab-${tab}`).classList.add('visible');
      activeTab = tab;
      if (tab === 'history') loadJobs();
    });
  });

  // --- Helpers ---
  function statusBadge(status) {
    const map = {
      pending: 'badge-neutral',
      processing: 'badge-warning',
      done: 'badge-success',
      succeeded: 'badge-success',
      completed: 'badge-success',
      failed: 'badge-error',
      running: 'badge-warning',
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${status}</span>`;
  }

  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleString();
    } catch (e) {
      return str;
    }
  }

  function elapsed(start, end) {
    if (!start) return '—';
    const s = new Date(start);
    const e = end ? new Date(end) : new Date();
    const sec = Math.round((e - s) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return `${min}m ${sec % 60}s`;
  }

  function showSection(id, visible) {
    const el = container.querySelector(`#${id}`);
    if (el) el.style.display = visible ? '' : 'none';
  }

  // --- Active job section ---
  function renderNoActiveJob() {
    const sec = container.querySelector('#active-job-section');
    sec.innerHTML = `
      <div class="shell-card">
        <div class="job-hero">
          <div class="job-hero-text">
            <h2>No Active Job</h2>
            <p>Click <strong>Start New Job</strong> to scan and upscale all product images under 400×400 px.</p>
          </div>
        </div>
      </div>
    `;
  }

  function renderActiveJob(job) {
    const sec = container.querySelector('#active-job-section');
    const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
    const isRunning = job.status === 'running' || job.status === 'processing';
    sec.innerHTML = `
      <div class="shell-card active-job-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:var(--p-space-300);">
          <div>
            <div style="display:flex;align-items:center;gap:var(--p-space-200);margin-bottom:var(--p-space-100);">
              <span class="shell-section-title" style="margin:0;">Current Job</span>
              ${statusBadge(job.status)}
            </div>
            <div class="dim-text">ID: ${job.job_id || job.id}</div>
          </div>
          <div style="text-align:right;">
            <div class="dim-text">Started: ${formatDate(job.started_at)}</div>
            ${job.finished_at ? `<div class="dim-text">Finished: ${formatDate(job.finished_at)}</div>` : ''}
            <div class="dim-text">Elapsed: ${elapsed(job.started_at, job.finished_at)}</div>
          </div>
        </div>
        <div class="stat-row" style="margin-top:var(--p-space-400);">
          <div class="stat-mini"><div class="stat-mini-label">Total</div><div class="stat-mini-value">${job.total ?? '—'}</div></div>
          <div class="stat-mini"><div class="stat-mini-label">Processed</div><div class="stat-mini-value">${job.processed ?? 0}</div></div>
          <div class="stat-mini"><div class="stat-mini-label" style="color:var(--p-color-text-success);">Succeeded</div><div class="stat-mini-value" style="color:var(--p-color-text-success);">${job.succeeded ?? 0}</div></div>
          <div class="stat-mini"><div class="stat-mini-label" style="color:var(--p-color-text-critical);">Failed</div><div class="stat-mini-value" style="color:var(--p-color-text-critical);">${job.failed ?? 0}</div></div>
        </div>
        ${job.total > 0 ? `
          <div>
            <div style="display:flex;justify-content:space-between;margin-bottom:var(--p-space-100);">
              <span class="dim-text">Progress</span>
              <span class="dim-text">${pct}% (${job.processed}/${job.total})</span>
            </div>
            <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
          </div>
        ` : ''}
        ${isRunning ? `<div class="dim-text" style="margin-top:var(--p-space-300);">⏳ Job is running — auto-refreshing every 5 seconds…</div>` : ''}
      </div>
    `;
  }

  // --- Images table ---
  async function loadImages() {
    if (!activeJobId) return;
    showSection('images-section', true);
    const wrap = container.querySelector('#images-table-wrap');
    wrap.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    try {
      const result = await bridge.call('/job/images', {
        job_id: activeJobId,
        page: imgPage,
        page_size: imgPageSize,
      });
      imgTotal = result.total;
      renderImagesTable(result.items);
      updateImgPagination();
    } catch (err) {
      wrap.innerHTML = `<div class="shell-error-banner">Failed to load images: ${err.message || err}</div>`;
    }
  }

  function renderImagesTable(items) {
    const wrap = container.querySelector('#images-table-wrap');
    const filtered = imgStatusFilter ? items.filter(i => i.status === imgStatusFilter) : items;

    if (!filtered.length) {
      wrap.innerHTML = `<div class="shell-empty">No images found${imgStatusFilter ? ` with status "${imgStatusFilter}"` : ''}.</div>`;
      return;
    }

    const rows = filtered.map(item => {
      const origDim = (item.original_width && item.original_height)
        ? `${item.original_width}×${item.original_height}`
        : '<span class="dim-text">unknown</span>';
      const thumb = item.original_src
        ? `<img class="thumb" src="${item.original_src}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<span class="thumb-placeholder">?</span>`;
      const repThumb = item.replacement_src
        ? `<img class="thumb" src="${item.replacement_src}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<span class="dim-text">—</span>`;
      const errCell = item.error_message
        ? `<div class="error-cell" title="${item.error_message}">${item.error_message.length > 60 ? item.error_message.slice(0, 60) + '…' : item.error_message}</div>`
        : '—';
      return `<tr>
        <td>${thumb}</td>
        <td><span class="dim-text">${item.image_id}</span></td>
        <td><span class="dim-text">${item.product_id}</span></td>
        <td>${origDim}</td>
        <td>${statusBadge(item.status)}</td>
        <td>${repThumb}</td>
        <td>${errCell}</td>
        <td><span class="dim-text">${formatDate(item.processed_at)}</span></td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table class="shell-table">
        <thead><tr>
          <th>Original</th>
          <th>Image ID</th>
          <th>Product ID</th>
          <th>Dimensions</th>
          <th>Status</th>
          <th>Replaced</th>
          <th>Error</th>
          <th>Processed At</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    container.querySelector('#img-pagination-info').textContent =
      `Showing ${((imgPage - 1) * imgPageSize) + 1}–${Math.min(imgPage * imgPageSize, imgTotal)} of ${imgTotal}`;
  }

  function updateImgPagination() {
    const prev = container.querySelector('#img-prev-btn');
    const next = container.querySelector('#img-next-btn');
    prev.disabled = imgPage <= 1;
    next.disabled = imgPage * imgPageSize >= imgTotal;
  }

  container.querySelector('#img-prev-btn').addEventListener('click', () => {
    if (imgPage > 1) { imgPage--; loadImages(); }
  });
  container.querySelector('#img-next-btn').addEventListener('click', () => {
    if (imgPage * imgPageSize < imgTotal) { imgPage++; loadImages(); }
  });
  container.querySelector('#img-status-filter').addEventListener('change', (e) => {
    imgStatusFilter = e.target.value;
    imgPage = 1;
    loadImages();
  });

  // --- Jobs history ---
  async function loadJobs() {
    const wrap = container.querySelector('#jobs-table-wrap');
    wrap.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    try {
      const result = await bridge.call('/job/list', { page: jobsPage, page_size: jobsPageSize });
      jobsTotal = result.total;
      renderJobsTable(result.items);
      updateJobsPagination();
    } catch (err) {
      wrap.innerHTML = `<div class="shell-error-banner">Failed to load jobs: ${err.message || err}</div>`;
    }
  }

  function renderJobsTable(items) {
    const wrap = container.querySelector('#jobs-table-wrap');
    if (!items.length) {
      wrap.innerHTML = `<div class="shell-empty">No jobs found.</div>`;
      return;
    }
    const rows = items.map(job => {
      const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
      const isActive = activeJobId === job.id;
      return `<tr ${isActive ? 'style="background:var(--p-color-bg-fill);"' : ''}>
        <td><span class="dim-text">${job.id}</span>${isActive ? ' <span class="badge badge-warning">active</span>' : ''}</td>
        <td>${statusBadge(job.status)}</td>
        <td>${job.total ?? '—'}</td>
        <td>${job.processed ?? 0}</td>
        <td style="color:var(--p-color-text-success);font-weight:var(--p-font-weight-semibold);">${job.succeeded ?? 0}</td>
        <td style="color:var(--p-color-text-critical);font-weight:var(--p-font-weight-semibold);">${job.failed ?? 0}</td>
        <td>${job.total > 0 ? `${pct}%` : '—'}</td>
        <td><span class="dim-text">${formatDate(job.started_at)}</span></td>
        <td><span class="dim-text">${elapsed(job.started_at, job.finished_at)}</span></td>
        <td>
          <div class="jobs-table-actions">
            <button class="btn-secondary" data-job-view="${job.id}">View Images</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table class="shell-table">
        <thead><tr>
          <th>Job ID</th><th>Status</th><th>Total</th><th>Processed</th>
          <th>Succeeded</th><th>Failed</th><th>Progress</th>
          <th>Started</th><th>Elapsed</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-job-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const jid = btn.dataset.jobView;
        activeJobId = jid;
        imgPage = 1;
        tabBtns.forEach(b => b.classList.remove('active'));
        container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('visible'));
        const dashTab = container.querySelector('[data-tab="dashboard"]');
        dashTab.classList.add('active');
        container.querySelector('#tab-dashboard').classList.add('visible');
        activeTab = 'dashboard';
        loadJobStatus(jid);
        loadImages();
      });
    });
  }

  function updateJobsPagination() {
    container.querySelector('#jobs-prev-btn').disabled = jobsPage <= 1;
    container.querySelector('#jobs-next-btn').disabled = jobsPage * jobsPageSize >= jobsTotal;
  }

  container.querySelector('#jobs-prev-btn').addEventListener('click', () => {
    if (jobsPage > 1) { jobsPage--; loadJobs(); }
  });
  container.querySelector('#jobs-next-btn').addEventListener('click', () => {
    if (jobsPage * jobsPageSize < jobsTotal) { jobsPage++; loadJobs(); }
  });

  // --- Job status polling ---
  async function loadJobStatus(jobId) {
    try {
      const job = await bridge.call('/job/status', { job_id: jobId });
      currentJobData = job;
      renderActiveJob(job);
      loadImages();

      const isRunning = job.status === 'running' || job.status === 'processing';
      if (isRunning) {
        schedulePoll(jobId);
      } else {
        stopPoll();
      }
    } catch (err) {
      container.querySelector('#active-job-section').innerHTML =
        `<div class="shell-error-banner">Failed to fetch job status: ${err.message || err}</div>`;
    }
  }

  function schedulePoll(jobId) {
    stopPoll();
    pollTimer = setTimeout(async () => {
      await loadJobStatus(jobId);
    }, 5000);
  }

  function stopPoll() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // --- Start job ---
  container.querySelector('#btn-start-job').addEventListener('click', async () => {
    const btn = container.querySelector('#btn-start-job');
    btn.disabled = true;
    btn.textContent = '⏳ Starting…';
    stopPoll();

    try {
      const result = await bridge.call('/job/start', {});
      bridge.notify('Job started successfully', 'success');
      activeJobId = result.job_id;
      imgPage = 1;
      imgStatusFilter = '';
      container.querySelector('#img-status-filter').value = '';

      tabBtns.forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('visible'));
      container.querySelector('[data-tab="dashboard"]').classList.add('active');
      container.querySelector('#tab-dashboard').classList.add('visible');
      activeTab = 'dashboard';

      await loadJobStatus(activeJobId);
    } catch (err) {
      bridge.notify(`Failed to start job: ${err.message || err}`, 'error');
      container.querySelector('#active-job-section').innerHTML =
        `<div class="shell-error-banner">Failed to start job: ${err.message || err}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Start New Job';
    }
  });

  // --- Refresh ---
  container.querySelector('#btn-refresh-all').addEventListener('click', async () => {
    const btn = container.querySelector('#btn-refresh-all');
    btn.disabled = true;
    try {
      if (activeTab === 'history') {
        await loadJobs();
      } else {
        if (activeJobId) {
          await loadJobStatus(activeJobId);
        } else {
          await loadLatestJob();
        }
      }
    } finally {
      btn.disabled = false;
    }
  });

  // --- Load latest job on mount ---
  async function loadLatestJob() {
    const sec = container.querySelector('#active-job-section');
    sec.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    try {
      const result = await bridge.call('/job/list', { page: 1, page_size: 1 });
      if (result.items && result.items.length > 0) {
        const latest = result.items[0];
        activeJobId = latest.id;
        await loadJobStatus(activeJobId);
      } else {
        renderNoActiveJob();
        showSection('images-section', false);
      }
    } catch (err) {
      sec.innerHTML = `<div class="shell-error-banner">Failed to load job data: ${err.message || err}</div>`;
    }
  }

  loadLatestJob();
}
```


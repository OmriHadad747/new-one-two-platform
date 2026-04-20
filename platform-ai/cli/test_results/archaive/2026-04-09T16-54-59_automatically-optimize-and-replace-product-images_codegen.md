# Chat Local — Codegen Output

**Date:** 2026-04-09 16:54:59  
**Prompt:** Automatically optimize and replace product images ≤400×400 pixels with compressed, quality-enhanced versions.

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['products/create', 'products/update'],
  cronSchedule: null,
  npmPackages: ['sharp@0.33.5'],
  handler: async function(ctx) {
    const sharp = require('sharp');

    // Default settings
    const DEFAULT_SETTINGS = {
      max_dimension: 400,
      jpeg_quality: 85,
      webp_quality: 85,
      output_format: 'jpeg',
      auto_process_enabled: true
    };

    // Helper: load tenant settings
    async function loadSettings() {
      const rows = await ctx.db`
        SELECT max_dimension, jpeg_quality, webp_quality, output_format, auto_process_enabled
        FROM image_optimization_settings
        WHERE tenant_id = ${ctx.tenantId}
        LIMIT 1
      `;
      if (rows.length === 0) return DEFAULT_SETTINGS;
      return {
        max_dimension: rows[0].max_dimension ?? DEFAULT_SETTINGS.max_dimension,
        jpeg_quality: rows[0].jpeg_quality ?? DEFAULT_SETTINGS.jpeg_quality,
        webp_quality: rows[0].webp_quality ?? DEFAULT_SETTINGS.webp_quality,
        output_format: rows[0].output_format ?? DEFAULT_SETTINGS.output_format,
        auto_process_enabled: rows[0].auto_process_enabled ?? DEFAULT_SETTINGS.auto_process_enabled
      };
    }

    // Helper: download image as buffer
    async function downloadImage(src) {
      const result = await ctx.http.call(src, { method: 'GET' });
      // ctx.http.call returns parsed JSON or raw — for images we need buffer
      // Use a raw fetch approach
      return result;
    }

    // Helper: process a single image
    async function processImage(productId, image, settings) {
      const imageId = image.id;
      const src = image.src;

      let originalWidth = null;
      let originalHeight = null;
      let status = 'error';
      let skipReason = null;
      let optimizedSrc = null;
      let errorMessage = null;

      try {
        // Download image
        const response = await ctx.http.call(src, { method: 'GET' });
        
        // response from ctx.http.call — we need the raw buffer
        // ctx.http.call returns parsed JSON for JSON responses, but for images
        // we need to handle binary. The harness may return a Buffer or similar.
        // We'll treat the response as a buffer if it's a Buffer, otherwise try to handle
        let imageBuffer;
        if (Buffer.isBuffer(response)) {
          imageBuffer = response;
        } else if (response && response.data && Buffer.isBuffer(response.data)) {
          imageBuffer = response.data;
        } else {
          // Try to get buffer from response
          imageBuffer = Buffer.from(response);
        }

        // Get image metadata
        const metadata = await sharp(imageBuffer).metadata();
        originalWidth = metadata.width;
        originalHeight = metadata.height;

        const maxDim = settings.max_dimension || 400;

        if (originalWidth <= maxDim && originalHeight <= maxDim) {
          // Qualify for optimization
          if (settings.auto_process_enabled) {
            // Compress and quality-enhance
            let sharpPipeline = sharp(imageBuffer);
            let mimeType;

            if (settings.output_format === 'webp') {
              sharpPipeline = sharpPipeline.webp({ quality: settings.webp_quality });
              mimeType = 'image/webp';
            } else {
              sharpPipeline = sharpPipeline.jpeg({ quality: settings.jpeg_quality });
              mimeType = 'image/jpeg';
            }

            const optimizedBuffer = await sharpPipeline.toBuffer();
            const base64Attachment = optimizedBuffer.toString('base64');

            // PUT the product image with base64 attachment
            const updateResponse = await ctx.shopify.post(
              `/products/${productId}/images/${imageId}.json`,
              {
                image: {
                  id: imageId,
                  attachment: base64Attachment
                }
              }
            );

            optimizedSrc = updateResponse && updateResponse.image ? updateResponse.image.src : null;
            status = 'optimized';
          } else {
            // auto_process_enabled is false — skip
            status = 'skipped';
            skipReason = 'auto_process_enabled is false';
          }
        } else {
          // Dimensions exceed threshold
          status = 'skipped';
          skipReason = `Dimensions ${originalWidth}x${originalHeight} exceed ${maxDim}x${maxDim} threshold`;
        }
      } catch (err) {
        status = 'error';
        errorMessage = err && err.message ? err.message : String(err);
        ctx.logger.error({ productId, imageId, error: errorMessage }, 'Image processing error');
      }

      return {
        imageId,
        src,
        originalWidth,
        originalHeight,
        status,
        skipReason,
        optimizedSrc,
        errorMessage
      };
    }

    // Helper: upsert job record
    async function upsertJob(productId, imageId, data) {
      await ctx.db`
        INSERT INTO image_optimization_jobs (
          tenant_id, product_id, image_id, original_src,
          original_width, original_height, status, skip_reason,
          optimized_src, error_message, processed_at
        )
        VALUES (
          ${ctx.tenantId}, ${productId}, ${imageId}, ${data.original_src},
          ${data.original_width}, ${data.original_height}, ${data.status}, ${data.skip_reason},
          ${data.optimized_src}, ${data.error_message}, NOW()
        )
        ON CONFLICT (tenant_id, image_id)
        DO UPDATE SET
          original_src = EXCLUDED.original_src,
          original_width = EXCLUDED.original_width,
          original_height = EXCLUDED.original_height,
          status = EXCLUDED.status,
          skip_reason = EXCLUDED.skip_reason,
          optimized_src = EXCLUDED.optimized_src,
          error_message = EXCLUDED.error_message,
          processed_at = NOW()
      `;
    }

    // ── ADMIN TRIGGER ────────────────────────────────────────────────────────
    if (ctx.trigger === 'admin') {
      ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

      // GET /settings/get
      if (ctx.adminPath === '/settings/get') {
        const settings = await loadSettings();
        return {
          max_dimension: settings.max_dimension,
          jpeg_quality: settings.jpeg_quality,
          webp_quality: settings.webp_quality,
          output_format: settings.output_format,
          auto_process_enabled: settings.auto_process_enabled
        };
      }

      // POST /settings/save
      if (ctx.adminPath === '/settings/save') {
        const { max_dimension, jpeg_quality, webp_quality, output_format, auto_process_enabled } = ctx.adminBody;
        ctx.logger.info({ max_dimension, output_format, auto_process_enabled }, 'Saving image optimization settings');

        await ctx.db`
          INSERT INTO image_optimization_settings (
            tenant_id, max_dimension, jpeg_quality, webp_quality, output_format, auto_process_enabled, updated_at
          )
          VALUES (
            ${ctx.tenantId}, ${max_dimension}, ${jpeg_quality}, ${webp_quality}, ${output_format}, ${auto_process_enabled}, NOW()
          )
          ON CONFLICT (tenant_id)
          DO UPDATE SET
            max_dimension = EXCLUDED.max_dimension,
            jpeg_quality = EXCLUDED.jpeg_quality,
            webp_quality = EXCLUDED.webp_quality,
            output_format = EXCLUDED.output_format,
            auto_process_enabled = EXCLUDED.auto_process_enabled,
            updated_at = NOW()
        `;

        return { success: true };
      }

      // GET /jobs/list
      if (ctx.adminPath === '/jobs/list') {
        const { page = 1, page_size = 20, status, product_id } = ctx.adminBody;
        const offset = (page - 1) * page_size;

        let items, countRows;

        if (status && product_id) {
          items = await ctx.db`
            SELECT id, product_id, image_id, original_src, original_width, original_height,
                   status, skip_reason, optimized_src, error_message, processed_at, created_at
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND status = ${status}
              AND product_id = ${product_id}
            ORDER BY created_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
          countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND status = ${status}
              AND product_id = ${product_id}
          `;
        } else if (status) {
          items = await ctx.db`
            SELECT id, product_id, image_id, original_src, original_width, original_height,
                   status, skip_reason, optimized_src, error_message, processed_at, created_at
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND status = ${status}
            ORDER BY created_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
          countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND status = ${status}
          `;
        } else if (product_id) {
          items = await ctx.db`
            SELECT id, product_id, image_id, original_src, original_width, original_height,
                   status, skip_reason, optimized_src, error_message, processed_at, created_at
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND product_id = ${product_id}
            ORDER BY created_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
          countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
              AND product_id = ${product_id}
          `;
        } else {
          items = await ctx.db`
            SELECT id, product_id, image_id, original_src, original_width, original_height,
                   status, skip_reason, optimized_src, error_message, processed_at, created_at
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY created_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;
          countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM image_optimization_jobs
            WHERE tenant_id = ${ctx.tenantId}
          `;
        }

        const total = parseInt(countRows[0].total, 10);

        return {
          items: items.map(r => ({
            id: String(r.id),
            product_id: Number(r.product_id),
            image_id: Number(r.image_id),
            original_src: r.original_src || '',
            original_width: r.original_width != null ? Number(r.original_width) : null,
            original_height: r.original_height != null ? Number(r.original_height) : null,
            status: r.status || '',
            skip_reason: r.skip_reason || '',
            optimized_src: r.optimized_src || '',
            error_message: r.error_message || '',
            processed_at: r.processed_at ? r.processed_at.toISOString() : '',
            created_at: r.created_at ? r.created_at.toISOString() : ''
          })),
          total,
          page: Number(page),
          page_size: Number(page_size)
        };
      }

      // POST /jobs/retry
      if (ctx.adminPath === '/jobs/retry') {
        const { job_id } = ctx.adminBody;
        ctx.logger.info({ job_id }, 'Retrying image optimization job');

        const jobRows = await ctx.db`
          SELECT * FROM image_optimization_jobs
          WHERE tenant_id = ${ctx.tenantId} AND id = ${job_id}
          LIMIT 1
        `;

        if (jobRows.length === 0) {
          return { success: false, status: 'error', optimized_src: '', error_message: 'Job not found' };
        }

        const job = jobRows[0];
        const settings = await loadSettings();

        const result = await processImage(job.product_id, { id: job.image_id, src: job.original_src }, settings);

        await upsertJob(job.product_id, job.image_id, {
          original_src: result.src,
          original_width: result.originalWidth,
          original_height: result.originalHeight,
          status: result.status,
          skip_reason: result.skipReason,
          optimized_src: result.optimizedSrc,
          error_message: result.errorMessage
        });

        return {
          success: result.status !== 'error',
          status: result.status,
          optimized_src: result.optimizedSrc || '',
          error_message: result.errorMessage || ''
        };
      }

      // POST /products/scan
      if (ctx.adminPath === '/products/scan') {
        const { product_id } = ctx.adminBody;
        ctx.logger.info({ product_id }, 'Scanning product images');

        let imagesFound = 0;
        let imagesQueued = 0;

        try {
          const productData = await ctx.shopify.get(`/products/${product_id}.json?fields=id,images`);
          const images = (productData && productData.product && productData.product.images) ? productData.product.images : [];
          imagesFound = images.length;

          // Queue all images by upserting pending jobs
          for (const image of images) {
            await ctx.db`
              INSERT INTO image_optimization_jobs (
                tenant_id, product_id, image_id, original_src, status, processed_at
              )
              VALUES (
                ${ctx.tenantId}, ${product_id}, ${image.id}, ${image.src}, 'pending', NULL
              )
              ON CONFLICT (tenant_id, image_id)
              DO UPDATE SET
                status = 'pending',
                original_src = EXCLUDED.original_src,
                error_message = NULL,
                processed_at = NULL
            `;
            imagesQueued++;
          }
        } catch (err) {
          ctx.logger.error({ product_id, error: err.message }, 'Error scanning product');
          return { success: false, images_found: 0, images_queued: 0 };
        }

        return { success: true, images_found: imagesFound, images_queued: imagesQueued };
      }

      // GET /stats/summary
      if (ctx.adminPath === '/stats/summary') {
        const rows = await ctx.db`
          SELECT
            COUNT(*) FILTER (WHERE status = 'optimized') AS total_optimized,
            COUNT(*) FILTER (WHERE status = 'skipped') AS total_skipped,
            COUNT(*) FILTER (WHERE status = 'error') AS total_errors,
            COUNT(*) FILTER (WHERE status = 'pending') AS total_pending
          FROM image_optimization_jobs
          WHERE tenant_id = ${ctx.tenantId}
        `;

        const summary = rows[0];
        return {
          total_optimized: parseInt(summary.total_optimized, 10) || 0,
          total_skipped: parseInt(summary.total_skipped, 10) || 0,
          total_errors: parseInt(summary.total_errors, 10) || 0,
          total_pending: parseInt(summary.total_pending, 10) || 0
        };
      }

      ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
      return { error: 'unknown path' };
    }

    // ── WEBHOOK TRIGGER ──────────────────────────────────────────────────────
    try {
      const { id: productId, images } = ctx.payload;
      ctx.logger.info({ trigger: ctx.trigger, productId }, 'Processing product webhook');

      if (!images || images.length === 0) {
        ctx.logger.info({ productId }, 'No images found in payload — skipping');
        return;
      }

      const settings = await loadSettings();

      // Note: Per platform limitation, per-item write calls inside the loop are
      // unavoidable for image replacement. We process each image sequentially.
      for (const image of images) {
        const imageId = image.id;
        const src = image.src;

        let originalWidth = null;
        let originalHeight = null;
        let status = 'error';
        let skipReason = null;
        let optimizedSrc = null;
        let errorMessage = null;

        try {
          // Download image binary
          const imageResponse = await ctx.http.call(src, { method: 'GET' });

          let imageBuffer;
          if (Buffer.isBuffer(imageResponse)) {
            imageBuffer = imageResponse;
          } else if (imageResponse && Buffer.isBuffer(imageResponse.data)) {
            imageBuffer = imageResponse.data;
          } else {
            imageBuffer = Buffer.from(imageResponse);
          }

          // Get metadata
          const metadata = await sharp(imageBuffer).metadata();
          originalWidth = metadata.width;
          originalHeight = metadata.height;

          const maxDim = settings.max_dimension || 400;

          if (originalWidth <= maxDim && originalHeight <= maxDim) {
            if (settings.auto_process_enabled) {
              // Optimize the image
              let sharpPipeline = sharp(imageBuffer);

              if (settings.output_format === 'webp') {
                sharpPipeline = sharpPipeline.webp({ quality: settings.webp_quality });
              } else {
                sharpPipeline = sharpPipeline.jpeg({ quality: settings.jpeg_quality });
              }

              const optimizedBuffer = await sharpPipeline.toBuffer();
              const base64Attachment = optimizedBuffer.toString('base64');

              // PUT the product image with base64 attachment
              const updateResponse = await ctx.shopify.post(
                `/products/${productId}/images/${imageId}.json`,
                {
                  image: {
                    id: imageId,
                    attachment: base64Attachment
                  }
                }
              );

              optimizedSrc = updateResponse && updateResponse.image ? updateResponse.image.src : null;
              status = 'optimized';
              ctx.logger.info({ productId, imageId, optimizedSrc }, 'Image optimized');
            } else {
              status = 'skipped';
              skipReason = 'auto_process_enabled is false';
              ctx.logger.info({ productId, imageId }, 'Skipping — auto_process_enabled is false');
            }
          } else {
            status = 'skipped';
            skipReason = `Dimensions ${originalWidth}x${originalHeight} exceed ${maxDim}x${maxDim} threshold`;
            ctx.logger.info({ productId, imageId, originalWidth, originalHeight }, 'Skipping — dimensions exceed threshold');
          }
        } catch (err) {
          status = 'error';
          errorMessage = err && err.message ? err.message : String(err);
          ctx.logger.error({ productId, imageId, error: errorMessage }, 'Error processing image');
        }

        // Upsert job record
        await ctx.db`
          INSERT INTO image_optimization_jobs (
            tenant_id, product_id, image_id, original_src,
            original_width, original_height, status, skip_reason,
            optimized_src, error_message, processed_at
          )
          VALUES (
            ${ctx.tenantId}, ${productId}, ${imageId}, ${src},
            ${originalWidth}, ${originalHeight}, ${status}, ${skipReason},
            ${optimizedSrc}, ${errorMessage}, NOW()
          )
          ON CONFLICT (tenant_id, image_id)
          DO UPDATE SET
            product_id = EXCLUDED.product_id,
            original_src = EXCLUDED.original_src,
            original_width = EXCLUDED.original_width,
            original_height = EXCLUDED.original_height,
            status = EXCLUDED.status,
            skip_reason = EXCLUDED.skip_reason,
            optimized_src = EXCLUDED.optimized_src,
            error_message = EXCLUDED.error_message,
            processed_at = NOW()
        `;

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
      }

      ctx.logger.info({ productId, imageCount: images.length }, 'Finished processing product images');
    } catch (err) {
      ctx.logger.error({ error: err && err.message ? err.message : String(err) }, 'Unhandled error in webhook handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE image_optimization_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  product_id BIGINT NOT NULL,
  image_id BIGINT NOT NULL,
  original_src TEXT NOT NULL,
  original_width INTEGER NULL,
  original_height INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT NULL,
  optimized_src TEXT NULL,
  error_message TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, image_id)
);

ALTER TABLE image_optimization_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY image_optimization_jobs_tenant_isolation ON image_optimization_jobs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX image_optimization_jobs_tenant_id_idx ON image_optimization_jobs (tenant_id);
CREATE INDEX image_optimization_jobs_tenant_product_idx ON image_optimization_jobs (tenant_id, product_id);
CREATE INDEX image_optimization_jobs_tenant_status_idx ON image_optimization_jobs (tenant_id, status);

CREATE TABLE image_optimization_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  max_dimension INTEGER NOT NULL DEFAULT 400,
  jpeg_quality INTEGER NOT NULL DEFAULT 85,
  webp_quality INTEGER NOT NULL DEFAULT 82,
  output_format TEXT NOT NULL DEFAULT 'jpeg',
  auto_process_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

ALTER TABLE image_optimization_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY image_optimization_settings_tenant_isolation ON image_optimization_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX image_optimization_settings_tenant_id_idx ON image_optimization_settings (tenant_id);
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // Build the full HTML skeleton first
  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Image Optimizer</span>
        <div style="display:flex;gap:var(--p-space-200);align-items:center;">
          <button class="btn-secondary" id="btn-refresh">↻ Refresh</button>
          <button class="btn-primary" id="btn-scan-all">Scan &amp; Optimize All</button>
        </div>
      </div>

      <div id="error-banner" class="shell-error-banner" style="display:none;"></div>

      <!-- Stats Row -->
      <div class="shell-stats-row" id="stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Optimized</div>
          <div class="shell-stat-value" id="stat-optimized">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Pending</div>
          <div class="shell-stat-value" id="stat-pending">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Skipped</div>
          <div class="shell-stat-value" id="stat-skipped">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Errors</div>
          <div class="shell-stat-value" id="stat-errors">—</div>
        </div>
      </div>

      <!-- Two-column layout: Jobs + Settings -->
      <div id="main-layout" style="display:flex;gap:var(--p-space-400);align-items:flex-start;flex-wrap:wrap;">

        <!-- Jobs Section -->
        <div style="flex:2;min-width:320px;">
          <div class="shell-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--p-space-400);">
              <span class="shell-section-title">Optimization Jobs</span>
              <div style="display:flex;gap:var(--p-space-200);align-items:center;">
                <select id="filter-status" style="border:1px solid var(--p-color-border);border-radius:var(--p-border-radius-100);padding:var(--p-space-100) var(--p-space-200);font-size:var(--p-font-size-350);background:var(--p-color-bg-surface);color:var(--p-color-text);">
                  <option value="">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="skipped">Skipped</option>
                </select>
                <input id="filter-product" class="shell-search" placeholder="Product ID…" type="number" style="width:120px;" />
              </div>
            </div>

            <div id="jobs-loading" class="shell-loading" style="display:none;">
              <div class="shell-spinner"></div>
            </div>

            <div id="jobs-empty" class="shell-empty" style="display:none;">No jobs found.</div>

            <div class="shell-table-wrap" id="jobs-table-wrap" style="display:none;">
              <table class="shell-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Original</th>
                    <th>Dimensions</th>
                    <th>Status</th>
                    <th>Processed</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="jobs-tbody"></tbody>
              </table>
            </div>

            <div class="shell-pagination" id="jobs-pagination" style="display:none;">
              <span id="jobs-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
              <div class="shell-pagination-btns">
                <button class="btn-secondary" id="btn-prev" disabled>← Prev</button>
                <button class="btn-secondary" id="btn-next" disabled>Next →</button>
              </div>
            </div>
          </div>

          <!-- Scan Single Product -->
          <div class="shell-card" style="margin-top:var(--p-space-400);">
            <span class="shell-section-title">Scan Single Product</span>
            <p style="font-size:var(--p-font-size-350);color:var(--p-color-text-secondary);margin:var(--p-space-200) 0 var(--p-space-300) 0;">
              Enter a Shopify product ID to scan and queue its images for optimization.
            </p>
            <div style="display:flex;gap:var(--p-space-200);align-items:flex-end;">
              <div style="flex:1;">
                <label style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);display:block;margin-bottom:var(--p-space-100);">Product ID</label>
                <input id="scan-product-id" type="number" class="shell-search" placeholder="e.g. 7891234567890" style="width:100%;" />
              </div>
              <button class="btn-primary" id="btn-scan-single">Scan Product</button>
            </div>
            <div id="scan-result" style="margin-top:var(--p-space-300);display:none;"></div>
          </div>
        </div>

        <!-- Settings Section -->
        <div style="flex:1;min-width:260px;">
          <div class="shell-card">
            <span class="shell-section-title">Settings</span>
            <div id="settings-loading" class="shell-loading" style="display:none;">
              <div class="shell-spinner"></div>
            </div>
            <div id="settings-form" style="display:none;">
              <div style="margin-top:var(--p-space-400);">
                <label class="settings-label">Max Dimension (px)
                  <span class="settings-hint">Images ≤ this size are optimized</span>
                </label>
                <input id="s-max-dimension" type="number" min="1" max="10000" class="settings-input" />
              </div>
              <div style="margin-top:var(--p-space-300);">
                <label class="settings-label">Output Format
                  <span class="settings-hint">jpeg, webp, or original</span>
                </label>
                <select id="s-output-format" class="settings-input">
                  <option value="jpeg">JPEG</option>
                  <option value="webp">WebP</option>
                  <option value="original">Original</option>
                </select>
              </div>
              <div style="margin-top:var(--p-space-300);">
                <label class="settings-label">JPEG Quality (1–100)
                  <span class="settings-hint">Higher = larger file</span>
                </label>
                <input id="s-jpeg-quality" type="number" min="1" max="100" class="settings-input" />
              </div>
              <div style="margin-top:var(--p-space-300);">
                <label class="settings-label">WebP Quality (1–100)
                  <span class="settings-hint">Higher = larger file</span>
                </label>
                <input id="s-webp-quality" type="number" min="1" max="100" class="settings-input" />
              </div>
              <div style="margin-top:var(--p-space-300);">
                <label style="display:flex;align-items:center;gap:var(--p-space-200);cursor:pointer;font-size:var(--p-font-size-350);color:var(--p-color-text);">
                  <input id="s-auto-process" type="checkbox" style="width:16px;height:16px;cursor:pointer;" />
                  Auto-process new products
                </label>
                <div style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);margin-top:var(--p-space-100);margin-left:var(--p-space-500);">Automatically queue images when products are created/updated</div>
              </div>

              <div style="margin-top:var(--p-space-500);">
                <button class="btn-primary" id="btn-save-settings" style="width:100%;">Save Settings</button>
              </div>
            </div>
          </div>

          <!-- Backend Notes -->
          <div class="shell-card" style="margin-top:var(--p-space-400);">
            <span class="shell-section-title">How It Works</span>
            <div style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);line-height:1.6;margin-top:var(--p-space-300);">
              <div style="margin-bottom:var(--p-space-200);">
                <span style="font-weight:var(--p-font-weight-semibold);color:var(--p-color-text);">Dimension detection:</span>
                Each image is downloaded and inspected with Sharp to check if it meets the ≤400×400 threshold before processing.
              </div>
              <div style="margin-bottom:var(--p-space-200);">
                <span style="font-weight:var(--p-font-weight-semibold);color:var(--p-color-text);">Per-image writes:</span>
                Shopify requires an individual API call per image — no batch writes available.
              </div>
              <div>
                <span style="font-weight:var(--p-font-weight-semibold);color:var(--p-color-text);">Image replacement:</span>
                Shopify images are replaced via base64 attachment PUT, preserving the image record ID.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Append scoped styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .settings-label {
      display: block;
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
      margin-bottom: var(--p-space-100);
    }
    .settings-hint {
      display: block;
      font-size: var(--p-font-size-300);
      font-weight: 400;
      color: var(--p-color-text-secondary);
    }
    .settings-input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-200) var(--p-space-300);
      font-size: var(--p-font-size-350);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
    }
    .settings-input:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
    }
    .job-img-thumb {
      width: 40px;
      height: 40px;
      object-fit: cover;
      border-radius: var(--p-border-radius-100);
      border: 1px solid var(--p-color-border);
      vertical-align: middle;
    }
    .optimized-link {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-success);
      text-decoration: none;
      display: block;
    }
    .optimized-link:hover { text-decoration: underline; }
    .error-msg {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-critical);
    }
    #scan-result .result-card {
      padding: var(--p-space-300);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
    }
    .result-card.success {
      background: var(--p-color-bg-fill-success);
      color: var(--p-color-text-success);
    }
    .result-card.error {
      background: var(--p-color-bg-fill-critical);
      color: var(--p-color-text-critical);
    }
  `;
  container.appendChild(styleEl);

  // State
  let currentPage = 1;
  const pageSize = 20;
  let totalJobs = 0;
  let filterStatus = '';
  let filterProductId = null;
  let jobsDebounceTimer = null;

  // DOM refs
  const errorBanner = container.querySelector('#error-banner');
  const statOptimized = container.querySelector('#stat-optimized');
  const statPending = container.querySelector('#stat-pending');
  const statSkipped = container.querySelector('#stat-skipped');
  const statErrors = container.querySelector('#stat-errors');

  const jobsLoading = container.querySelector('#jobs-loading');
  const jobsEmpty = container.querySelector('#jobs-empty');
  const jobsTableWrap = container.querySelector('#jobs-table-wrap');
  const jobsTbody = container.querySelector('#jobs-tbody');
  const jobsPagination = container.querySelector('#jobs-pagination');
  const jobsPageInfo = container.querySelector('#jobs-page-info');
  const btnPrev = container.querySelector('#btn-prev');
  const btnNext = container.querySelector('#btn-next');

  const filterStatusEl = container.querySelector('#filter-status');
  const filterProductEl = container.querySelector('#filter-product');

  const settingsLoading = container.querySelector('#settings-loading');
  const settingsForm = container.querySelector('#settings-form');

  const btnRefresh = container.querySelector('#btn-refresh');
  const btnScanAll = container.querySelector('#btn-scan-all');
  const btnScanSingle = container.querySelector('#btn-scan-single');
  const btnSaveSettings = container.querySelector('#btn-save-settings');
  const scanProductIdEl = container.querySelector('#scan-product-id');
  const scanResult = container.querySelector('#scan-result');

  // Helpers
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = '';
  }

  function hideError() {
    errorBanner.style.display = 'none';
  }

  function statusBadge(status) {
    const map = {
      completed: 'badge-success',
      failed: 'badge-error',
      pending: 'badge-neutral',
      processing: 'badge-warning',
      skipped: 'badge-warning',
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

  function truncateSrc(src) {
    if (!src) return '—';
    try {
      const url = new URL(src);
      const parts = url.pathname.split('/');
      const filename = parts[parts.length - 1];
      return filename.length > 28 ? filename.slice(0, 25) + '…' : filename;
    } catch (e) {
      return src.length > 30 ? src.slice(0, 27) + '…' : src;
    }
  }

  // Load stats
  async function loadStats() {
    try {
      const data = await bridge.call('/stats/summary', {});
      statOptimized.textContent = data.total_optimized ?? 0;
      statPending.textContent = data.total_pending ?? 0;
      statSkipped.textContent = data.total_skipped ?? 0;
      statErrors.textContent = data.total_errors ?? 0;
    } catch (e) {
      statOptimized.textContent = '—';
      statPending.textContent = '—';
      statSkipped.textContent = '—';
      statErrors.textContent = '—';
    }
  }

  // Load jobs
  async function loadJobs(page) {
    currentPage = page;
    jobsLoading.style.display = '';
    jobsEmpty.style.display = 'none';
    jobsTableWrap.style.display = 'none';
    jobsPagination.style.display = 'none';
    hideError();

    const body = {
      page: currentPage,
      page_size: pageSize,
      status: filterStatus,
      product_id: filterProductId ? Number(filterProductId) : 0,
    };

    try {
      const data = await bridge.call('/jobs/list', body);
      jobsLoading.style.display = 'none';
      totalJobs = data.total || 0;
      const items = data.items || [];

      if (items.length === 0) {
        jobsEmpty.style.display = '';
        return;
      }

      // Render rows
      jobsTbody.innerHTML = '';
      items.forEach(job => {
        const tr = document.createElement('tr');

        // Product / image
        const tdProduct = document.createElement('td');
        const imgEl = document.createElement('img');
        imgEl.className = 'job-img-thumb';
        imgEl.src = job.original_src || '';
        imgEl.alt = '';
        imgEl.title = job.original_src || '';
        imgEl.onerror = function() { this.style.display = 'none'; };
        const productLabel = document.createElement('div');
        productLabel.style.fontSize = 'var(--p-font-size-300)';
        productLabel.style.color = 'var(--p-color-text-secondary)';
        productLabel.style.marginTop = 'var(--p-space-100)';
        productLabel.textContent = `P: ${job.product_id || '—'}`;
        const imgWrap = document.createElement('div');
        imgWrap.style.display = 'flex';
        imgWrap.style.flexDirection = 'column';
        imgWrap.style.alignItems = 'center';
        imgWrap.style.gap = 'var(--p-space-100)';
        imgWrap.appendChild(imgEl);
        imgWrap.appendChild(productLabel);
        tdProduct.appendChild(imgWrap);
        tr.appendChild(tdProduct);

        // Original src
        const tdSrc = document.createElement('td');
        if (job.original_src) {
          const a = document.createElement('a');
          a.href = job.original_src;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.style.fontSize = 'var(--p-font-size-300)';
          a.style.color = 'var(--p-color-text)';
          a.style.textDecoration = 'none';
          a.textContent = truncateSrc(job.original_src);
          a.title = job.original_src;
          tdSrc.appendChild(a);
        } else {
          tdSrc.textContent = '—';
        }
        tr.appendChild(tdSrc);

        // Dimensions
        const tdDim = document.createElement('td');
        tdDim.style.fontSize = 'var(--p-font-size-300)';
        tdDim.style.whiteSpace = 'nowrap';
        if (job.original_width && job.original_height) {
          tdDim.textContent = `${job.original_width} × ${job.original_height}`;
        } else {
          tdDim.textContent = '—';
        }
        tr.appendChild(tdDim);

        // Status
        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = statusBadge(job.status);
        if (job.skip_reason) {
          const hint = document.createElement('div');
          hint.style.fontSize = 'var(--p-font-size-300)';
          hint.style.color = 'var(--p-color-text-secondary)';
          hint.style.marginTop = 'var(--p-space-100)';
          hint.textContent = job.skip_reason;
          tdStatus.appendChild(hint);
        }
        if (job.error_message) {
          const err = document.createElement('div');
          err.className = 'error-msg';
          err.style.marginTop = 'var(--p-space-100)';
          err.textContent = job.error_message;
          err.title = job.error_message;
          tdStatus.appendChild(err);
        }
        if (job.optimized_src && job.status === 'completed') {
          const aOpt = document.createElement('a');
          aOpt.className = 'optimized-link';
          aOpt.href = job.optimized_src;
          aOpt.target = '_blank';
          aOpt.rel = 'noopener noreferrer';
          aOpt.textContent = '↗ View optimized';
          aOpt.style.marginTop = 'var(--p-space-100)';
          tdStatus.appendChild(aOpt);
        }
        tr.appendChild(tdStatus);

        // Processed at
        const tdDate = document.createElement('td');
        tdDate.style.fontSize = 'var(--p-font-size-300)';
        tdDate.style.whiteSpace = 'nowrap';
        tdDate.textContent = formatDate(job.processed_at || job.created_at);
        tr.appendChild(tdDate);

        // Action
        const tdAction = document.createElement('td');
        if (job.status === 'failed') {
          const retryBtn = document.createElement('button');
          retryBtn.className = 'btn-secondary';
          retryBtn.textContent = 'Retry';
          retryBtn.style.fontSize = 'var(--p-font-size-300)';
          retryBtn.style.padding = 'var(--p-space-100) var(--p-space-200)';
          retryBtn.addEventListener('click', async () => {
            retryBtn.disabled = true;
            retryBtn.textContent = '…';
            try {
              const res = await bridge.call('/jobs/retry', { job_id: job.id });
              if (res.success) {
                bridge.notify('Job retried successfully', 'success');
                loadJobs(currentPage);
                loadStats();
              } else {
                bridge.notify(res.error_message || 'Retry failed', 'error');
                retryBtn.disabled = false;
                retryBtn.textContent = 'Retry';
              }
            } catch (e) {
              bridge.notify('Retry request failed', 'error');
              retryBtn.disabled = false;
              retryBtn.textContent = 'Retry';
            }
          });
          tdAction.appendChild(retryBtn);
        } else {
          tdAction.textContent = '—';
          tdAction.style.color = 'var(--p-color-text-secondary)';
          tdAction.style.fontSize = 'var(--p-font-size-300)';
        }
        tr.appendChild(tdAction);

        jobsTbody.appendChild(tr);
      });

      jobsTableWrap.style.display = '';

      // Pagination
      const totalPages = Math.ceil(totalJobs / pageSize);
      if (totalPages > 1) {
        jobsPagination.style.display = '';
        jobsPageInfo.textContent = `Page ${currentPage} of ${totalPages} (${totalJobs} total)`;
        btnPrev.disabled = currentPage <= 1;
        btnNext.disabled = currentPage >= totalPages;
      }

    } catch (e) {
      jobsLoading.style.display = 'none';
      showError('Failed to load jobs. Please try again.');
    }
  }

  // Load settings
  async function loadSettings() {
    settingsLoading.style.display = '';
    settingsForm.style.display = 'none';
    try {
      const data = await bridge.call('/settings/get', {});
      settingsLoading.style.display = 'none';
      settingsForm.style.display = '';
      container.querySelector('#s-max-dimension').value = data.max_dimension ?? 400;
      container.querySelector('#s-jpeg-quality').value = data.jpeg_quality ?? 80;
      container.querySelector('#s-webp-quality').value = data.webp_quality ?? 80;
      const fmtEl = container.querySelector('#s-output-format');
      fmtEl.value = data.output_format || 'jpeg';
      container.querySelector('#s-auto-process').checked = !!data.auto_process_enabled;
    } catch (e) {
      settingsLoading.style.display = 'none';
      settingsForm.style.display = '';
      bridge.notify('Could not load settings', 'error');
    }
  }

  // Save settings
  async function saveSettings() {
    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = 'Saving…';
    const payload = {
      max_dimension: Number(container.querySelector('#s-max-dimension').value),
      jpeg_quality: Number(container.querySelector('#s-jpeg-quality').value),
      webp_quality: Number(container.querySelector('#s-webp-quality').value),
      output_format: container.querySelector('#s-output-format').value,
      auto_process_enabled: container.querySelector('#s-auto-process').checked,
    };
    try {
      const res = await bridge.call('/settings/save', payload);
      if (res.success) {
        bridge.notify('Settings saved successfully', 'success');
      } else {
        bridge.notify('Failed to save settings', 'error');
      }
    } catch (e) {
      bridge.notify('Save request failed', 'error');
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = 'Save Settings';
    }
  }

  // Scan all products
  async function scanAll() {
    btnScanAll.disabled = true;
    btnScanAll.textContent = 'Scanning…';
    try {
      // Scan with no product_id to trigger global scan (product_id: 0 = all)
      const res = await bridge.call('/products/scan', { product_id: 0 });
      if (res.success) {
        bridge.notify(`Scan complete — ${res.images_found} images found, ${res.images_queued} queued`, 'success');
        loadJobs(1);
        loadStats();
      } else {
        bridge.notify('Scan failed or returned no results', 'error');
      }
    } catch (e) {
      bridge.notify('Scan request failed', 'error');
    } finally {
      btnScanAll.disabled = false;
      btnScanAll.textContent = 'Scan & Optimize All';
    }
  }

  // Scan single product
  async function scanSingle() {
    const pid = Number(scanProductIdEl.value);
    if (!pid || isNaN(pid) || pid <= 0) {
      bridge.notify('Please enter a valid product ID', 'error');
      return;
    }
    btnScanSingle.disabled = true;
    btnScanSingle.textContent = 'Scanning…';
    scanResult.style.display = 'none';
    try {
      const res = await bridge.call('/products/scan', { product_id: pid });
      scanResult.style.display = '';
      const card = document.createElement('div');
      card.className = 'result-card ' + (res.success ? 'success' : 'error');
      if (res.success) {
        card.textContent = `✓ Found ${res.images_found} image(s), queued ${res.images_queued} for optimization.`;
      } else {
        card.textContent = '✗ Scan failed. Check the product ID and try again.';
      }
      scanResult.innerHTML = '';
      scanResult.appendChild(card);
      if (res.success) {
        loadJobs(1);
        loadStats();
      }
    } catch (e) {
      scanResult.style.display = '';
      const card = document.createElement('div');
      card.className = 'result-card error';
      card.textContent = '✗ Scan request failed.';
      scanResult.innerHTML = '';
      scanResult.appendChild(card);
    } finally {
      btnScanSingle.disabled = false;
      btnScanSingle.textContent = 'Scan Product';
    }
  }

  // Event listeners
  btnRefresh.addEventListener('click', () => {
    loadStats();
    loadJobs(currentPage);
  });

  btnScanAll.addEventListener('click', scanAll);
  btnScanSingle.addEventListener('click', scanSingle);
  btnSaveSettings.addEventListener('click', saveSettings);

  btnPrev.addEventListener('click', () => {
    if (currentPage > 1) loadJobs(currentPage - 1);
  });

  btnNext.addEventListener('click', () => {
    const totalPages = Math.ceil(totalJobs / pageSize);
    if (currentPage < totalPages) loadJobs(currentPage + 1);
  });

  filterStatusEl.addEventListener('change', () => {
    filterStatus = filterStatusEl.value;
    loadJobs(1);
  });

  filterProductEl.addEventListener('input', () => {
    if (jobsDebounceTimer) clearTimeout(jobsDebounceTimer);
    jobsDebounceTimer = setTimeout(() => {
      const v = filterProductEl.value.trim();
      filterProductId = v ? Number(v) : null;
      loadJobs(1);
    }, 400);
  });

  // Initial load
  loadStats();
  loadJobs(1);
  loadSettings();
}
```


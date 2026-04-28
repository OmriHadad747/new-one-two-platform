import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import sharp from "sharp";

type JobFn = (payload: unknown) => Promise<void>;

interface JobPayload {
  runId?: string;
  trigger?: string;
}

interface BulkProductNode {
  id: string;
  title: string;
  __typename?: string;
}

interface BulkMediaNode {
  id: string;
  __parentId: string;
  __typename?: string;
  image?: {
    url: string;
    width: number | null;
    height: number | null;
  };
}

interface ImageEntry {
  productGid: string;
  productNumericId: number;
  productTitle: string;
  mediaGid: string;
  url: string;
  width: number | null;
  height: number | null;
}

async function runOptimization(runId: string, trigger: string): Promise<void> {
  const jobName = "main";
  console.log({ jobName, runId, trigger }, "optimization run started");

  const shopify = await shopifyClientFor();

  // Bulk-fetch all products with their media image nodes
  const productMap = new Map<string, { title: string }>();
  const imageEntries: ImageEntry[] = [];
  const seenUrls = new Set<string>();

  try {
    for await (const item of shopify.bulkQuery(`
      {
        products {
          edges {
            node {
              id
              title
              media(first: 250) {
                edges {
                  node {
                    __typename
                    id
                    ... on MediaImage {
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
      }
    `)) {
      const raw = item as Record<string, unknown>;

      // Bulk query returns parent product rows and child media rows separately
      // Parent product rows have `id` and `title` but no `__parentId`
      const parentId = raw.__parentId as string | undefined;

      if (!parentId) {
        // This is a product node
        const gid = raw.id as string | undefined;
        const title = raw.title as string | undefined;
        if (gid && title !== undefined) {
          productMap.set(gid, { title: title ?? "" });
        }
      } else {
        // This is a media node
        const typename = raw.__typename as string | undefined;
        if (typename !== "MediaImage") continue;

        const mediaGid = raw.id as string | undefined;
        if (!mediaGid) continue;

        const image = raw.image as { url: string; width: number | null; height: number | null } | undefined;
        if (!image?.url) continue;

        // Deduplicate by source URL
        if (seenUrls.has(image.url)) continue;
        seenUrls.add(image.url);

        const product = productMap.get(parentId);
        if (!product) continue;

        // Extract numeric product ID from GID
        const parts = parentId.split("/");
        const numericPart = parts[parts.length - 1];
        const numericId = parseInt(numericPart ?? "0", 10);
        if (!numericId) continue;

        imageEntries.push({
          productGid: parentId,
          productNumericId: numericId,
          productTitle: product.title,
          mediaGid,
          url: image.url,
          width: image.width,
          height: image.height,
        });
      }
    }
  } catch (err) {
    console.error({ jobName, runId }, "bulk query failed");
    await sql`
      UPDATE optimization_runs
      SET status = 'failed', completed_at = NOW(), total_images = 0
      WHERE id = ${runId}::uuid AND status = 'in_progress'
    `;
    throw err;
  }

  const totalImages = imageEntries.length;
  console.log({ jobName, runId, totalImages }, "bulk fetch complete");

  // Update total_images count
  await sql`
    UPDATE optimization_runs SET total_images = ${totalImages} WHERE id = ${runId}::uuid
  `;

  // Insert all run items as pending (idempotent — skip already-inserted)
  if (imageEntries.length > 0) {
    for (const entry of imageEntries) {
      await sql`
        INSERT INTO optimization_run_items
          (run_id, product_id, product_title, image_id, source_url, source_width, source_height, outcome, failure_reason, optimized_url, processed_at)
        VALUES
          (${runId}::uuid, ${entry.productNumericId}, ${entry.productTitle}, ${entry.mediaGid}, ${entry.url}, ${entry.width}, ${entry.height}, 'pending', NULL, NULL, NULL)
        ON CONFLICT (run_id, image_id) DO NOTHING
      `;
    }
  }

  let succeededCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  // Process each image
  for (const entry of imageEntries) {
    // Check if already processed (idempotency on retry)
    const existingItems = await sql<{ outcome: string }[]>`
      SELECT outcome FROM optimization_run_items
      WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid} AND outcome != 'pending'
    `;
    const existing = existingItems[0];
    if (existing) {
      if (existing.outcome === "succeeded") succeededCount++;
      else if (existing.outcome === "skipped") skippedCount++;
      else if (existing.outcome === "failed") failedCount++;
      continue;
    }

    try {
      // Determine actual dimensions — download bytes and use sharp
      // Note: Shopify bulk query may not guarantee width/height on all nodes
      // per the platform limitation, so we always download to get real dimensions
      let imageBuffer: Buffer;
      let mimeType = "image/jpeg";

      try {
        const resp = await fetch(entry.url, { signal: AbortSignal.timeout(15_000) });
        if (!resp.ok) {
          throw new Error(`image download failed: ${resp.status}`);
        }
        const contentType = resp.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) {
          throw new Error(`non-image content-type: ${contentType}`);
        }
        if (contentType.includes("png")) mimeType = "image/png";
        else if (contentType.includes("webp")) mimeType = "image/webp";
        else mimeType = "image/jpeg";

        const arrayBuf = await resp.arrayBuffer();
        imageBuffer = Buffer.from(arrayBuf);
      } catch (downloadErr) {
        const reason = (downloadErr instanceof Error ? downloadErr.message : String(downloadErr)).replace(/\u0000/g, "");
        console.warn({ jobName, runId, imageId: entry.mediaGid }, `download failed: ${reason}`);
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      // Read actual dimensions with sharp
      const metadata = await sharp(imageBuffer).metadata();
      const actualWidth = metadata.width ?? 0;
      const actualHeight = metadata.height ?? 0;

      // Store resolved dimensions
      await sql`
        UPDATE optimization_run_items
        SET source_width = ${actualWidth}, source_height = ${actualHeight}
        WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
      `;

      // Skip if already at or below 400x400
      if (actualWidth <= 400 && actualHeight <= 400) {
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'skipped', processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        skippedCount++;
        console.log({ jobName, runId, imageId: entry.mediaGid, actualWidth, actualHeight }, "image skipped — already small");
        continue;
      }

      // Resize to 400x400 (fit: inside, no upscale via withoutEnlargement)
      const resizedBuffer = await sharp(imageBuffer)
        .resize(400, 400, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const resizedMimeType = "image/jpeg";
      const resizedFilename = `optimized-${entry.productNumericId}-${Date.now()}.jpg`;

      // Step 1: stagedUploadsCreate
      const stagedResult = await shopify.graphql(
        `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors { field message }
          }
        }`,
        {
          input: [
            {
              filename: resizedFilename,
              mimeType: resizedMimeType,
              resource: "IMAGE",
              fileSize: String(resizedBuffer.byteLength),
              httpMethod: "PUT",
            },
          ],
        },
      ) as {
        stagedUploadsCreate: {
          stagedTargets: Array<{
            url: string;
            resourceUrl: string;
            parameters: Array<{ name: string; value: string }>;
          }>;
          userErrors: Array<{ message: string }>;
        };
      };

      if (stagedResult.stagedUploadsCreate.userErrors.length > 0) {
        const reason = stagedResult.stagedUploadsCreate.userErrors.map((e) => e.message).join("; ");
        console.warn({ jobName, runId, imageId: entry.mediaGid }, `stagedUploadsCreate failed: ${reason}`);
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason.replace(/\u0000/g, "")}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      const target = stagedResult.stagedUploadsCreate.stagedTargets[0];
      if (!target) {
        const reason = "no staged target returned";
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      // Step 2: PUT resized buffer to staged URL
      try {
        const putResp = await fetch(target.url, {
          method: "PUT",
          headers: { "Content-Type": resizedMimeType },
          body: resizedBuffer,
          signal: AbortSignal.timeout(30_000),
        });
        if (!putResp.ok) {
          throw new Error(`PUT to staged URL failed: ${putResp.status}`);
        }
      } catch (putErr) {
        const reason = (putErr instanceof Error ? putErr.message : String(putErr)).replace(/\u0000/g, "");
        console.warn({ jobName, runId, imageId: entry.mediaGid }, `staged PUT failed: ${reason}`);
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      // Step 3: fileCreate to register in Shopify
      const fileCreateResult = await shopify.graphql(
        `mutation FileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on MediaImage {
                id
                image { url }
              }
            }
            userErrors { field message }
          }
        }`,
        {
          files: [
            {
              originalSource: target.resourceUrl,
              contentType: "IMAGE",
              filename: resizedFilename,
            },
          ],
        },
      ) as {
        fileCreate: {
          files: Array<{ id?: string; image?: { url: string } }>;
          userErrors: Array<{ message: string }>;
        };
      };

      if (fileCreateResult.fileCreate.userErrors.length > 0) {
        const reason = fileCreateResult.fileCreate.userErrors.map((e) => e.message).join("; ");
        console.warn({ jobName, runId, imageId: entry.mediaGid }, `fileCreate failed: ${reason}`);
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason.replace(/\u0000/g, "")}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      const createdFile = fileCreateResult.fileCreate.files[0];
      const optimizedUrl = createdFile?.image?.url ?? target.resourceUrl;

      // Step 4: productUpdate to attach the new image
      const productUpdateResult = await shopify.graphql(
        `mutation ProductUpdate($product: ProductUpdateInput, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            userErrors { field message }
          }
        }`,
        {
          product: { id: entry.productGid },
          media: [
            {
              originalSource: target.resourceUrl,
              mediaContentType: "IMAGE",
              filename: resizedFilename,
            },
          ],
        },
      ) as {
        productUpdate: {
          userErrors: Array<{ message: string }>;
        };
      };

      if (productUpdateResult.productUpdate.userErrors.length > 0) {
        const reason = productUpdateResult.productUpdate.userErrors.map((e) => e.message).join("; ");
        // Could be product deleted
        console.warn({ jobName, runId, imageId: entry.mediaGid, productGid: entry.productGid }, `productUpdate failed: ${reason}`);
        await sql`
          UPDATE optimization_run_items
          SET outcome = 'failed', failure_reason = ${reason.replace(/\u0000/g, "")}, processed_at = NOW()
          WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
        `;
        failedCount++;
        continue;
      }

      // Mark succeeded
      await sql`
        UPDATE optimization_run_items
        SET outcome = 'succeeded', optimized_url = ${optimizedUrl}, processed_at = NOW()
        WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
      `;
      succeededCount++;
      console.log({ jobName, runId, imageId: entry.mediaGid }, "image optimized");
    } catch (itemErr) {
      const reason = (itemErr instanceof Error ? itemErr.message : String(itemErr)).replace(/\u0000/g, "");
      console.error({ jobName, runId, imageId: entry.mediaGid }, `unexpected error: ${reason}`);
      await sql`
        UPDATE optimization_run_items
        SET outcome = 'failed', failure_reason = ${reason}, processed_at = NOW()
        WHERE run_id = ${runId}::uuid AND image_id = ${entry.mediaGid}
      `;
      failedCount++;
    }
  }

  // Finalize the run
  await sql`
    UPDATE optimization_runs
    SET
      status = 'completed',
      succeeded_count = ${succeededCount},
      skipped_count = ${skippedCount},
      failed_count = ${failedCount},
      completed_at = NOW()
    WHERE id = ${runId}::uuid AND status = 'in_progress'
  `;

  console.log({ jobName, runId, succeededCount, skippedCount, failedCount }, "optimization run completed");
}

export const jobs: Record<string, JobFn> = {
  main: async (payload) => {
    const jobName = "main";
    const p = (payload ?? {}) as JobPayload;

    // If a runId was provided (manual trigger from admin), use it
    if (p.runId) {
      // Verify the run still exists and is in_progress
      const existingRows = await sql<{ id: string; status: string }[]>`
        SELECT id::text AS id, status FROM optimization_runs WHERE id = ${p.runId}::uuid LIMIT 1
      `;
      const existing = existingRows[0];
      if (!existing || existing.status !== "in_progress") {
        console.log({ jobName, runId: p.runId }, "run not found or not in_progress, skipping");
        return;
      }
      await runOptimization(p.runId, p.trigger ?? "manual");
      return;
    }

    // Cron-triggered path: check for existing in_progress run to prevent concurrent execution
    const inProgressRows = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM optimization_runs WHERE status = 'in_progress' LIMIT 1
    `;
    if (inProgressRows.length > 0) {
      console.log({ jobName }, "another run is already in_progress, skipping");
      return;
    }

    // Check if cron is enabled
    const settingsRows = await sql<{ is_enabled: boolean }[]>`
      SELECT is_enabled FROM optimization_settings WHERE singleton = true
    `;
    const settings = settingsRows[0];
    if (settings && !settings.is_enabled) {
      console.log({ jobName }, "optimization is disabled, skipping scheduled run");
      return;
    }

    // Create a new run record
    const insertedRows = await sql<{ id: string }[]>`
      INSERT INTO optimization_runs (trigger, status, total_images, succeeded_count, skipped_count, failed_count, started_at)
      VALUES ('cron', 'in_progress', 0, 0, 0, 0, NOW())
      RETURNING id::text AS id
    `;

    const newRun = insertedRows[0];
    if (!newRun) {
      console.error({ jobName }, "failed to insert optimization_runs row");
      return;
    }

    await runOptimization(newRun.id, "cron");
  },
};
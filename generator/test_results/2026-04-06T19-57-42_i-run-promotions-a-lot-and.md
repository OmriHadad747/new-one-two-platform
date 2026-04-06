# Feature Generator — Run Result

**Date:** 2026-04-06 19:57:42  
**Status:** ✅ SUCCESS  
**Total:** 203348ms  
**Prompt:** I run promotions a lot and I'm always manually creating discount codes one by one in Shopify which is a nightmare. I want something where I can just say "give me 500 codes with 15% off" and it does it for me. Would be great if I could download them as a spreadsheet too to share with my team.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 1299ms     |
| Architect   | ✓      | 26081ms    |
| CodeSpec    | ✓      | 25871ms    |
| Handler     | ✓      | 67717ms    |
| Migration   | ✓      | 67717ms    |
| Admin UI    | ✓      | 67717ms    |
| Validation  | ✓      | 11ms       |
| Explanation | ✓      | 3637ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: [],
  cronSchedule: null,
  npmPackages: ['exceljs@4.4.0', 'uuid@9.0.1'],
  handler: async function(ctx) {
    const { v4: uuidv4 } = require('uuid');
    const ExcelJS = require('exceljs');
    const crypto = require('crypto');

    function generateUniqueCodes(quantity, title) {
      let titleSlug = title.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);
      if (!titleSlug) titleSlug = 'CODE';
      const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const codes = new Set();
      while (codes.size < quantity) {
        let randomSuffix = '';
        const bytes = crypto.randomBytes(8);
        for (let i = 0; i < 8; i++) {
          randomSuffix += CHARSET[bytes[i] % CHARSET.length];
        }
        const candidate = titleSlug + '_' + randomSuffix;
        codes.add(candidate);
      }
      return Array.from(codes);
    }

    async function buildXlsxBase64(title, codes) {
      const filename = title.replace(/[^A-Z0-9_\-]/gi, '_') + '_codes.xlsx';
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Codes');
      ws.columns = [{ header: 'Code', key: 'code', width: 20 }];
      for (const code of codes) {
        ws.addRow({ code });
      }
      const xlsxBuffer = await wb.xlsx.writeBuffer();
      const fileBase64 = Buffer.from(xlsxBuffer).toString('base64');
      return { filename, fileBase64 };
    }

    try {
      ctx.logger.info({ trigger: ctx.trigger, adminPath: ctx.adminPath }, 'Handler invoked');

      if (ctx.trigger !== 'admin') {
        return { error: 'unsupported trigger' };
      }

      if (ctx.adminPath === '/generate') {
        const { title, percentage, quantity, startsAt, endsAt } = ctx.adminBody || {};

        if (typeof percentage !== 'number' || percentage < 1 || percentage > 100) {
          return { error: 'invalid parameters: percentage must be between 1 and 100' };
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
          return { error: 'invalid parameters: quantity must be a positive integer (max 10000)' };
        }
        if (!title || typeof title !== 'string' || !title.trim()) {
          return { error: 'invalid parameters: title is required' };
        }

        ctx.logger.info({ title, percentage, quantity }, 'Generating discount codes');

        const codes = generateUniqueCodes(quantity, title);

        // Step 1: Create discount node
        let discountGid;
        try {
          const createResult = await ctx.shopify.graphql(
            `mutation CreateBasicDiscount($input: DiscountCodeBasicInput!) {
              discountCodeBasicCreate(basicCodeDiscount: $input) {
                codeDiscountNode {
                  id
                }
                userErrors {
                  field
                  message
                }
              }
            }`,
            {
              input: {
                title: title,
                code: codes[0],
                customerGets: {
                  value: { percentage: percentage / 100 },
                  items: { all: true }
                },
                appliesOncePerCustomer: false,
                usageLimit: null,
                startsAt: startsAt || null,
                endsAt: endsAt || null
              }
            }
          );

          const { codeDiscountNode, userErrors } = createResult.discountCodeBasicCreate;
          if (userErrors && userErrors.length > 0) {
            ctx.logger.error({ userErrors }, 'discountCodeBasicCreate userErrors');
            return { error: userErrors[0].message };
          }
          discountGid = codeDiscountNode.id;
          ctx.logger.info({ discountGid }, 'Discount node created');
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'Failed to create discount node');
          return { error: 'Failed to create discount: ' + err.message };
        }

        // Step 2: Bulk add codes in chunks of 250
        const codesInput = codes.map(code => ({ code }));
        const CHUNK_SIZE = 250;
        let totalImported = 0;
        let totalFailed = 0;

        for (let i = 0; i < codesInput.length; i += CHUNK_SIZE) {
          const chunk = codesInput.slice(i, i + CHUNK_SIZE);
          try {
            const bulkResult = await ctx.shopify.graphql(
              `mutation BulkAddCodes($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
                discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
                  bulkCreation {
                    id
                    done
                    codesCount
                    importedCount
                    failedCount
                  }
                  userErrors {
                    code
                    field
                    message
                  }
                }
              }`,
              { discountId: discountGid, codes: chunk }
            );

            const { bulkCreation, userErrors: bulkErrors } = bulkResult.discountRedeemCodeBulkAdd;
            if (bulkErrors && bulkErrors.length > 0) {
              ctx.logger.warn({ bulkErrors }, 'discountRedeemCodeBulkAdd userErrors');
              totalFailed += chunk.length;
            } else if (bulkCreation) {
              totalImported += bulkCreation.importedCount || 0;
              totalFailed += bulkCreation.failedCount || 0;
            }
          } catch (err) {
            ctx.logger.error({ err: err.message, chunkStart: i }, 'Bulk add chunk failed');
            totalFailed += chunk.length;
          }

          if (i + CHUNK_SIZE < codesInput.length) {
            await new Promise(r => setTimeout(r, 200));
          }
        }

        ctx.logger.info({ totalImported, totalFailed }, 'Bulk add complete');

        // Step 3: Persist job to DB
        const jobId = uuidv4();
        await ctx.db`
          INSERT INTO discount_jobs (id, tenant_id, discount_gid, title, percentage, quantity, starts_at, ends_at, status, codes, created_at)
          VALUES (
            ${jobId},
            ${ctx.tenantId},
            ${discountGid},
            ${title},
            ${percentage},
            ${quantity},
            ${startsAt || null},
            ${endsAt || null},
            ${'complete'},
            ${JSON.stringify(codes)},
            NOW()
          )
        `;

        ctx.logger.info({ jobId }, 'Job record inserted');

        return { jobId, discountGid, quantity, status: 'complete', importedCount: totalImported, failedCount: totalFailed };

      } else if (ctx.adminPath === '/jobs') {
        const rows = await ctx.db`
          SELECT id AS "jobId", title, percentage, quantity, status, created_at AS "createdAt"
          FROM discount_jobs
          WHERE tenant_id = ${ctx.tenantId}
          ORDER BY created_at DESC
          LIMIT 100
        `;
        return { jobs: rows };

      } else if (ctx.adminPath === '/download') {
        const { jobId } = ctx.adminBody || {};
        if (!jobId) {
          return { error: 'jobId is required' };
        }

        const rows = await ctx.db`
          SELECT codes, title
          FROM discount_jobs
          WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
        `;

        if (!rows || rows.length === 0) {
          return { error: 'job not found' };
        }

        const codes = rows[0].codes;
        const title = rows[0].title;

        const { filename, fileBase64 } = await buildXlsxBase64(title, codes);
        return { filename, fileBase64 };

      } else {
        ctx.logger.warn({ adminPath: ctx.adminPath }, 'Unknown admin path');
        return { error: 'unknown path' };
      }

    } catch (err) {
      ctx.logger.error({ err: err.message }, 'Unhandled error in handler');
      return { error: 'internal error: ' + err.message };
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE IF NOT EXISTS discount_jobs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  discount_gid TEXT NOT NULL,
  title TEXT NOT NULL,
  percentage NUMERIC NOT NULL,
  quantity INT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  codes JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discount_jobs_tenant_created_idx ON discount_jobs (tenant_id, created_at DESC);
```

### admin_ui.js

```javascript
import { useState, useEffect } from 'react';

export default function AdminUI({ bridge }) {
  const [tab, setTab] = useState('generate');
  const [title, setTitle] = useState('');
  const [percentage, setPercentage] = useState('');
  const [quantity, setQuantity] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState(null);
  const [generateError, setGenerateError] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [downloadingJobId, setDownloadingJobId] = useState(null);
  const [downloadError, setDownloadError] = useState(null);

  useEffect(() => {
    if (tab === 'jobs') {
      loadJobs();
    }
  }, [tab]);

  async function loadJobs() {
    setJobsLoading(true);
    try {
      const result = await bridge.call('/jobs');
      setJobs(result.jobs || []);
    } catch (err) {
      setJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }

  async function handleGenerate(e) {
    e.preventDefault();
    setGenerateError(null);
    setGenerateResult(null);
    setGenerating(true);
    try {
      const pct = parseFloat(percentage);
      const qty = parseInt(quantity, 10);
      const result = await bridge.call('/generate', {
        title: title.trim(),
        percentage: pct,
        quantity: qty,
        startsAt: startsAt || null,
        endsAt: endsAt || null
      });
      if (result.error) {
        setGenerateError(result.error);
      } else {
        setGenerateResult(result);
      }
    } catch (err) {
      setGenerateError('Request failed: ' + err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleDownload(jobId, jobTitle) {
    setDownloadError(null);
    setDownloadingJobId(jobId);
    try {
      const result = await bridge.call('/download', { jobId });
      if (result.error) {
        setDownloadError(result.error);
        return;
      }
      const { filename, fileBase64 } = result;
      const byteChars = atob(fileBase64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError('Download failed: ' + err.message);
    } finally {
      setDownloadingJobId(null);
    }
  }

  const tabStyle = (t) => ({
    padding: '8px 20px',
    cursor: 'pointer',
    borderBottom: tab === t ? '2px solid #5c6ac4' : '2px solid transparent',
    fontWeight: tab === t ? '600' : '400',
    background: 'none',
    border: tab === t ? 'none' : 'none',
    borderBottom: tab === t ? '2px solid #5c6ac4' : '2px solid transparent',
    color: tab === t ? '#5c6ac4' : '#555',
    fontSize: '14px'
  });

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: '760px', margin: '0 auto', padding: '24px' }}>
      <h2 style={{ marginBottom: '16px' }}>Bulk Discount Code Generator</h2>

      <div style={{ display: 'flex', borderBottom: '1px solid #ddd', marginBottom: '24px' }}>
        <button style={tabStyle('generate')} onClick={() => setTab('generate')}>Generate Codes</button>
        <button style={tabStyle('jobs')} onClick={() => setTab('jobs')}>Job History</button>
      </div>

      {tab === 'generate' && (
        <div>
          <form onSubmit={handleGenerate}>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Discount Title</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. PROMO_NOV"
                required
                style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Discount Percentage (1–100)</label>
              <input
                type="number"
                value={percentage}
                onChange={e => setPercentage(e.target.value)}
                placeholder="e.g. 15"
                min="1" max="100" step="0.01"
                required
                style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Quantity of Codes (1–10000)</label>
              <input
                type="number"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder="e.g. 500"
                min="1" max="10000" step="1"
                required
                style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '16px', marginBottom: '14px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>Start Date (optional)</label>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={e => setStartsAt(e.target.value)}
                  style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: '500' }}>End Date (optional)</label>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={e => setEndsAt(e.target.value)}
                  style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={generating}
              style={{ padding: '10px 24px', background: '#5c6ac4', color: '#fff', border: 'none', borderRadius: '4px', cursor: generating ? 'not-allowed' : 'pointer', fontSize: '14px', fontWeight: '600' }}
            >
              {generating ? 'Generating...' : 'Generate & Save'}
            </button>
          </form>

          {generateError && (
            <div style={{ marginTop: '16px', padding: '12px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '4px', color: '#b91c1c' }}>
              {generateError}
            </div>
          )}

          {generateResult && (
            <div style={{ marginTop: '16px', padding: '16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '4px' }}>
              <strong style={{ color: '#15803d' }}>✓ Codes generated successfully!</strong>
              <div style={{ marginTop: '8px', fontSize: '13px', color: '#374151' }}>
                <div>Job ID: <code>{generateResult.jobId}</code></div>
                <div>Quantity: {generateResult.quantity}</div>
                <div>Imported: {generateResult.importedCount}</div>
                {generateResult.failedCount > 0 && <div style={{ color: '#b91c1c' }}>Failed: {generateResult.failedCount}</div>}
                <div>Status: {generateResult.status}</div>
              </div>
              <button
                onClick={() => handleDownload(generateResult.jobId, title)}
                disabled={downloadingJobId === generateResult.jobId}
                style={{ marginTop: '12px', padding: '8px 16px', background: '#047857', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
              >
                {downloadingJobId === generateResult.jobId ? 'Downloading...' : '⬇ Download Spreadsheet'}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'jobs' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0 }}>Recent Jobs</h3>
            <button onClick={loadJobs} style={{ padding: '6px 14px', border: '1px solid #ccc', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}>Refresh</button>
          </div>

          {downloadError && (
            <div style={{ marginBottom: '12px', padding: '10px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '4px', color: '#b91c1c' }}>
              {downloadError}
            </div>
          )}

          {jobsLoading ? (
            <div style={{ color: '#666', padding: '20px', textAlign: 'center' }}>Loading...</div>
          ) : jobs.length === 0 ? (
            <div style={{ color: '#888', padding: '20px', textAlign: 'center' }}>No jobs found.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f3f4f6' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Title</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>%</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Status</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Created</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Download</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.jobId} style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <td style={{ padding: '10px 12px' }}>{job.title}</td>
                    <td style={{ padding: '10px 12px' }}>{job.percentage}%</td>
                    <td style={{ padding: '10px 12px' }}>{job.quantity}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '12px',
                        background: job.status === 'complete' ? '#d1fae5' : '#fef3c7',
                        color: job.status === 'complete' ? '#065f46' : '#92400e'
                      }}>
                        {job.status}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>{new Date(job.createdAt).toLocaleString()}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <button
                        onClick={() => handleDownload(job.jobId, job.title)}
                        disabled={downloadingJobId === job.jobId}
                        style={{ padding: '5px 12px', background: '#5c6ac4', color: '#fff', border: 'none', borderRadius: '4px', cursor: downloadingJobId === job.jobId ? 'not-allowed' : 'pointer', fontSize: '12px' }}
                      >
                        {downloadingJobId === job.jobId ? '...' : '⬇ XLSX'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
```


## Explanation

This feature lets you generate multiple discount codes all at once, saving you hours of manual work. Just open the discount code generator in your Shopify Admin, enter how many codes you want to create, set the discount percentage, and choose when the codes expire. Click generate, and your app instantly creates all the codes and groups them under a single discount. You can then download the entire list as a spreadsheet file—perfect for sharing with your team, customers, or sales partners.

All your generated codes are saved in your dashboard, so you can see a history of every bulk generation job you've run, how many codes were created, and re-download the spreadsheet anytime. If you need to generate more codes with different settings, just run the tool again—each batch is tracked separately for easy organization.

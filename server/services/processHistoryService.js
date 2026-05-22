// processHistoryService.js
//
// Phase 4.7: persistent history of batch processing jobs. Survives
// server restarts. Stored as a single JSON file with newest-first order.
//
// Only batch jobs are logged. Single-order processOrder() calls happen
// frequently during testing and would clutter history; if you want to
// know what happened with a single order, the order detail page's
// Process result UI already shows that synchronously.
//
// Retention: oldest entries pruned past MAX_ENTRIES on every append.
// Each entry stays compact — full sub-order results would be enormous
// for batches of 500. Per-order details are summarized down to
// success/partial/failed counts. Click into an entry in the UI to see
// what the orchestrator was DOING; what it actually wrote per sub-order
// only matters for in-flight jobs (where you can poll /process/job/:id).

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'config', 'process-history.json');
const MAX_ENTRIES = 500;

class ProcessHistoryService {
  constructor() {
    this._ensureFile();
  }

  _ensureFile() {
    try {
      if (!fs.existsSync(HISTORY_PATH)) {
        const dir = path.dirname(HISTORY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HISTORY_PATH, JSON.stringify({ entries: [] }, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn(`[History] Could not ensure ${HISTORY_PATH}: ${err.message}`);
    }
  }

  async _read() {
    try {
      const raw = await fsp.readFile(HISTORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  async _write(entries) {
    // Keep most recent MAX_ENTRIES (entries are newest-first by convention)
    const trimmed = entries.slice(0, MAX_ENTRIES);
    const tmpPath = HISTORY_PATH + '.tmp';
    await fsp.writeFile(tmpPath, JSON.stringify({ entries: trimmed }, null, 2), 'utf8');
    await fsp.rename(tmpPath, HISTORY_PATH);
  }

  /**
   * Record a completed batch job. Strips heavy fields (per-order
   * sub-order details) down to summary counts for storage efficiency.
   */
  async recordBatch(job, options = {}) {
    if (!job || !job.jobId) {
      throw new Error('recordBatch requires a job with jobId');
    }

    const summarized = (job.results || []).map((r) => {
      if (r.error) {
        return {
          orderId: r.orderId,
          orderNumber: r.orderNumber || r.orderId,
          status: 'failed',
          error: r.error,
        };
      }
      const subOrders = r.subOrders || [];
      const allOk = subOrders.length > 0 && subOrders.every((s) => s.success);
      const someOk = subOrders.some((s) => s.success);
      const status = allOk ? 'success' : someOk ? 'partial' : 'failed';
      return {
        orderId: r.orderId,
        orderNumber: r.orderNumber || r.orderId,
        status,
        subOrderCount: subOrders.length,
        photoCount: subOrders.reduce(
          (sum, s) => sum + (s.photosDownloaded?.length || 0),
          0
        ),
        warningCount: subOrders.reduce(
          (sum, s) => sum + (s.warnings?.length || 0),
          0
        ),
        statusUpdated: !!r.statusUpdated,
      };
    });

    const successCount = summarized.filter((s) => s.status === 'success').length;
    const partialCount = summarized.filter((s) => s.status === 'partial').length;
    const failedCount = summarized.filter((s) => s.status === 'failed').length;

    const entry = {
      jobId: job.jobId,
      kind: 'batch',
      startedAt: job.startedAt,
      completedAt: job.completedAt || new Date().toISOString(),
      status: job.status,
      total: job.total,
      completed: job.completed,
      successCount,
      partialCount,
      failedCount,
      options: job.options || {},
      qrSheetPaths: job.qrSheetPaths || [],
      mode: options.mode || null,
      ranBy: options.username || null,
      results: summarized,
      cancelled: !!job.cancelled,
      error: job.error || null,
    };

    const entries = await this._read();
    entries.unshift(entry); // newest first
    await this._write(entries);
    console.log(
      `[History] Recorded batch ${job.jobId}: ${successCount}✓ ${partialCount}⚠ ${failedCount}✗`
    );
    return entry;
  }

  async list({ limit = 50, offset = 0 } = {}) {
    const entries = await this._read();
    return {
      total: entries.length,
      entries: entries.slice(offset, offset + limit),
      limit,
      offset,
    };
  }

  async get(jobId) {
    const entries = await this._read();
    return entries.find((e) => e.jobId === jobId) || null;
  }

  /**
   * Phase 61: latest per-order process outcome, for the orders-list
   * "⚠ Last process failed" badge. Scans entries newest-first and returns the
   * FIRST (most recent) result for each requested orderId — so a later
   * successful reprocess overrides an earlier failure, and the badge clears
   * on its own. Only BATCH jobs are recorded here; single-order Process
   * failures surface on the order-detail red banner instead (the operator is
   * on that page when they single-process). Returns a map keyed by String
   * orderId → { status, error, jobId, at }. Orders never batch-processed are
   * simply absent (no badge). Non-throwing by contract — callers treat a
   * thrown/empty result as "no badge".
   */
  async getLatestStatusByOrderId(orderIds = []) {
    const want = new Set((orderIds || []).map((id) => String(id)));
    const out = {};
    if (want.size === 0) return out;
    const entries = await this._read(); // newest-first
    for (const entry of entries) {
      for (const r of entry.results || []) {
        const id = String(r.orderId);
        if (!want.has(id) || out[id]) continue;
        out[id] = {
          status: r.status,
          error: r.error || null,
          jobId: entry.jobId,
          at: entry.completedAt || entry.startedAt || null,
        };
      }
      if (Object.keys(out).length === want.size) break; // all found — stop early
    }
    return out;
  }

  async clear() {
    await this._write([]);
    return { cleared: true };
  }
}

module.exports = new ProcessHistoryService();
module.exports.MAX_ENTRIES = MAX_ENTRIES;

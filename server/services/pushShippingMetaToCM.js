// Best-effort push of shipping metadata to the Customer Manager (CM)
// app running on the DigitalOcean droplet.
//
// Fires from TWO call sites:
//   - schedulerService.js, right after shipstationLinkService.update
//     when the scheduler detects SS reported the order shipped
//   - routes/shipstation.js POST /orders/:orderId/mark-shipped, right
//     after the local link update when an operator manually marks it
//
// LOAD-BEARING: this MUST be best-effort. A CM outage / wrong secret /
// network flap MUST NOT block the local shipstation_links update or
// the ms_orders writeback. Every error is caught + recorded in the
// local push-log SQLite table, never re-thrown.
//
// Observability: Joey watches two metrics in production:
//   1. track_missing_at_ship rate — how often the label lacked a real
//      tracking number at push time. Currently 100% due to a
//      ShipStation workflow issue; expected to drop to 0 after that
//      fix. This service records ONE row per push, with the
//      trackingPresent flag telling the story.
//   2. push_failed rate — how often the CM POST failed. Should be 0
//      steady-state; nonzero means CM is down, the secret is wrong,
//      or the CM URL is misconfigured.
//
// Query for both:
//   sqlite3 server/config/sytist-dashboard.db \
//     "SELECT date(pushed_at), \
//             SUM(CASE WHEN tracking_present=1 THEN 1 ELSE 0 END) AS tracked, \
//             SUM(CASE WHEN tracking_present=0 THEN 1 ELSE 0 END) AS track_missing, \
//             SUM(CASE WHEN push_ok=0 THEN 1 ELSE 0 END) AS push_failed \
//      FROM shipping_meta_push_log \
//      WHERE pushed_at >= date('now', '-30 days') \
//      GROUP BY 1 ORDER BY 1 DESC;"

const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn(
    '[pushShippingMetaToCM] better-sqlite3 not loadable; push disabled'
  );
}

// Config comes from app-settings.json (unencrypted, but the secret
// is treated as sensitive — never logged in full). Two fields:
//   dashboardPushToCmUrl:    full URL to CM's endpoint, e.g.
//                             "https://campaigns.sportslinephotography.com/api/sytist/shipping-meta"
//   dashboardPushToCmSecret: the shared secret paired with CM's
//                             SETTINGS_dashboard_push_secret.
// Both undefined = push disabled (dev / not-yet-configured); the
// service no-ops and doesn't log every skip.

function loadConfig() {
  try {
    const fs = require('fs');
    const settingsPath = path.join(__dirname, '..', 'config', 'app-settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    const url = settings.dashboardPushToCmUrl || null;
    const secret = settings.dashboardPushToCmSecret || null;
    if (!url || !secret) return null;
    return { url, secret };
  } catch (e) {
    console.warn('[pushShippingMetaToCM] loadConfig failed:', e.message);
    return null;
  }
}

let _db = null;
let _stmts = null;

function initLogDb() {
  if (_db) return _db;
  if (!Database) return null;
  const dbPath = path.join(__dirname, '..', 'config', 'sytist-dashboard.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS shipping_meta_push_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id          TEXT NOT NULL,
      tracking_present  INTEGER NOT NULL,  -- 0 / 1
      push_ok           INTEGER NOT NULL,  -- 0 / 1
      http_status       INTEGER,           -- null on network failure
      error_message     TEXT,              -- populated on push_ok=0
      pushed_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shipping_meta_push_log_pushed_at
      ON shipping_meta_push_log (pushed_at);
  `);
  _stmts = {
    insert: _db.prepare(`
      INSERT INTO shipping_meta_push_log
        (order_id, tracking_present, push_ok, http_status, error_message)
      VALUES
        (@order_id, @tracking_present, @push_ok, @http_status, @error_message)
    `),
  };
  return _db;
}

function recordLog(row) {
  try {
    initLogDb();
    if (!_stmts) return;
    _stmts.insert.run({
      order_id: String(row.order_id),
      tracking_present: row.tracking_present ? 1 : 0,
      push_ok: row.push_ok ? 1 : 0,
      http_status: row.http_status ?? null,
      error_message: row.error_message ?? null,
    });
  } catch (e) {
    // Log-of-a-log: don't propagate. If SQLite is broken, the whole
    // dashboard is broken and this is the least of Joey's problems.
    console.warn('[pushShippingMetaToCM] recordLog failed:', e.message);
  }
}

/**
 * POST shipping metadata to the Customer Manager. Best-effort.
 *
 * @param {object} args
 * @param {number|string} args.orderId       — Sytist order_id.
 * @param {number}        args.weightOz      — order-level weight (integer oz).
 * @param {string}        args.serviceCode   — ShipStation service code.
 * @param {string}        args.packageCode   — ShipStation package code.
 * @param {string|null}   args.carrierCode   — carrier code (e.g. 'stamps_com').
 * @param {string|null}   args.trackingNumber — real tracking number or null.
 * @param {string}        args.shippedAt     — ISO 8601 timestamp.
 * @returns {Promise<void>}  Always resolves; errors are logged, not thrown.
 */
async function pushShippingMetaToCM(args) {
  const cfg = loadConfig();
  if (!cfg) return; // not configured — no-op silently

  const orderId = args.orderId;
  const trackingPresent = !!(
    args.trackingNumber &&
    String(args.trackingNumber).trim() &&
    !/^0{3,}/.test(String(args.trackingNumber).trim())
  );

  const payload = {
    orderId: parseInt(orderId, 10),
    weightOz: parseInt(args.weightOz, 10),
    serviceCode: args.serviceCode,
    packageCode: args.packageCode,
    carrierCode: args.carrierCode ?? null,
    trackingNumber: args.trackingNumber ?? null,
    shippedAt: args.shippedAt,
  };

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-Secret': cfg.secret,
      },
      body: JSON.stringify(payload),
      // 10s timeout — CM's endpoint is a simple upsert; anything
      // slower means CM is broken and we should stop waiting.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      recordLog({
        order_id: orderId,
        tracking_present: trackingPresent,
        push_ok: false,
        http_status: res.status,
        error_message: text.slice(0, 500),
      });
      console.warn(
        `[pushShippingMetaToCM] order ${orderId} — CM returned HTTP ${res.status}: ${text.slice(0, 200)}`
      );
      return;
    }
    recordLog({
      order_id: orderId,
      tracking_present: trackingPresent,
      push_ok: true,
      http_status: res.status,
      error_message: null,
    });
    if (!trackingPresent) {
      // Joey's ask: "track_missing_at_ship event on the dashboard.
      // Right now I'd have no way to notice tracking starting to arrive
      // except by reading emails. That counter going from 458/month to
      // zero is how I'll know the fix worked."
      console.log(
        `[pushShippingMetaToCM] order ${orderId} — pushed; track_missing_at_ship (SS returned no tracking)`
      );
    }
  } catch (e) {
    recordLog({
      order_id: orderId,
      tracking_present: trackingPresent,
      push_ok: false,
      http_status: null,
      error_message: (e && e.message) ? e.message.slice(0, 500) : String(e).slice(0, 500),
    });
    console.warn(
      `[pushShippingMetaToCM] order ${orderId} — network error: ${e.message || e}`
    );
  }
}

module.exports = { pushShippingMetaToCM };

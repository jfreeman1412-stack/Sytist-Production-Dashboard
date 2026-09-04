// Tracking-reconcile pass for the shipping-meta pipeline.
//
// BACKGROUND
// ----------
// The dashboard buys a shipping label and (nearly-simultaneously)
// flips the order to Printing. The next scheduler tick queries
// ShipStation, sees status='shipped', but reads tracking_number as
// null because the label service hasn't propagated the tracking back
// yet. The initial write persists that null and there is no second
// look, so the tracking is permanently lost to the pipeline. That
// state is why CM's tracked-variant email path fires 0% of the time
// even for classes that always carry tracking (Ground Advantage).
//
// SHAPE
// -----
// Mirrors PHASE-4-DEPLOY.txt's Creatomate reconcile so operators have
// one mental model. Two passes:
//
//   1. BACKFILL — one-shot. Sweeps ALL null-tracking rows regardless
//      of age, throttled per-batch. Run via
//      `node server/scripts/reconcile-backfill.js`.
//
//   2. ONGOING — hooked into schedulerService._pollOnce. Every 5min
//      tick calls `runReconcileTick({backfill:false})` at the end of
//      the tick. Age-windowed: rows more than 5 min old (past the
//      grace period) and less than 24h old (before the give-up
//      ceiling). Rows past 24h without tracking get marked gave_up
//      once and are then excluded forever.
//
// FILTER
// ------
// `package_code = 'package'` — whitelist of tracking-bearing classes.
// Flats (`large_envelope_or_flat`) are excluded because their
// permanent-null tracking is CORRECT for that mail class. See
// apps/api/src/services/shippingMeta.ts mapShipStationToUspsMailClass
// for the mapping table.
//
// SAFETY
// ------
//   * Best-effort throughout — every error caught + logged, never
//     re-thrown. A poll tick's other work must not be blocked by
//     reconcile failures.
//   * COALESCE-protected UPDATE on shipstation_links (only writes
//     when currently null — see setTrackingNumberIfNull).
//   * Narrow write on ms_orders.order_shipped_track only — see
//     sytistDbService.backfillTrackingNumber for why.
//   * CM push goes through the existing pushShippingMetaToCM which
//     already COALESCE-protects on the CM side.
//   * The `NOT EXISTS (gave_up)` clause is LOAD-BEARING once the
//     backfill runs — historical rows that will never recover would
//     otherwise re-match the base predicate on every tick. The index
//     on shipping_meta_reconcile_log.order_id is what keeps that
//     exclusion cheap at scale.
//   * Backfill mode does NOT run the give-up sweep per-round.
//     Reason: with BATCH_SIZE=50 and ~458 historical null rows, a
//     per-round sweep would mark the OTHER ~408 as gave_up before
//     subsequent rounds got to try them. The CLI runs rounds until
//     drained, then invokes runGiveUpSweep() explicitly. Ongoing
//     mode keeps the per-tick sweep (rows > 24h old are age-gated
//     out of the candidate query anyway).
//
// OBSERVABILITY
// -------------
// Every attempt records one row in `shipping_meta_reconcile_log`
// with one of four outcomes: 'recovered', 'still_missing',
// 'gave_up', 'ss_error'. The `shipped_at` column is captured on
// every row so `reconciled_at - shipped_at` gives the recovery-delay
// distribution — that's the data we don't have today and will need
// to decide whether a short delay on initial capture would replace
// most of the reconcile load (currently: no data, so reconcile is
// the safe general fix; after a few weeks of log rows, we'll know).
//
// Recovered counts / give-up counts / SS errors / recovery-delay
// distribution:
//   sqlite3 server/config/sytist-dashboard.db \
//     "SELECT date(reconciled_at) AS day,
//             SUM(outcome='recovered')    AS recovered,
//             SUM(outcome='still_missing') AS still_missing,
//             SUM(outcome='gave_up')       AS gave_up,
//             SUM(outcome='ss_error')      AS ss_errors
//        FROM shipping_meta_reconcile_log
//       WHERE reconciled_at >= date('now','-30 days')
//       GROUP BY 1 ORDER BY 1 DESC;"
//
//   sqlite3 server/config/sytist-dashboard.db \
//     "SELECT round(AVG((julianday(reconciled_at) - julianday(shipped_at))*24*60),1) AS avg_delay_min,
//             MAX((julianday(reconciled_at) - julianday(shipped_at))*24*60) AS max_delay_min,
//             COUNT(*) AS recovered_rows
//        FROM shipping_meta_reconcile_log
//       WHERE outcome='recovered' AND shipped_at IS NOT NULL;"

const path = require('path');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn(
    '[shippingMetaReconcile] better-sqlite3 not loadable; reconcile disabled'
  );
}

// Constants — sized per the Phase 2 correction 3 design discussion
// (see the Sept-2026 conversation with Joey). All four values were
// explicitly approved together; do not tune one in isolation.
const GRACE_PERIOD_MINUTES = 5;   // don't retry until N min past ship
const RETRY_INTERVAL_MINUTES = 5; // don't retry same order within N min
const GIVE_UP_HOURS = 24;          // no tracking after N hours → give up
const BATCH_SIZE = 50;             // ceiling per tick, within SS 40/min rate

// The whitelist of mail classes we EXPECT to carry tracking. Flats
// have tracking_number IS NULL as a PERMANENT correct state, so
// including them here would generate never-recovers noise + waste
// SS API calls. See apps/api/src/services/shippingMeta.ts for the
// authoritative mapping table.
const TRACKING_BEARING_PACKAGE_CODE = 'package';

// Log-table schema. Exported (module.exports below) so the reconcile-
// queries verify harness builds a throwaway in-memory DB from the
// SAME statement production uses — no schema-drift-in-tests risk.
const RECONCILE_LOG_CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS shipping_meta_reconcile_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        TEXT NOT NULL,
    ss_order_id     TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    tracking_number TEXT,
    shipped_at      TEXT,
    http_status     INTEGER,
    error_message   TEXT,
    reconciled_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_shipping_meta_reconcile_log_reconciled_at
    ON shipping_meta_reconcile_log (reconciled_at);
  CREATE INDEX IF NOT EXISTS idx_shipping_meta_reconcile_log_order_id
    ON shipping_meta_reconcile_log (order_id);
  CREATE INDEX IF NOT EXISTS idx_shipping_meta_reconcile_log_outcome
    ON shipping_meta_reconcile_log (outcome);
`;

let _db = null;
let _stmts = null;

/**
 * Idempotent init. Called on first use. Creates the log table + the
 * indexes (order_id + outcome are load-bearing — see NOT EXISTS
 * clauses in the base predicate).
 */
function initReconcileDb() {
  if (_db) return _db;
  if (!Database) return null;
  const dbPath = path.join(__dirname, '..', 'config', 'sytist-dashboard.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(RECONCILE_LOG_CREATE_SQL);
  _stmts = {
    insert: _db.prepare(`
      INSERT INTO shipping_meta_reconcile_log
        (order_id, ss_order_id, outcome, tracking_number, shipped_at, http_status, error_message)
      VALUES
        (@order_id, @ss_order_id, @outcome, @tracking_number, @shipped_at, @http_status, @error_message)
    `),
  };
  return _db;
}

function _log(row) {
  try {
    initReconcileDb();
    if (!_stmts) return;
    _stmts.insert.run({
      order_id: String(row.order_id),
      ss_order_id: String(row.ss_order_id),
      outcome: String(row.outcome),
      tracking_number: row.tracking_number ?? null,
      shipped_at: row.shipped_at ?? null,
      http_status: row.http_status ?? null,
      error_message: row.error_message ?? null,
    });
  } catch (e) {
    // Log-of-a-log: don't propagate.
    console.warn('[shippingMetaReconcile] recordLog failed:', e.message);
  }
}

// ─── SQL builders (pure functions, exported for testing) ──────────
//
// These are the single source of truth for every reconcile query.
// The verify-reconcile-queries.js harness runs each against an
// in-memory DB built from the exported schemas, catching any column
// drift (including the exact bug that shipped in the first cut of
// this file: SELECT sl.id where the primary key is order_id).
//
// SELECT columns audited against shipstationLinkService's real
// schema: order_id (PK), ss_order_id, ss_order_number, ss_order_status,
// tracking_number, carrier_code, service_code, package_code,
// payload_json, shipped_at, created_at, updated_at.

/**
 * Candidate query — the rows the reconcile pass will re-poll SS for.
 * Two modes:
 *   - backfill=true:  no age window (sweeps all history), no
 *                     grace-period clause. Still respects the
 *                     gave_up exclusion + the 5-min retry-recency
 *                     floor so re-runs don't hammer the same rows.
 *   - backfill=false: adds shipped_at grace (>5min old) AND give-up
 *                     ceiling (<24h old) so ancient rows drain into
 *                     the give-up sweep instead of being retried.
 *
 * Optional `sinceDays` (opt-in via backfill CLI `--since-days=N`):
 * additionally constrains candidates to `shipped_at > NOW - N days`.
 * Used to bound the SS API cost when the backlog is large and older
 * rows carry no operator value — a tracked-email link for an order
 * that arrived months ago is not something a customer will follow.
 * Zero/null/undefined = unbounded (default).
 *
 * Returns { sql, params } — params object for better-sqlite3 named
 * binding.
 */
function buildCandidateQuery({ backfill, limit, sinceDays }) {
  const clauses = [
    `sl.tracking_number IS NULL`,
    `sl.package_code = @package_code`,
    `sl.ss_order_id IS NOT NULL`,
    `sl.shipped_at IS NOT NULL`,
    // Gave-up exclusion — load-bearing once backfill runs.
    `NOT EXISTS (
       SELECT 1 FROM shipping_meta_reconcile_log l
        WHERE l.order_id = sl.order_id
          AND l.outcome  = 'gave_up'
     )`,
    // Retry-recency floor — don't hit the same order twice per tick.
    `NOT EXISTS (
       SELECT 1 FROM shipping_meta_reconcile_log l
        WHERE l.order_id = sl.order_id
          AND l.reconciled_at > datetime('now', @retry_recency)
     )`,
  ];
  const params = {
    package_code: TRACKING_BEARING_PACKAGE_CODE,
    retry_recency: `-${RETRY_INTERVAL_MINUTES} minutes`,
    limit,
  };
  if (!backfill) {
    clauses.push(`sl.shipped_at < datetime('now', @grace)`);
    clauses.push(`sl.shipped_at > datetime('now', @give_up_ceiling)`);
    params.grace = `-${GRACE_PERIOD_MINUTES} minutes`;
    params.give_up_ceiling = `-${GIVE_UP_HOURS} hours`;
  }
  if (sinceDays != null && Number.isFinite(sinceDays) && sinceDays > 0) {
    clauses.push(`sl.shipped_at > datetime('now', @since_days)`);
    params.since_days = `-${sinceDays} days`;
  }
  const sql = `
    SELECT sl.order_id, sl.ss_order_id, sl.ss_order_number,
           sl.carrier_code, sl.service_code, sl.package_code,
           sl.payload_json, sl.shipped_at
      FROM shipstation_links sl
     WHERE ${clauses.join('\n       AND ')}
     ORDER BY sl.shipped_at DESC
     LIMIT @limit
  `;
  return { sql, params };
}

/**
 * Preview counts — supports the CLI's dry-run before writes.
 * Three builders: candidate count, would-be-given-up count, existing
 * gave_up count. Each returns { sql, params }.
 */
function buildPreviewCandidateCountQuery({ backfill, sinceDays } = {}) {
  const { sql, params } = buildCandidateQuery({ backfill, limit: 1000000, sinceDays });
  return {
    sql: `SELECT COUNT(*) AS n FROM (${sql}) t`,
    params,
  };
}

function buildPreviewGiveUpCountQuery() {
  // Guard MUST match buildGiveUpSweepQuery — otherwise preview lies
  // about what the sweep will actually do. Both require an EXISTS
  // prior-log-entry check; see buildGiveUpSweepQuery docstring for
  // the Aug 31 2026 incident this defends against.
  return {
    sql: `
      SELECT COUNT(*) AS n
        FROM shipstation_links sl
       WHERE sl.tracking_number IS NULL
         AND sl.package_code = @package_code
         AND sl.shipped_at IS NOT NULL
         AND sl.shipped_at <= datetime('now', @give_up_ceiling)
         AND NOT EXISTS (
           SELECT 1 FROM shipping_meta_reconcile_log l
            WHERE l.order_id = sl.order_id
              AND l.outcome  = 'gave_up'
         )
         AND EXISTS (
           SELECT 1 FROM shipping_meta_reconcile_log l
            WHERE l.order_id = sl.order_id
         )
    `,
    params: {
      package_code: TRACKING_BEARING_PACKAGE_CODE,
      give_up_ceiling: `-${GIVE_UP_HOURS} hours`,
    },
  };
}

function buildPreviewAlreadyGaveUpQuery() {
  return {
    sql: `
      SELECT COUNT(DISTINCT order_id) AS n
        FROM shipping_meta_reconcile_log
       WHERE outcome = 'gave_up'
    `,
    params: {},
  };
}

/**
 * Give-up sweep — marks rows as 'gave_up' when they're past the 24h
 * ceiling AND have been reconciled at least once.
 *
 * LOAD-BEARING GUARD: the `EXISTS (prior log entry)` clause is
 * what stops this sweep from blind-marking historical rows on a
 * fresh deploy. Without it, ongoing mode (which runs on every 5-min
 * scheduler tick) would sweep the entire backlog of ancient
 * null-tracking package rows in ONE unbounded INSERT ... SELECT
 * the first time it fires — no SS lookup, no chance to recover
 * anything. That happened on Aug 31 2026: pushing the reconcile
 * service to prod triggered a 1,585-row blind sweep on the next
 * scheduler tick before backfill CLI had ever run. The guard
 * requires that we've LOGGED something for this order previously
 * — either 'recovered', 'still_missing', or 'ss_error' — proving
 * a real reconcile attempt happened first.
 *
 * How the two paths satisfy the guard:
 *   - BACKFILL CLI: each round reconciles up to BATCH_SIZE rows,
 *     each writing 'recovered'/'still_missing'/'ss_error' to the
 *     log per attempt. After the round loop drains, the CLI calls
 *     runGiveUpSweep() explicitly — every candidate now has ≥1
 *     prior log entry, so it qualifies for give-up.
 *   - ONGOING scheduler: age-windowed candidate query only touches
 *     rows in [5min, 24h) old. Those rows accumulate 'still_missing'
 *     entries every tick until they age past 24h — the give-up
 *     sweep then marks them. Pre-deploy rows with no log entries
 *     stay INVISIBLE to ongoing mode (candidate query excludes
 *     them via the 24h ceiling, sweep excludes them via this
 *     EXISTS clause). The ONLY way pre-deploy rows get reconciled
 *     is via the backfill CLI. That is the deliberate design after
 *     the Aug 31 2026 incident: ongoing mode is a bad place for
 *     "sweep everything the operator hasn't gotten to."
 *
 * Positional params: better-sqlite3's INSERT ... SELECT with '?'
 * markers doesn't mix well with named-binding objects, and the
 * sweep predates this file's named-bind convention. Three params:
 * give_up_hours literal (embedded in message text), package_code
 * (whitelist), age cutoff.
 */
function buildGiveUpSweepQuery() {
  return {
    sql: `
      INSERT INTO shipping_meta_reconcile_log
        (order_id, ss_order_id, outcome, shipped_at, error_message)
      SELECT sl.order_id, sl.ss_order_id, 'gave_up', sl.shipped_at,
             'no tracking after ' || ? || 'h'
        FROM shipstation_links sl
       WHERE sl.tracking_number IS NULL
         AND sl.package_code = ?
         AND sl.shipped_at IS NOT NULL
         AND sl.shipped_at <= datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1 FROM shipping_meta_reconcile_log l
            WHERE l.order_id = sl.order_id
              AND l.outcome  = 'gave_up'
         )
         AND EXISTS (
           -- Load-bearing: proves a real reconcile attempt happened
           -- first. See docstring above for the incident this
           -- guards against.
           SELECT 1 FROM shipping_meta_reconcile_log l
            WHERE l.order_id = sl.order_id
         )
    `,
    params: [
      GIVE_UP_HOURS,
      TRACKING_BEARING_PACKAGE_CODE,
      `-${GIVE_UP_HOURS} hours`,
    ],
  };
}

// ─── Preview / sweep / tick — public API ──────────────────────────

/**
 * Preview the row counts. Never writes. Called by the CLI before it
 * commits to running.
 */
function previewCounts({ backfill, sinceDays } = {}) {
  initReconcileDb();
  if (!_db) return { available: false };

  const cand = buildPreviewCandidateCountQuery({ backfill, sinceDays });
  // Give-up preview intentionally NOT gated on sinceDays: sweep is
  // guarded by EXISTS(prior log entry), so only rows this run (or a
  // previous run) actually reconciled will show up. Bounding the
  // preview by sinceDays would show fewer rows than the sweep will
  // touch if a prior wider run left log entries on older rows.
  const give = buildPreviewGiveUpCountQuery();
  const already = buildPreviewAlreadyGaveUpQuery();

  const candidatesForRetry = _db.prepare(cand.sql).get(cand.params).n;
  const wouldGiveUp = _db.prepare(give.sql).get(give.params).n;
  const alreadyGaveUp = _db.prepare(already.sql).get(already.params).n;

  return {
    available: true,
    candidatesForRetry,
    wouldGiveUp,
    alreadyGaveUp,
    thresholds: {
      gracePeriodMinutes: GRACE_PERIOD_MINUTES,
      retryIntervalMinutes: RETRY_INTERVAL_MINUTES,
      giveUpHours: GIVE_UP_HOURS,
      batchSize: BATCH_SIZE,
      trackingBearingPackageCode: TRACKING_BEARING_PACKAGE_CODE,
      // null/undefined = unbounded; a positive number = the operator
      // opt-in cap. Surfaced in the CLI preview alongside the fixed
      // thresholds so it's always visible before writes happen.
      sinceDays: sinceDays != null && sinceDays > 0 ? sinceDays : null,
    },
  };
}

/**
 * Run the give-up sweep. Public so the backfill CLI can call it
 * explicitly after all rounds drain (see the "SAFETY" note in the
 * header about why backfill mode doesn't do this per-round).
 *
 * @returns {{ rowsMarked: number, available: boolean }}
 */
function runGiveUpSweep() {
  initReconcileDb();
  if (!_db) return { rowsMarked: 0, available: false };
  const q = buildGiveUpSweepQuery();
  const result = _db.prepare(q.sql).run(...q.params);
  if (result.changes > 0) {
    console.log(
      `[shippingMetaReconcile] gave-up sweep marked ${result.changes} row(s) as gave_up`
    );
  }
  return { rowsMarked: result.changes, available: true };
}

/**
 * Reconcile one candidate row: pull the SS shipment (NOT the order),
 * extract tracking + cost + shipDate, write through to
 * shipstation_links + ms_orders + CM if found. All errors caught +
 * logged; returns the outcome string.
 *
 * Read pattern (fixed Sep 2026): calls `/shipments?orderId=…` via
 * shipstationService.getBestShipmentForOrder. Do NOT read tracking
 * from `/orders/{id}.shipments[]` — that endpoint's shipments array
 * is empty in practice and drove the 0/100 recovery rate on the
 * first backfill attempt. See the shipstationService docstring on
 * `listShipments` for the diagnostic trail.
 */
async function _reconcileOne(candidate, deps) {
  const { shipstationService, shipstationLinkService, sytistDb } = deps;

  let shipment = null;
  try {
    shipment = await shipstationService.getBestShipmentForOrder(candidate.ss_order_id);
  } catch (err) {
    const httpStatus = err?.response?.status ?? null;
    _log({
      order_id: candidate.order_id,
      ss_order_id: candidate.ss_order_id,
      outcome: 'ss_error',
      shipped_at: candidate.shipped_at,
      http_status: httpStatus,
      error_message: (err.message || String(err)).slice(0, 500),
    });
    console.warn(
      `[shippingMetaReconcile] order ${candidate.order_id}: SS getBestShipmentForOrder failed (${httpStatus ?? 'network'}): ${err.message}`
    );
    return 'ss_error';
  }

  // No non-voided shipment for this order → nothing to recover on
  // this tick. Log still_missing; next tick retries per the
  // retry-recency floor.
  if (!shipment || !shipment.trackingNumber) {
    _log({
      order_id: candidate.order_id,
      ss_order_id: candidate.ss_order_id,
      outcome: 'still_missing',
      shipped_at: candidate.shipped_at,
      error_message: !shipment
        ? 'no non-voided shipment exists for this SS order'
        : 'shipment exists but trackingNumber is empty/0000-prefix',
    });
    return 'still_missing';
  }

  const tracking = shipment.trackingNumber;
  const carrierCode = shipment.carrierCode || candidate.carrier_code || null;

  // Found real tracking. Fan out the writes. Each in its own try
  // block so a partial-failure state is captured accurately in the
  // log — the local link update is the source of truth for "did we
  // recover this one", so we log 'recovered' iff it committed.
  let localWritten = false;
  try {
    localWritten = shipstationLinkService.setTrackingNumberIfNull(
      candidate.order_id,
      tracking
    );
  } catch (err) {
    console.warn(
      `[shippingMetaReconcile] order ${candidate.order_id}: local link write failed: ${err.message}`
    );
  }

  if (!localWritten) {
    // Either the link row disappeared or a concurrent writer beat us
    // to it. Log as still_missing so we don't claim recovery for
    // work we didn't do.
    _log({
      order_id: candidate.order_id,
      ss_order_id: candidate.ss_order_id,
      outcome: 'still_missing',
      shipped_at: candidate.shipped_at,
      error_message: 'local link no longer null (raced or deleted)',
    });
    return 'still_missing';
  }

  // Also update the local link's shipped_at + carrier_code +
  // shipment_id from shipment data. shipped_at from the shipment
  // record is authoritative (label-purchase time); the value we
  // wrote at ship-detection time is approximate.
  // shipstationLinkService.update uses COALESCE — passing non-null
  // overwrites. shipment_id here backfills the delivery-detection
  // path segment for rows that were shipped before Ship 2 (when the
  // column didn't exist) OR before the ss/orders read pattern was
  // fixed — same reason we backfill tracking here.
  try {
    shipstationLinkService.update(candidate.order_id, {
      shippedAt: shipment.shipDate || null,
      carrierCode: shipment.carrierCode || null,
      shipmentId: shipment.shipmentId || null,
    });
  } catch (err) {
    console.warn(
      `[shippingMetaReconcile] order ${candidate.order_id}: link shipDate/carrier/shipment_id update failed (non-fatal): ${err.message}`
    );
  }

  // Log recovered NOW — before the ms_orders and CM writes — because
  // that's when we accepted the tracking as canonical. If ms_orders
  // or CM fails, we retry the SIDE-EFFECTS next tick without
  // re-doing the local link write (setTrackingNumberIfNull skips it
  // now). The log row remains truthful about what happened.
  _log({
    order_id: candidate.order_id,
    ss_order_id: candidate.ss_order_id,
    outcome: 'recovered',
    tracking_number: tracking,
    shipped_at: candidate.shipped_at,
  });

  // ms_orders backfill — write tracking + cost + date in one UPDATE.
  // shippedDate must be YYYY-MM-DD for Sytist's DATE column (see
  // backfillShipping guard).
  try {
    const shippedDateYmd =
      shipment.shipDate
        ? new Date(shipment.shipDate).toISOString().slice(0, 10)
        : null;
    await sytistDb.backfillShipping(candidate.order_id, {
      trackingNumber: tracking,
      shipCost: shipment.shipmentCost, // null → skipped
      shippedDate: shippedDateYmd,     // null → skipped
    });
  } catch (err) {
    console.warn(
      `[shippingMetaReconcile] order ${candidate.order_id}: ms_orders backfill failed (tracking still recovered in link): ${err.message}`
    );
  }

  // CM push — best-effort. CM's upsert is COALESCE-protected on
  // trackingNumber, so a second push with the real tracking will
  // update the CM row's tracking column without disturbing anything
  // else. Also promotes the shipped-email variant from flat to
  // tracked on the CM side if the poller hasn't fired yet.
  try {
    const { pushShippingMetaToCM } = require('./pushShippingMetaToCM');
    let weightOz = 0;
    try {
      const payload = candidate.payload_json ? JSON.parse(candidate.payload_json) : null;
      if (payload?.weight?.value && typeof payload.weight.value === 'number') {
        weightOz = payload.weight.value;
      }
    } catch (_) { /* leave weightOz=0 on parse fail */ }
    await pushShippingMetaToCM({
      orderId: candidate.order_id,
      weightOz,
      serviceCode: shipment.serviceCode || candidate.service_code,
      packageCode: shipment.packageCode || candidate.package_code,
      carrierCode,
      trackingNumber: tracking,
      shipmentId: shipment.shipmentId || null,
      shippedAt: shipment.shipDate || candidate.shipped_at,
    });
  } catch (err) {
    console.warn(
      `[shippingMetaReconcile] order ${candidate.order_id}: CM push failed (tracking still recovered locally): ${err.message}`
    );
  }

  console.log(
    `[shippingMetaReconcile] order ${candidate.order_id}: RECOVERED tracking=${tracking} carrier=${carrierCode || 'unknown'} cost=${shipment.shipmentCost} shipDate=${shipment.shipDate}`
  );
  return 'recovered';
}

/**
 * Main entry. Runs one reconcile pass over up to BATCH_SIZE
 * candidates. Optionally follows with the give-up sweep.
 *
 * IMPORTANT: `runGiveUp` defaults to !backfill because the backfill
 * CLI runs many rounds in sequence, and a per-round give-up sweep
 * would mark ancient rows BEFORE subsequent rounds get to reconcile
 * them (see the SAFETY note in the file header). The CLI calls
 * `runGiveUpSweep()` explicitly after its round loop drains.
 *
 * Ongoing (scheduler) ticks keep runGiveUp=true so age-drift is
 * cleaned up naturally.
 *
 * @param {object} opts
 * @param {boolean} [opts.backfill=false]
 * @param {number}  [opts.limit=BATCH_SIZE]
 * @param {boolean} [opts.runGiveUp=!backfill]
 * @param {number}  [opts.sinceDays]  — opt-in bound. Constrains
 *   candidates to shipped_at > NOW - N days. Undefined/null/0 =
 *   unbounded. Passed through to buildCandidateQuery. Used by the
 *   backfill CLI's --since-days=N flag to cap SS API cost when the
 *   backlog is large and older rows carry no operator value.
 * @returns {Promise<{
 *   candidates: number,
 *   recovered: number,
 *   still_missing: number,
 *   ss_errors: number,
 *   given_up: number,
 * }>}
 */
async function runReconcileTick({
  backfill = false,
  limit = BATCH_SIZE,
  runGiveUp,
  sinceDays,
} = {}) {
  const doGiveUp = runGiveUp === undefined ? !backfill : !!runGiveUp;
  const summary = {
    candidates: 0,
    recovered: 0,
    still_missing: 0,
    ss_errors: 0,
    given_up: 0,
  };
  initReconcileDb();
  if (!_db) {
    console.warn('[shippingMetaReconcile] reconcile db unavailable — skipping');
    return summary;
  }

  // Lazy-load side services to keep this file loadable in isolation
  // (tests, backfill CLI). Matches the pattern in schedulerService.
  const shipstationLinkService = require('./shipstationLinkService');
  const shipstationService = require('./shipstationService');
  const sytistDb = require('./sytistDbService');
  const deps = { shipstationService, shipstationLinkService, sytistDb };

  const q = buildCandidateQuery({ backfill, limit, sinceDays });
  const candidates = _db.prepare(q.sql).all(q.params);
  summary.candidates = candidates.length;
  if (candidates.length === 0) {
    if (doGiveUp) {
      const giveUp = runGiveUpSweep();
      summary.given_up = giveUp.rowsMarked || 0;
    }
    return summary;
  }

  console.log(
    `[shippingMetaReconcile] ${backfill ? 'BACKFILL' : 'ongoing'} tick: ${candidates.length} candidate(s)`
  );

  for (const c of candidates) {
    let outcome;
    try {
      outcome = await _reconcileOne(c, deps);
    } catch (err) {
      // Defence-in-depth. _reconcileOne is already fully caught, but
      // any escape must not stop the batch.
      console.warn(
        `[shippingMetaReconcile] order ${c.order_id}: unexpected error in _reconcileOne (continuing): ${err.message}`
      );
      outcome = 'ss_error';
    }
    if (outcome === 'recovered') summary.recovered += 1;
    else if (outcome === 'still_missing') summary.still_missing += 1;
    else if (outcome === 'ss_error') summary.ss_errors += 1;
  }

  if (doGiveUp) {
    const giveUp = runGiveUpSweep();
    summary.given_up = giveUp.rowsMarked || 0;
  }

  console.log(
    `[shippingMetaReconcile] tick complete: recovered=${summary.recovered} ` +
      `still_missing=${summary.still_missing} ss_errors=${summary.ss_errors} ` +
      `given_up=${summary.given_up}`
  );
  return summary;
}

module.exports = {
  runReconcileTick,
  previewCounts,
  runGiveUpSweep,
  // Testing surface — every SQL builder + the log-table schema
  // exposed so verify-reconcile-queries.js can validate against an
  // in-memory DB built from real schemas.
  RECONCILE_LOG_CREATE_SQL,
  buildCandidateQuery,
  buildPreviewCandidateCountQuery,
  buildPreviewGiveUpCountQuery,
  buildPreviewAlreadyGaveUpQuery,
  buildGiveUpSweepQuery,
  _constants: {
    GRACE_PERIOD_MINUTES,
    RETRY_INTERVAL_MINUTES,
    GIVE_UP_HOURS,
    BATCH_SIZE,
    TRACKING_BEARING_PACKAGE_CODE,
  },
};

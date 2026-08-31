// Verify harness for the tracking-reconcile SQL.
//
// WHY THIS EXISTS
// ---------------
// The first cut of shippingMetaReconcileService.js shipped with
// SELECT sl.id FROM shipstation_links — a column that doesn't
// exist. Joey caught it on the dry-run's first line. `node --check`
// passed cleanly (of course — it validates JS syntax, not SQL) and
// there was no other test in place. This harness is the check that
// would have caught it BEFORE ship.
//
// SHAPE
// -----
// Follows the pattern of the other server/scripts/verify-*.js
// harnesses (verify-status-guard, verify-batch-divider, etc.):
//   - No test framework — plain node script with assert.
//   - Exits 0 on all-pass, 1 on any failure.
//   - Prints one line per case.
//
// WHAT IT VALIDATES
// -----------------
// 1. Every SQL builder produces a query that db.prepare() accepts
//    against a schema built from the EXPORTED schema constants
//    (SHIPSTATION_LINKS_CREATE_TABLE_SQL from shipstationLinkService
//    + RECONCILE_LOG_CREATE_SQL from shippingMetaReconcileService).
//    A column drift in either schema surfaces as a clear SQL error
//    on prepare, not a mysterious runtime failure.
//
// 2. Filter logic — inserts fixture rows covering every predicate
//    branch (grace period, give-up ceiling, mail-class whitelist,
//    already-null vs already-tracked, already-gave-up exclusion,
//    retry-recency floor) and asserts each query returns the
//    expected row set.
//
// 3. Give-up sweep — asserts it (a) marks ancient null-tracking
//    tracking-bearing rows exactly once, (b) is idempotent on
//    re-run, (c) does NOT touch flat-class rows.
//
// 4. Retry-recency — asserts that a row with a recent log entry is
//    excluded from the candidate query.

const assert = require('assert');
const Database = require('better-sqlite3');

const {
  SHIPSTATION_LINKS_CREATE_TABLE_SQL,
} = require('../services/shipstationLinkService');
const {
  RECONCILE_LOG_CREATE_SQL,
  buildCandidateQuery,
  buildPreviewCandidateCountQuery,
  buildPreviewGiveUpCountQuery,
  buildPreviewAlreadyGaveUpQuery,
  buildGiveUpSweepQuery,
  _constants,
} = require('../services/shippingMetaReconcileService');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.stack || err.message}`);
  }
}

// ─── Set up an in-memory DB with the REAL schemas ─────────────

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SHIPSTATION_LINKS_CREATE_TABLE_SQL);
  db.exec(RECONCILE_LOG_CREATE_SQL);
  return db;
}

/**
 * Insert a shipstation_links row. `ago` is the shipped_at offset
 * expressed as an SQL modifier like '-10 minutes' or '-25 hours'.
 * Null 'ago' → shipped_at NULL.
 */
function insertLink(db, {
  order_id,
  ss_order_id = 1,
  tracking_number = null,
  package_code = 'package',
  service_code = 'usps_ground_advantage',
  carrier_code = 'stamps_com',
  ago,
}) {
  const shippedExpr = ago == null ? 'NULL' : `datetime('now', ?)`;
  const nowIso = new Date().toISOString();
  const bind = ago == null ? [] : [ago];
  db.prepare(`
    INSERT INTO shipstation_links
      (order_id, ss_order_id, ss_order_number, ss_order_status,
       tracking_number, carrier_code, service_code, package_code,
       payload_json, shipped_at, created_at, updated_at)
    VALUES (?, ?, ?, 'shipped', ?, ?, ?, ?, NULL, ${shippedExpr}, ?, ?)
  `).run(
    String(order_id),
    ss_order_id,
    String(order_id),
    tracking_number,
    carrier_code,
    service_code,
    package_code,
    ...bind,
    nowIso,
    nowIso,
  );
}

function insertLogRow(db, { order_id, outcome, minsAgo = 0 }) {
  db.prepare(`
    INSERT INTO shipping_meta_reconcile_log
      (order_id, ss_order_id, outcome, reconciled_at)
    VALUES (?, '1', ?, datetime('now', ?))
  `).run(String(order_id), outcome, `-${minsAgo} minutes`);
}

// ─── Case 1: every SQL builder prepares against the real schema ──

console.log('▸ SQL prepares against real schemas');
{
  const db = freshDb();
  check('buildCandidateQuery (backfill=true) prepares', () => {
    const q = buildCandidateQuery({ backfill: true, limit: 50 });
    db.prepare(q.sql); // throws if any column is unknown
  });
  check('buildCandidateQuery (backfill=false) prepares', () => {
    const q = buildCandidateQuery({ backfill: false, limit: 50 });
    db.prepare(q.sql);
  });
  check('buildPreviewCandidateCountQuery (backfill=true) prepares', () => {
    const q = buildPreviewCandidateCountQuery({ backfill: true });
    db.prepare(q.sql);
  });
  check('buildPreviewCandidateCountQuery (backfill=false) prepares', () => {
    const q = buildPreviewCandidateCountQuery({ backfill: false });
    db.prepare(q.sql);
  });
  check('buildPreviewGiveUpCountQuery prepares', () => {
    const q = buildPreviewGiveUpCountQuery();
    db.prepare(q.sql);
  });
  check('buildPreviewAlreadyGaveUpQuery prepares', () => {
    const q = buildPreviewAlreadyGaveUpQuery();
    db.prepare(q.sql);
  });
  check('buildGiveUpSweepQuery prepares', () => {
    const q = buildGiveUpSweepQuery();
    db.prepare(q.sql);
  });
}

// ─── Case 2: every column referenced by every query exists ──────
//
// Defence-in-depth against a future edit that adds a new column
// reference without adding it to the shipstation_links schema.
// PRAGMA table_info returns the ground truth for the schema, and we
// cross-check every column identifier the query builders emit.

console.log('▸ Every column referenced actually exists');
{
  const db = freshDb();
  const cols = new Set(
    db.prepare(`PRAGMA table_info(shipstation_links)`).all().map(r => r.name)
  );
  const logCols = new Set(
    db.prepare(`PRAGMA table_info(shipping_meta_reconcile_log)`).all().map(r => r.name)
  );

  check('shipstation_links has expected columns', () => {
    for (const name of [
      'order_id', 'ss_order_id', 'ss_order_number', 'ss_order_status',
      'tracking_number', 'carrier_code', 'service_code', 'package_code',
      'payload_json', 'shipped_at', 'created_at', 'updated_at',
    ]) {
      assert(cols.has(name), `missing column ${name}`);
    }
  });
  check('shipping_meta_reconcile_log has expected columns', () => {
    for (const name of [
      'id', 'order_id', 'ss_order_id', 'outcome', 'tracking_number',
      'shipped_at', 'http_status', 'error_message', 'reconciled_at',
    ]) {
      assert(logCols.has(name), `missing column ${name}`);
    }
  });
  check('shipstation_links has NO "id" column (was the shipped bug)', () => {
    assert(!cols.has('id'), 'if this fires, the schema changed and the historical bug context is gone — update the harness');
  });
}

// ─── Case 3: filter behavior end-to-end ─────────────────────────

console.log('▸ Filter behavior (fixtures → expected candidate sets)');
{
  const db = freshDb();

  // Fixture rows spanning the predicate branches.
  insertLink(db, { order_id: 'RECENT_PKG_NULL', ss_order_id: 101, ago: '-1 minutes' });
  insertLink(db, { order_id: 'MIDAGE_PKG_NULL', ss_order_id: 102, ago: '-30 minutes' });
  insertLink(db, { order_id: 'ANCIENT_PKG_NULL', ss_order_id: 103, ago: '-25 hours' });
  insertLink(db, {
    order_id: 'MIDAGE_PKG_HAS_TRACK', ss_order_id: 104,
    tracking_number: '9400111899223197428347', ago: '-30 minutes',
  });
  insertLink(db, {
    order_id: 'MIDAGE_FLAT_NULL', ss_order_id: 105,
    package_code: 'large_envelope_or_flat',
    service_code: 'usps_first_class_mail', ago: '-30 minutes',
  });
  insertLink(db, { order_id: 'NO_SHIP_DATE', ss_order_id: 106, ago: null });

  // A row that's already been marked gave_up — must be excluded.
  insertLink(db, { order_id: 'ALREADY_GAVE_UP', ss_order_id: 107, ago: '-30 minutes' });
  insertLogRow(db, { order_id: 'ALREADY_GAVE_UP', outcome: 'gave_up', minsAgo: 60 });

  // A row we polled recently (within 5-min retry-recency floor).
  insertLink(db, { order_id: 'RECENTLY_POLLED', ss_order_id: 108, ago: '-30 minutes' });
  insertLogRow(db, { order_id: 'RECENTLY_POLLED', outcome: 'still_missing', minsAgo: 2 });

  // A row we polled a while ago — should NOT be excluded.
  insertLink(db, { order_id: 'OLDER_LOG_ROW', ss_order_id: 109, ago: '-30 minutes' });
  insertLogRow(db, { order_id: 'OLDER_LOG_ROW', outcome: 'still_missing', minsAgo: 60 });

  const runCandidateQuery = (backfill) => {
    const q = buildCandidateQuery({ backfill, limit: 999 });
    return db.prepare(q.sql).all(q.params).map(r => r.order_id).sort();
  };

  check('backfill mode: catches ALL null-tracking package rows regardless of age', () => {
    const rows = runCandidateQuery(true);
    // Expected: RECENT_PKG_NULL (any age ok in backfill),
    //           MIDAGE_PKG_NULL, ANCIENT_PKG_NULL (no age ceiling in backfill),
    //           OLDER_LOG_ROW (recent-log >5min so retry-recency doesn't apply).
    // Excluded: MIDAGE_PKG_HAS_TRACK (has tracking),
    //           MIDAGE_FLAT_NULL (wrong mail class),
    //           NO_SHIP_DATE (null shipped_at fails filter),
    //           ALREADY_GAVE_UP (gave-up exclusion),
    //           RECENTLY_POLLED (retry-recency floor).
    assert.deepStrictEqual(
      rows,
      ['ANCIENT_PKG_NULL', 'MIDAGE_PKG_NULL', 'OLDER_LOG_ROW', 'RECENT_PKG_NULL'],
      `got: ${JSON.stringify(rows)}`
    );
  });

  check('ongoing mode: adds grace + give-up ceiling (excludes too-recent AND too-old)', () => {
    const rows = runCandidateQuery(false);
    // Excluded compared to backfill:
    //   RECENT_PKG_NULL (in grace period, <5min old)
    //   ANCIENT_PKG_NULL (past give-up ceiling, >24h old)
    assert.deepStrictEqual(
      rows,
      ['MIDAGE_PKG_NULL', 'OLDER_LOG_ROW'],
      `got: ${JSON.stringify(rows)}`
    );
  });

  check('preview candidate count (backfill) matches candidate query', () => {
    const q = buildPreviewCandidateCountQuery({ backfill: true });
    const n = db.prepare(q.sql).get(q.params).n;
    assert.strictEqual(n, runCandidateQuery(true).length);
  });

  check('preview candidate count (ongoing) matches candidate query', () => {
    const q = buildPreviewCandidateCountQuery({ backfill: false });
    const n = db.prepare(q.sql).get(q.params).n;
    assert.strictEqual(n, runCandidateQuery(false).length);
  });
}

// ─── Case 4: give-up sweep ───────────────────────────────────────

console.log('▸ Give-up sweep (marks ancient package rows only)');
{
  const db = freshDb();

  insertLink(db, { order_id: 'ANCIENT_PKG_1', ss_order_id: 201, ago: '-25 hours' });
  insertLink(db, { order_id: 'ANCIENT_PKG_2', ss_order_id: 202, ago: '-72 hours' });
  insertLink(db, { order_id: 'MIDAGE_PKG', ss_order_id: 203, ago: '-30 minutes' });
  insertLink(db, {
    order_id: 'ANCIENT_FLAT', ss_order_id: 204,
    package_code: 'large_envelope_or_flat',
    service_code: 'usps_first_class_mail', ago: '-72 hours',
  });
  insertLink(db, {
    order_id: 'ANCIENT_PKG_HAS_TRACK', ss_order_id: 205,
    tracking_number: '9400111899223197428347', ago: '-72 hours',
  });

  const runSweep = () => {
    const q = buildGiveUpSweepQuery();
    return db.prepare(q.sql).run(...q.params).changes;
  };

  check('preview give-up count matches what sweep will mark', () => {
    const q = buildPreviewGiveUpCountQuery();
    const preview = db.prepare(q.sql).get(q.params).n;
    // Only ANCIENT_PKG_1 and ANCIENT_PKG_2 qualify:
    //   MIDAGE_PKG: too recent (30min < 24h ceiling)
    //   ANCIENT_FLAT: wrong mail class
    //   ANCIENT_PKG_HAS_TRACK: already has tracking
    assert.strictEqual(preview, 2, `preview=${preview}`);
  });

  check('first sweep marks exactly the two ancient package rows', () => {
    const marked = runSweep();
    assert.strictEqual(marked, 2, `marked=${marked}`);
    const gaveUpIds = db.prepare(
      `SELECT DISTINCT order_id FROM shipping_meta_reconcile_log
        WHERE outcome='gave_up' ORDER BY order_id`
    ).all().map(r => r.order_id);
    assert.deepStrictEqual(
      gaveUpIds,
      ['ANCIENT_PKG_1', 'ANCIENT_PKG_2'],
      `got: ${JSON.stringify(gaveUpIds)}`
    );
  });

  check('second sweep is idempotent (adds zero new rows)', () => {
    const marked = runSweep();
    assert.strictEqual(marked, 0, `marked=${marked}`);
  });

  check('preview give-up count is zero after sweep', () => {
    const q = buildPreviewGiveUpCountQuery();
    const preview = db.prepare(q.sql).get(q.params).n;
    assert.strictEqual(preview, 0, `preview=${preview}`);
  });

  check('preview already-gave-up count matches log', () => {
    const q = buildPreviewAlreadyGaveUpQuery();
    const preview = db.prepare(q.sql).get(q.params).n;
    assert.strictEqual(preview, 2, `preview=${preview}`);
  });

  check('gave-up rows are then excluded from candidate query', () => {
    const q = buildCandidateQuery({ backfill: true, limit: 999 });
    const rows = db.prepare(q.sql).all(q.params).map(r => r.order_id).sort();
    // Only MIDAGE_PKG remains — the two ancient are gave_up,
    // ANCIENT_FLAT is wrong mail class, ANCIENT_PKG_HAS_TRACK has
    // tracking.
    assert.deepStrictEqual(rows, ['MIDAGE_PKG'], `got: ${JSON.stringify(rows)}`);
  });
}

// ─── Case 5: constants sanity ────────────────────────────────────

console.log('▸ Constants match Joey-approved values');
{
  check('GRACE_PERIOD_MINUTES = 5', () => {
    assert.strictEqual(_constants.GRACE_PERIOD_MINUTES, 5);
  });
  check('RETRY_INTERVAL_MINUTES = 5', () => {
    assert.strictEqual(_constants.RETRY_INTERVAL_MINUTES, 5);
  });
  check('GIVE_UP_HOURS = 24', () => {
    assert.strictEqual(_constants.GIVE_UP_HOURS, 24);
  });
  check('BATCH_SIZE = 50', () => {
    assert.strictEqual(_constants.BATCH_SIZE, 50);
  });
  check('TRACKING_BEARING_PACKAGE_CODE = "package"', () => {
    assert.strictEqual(_constants.TRACKING_BEARING_PACKAGE_CODE, 'package');
  });
}

// ─── Summary ─────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;

console.log('');
if (failed === 0) {
  console.log(`✓ verify-reconcile-queries: ${passed}/${results.length} passed`);
  process.exit(0);
} else {
  console.log(`✗ verify-reconcile-queries: ${failed} FAILED of ${results.length}`);
  process.exit(1);
}

// CLI for the shipment_id BACKFILL pass.
//
// One-shot script for the pre-Ship-2 backlog. Sweeps shipstation_links
// rows that have tracking but NO shipment_id — the delivery-detection
// path on Customer Manager needs shipment_id as the V2
// /v2/labels/{id}/track path segment, and rows written before Ship 2
// (or written by a scheduler tick that saw a shipment with null
// shipmentId — rare but possible per the defensive null-fallback) will
// have shipment_id NULL.
//
// Steady-state: every new ship-detection (scheduler auto-detect,
// operator mark-shipped) writes shipment_id at insert time. No
// ongoing reconcile is needed for shipment_id specifically —
// shippingMetaReconcileService's tracking reconcile ALSO writes
// shipment_id when it recovers tracking, so any row that lacks
// tracking is naturally caught. This CLI covers the ONLY remaining
// case: rows that already have tracking but never got shipment_id.
//
// Usage (same shape as reconcile-backfill.js):
//   node scripts/backfill-shipment-id.js --dry-run
//     → prints candidate count and exits. No writes.
//
//   node scripts/backfill-shipment-id.js
//     → prints preview, prompts y/N, then runs.
//
//   node scripts/backfill-shipment-id.js --yes
//     → skips prompt.
//
//   node scripts/backfill-shipment-id.js --since-days=N
//     → bound candidates to shipped_at > NOW - N days. Default 30 —
//       a tracked package older than that has been delivered for
//       weeks; nobody wants a "your order was delivered" email
//       about it, and CM's poller launch-date floor would skip it
//       anyway. Set 0 to disable the bound (unbounded).
//
//   node scripts/backfill-shipment-id.js --max-rounds=N
//     → cap on batch iterations. Default 200.
//
// Safety:
//   - Best-effort throughout. SS errors / MySQL errors / CM push
//     failures logged per-row, never re-thrown.
//   - Rate limit: SS V1 API is 40 req/min per key. BATCH_SIZE=50
//     per round with sequential rounds keeps us just at the ceiling.
//   - Idempotent: rows with shipment_id already populated are excluded
//     by the candidate query. Re-running catches nothing on the
//     second pass.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const readline = require('readline');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('✗ better-sqlite3 not loadable');
  process.exit(1);
}

const shipstationLinkService = require('../services/shipstationLinkService');
const shipstationService = require('../services/shipstationService');
const { pushShippingMetaToCM } = require('../services/pushShippingMetaToCM');

const BATCH_SIZE = 50;
const DEFAULT_SINCE_DAYS = 30;

function parseArgs() {
  const args = {
    dryRun: false,
    yes: false,
    maxRounds: 200,
    sinceDays: DEFAULT_SINCE_DAYS,
    repushOnly: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--repush-only') args.repushOnly = true;
    else if (arg.startsWith('--max-rounds=')) {
      const n = parseInt(arg.slice('--max-rounds='.length), 10);
      if (Number.isFinite(n) && n > 0) args.maxRounds = n;
    } else if (arg.startsWith('--since-days=')) {
      const raw = arg.slice('--since-days='.length);
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`✗ Invalid --since-days value: "${raw}" (must be a non-negative integer; 0 = unbounded)`);
        process.exit(1);
      }
      args.sinceDays = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage:',
          '  node scripts/backfill-shipment-id.js --dry-run              Print candidate count, no writes.',
          '  node scripts/backfill-shipment-id.js                        Print preview, prompt y/N, run.',
          '  node scripts/backfill-shipment-id.js --yes                  Skip prompt.',
          '  node scripts/backfill-shipment-id.js --max-rounds=N         Cap round iterations (default 200).',
          '  node scripts/backfill-shipment-id.js --since-days=N         Bound to shipped_at > NOW - N days',
          '                                                              (default 30; 0 = unbounded).',
          '  node scripts/backfill-shipment-id.js --repush-only          Skip SS lookup — just re-push already-',
          '                                                              locally-populated rows to CM. For the',
          '                                                              type-mismatch incident 2026-09-04: rows',
          '                                                              where local SQLite has shipment_id but',
          '                                                              CM 400d because dashboard sent a number.',
          '                                                              Compose with --since-days=N to bound.',
        ].join('\n')
      );
      process.exit(0);
    }
  }
  return args;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim().toLowerCase());
    });
  });
}

// Candidate query — rows lacking shipment_id, with a real ss_order_id
// (needed for the SS lookup), optionally bounded by shipped_at.
// Ordered newest-first so the most operator-relevant orders (recent
// shipments a customer might still ask about) are covered even if
// the round loop hits --max-rounds.
function buildCandidateQuery(sinceDays) {
  const clauses = [
    `shipment_id IS NULL`,
    `ss_order_id IS NOT NULL`,
    `shipped_at IS NOT NULL`,
  ];
  const params = { limit: BATCH_SIZE };
  if (sinceDays > 0) {
    clauses.push(`shipped_at > datetime('now', @since_days)`);
    params.since_days = `-${sinceDays} days`;
  }
  return {
    sql: `
      SELECT order_id, ss_order_id, tracking_number, carrier_code,
             service_code, package_code, payload_json, shipped_at
        FROM shipstation_links
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY shipped_at DESC
       LIMIT @limit
    `,
    params,
  };
}

// Count query for preview — same predicate, no LIMIT.
function buildPreviewCountQuery(sinceDays) {
  const clauses = [
    `shipment_id IS NULL`,
    `ss_order_id IS NOT NULL`,
    `shipped_at IS NOT NULL`,
  ];
  const params = {};
  if (sinceDays > 0) {
    clauses.push(`shipped_at > datetime('now', @since_days)`);
    params.since_days = `-${sinceDays} days`;
  }
  return {
    sql: `SELECT COUNT(*) AS n FROM shipstation_links WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

// --repush-only mode: rows that already HAVE shipment_id locally.
// Used to recover from the 2026-09-04 type-mismatch incident where
// local writes succeeded but CM's pushes 400'd because dashboard
// sent shipmentId as a number. CM's route is COALESCE-protected on
// every field, so a re-push is idempotent.
//
// Filter: shipment_id IS NOT NULL AND tracking_number IS NOT NULL
// (tracking is required for the poll path; a row with shipment_id
// but no tracking isn't useful to CM's delivery poller anyway).
function buildRepushCandidateQuery(sinceDays) {
  const clauses = [
    `shipment_id IS NOT NULL`,
    `tracking_number IS NOT NULL`,
    `ss_order_id IS NOT NULL`,
    `shipped_at IS NOT NULL`,
  ];
  const params = {};
  if (sinceDays > 0) {
    clauses.push(`shipped_at > datetime('now', @since_days)`);
    params.since_days = `-${sinceDays} days`;
  }
  // No LIMIT: repush is a one-off recovery, --since-days bound keeps
  // the row count small (~50 with default 30). Streaming all rows in
  // one pass avoids the "same row keeps matching each round" trap
  // that the tracking-recovery mode dodges naturally (candidates
  // drop out of the WHERE clause once shipment_id is written).
  return {
    sql: `
      SELECT order_id, ss_order_id, shipment_id, tracking_number, carrier_code,
             service_code, package_code, payload_json, shipped_at
        FROM shipstation_links
       WHERE ${clauses.join('\n         AND ')}
       ORDER BY shipped_at DESC
    `,
    params,
  };
}

function buildRepushCountQuery(sinceDays) {
  const clauses = [
    `shipment_id IS NOT NULL`,
    `tracking_number IS NOT NULL`,
    `ss_order_id IS NOT NULL`,
    `shipped_at IS NOT NULL`,
  ];
  const params = {};
  if (sinceDays > 0) {
    clauses.push(`shipped_at > datetime('now', @since_days)`);
    params.since_days = `-${sinceDays} days`;
  }
  return {
    sql: `SELECT COUNT(*) AS n FROM shipstation_links WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

/**
 * Re-push one row. Skips SS entirely — the shipment_id is already
 * captured locally; we just need CM to accept it. CM's upsert is
 * COALESCE-protected on every field, so a re-push doesn't clobber
 * unrelated columns.
 */
async function repushRow(row) {
  try {
    let weightOz = 0;
    try {
      const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      if (payload?.weight?.value && typeof payload.weight.value === 'number') {
        weightOz = payload.weight.value;
      }
    } catch (_) { /* leave weightOz=0 on parse fail */ }
    await pushShippingMetaToCM({
      orderId: row.order_id,
      weightOz,
      serviceCode: row.service_code,
      packageCode: row.package_code,
      carrierCode: row.carrier_code,
      trackingNumber: row.tracking_number,
      // Coerced to string at the push boundary in pushShippingMetaToCM
      // — passing a number here is safe now.
      shipmentId: row.shipment_id,
      shippedAt: row.shipped_at,
    });
    console.log(
      `[backfill-shipment-id] repush order ${row.order_id}: shipment_id=${row.shipment_id} pushed`
    );
    return 'repushed';
  } catch (err) {
    console.warn(
      `[backfill-shipment-id] repush order ${row.order_id}: push failed — ${err.message}`
    );
    return 'push_error';
  }
}

async function processRow(row) {
  let shipment = null;
  try {
    shipment = await shipstationService.getBestShipmentForOrder(row.ss_order_id);
  } catch (err) {
    console.warn(
      `[backfill-shipment-id] order ${row.order_id}: SS getBestShipmentForOrder failed — ${err.message}`
    );
    return 'ss_error';
  }
  if (!shipment || !shipment.shipmentId) {
    // SS knows no non-voided shipment for this SS order, or the
    // shipment exists but has no shipmentId. Not much to do here;
    // the shipment truly has no ID we can hand to V2 tracking, and
    // CM's poller will just skip this row forever. Log distinctly
    // so an unusual spike is visible.
    console.log(
      `[backfill-shipment-id] order ${row.order_id}: SS returned ${
        shipment ? 'shipment without shipmentId' : 'no shipment'
      } — skipping (CM will not poll this order for delivery)`
    );
    return 'skipped_no_shipment_id';
  }

  const shipmentId = shipment.shipmentId;

  // Local link write. Reuses the COALESCE-protected update so a
  // concurrent operator flow (rare during backfill) can't get
  // clobbered.
  try {
    shipstationLinkService.update(row.order_id, { shipmentId });
  } catch (err) {
    console.warn(
      `[backfill-shipment-id] order ${row.order_id}: local link write failed — ${err.message}`
    );
    return 'local_error';
  }

  // CM push. Best-effort — a CM outage doesn't stop the local
  // backfill from succeeding. CM's route is COALESCE-protected on
  // shipment_id, so re-pushing with the value fills the column
  // without disturbing other fields.
  try {
    let weightOz = 0;
    try {
      const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      if (payload?.weight?.value && typeof payload.weight.value === 'number') {
        weightOz = payload.weight.value;
      }
    } catch (_) { /* leave weightOz=0 on parse fail */ }
    await pushShippingMetaToCM({
      orderId: row.order_id,
      weightOz,
      serviceCode: shipment.serviceCode || row.service_code,
      packageCode: shipment.packageCode || row.package_code,
      carrierCode: shipment.carrierCode || row.carrier_code,
      trackingNumber: row.tracking_number,
      shipmentId,
      shippedAt: shipment.shipDate || row.shipped_at,
    });
  } catch (err) {
    console.warn(
      `[backfill-shipment-id] order ${row.order_id}: CM push failed (shipmentId written locally) — ${err.message}`
    );
  }

  console.log(
    `[backfill-shipment-id] order ${row.order_id}: shipmentId=${shipmentId} written`
  );
  return 'recovered';
}

async function main() {
  const args = parseArgs();

  const dbPath = path.join(__dirname, '..', 'config', 'sytist-dashboard.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  if (args.repushOnly) {
    await runRepushOnly(db, args);
    return;
  }

  console.log('▸ shipment_id backfill');
  console.log('');

  // Preview.
  const previewQ = buildPreviewCountQuery(args.sinceDays);
  const candidateCount = db.prepare(previewQ.sql).get(previewQ.params).n;

  console.log('  Thresholds:');
  console.log(`    • batch size              ${BATCH_SIZE} per round`);
  console.log(
    `    • since-days bound        ${
      args.sinceDays > 0 ? `${args.sinceDays} days (default 30)` : 'unbounded (--since-days=0)'
    }`
  );
  console.log('');
  console.log('  Preview:');
  console.log(`    • Candidates for shipmentId backfill  ${candidateCount}`);
  console.log('');

  if (args.dryRun) {
    console.log('✓ Dry run — no writes performed.');
    db.close();
    process.exit(0);
  }
  if (candidateCount === 0) {
    console.log('✓ Nothing to do.');
    db.close();
    process.exit(0);
  }
  if (!args.yes) {
    const answer = await ask('Proceed with backfill? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('✗ Cancelled — no writes performed.');
      db.close();
      process.exit(1);
    }
    console.log('');
  }

  const totals = {
    rounds: 0,
    recovered: 0,
    skipped_no_shipment_id: 0,
    ss_errors: 0,
    local_errors: 0,
  };

  for (let round = 1; round <= args.maxRounds; round++) {
    totals.rounds = round;
    const candQ = buildCandidateQuery(args.sinceDays);
    const candidates = db.prepare(candQ.sql).all(candQ.params);
    if (candidates.length === 0) break;

    console.log(`─── round ${round} (${candidates.length} candidates) ───`);
    for (const row of candidates) {
      const outcome = await processRow(row);
      if (outcome === 'recovered') totals.recovered += 1;
      else if (outcome === 'skipped_no_shipment_id') totals.skipped_no_shipment_id += 1;
      else if (outcome === 'ss_error') totals.ss_errors += 1;
      else if (outcome === 'local_error') totals.local_errors += 1;
    }
  }

  console.log('');
  console.log('✓ Backfill complete.');
  console.log(`  Rounds:                 ${totals.rounds}`);
  console.log(`  Recovered:              ${totals.recovered}`);
  console.log(`  Skipped (no shipment):  ${totals.skipped_no_shipment_id}`);
  console.log(`  SS errors:              ${totals.ss_errors}`);
  console.log(`  Local errors:           ${totals.local_errors}`);

  db.close();
}

// --repush-only branch. Reconciles the 2026-09-04 type-mismatch
// incident: local shipstation_links.shipment_id populated, CM has
// null because the initial push 400d on the numeric-shipmentId bug.
// After the coercion fix in pushShippingMetaToCM.js this run should
// succeed for every row (CM's upsert is COALESCE-protected).
async function runRepushOnly(db, args) {
  console.log('▸ shipment_id backfill — --repush-only mode');
  console.log('');

  const previewQ = buildRepushCountQuery(args.sinceDays);
  const candidateCount = db.prepare(previewQ.sql).get(previewQ.params).n;
  console.log('  Thresholds:');
  console.log(
    `    • since-days bound        ${
      args.sinceDays > 0 ? `${args.sinceDays} days (default 30)` : 'unbounded (--since-days=0)'
    }`
  );
  console.log('');
  console.log('  Preview:');
  console.log(`    • Rows locally-populated shipment_id  ${candidateCount}`);
  console.log('    (SS not called; CM upserted with COALESCE.)');
  console.log('');

  if (args.dryRun) {
    console.log('✓ Dry run — no writes performed.');
    db.close();
    process.exit(0);
  }
  if (candidateCount === 0) {
    console.log('✓ Nothing to do.');
    db.close();
    process.exit(0);
  }
  if (!args.yes) {
    const answer = await ask('Proceed with re-push? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('✗ Cancelled — no writes performed.');
      db.close();
      process.exit(1);
    }
    console.log('');
  }

  const candQ = buildRepushCandidateQuery(args.sinceDays);
  const candidates = db.prepare(candQ.sql).all(candQ.params);
  const totals = { repushed: 0, push_errors: 0 };
  for (const row of candidates) {
    const outcome = await repushRow(row);
    if (outcome === 'repushed') totals.repushed += 1;
    else if (outcome === 'push_error') totals.push_errors += 1;
  }

  console.log('');
  console.log('✓ Re-push complete.');
  console.log(`  Re-pushed:   ${totals.repushed}`);
  console.log(`  Push errors: ${totals.push_errors}`);

  db.close();
}

main().catch((err) => {
  console.error(`✗ Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});

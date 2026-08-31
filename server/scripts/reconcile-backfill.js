// CLI for the tracking-reconcile BACKFILL pass.
//
// Sweeps ALL historical shipstation_links rows with null tracking on
// tracking-bearing mail classes (package_code='package'), re-polls
// ShipStation for each, and writes back tracking where found.
//
// The ONGOING reconcile is wired into schedulerService and runs every
// 5 minutes with a grace period + give-up ceiling. This CLI is for
// the one-shot cold-start: when you deploy, ~458 historical rows
// need to be swept without waiting for them to naturally age into
// the ongoing pass. After this drains, the ongoing pass keeps
// steady-state.
//
// Usage:
//   node scripts/reconcile-backfill.js --dry-run
//     → prints counts (candidates to retry, would-be-given-up rows,
//       existing gave_up rows) and EXITS. No writes.
//
//   node scripts/reconcile-backfill.js
//     → prints the same preview, prompts y/N, then runs. Repeats
//       BATCH_SIZE-per-round until no candidates remain OR --max-rounds
//       hit. Runs the give-up sweep AT THE END.
//
//   node scripts/reconcile-backfill.js --yes
//     → skips the interactive prompt. Same behavior otherwise.
//
//   node scripts/reconcile-backfill.js --max-rounds=N
//     → cap on total batch iterations. Default 200 (~10,000 rows
//       at 50/round) — practical ceiling to catch runaway conditions;
//       real runs on ~500 historical rows finish in <20 rounds.
//
//   node scripts/reconcile-backfill.js --since-days=N
//     → bound backfill to rows shipped in the last N days. OPT-IN,
//       defaults to unbounded. Useful when the backlog is large and
//       older tracking has no operator value (a customer isn't
//       clicking a tracked-email link for an order that arrived
//       months ago). Compose with the other flags freely, e.g.
//       `--dry-run --since-days=30` to preview only.
//       The chosen bound is printed in the preview output alongside
//       the fixed thresholds so it's always visible before writes.
//
//   node scripts/reconcile-backfill.js --debug-order=<sytistOrderId>
//     → DIAGNOSTIC. Looks up the shipstation_links row for the
//       Sytist orderId, then dumps three raw payloads side-by-side:
//         (1) the local link row (what identifier we're using)
//         (2) GET /orders/{ss_order_id}       — the shape reconcile
//             + scheduler currently read tracking from
//         (3) GET /shipments?orderId=<ss>     — the authoritative
//             shipment source; if tracking lives here but not in
//             (2), the read pattern is wrong (not the timing).
//       Writes NOTHING. Exits after printing. Meant for the exact
//       question "SS UI shows tracking but our reconcile can't
//       find it — is it a wrong-endpoint problem or a wrong-
//       identifier problem?"
//
// The give-up count printed in the preview is what Joey specifically
// asked to see BEFORE running: the number of ancient rows that will
// be marked 'gave_up' in the log so they stop matching subsequent
// reconcile queries. Load-bearing exclusion — see the base predicate
// in shippingMetaReconcileService.js.
//
// Safety:
//   - Best-effort throughout. Any SS API error / MySQL error / CM
//     push failure on a single row is logged + counted, never
//     re-thrown.
//   - Fetches are rate-limited by BATCH_SIZE per round (50) and by
//     the round-loop being sequential (not parallel) — SS V1 API
//     rate limit is 40 req/min per key.
//   - Idempotent: re-running catches nothing on the second pass
//     (everything either recovered, still-missing-with-recent-attempt,
//     or gave-up).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const readline = require('readline');
const reconcileService = require('../services/shippingMetaReconcileService');

function parseArgs() {
  const args = {
    dryRun: false, yes: false, maxRounds: 200, sinceDays: null,
    debugOrder: null,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--max-rounds=')) {
      const n = parseInt(arg.slice('--max-rounds='.length), 10);
      if (Number.isFinite(n) && n > 0) args.maxRounds = n;
    } else if (arg.startsWith('--since-days=')) {
      const raw = arg.slice('--since-days='.length);
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✗ Invalid --since-days value: "${raw}" (must be a positive integer)`);
        process.exit(1);
      }
      args.sinceDays = n;
    } else if (arg.startsWith('--debug-order=')) {
      const raw = arg.slice('--debug-order='.length).trim();
      if (raw === '') {
        console.error('✗ --debug-order requires a value (Sytist orderId)');
        process.exit(1);
      }
      args.debugOrder = raw;
    } else if (arg === '--help' || arg === '-h') {
      // Trim leading whitespace from the file's header comment for a --help output
      console.log(
        [
          'Usage:',
          '  node scripts/reconcile-backfill.js --dry-run              Print counts only, no writes.',
          '  node scripts/reconcile-backfill.js                        Print preview, prompt y/N, run.',
          '  node scripts/reconcile-backfill.js --yes                  Skip prompt.',
          '  node scripts/reconcile-backfill.js --max-rounds=N         Cap round iterations.',
          '  node scripts/reconcile-backfill.js --since-days=N         Bound to shipped_at > NOW - N days',
          '                                                            (opt-in; default unbounded).',
          '  node scripts/reconcile-backfill.js --debug-order=<id>     Dump SS raw payloads for one order,',
          '                                                            no writes. Diagnostic tool.',
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

async function main() {
  const args = parseArgs();

  if (args.debugOrder) {
    await runDebugOrder(args.debugOrder);
    process.exit(0);
  }

  console.log('▸ Tracking-reconcile backfill');
  console.log('');

  const preview = reconcileService.previewCounts({
    backfill: true,
    sinceDays: args.sinceDays,
  });
  if (!preview.available) {
    console.error('✗ Reconcile DB unavailable (better-sqlite3 not loadable).');
    process.exit(1);
  }

  console.log('  Thresholds:');
  console.log(`    • grace period            ${preview.thresholds.gracePeriodMinutes} min`);
  console.log(`    • retry-recency floor     ${preview.thresholds.retryIntervalMinutes} min`);
  console.log(`    • give-up ceiling         ${preview.thresholds.giveUpHours} h`);
  console.log(`    • batch size              ${preview.thresholds.batchSize} per round`);
  console.log(`    • tracking-bearing class  package_code = '${preview.thresholds.trackingBearingPackageCode}'`);
  console.log(
    `    • since-days bound        ${
      preview.thresholds.sinceDays == null
        ? 'unbounded (default)'
        : `${preview.thresholds.sinceDays} days (--since-days=${preview.thresholds.sinceDays})`
    }`
  );
  console.log('');
  console.log('  Preview:');
  console.log(`    • Candidates for retry              ${preview.candidatesForRetry}`);
  console.log(`    • Would be marked gave_up (>${preview.thresholds.giveUpHours}h old)  ${preview.wouldGiveUp}`);
  console.log(`    • Existing gave_up rows in log      ${preview.alreadyGaveUp}`);
  console.log('');

  if (args.dryRun) {
    console.log('✓ Dry run — no writes performed.');
    process.exit(0);
  }

  if (preview.candidatesForRetry === 0 && preview.wouldGiveUp === 0) {
    console.log('✓ Nothing to do.');
    process.exit(0);
  }

  if (!args.yes) {
    const answer = await ask('Proceed with backfill? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('✗ Cancelled — no writes performed.');
      process.exit(1);
    }
    console.log('');
  }

  const totals = {
    rounds: 0,
    recovered: 0,
    still_missing: 0,
    ss_errors: 0,
    given_up: 0,
  };

  // Round loop — reconcile only. NO give-up sweep per round; with
  // BATCH_SIZE=50 and ~458 historical rows, a per-round sweep would
  // mark the other ~408 as gave_up in round 1 before rounds 2-10
  // ever got to try them. Sweep runs explicitly AFTER the loop
  // drains — every ancient row gets exactly one reconcile attempt.
  for (let round = 1; round <= args.maxRounds; round++) {
    totals.rounds = round;
    console.log(`─── round ${round} ───`);
    const summary = await reconcileService.runReconcileTick({
      backfill: true,
      runGiveUp: false,
      sinceDays: args.sinceDays,
    });
    totals.recovered += summary.recovered;
    totals.still_missing += summary.still_missing;
    totals.ss_errors += summary.ss_errors;
    console.log(
      `    round ${round}: candidates=${summary.candidates} ` +
        `recovered=${summary.recovered} still_missing=${summary.still_missing} ` +
        `ss_errors=${summary.ss_errors}`
    );
    if (summary.candidates === 0) {
      // Nothing left to work on. Round-loop-complete.
      break;
    }
  }

  // Final give-up sweep — after every ancient row has had its one
  // chance. Marks whatever remains at NULL tracking + >24h as
  // 'gave_up' so the ongoing scheduler tick excludes them forever
  // via the NOT EXISTS clause.
  console.log('─── final give-up sweep ───');
  const sweep = reconcileService.runGiveUpSweep();
  totals.given_up = sweep.rowsMarked || 0;
  console.log(`    marked ${totals.given_up} row(s) as gave_up`);

  console.log('');
  console.log('✓ Backfill complete.');
  console.log(`  Rounds:        ${totals.rounds}`);
  console.log(`  Recovered:     ${totals.recovered}`);
  console.log(`  Still missing: ${totals.still_missing}`);
  console.log(`  SS errors:     ${totals.ss_errors}`);
  console.log(`  Given up:      ${totals.given_up}`);
  console.log('');
  console.log('Query recovery-delay distribution:');
  console.log(
    "  sqlite3 server/config/sytist-dashboard.db \\\n" +
      "    \"SELECT round(AVG((julianday(reconciled_at) - julianday(shipped_at))*24*60),1) AS avg_delay_min, \\\n" +
      "            MAX((julianday(reconciled_at) - julianday(shipped_at))*24*60) AS max_delay_min, \\\n" +
      "            COUNT(*) AS recovered_rows \\\n" +
      "       FROM shipping_meta_reconcile_log \\\n" +
      "      WHERE outcome='recovered' AND shipped_at IS NOT NULL;\""
  );
}

/**
 * Diagnostic — dump raw SS payloads for one Sytist order. No writes.
 *
 * Purpose: the current read pattern (both scheduler + reconcile)
 * pulls tracking from `GET /orders/{id}.shipments[N].trackingNumber`.
 * That pattern has produced 100% nulls over ~30 days AND the first
 * reconcile backfill run recovered 0/100. ShipStation's UI clearly
 * shows tracking for the same orders — so the read is wrong (or the
 * identifier is wrong), not just late. This tool prints three
 * ground-truth payloads side-by-side so the operator can see:
 *
 *   (A) The local `shipstation_links` row — what identifier we're
 *       actually holding, and its column-by-column state.
 *
 *   (B) `GET /orders/{ss_order_id}` — the response the current read
 *       operates on. Its `shipments[]` array is the source that
 *       returns null. Dumped in full so we can see whether it's
 *       missing, empty, populated-without-trackingNumber, or
 *       populated-with-tracking-that-our-extractor-is-mishandling.
 *
 *   (C) `GET /shipments?orderId={ss_order_id}` — the /shipments
 *       endpoint. Per Joey's follow-up: tracking numbers belong to
 *       SHIPMENT records, not order records. A label-buy creates a
 *       shipment. /orders may return a stale/empty shipments[]
 *       inline while the /shipments query returns the actual
 *       shipment records with tracking. If (C) has tracking that
 *       (B) does not, the fix is a new read pattern that calls
 *       /shipments; if BOTH are empty, the identifier is wrong or
 *       the SS account is doing something we don't yet understand.
 *
 *   (D) `GET /shipments?orderNumber={ss_order_number}` — same
 *       endpoint keyed on orderNumber instead. If (C) is empty but
 *       (D) returns a shipment, the identifier column drift
 *       hypothesis (Joey's Q3) is proven — ss_order_id may hold
 *       an orderNumber where the SS integer ID belongs.
 *
 * Everything caught + printed; no data written; exits 0 regardless.
 */
async function runDebugOrder(sytistOrderId) {
  const shipstationLinkService = require('../services/shipstationLinkService');
  const shipstationService = require('../services/shipstationService');

  console.log(`▸ SS diagnostic for Sytist order ${sytistOrderId}`);
  console.log('');

  // ── (A) local link row ─────────────────────────────────────────
  let link = null;
  try {
    link = shipstationLinkService.getByOrderId(sytistOrderId);
  } catch (err) {
    console.error(`✗ Failed to read local link row: ${err.message}`);
    return;
  }
  console.log('(A) Local shipstation_links row:');
  if (!link) {
    console.log(`    (no row for order_id=${sytistOrderId})`);
    console.log('    Nothing to look up in SS — stopping.');
    return;
  }
  console.log(JSON.stringify(link, null, 2));
  console.log('');

  // ── (B) GET /orders/{ss_order_id} ─────────────────────────────
  console.log(`(B) GET /orders/${link.ss_order_id}`);
  console.log('    (this is the response the current reconcile + scheduler read)');
  let orderResp = null;
  try {
    orderResp = await shipstationService.getOrder(link.ss_order_id);
    console.log(JSON.stringify(orderResp, null, 2));
  } catch (err) {
    console.log(`    ✗ FAILED: HTTP ${err?.response?.status ?? 'network'} — ${err.message}`);
    if (err?.response?.data) {
      console.log('    response body:');
      console.log(JSON.stringify(err.response.data, null, 2));
    }
  }
  console.log('');

  // Highlight what our extractor would pull, per the current code
  // path in _reconcileOne + schedulerService line 248-251.
  if (orderResp) {
    const shipments = orderResp.shipments || [];
    const latest = shipments[shipments.length - 1];
    console.log('    Current extractor read:');
    console.log(`      shipments.length      = ${shipments.length}`);
    console.log(`      latest?.trackingNumber = ${JSON.stringify(latest?.trackingNumber)}`);
    console.log(`      ssOrder.trackingNumber = ${JSON.stringify(orderResp.trackingNumber)}`);
    console.log(`      → derived tracking     = ${JSON.stringify(latest?.trackingNumber || orderResp.trackingNumber || null)}`);
    console.log('');
  }

  // ── (C) GET /shipments?orderId={ss_order_id} ──────────────────
  console.log(`(C) GET /shipments?orderId=${link.ss_order_id}`);
  console.log('    (the authoritative source — tracking lives on shipment records)');
  try {
    const shResp = await shipstationService.listShipments({
      orderId: link.ss_order_id,
      pageSize: 500,
      sortBy: 'CreateDate',
      sortDir: 'DESC',
    });
    console.log(JSON.stringify(shResp, null, 2));
    const shipments = shResp?.shipments || [];
    console.log('');
    console.log('    Trackings visible on /shipments (all rows):');
    if (shipments.length === 0) {
      console.log('      (no shipments returned for this ss_order_id)');
    } else {
      for (const s of shipments) {
        console.log(
          `      shipmentId=${s.shipmentId} orderId=${s.orderId} orderNumber=${s.orderNumber} ` +
            `trackingNumber=${JSON.stringify(s.trackingNumber)} carrierCode=${s.carrierCode} ` +
            `voided=${s.voided}`
        );
      }
    }
  } catch (err) {
    console.log(`    ✗ FAILED: HTTP ${err?.response?.status ?? 'network'} — ${err.message}`);
    if (err?.response?.data) {
      console.log('    response body:');
      console.log(JSON.stringify(err.response.data, null, 2));
    }
  }
  console.log('');

  // ── (D) GET /shipments?orderNumber={ss_order_number} ──────────
  // Only runs if we have an orderNumber to try — this is the
  // identifier-drift check per Joey's Q3.
  if (link.ss_order_number) {
    console.log(`(D) GET /shipments?orderNumber=${link.ss_order_number}`);
    console.log('    (identifier-drift check: same query keyed on orderNumber)');
    try {
      const shResp2 = await shipstationService.listShipments({
        orderNumber: link.ss_order_number,
        pageSize: 500,
        sortBy: 'CreateDate',
        sortDir: 'DESC',
      });
      console.log(JSON.stringify(shResp2, null, 2));
      const shipments2 = shResp2?.shipments || [];
      console.log('');
      console.log('    Trackings visible via orderNumber lookup:');
      if (shipments2.length === 0) {
        console.log('      (no shipments returned for this ss_order_number)');
      } else {
        for (const s of shipments2) {
          console.log(
            `      shipmentId=${s.shipmentId} orderId=${s.orderId} orderNumber=${s.orderNumber} ` +
              `trackingNumber=${JSON.stringify(s.trackingNumber)} carrierCode=${s.carrierCode} ` +
              `voided=${s.voided}`
          );
        }
      }
    } catch (err) {
      console.log(`    ✗ FAILED: HTTP ${err?.response?.status ?? 'network'} — ${err.message}`);
      if (err?.response?.data) {
        console.log('    response body:');
        console.log(JSON.stringify(err.response.data, null, 2));
      }
    }
  } else {
    console.log('(D) SKIPPED — link row has no ss_order_number to try');
  }
  console.log('');
  console.log('✓ Diagnostic complete. No writes.');
}

main().catch((err) => {
  console.error(`✗ Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});

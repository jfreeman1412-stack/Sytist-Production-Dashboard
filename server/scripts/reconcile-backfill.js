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
  const args = { dryRun: false, yes: false, maxRounds: 200 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--max-rounds=')) {
      const n = parseInt(arg.slice('--max-rounds='.length), 10);
      if (Number.isFinite(n) && n > 0) args.maxRounds = n;
    } else if (arg === '--help' || arg === '-h') {
      // Trim leading whitespace from the file's header comment for a --help output
      console.log(
        [
          'Usage:',
          '  node scripts/reconcile-backfill.js --dry-run   Print counts only, no writes.',
          '  node scripts/reconcile-backfill.js             Print preview, prompt y/N, run.',
          '  node scripts/reconcile-backfill.js --yes       Skip prompt.',
          '  node scripts/reconcile-backfill.js --max-rounds=N   Cap round iterations.',
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

  console.log('▸ Tracking-reconcile backfill');
  console.log('');

  const preview = reconcileService.previewCounts({ backfill: true });
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

main().catch((err) => {
  console.error(`✗ Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});

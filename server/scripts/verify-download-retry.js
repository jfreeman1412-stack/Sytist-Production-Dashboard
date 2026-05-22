// Phase 61 verification harness — download retry/timeout classification.
// Exercises the REAL processingService._downloadWithRetry by stubbing the
// single-attempt primitive _downloadFile. No real network.
//
// Covers:
//   - transient failure retried then succeeds (retry counted)
//   - terminal 4xx fails immediately (NO retry — source genuinely missing)
//   - 429/408 are transient (retried) even though they're 4xx
//   - all-transient exhausts the attempt budget then throws

process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const proc = require('../services/processingService');

if (typeof proc._downloadWithRetry !== 'function' || typeof proc._isTerminalDownloadError !== 'function') {
  console.error('FAIL: processingService retry helpers are not exposed');
  process.exit(1);
}

// Build an error like the ones _downloadFile throws.
function httpError(status) {
  const e = new Error(`HTTP ${status} fetching x`);
  e.status = status;
  return e;
}
function networkError(code) {
  const e = new Error('fetch failed');
  e.cause = { code };
  return e;
}

// Run one scenario: feed a queue of behaviors to a stubbed _downloadFile.
// Each behavior is either an Error (throw it) or 'ok' (resolve). Returns
// { ok, attempts, error }.
async function runScenario(behaviors, opts = {}) {
  let attempts = 0;
  proc._downloadFile = async () => {
    const b = behaviors[Math.min(attempts, behaviors.length - 1)];
    attempts += 1;
    if (b === 'ok') return 'dest';
    throw b;
  };
  // Tiny backoffs so the harness is fast.
  const merged = { attempts: 4, backoffsMs: [1, 1, 1], timeoutMs: 50, ...opts };
  try {
    await proc._downloadWithRetry('http://x/y.jpg', 'dest', merged);
    return { ok: true, attempts };
  } catch (err) {
    return { ok: false, attempts, error: err };
  }
}

let pass = 0;
const fails = [];
async function expect(name, fn) {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fails.push(name); console.log(`  FAIL  ${name}`); }
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL  ${name} — threw ${e.message}`);
  }
}

(async () => {
  // 1. Transient (network) fails twice, then succeeds → ok, 3 attempts.
  await expect('transient x2 then success → ok, 3 attempts', async () => {
    const r = await runScenario([networkError('ECONNRESET'), networkError('ETIMEDOUT'), 'ok']);
    return r.ok === true && r.attempts === 3;
  });

  // 2. Terminal 404 → fails on attempt 1, NO retry.
  await expect('terminal 404 → fail, 1 attempt (no retry)', async () => {
    const r = await runScenario([httpError(404)]);
    return r.ok === false && r.attempts === 1 && r.error.status === 404;
  });

  // 3. 429 (Too Many Requests) is transient → retried, then succeeds.
  await expect('429 then success → ok, retried (429 is transient)', async () => {
    const r = await runScenario([httpError(429), 'ok']);
    return r.ok === true && r.attempts === 2;
  });

  // 4. 500 (server error) is transient → retried.
  await expect('500 then success → ok, retried (5xx is transient)', async () => {
    const r = await runScenario([httpError(500), 'ok']);
    return r.ok === true && r.attempts === 2;
  });

  // 5. All-transient → exhausts the 4-attempt budget then throws.
  await expect('all-transient → throws after 4 attempts', async () => {
    const r = await runScenario([networkError('ENOTFOUND')]); // always throws
    return r.ok === false && r.attempts === 4;
  });

  // 6. Classifier unit checks.
  await expect('classifier: 404 terminal, 500/429/408 + network transient', async () => {
    return (
      proc._isTerminalDownloadError(httpError(404)) === true &&
      proc._isTerminalDownloadError(httpError(403)) === true &&
      proc._isTerminalDownloadError(httpError(408)) === false &&
      proc._isTerminalDownloadError(httpError(429)) === false &&
      proc._isTerminalDownloadError(httpError(500)) === false &&
      proc._isTerminalDownloadError(networkError('ECONNRESET')) === false
    );
  });

  console.log(`\n${pass}/${pass + fails.length} download-retry cases pass`);
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})();

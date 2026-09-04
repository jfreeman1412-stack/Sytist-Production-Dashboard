// Verify harness for pushShippingMetaToCM's payload coercion at the
// push boundary.
//
// WHY THIS EXISTS
// ---------------
// Prod incident 2026-09-04: ShipStation returns shipmentId as a
// NUMBER (verified against the delivered-shipment probe: `"shipmentId":
// 338306983` — unquoted). The dashboard's callers pass it through
// unchanged. CM's route validates shipmentId as a non-empty STRING —
// so every push carrying a real shipmentId 400'd until the coercion
// landed in pushShippingMetaToCM.js.
//
// Neither side's tests caught this because both used string fixtures
// (CM's routes.sytistShippingMeta.test.ts + backfill-shipment-id.js
// fixture). This harness locks the coercion in: assertions run on the
// actual HTTP body constructed by pushShippingMetaToCM, with a
// numeric-input case that would have caught the bug.
//
// Same shape as verify-reconcile-queries.js / verify-shipment-
// extraction.js — mock the boundary, assert on outputs, exit code
// signals pass/fail. No test framework dependency.
//
// Run:
//   node server/scripts/verify-push-boundary.js
//
// Exit code 0 = all pass. Non-zero = failure printed to stderr.

// Mock global fetch to CAPTURE the payload instead of hitting CM.
// pushShippingMetaToCM uses the global fetch; we swap it for the
// duration of the harness. appSettings is real — it reads the
// on-disk config; the harness fakes the config values via
// process.env-style shimming.
const path = require('path');

// Force appSettings to think push is configured — otherwise loadConfig
// returns null and the whole function no-ops. We stub the module
// BEFORE the target loads.
const Module = require('module');
const originalResolve = Module._resolve_filename;

// Simple shim: intercept require('../config/appSettings') to return
// a stub with the two keys pushShippingMetaToCM reads.
const appSettingsPath = require.resolve(path.join(__dirname, '..', 'config', 'appSettings'));
const originalCache = require.cache[appSettingsPath];
require.cache[appSettingsPath] = {
  id: appSettingsPath,
  filename: appSettingsPath,
  loaded: true,
  exports: {
    getRawValueSync: (key) => {
      if (key === 'dashboardPushToCmUrl') return 'http://harness.local/api/sytist/shipping-meta';
      if (key === 'dashboardPushToCmSecret') return 'harness-secret';
      return '';
    },
  },
};

// better-sqlite3 shim: pushShippingMetaToCM opens the log db lazily;
// for the harness we don't want to touch the real db. Swap require
// so a call to require('better-sqlite3') returns a no-op stub.
const dbPath = path.join(__dirname, '..', 'config', 'sytist-dashboard.db');
const betterSqliteId = require.resolve('better-sqlite3');
require.cache[betterSqliteId] = {
  id: betterSqliteId,
  filename: betterSqliteId,
  loaded: true,
  exports: function stubDatabase() {
    return {
      pragma: () => {},
      exec: () => {},
      prepare: () => ({
        run: () => ({}),
      }),
    };
  },
};

// Now require the target. Its top-level try/catch on better-sqlite3
// will succeed (we gave it a stub).
const { pushShippingMetaToCM } = require('../services/pushShippingMetaToCM');

// ── fetch mock capturing the body ─────────────────────────────────
let capturedBody = null;
let capturedHeaders = null;
let capturedMethod = null;

const originalFetch = global.fetch;
global.fetch = async (url, init) => {
  capturedMethod = init?.method || 'GET';
  capturedHeaders = init?.headers || {};
  try {
    capturedBody = JSON.parse(init?.body || '{}');
  } catch (_) {
    capturedBody = init?.body;
  }
  // Return a fake 200 so the target considers the push successful.
  return {
    ok: true,
    status: 200,
    text: async () => '',
  };
};

// ── assertions ────────────────────────────────────────────────────
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function reset() {
  capturedBody = null;
  capturedHeaders = null;
  capturedMethod = null;
}

async function main() {
  console.log('▸ pushShippingMetaToCM — payload coercion at the push boundary');
  console.log('');

  // ── Case 1: numeric shipmentId (SS actual behavior) → string on wire ─
  await reset();
  await pushShippingMetaToCM({
    orderId: 117558,
    weightOz: 8,
    serviceCode: 'usps_first_class_mail',
    packageCode: 'package',
    carrierCode: 'stamps_com',
    trackingNumber: '9400111899000000000000',
    // Deliberately NUMBER — this was the prod incident.
    shipmentId: 338255113,
    shippedAt: '2026-08-31T18:00:00Z',
  });
  check('numeric shipmentId is coerced to STRING on the wire (the prod-incident regression)', () => {
    assert(capturedBody !== null, 'no body captured — did the push happen?');
    assert(
      typeof capturedBody.shipmentId === 'string',
      `expected shipmentId type 'string' on wire, got '${typeof capturedBody.shipmentId}' (value: ${JSON.stringify(capturedBody.shipmentId)})`
    );
    assert(
      capturedBody.shipmentId === '338255113',
      `expected '338255113' string on wire, got ${JSON.stringify(capturedBody.shipmentId)}`
    );
  });

  // ── Case 2: string shipmentId (backfill CLI path) → unchanged ────
  await reset();
  await pushShippingMetaToCM({
    orderId: 117420,
    weightOz: 8,
    serviceCode: 'usps_first_class_mail',
    packageCode: 'package',
    carrierCode: 'stamps_com',
    trackingNumber: '9400111899000000000000',
    shipmentId: '338306983', // already a string
    shippedAt: '2026-08-31T18:00:00Z',
  });
  check('string shipmentId passes through unchanged', () => {
    assert(capturedBody.shipmentId === '338306983', `expected pass-through, got ${JSON.stringify(capturedBody.shipmentId)}`);
  });

  // ── Case 3: null shipmentId → null on wire ───────────────────────
  await reset();
  await pushShippingMetaToCM({
    orderId: 117999,
    weightOz: 8,
    serviceCode: 'usps_first_class_mail',
    packageCode: 'package',
    carrierCode: 'stamps_com',
    trackingNumber: '9400111899000000000000',
    shipmentId: null,
    shippedAt: '2026-08-31T18:00:00Z',
  });
  check('null shipmentId stays null on wire (pre-Ship-2 backlog path)', () => {
    assert(capturedBody.shipmentId === null, `expected null, got ${JSON.stringify(capturedBody.shipmentId)}`);
  });

  // ── Case 4: undefined shipmentId → null on wire ──────────────────
  await reset();
  await pushShippingMetaToCM({
    orderId: 118000,
    weightOz: 8,
    serviceCode: 'usps_first_class_mail',
    packageCode: 'package',
    carrierCode: 'stamps_com',
    trackingNumber: '9400111899000000000000',
    // shipmentId deliberately omitted
    shippedAt: '2026-08-31T18:00:00Z',
  });
  check('omitted shipmentId → null on wire', () => {
    assert(capturedBody.shipmentId === null, `expected null, got ${JSON.stringify(capturedBody.shipmentId)}`);
  });

  // ── Case 5: numeric shipmentId that STRINGIFIES to leading-zero — verify no
  //           precision loss (SS shipmentIds are integers <= 2^32, safe in JS number).
  await reset();
  await pushShippingMetaToCM({
    orderId: 118001,
    weightOz: 8,
    serviceCode: 'usps_first_class_mail',
    packageCode: 'package',
    carrierCode: 'stamps_com',
    trackingNumber: '9400111899000000000000',
    shipmentId: 1,
    shippedAt: '2026-08-31T18:00:00Z',
  });
  check('small numeric shipmentId (1) → "1" on wire (edge)', () => {
    assert(capturedBody.shipmentId === '1', `got ${JSON.stringify(capturedBody.shipmentId)}`);
  });

  // ── Case 6: assert header shape (unchanged by hotfix; guards against regression) ─
  check('POST with X-Dashboard-Secret header + application/json content-type', () => {
    assert(capturedMethod === 'POST', `method was ${capturedMethod}`);
    assert(capturedHeaders['Content-Type'] === 'application/json', 'wrong content type');
    assert(
      capturedHeaders['X-Dashboard-Secret'] === 'harness-secret',
      'secret header missing or wrong'
    );
  });

  console.log('');
  if (failures > 0) {
    console.error(`✗ verify-push-boundary: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`✓ verify-push-boundary: 6/6 passed`);
}

main()
  .catch((err) => {
    console.error(`✗ Unexpected error: ${err.stack || err.message}`);
    process.exit(2);
  })
  .finally(() => {
    global.fetch = originalFetch;
    if (originalCache) require.cache[appSettingsPath] = originalCache;
  });

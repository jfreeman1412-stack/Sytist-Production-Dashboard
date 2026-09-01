// Verify harness for ShipStation /shipments extraction logic.
//
// WHY THIS EXISTS
// ---------------
// The tracking-reconcile that shipped Aug 31 2026 recovered 0/100
// on its first live run because it inherited the scheduler's read
// pattern `latest.trackingNumber || ssOrder.trackingNumber` from
// GET /orders/{id}, which has NEVER carried tracking on this
// account since Phase 13e. Not one of the 35 SQL-correctness tests
// I shipped could catch this: they proved the SQL parses and
// filters correctly, said nothing about whether the SS response
// shape was what the code assumed.
//
// This harness exists so that assumption is testable. It exercises
// the pure functions on shipstationService that operate over the
// shipment shape — _pickBestShipment and _extractShipmentFields
// — with fixtures modeled after real SS payloads (voided flag,
// shipmentCost as number-or-string, shipDate vs createDate
// fallback, 000-prefix reference-number filtering, empty/missing
// tracking). The paginated fetch itself is not tested here — it's
// I/O — but the code path that decides what to DO with a fetched
// shipments list IS tested.
//
// Same shape as the other server/scripts/verify-*.js harnesses:
// plain node, assert, exits 0/1.

const assert = require('assert');
const ss = require('../services/shipstationService');

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

// ─── _pickBestShipment ───────────────────────────────────────────

console.log('▸ _pickBestShipment');

check('returns null on empty array', () => {
  assert.strictEqual(ss._pickBestShipment([]), null);
});

check('returns null on null / non-array input', () => {
  assert.strictEqual(ss._pickBestShipment(null), null);
  assert.strictEqual(ss._pickBestShipment(undefined), null);
  assert.strictEqual(ss._pickBestShipment({}), null);
});

check('picks the only non-voided shipment', () => {
  const shipments = [
    { shipmentId: 1, voided: false, shipDate: '2026-08-15', trackingNumber: 'A' },
  ];
  assert.strictEqual(ss._pickBestShipment(shipments).shipmentId, 1);
});

check('returns null when every shipment is voided', () => {
  const shipments = [
    { shipmentId: 1, voided: true, shipDate: '2026-08-15', trackingNumber: 'VOIDED' },
    { shipmentId: 2, voided: true, shipDate: '2026-08-20', trackingNumber: 'VOIDED2' },
  ];
  assert.strictEqual(ss._pickBestShipment(shipments), null);
});

check('picks most recent by shipDate DESC regardless of input order', () => {
  // Feed them in ASCENDING order to prove sort is our responsibility.
  const shipments = [
    { shipmentId: 2, voided: false, shipDate: '2026-08-15', trackingNumber: 'OLD' },
    { shipmentId: 3, voided: false, shipDate: '2026-08-20', trackingNumber: 'NEWEST' },
    { shipmentId: 4, voided: false, shipDate: '2026-08-18', trackingNumber: 'MID' },
  ];
  const best = ss._pickBestShipment(shipments);
  assert.strictEqual(best.shipmentId, 3);
  assert.strictEqual(best.trackingNumber, 'NEWEST');
});

check('picks the non-voided one even when a voided one is newer', () => {
  // Real scenario: operator voided a label on 08-20, purchased a
  // new one on 08-18. Must pick the 08-18 non-voided.
  const shipments = [
    { shipmentId: 5, voided: true,  shipDate: '2026-08-20', trackingNumber: 'VOIDED_LATE' },
    { shipmentId: 6, voided: false, shipDate: '2026-08-18', trackingNumber: 'REAL' },
  ];
  const best = ss._pickBestShipment(shipments);
  assert.strictEqual(best.shipmentId, 6);
  assert.strictEqual(best.trackingNumber, 'REAL');
});

check('falls back to createDate when shipDate missing', () => {
  const shipments = [
    { shipmentId: 7, voided: false, createDate: '2026-08-15', trackingNumber: 'A' },
    { shipmentId: 8, voided: false, createDate: '2026-08-20', trackingNumber: 'B' },
  ];
  const best = ss._pickBestShipment(shipments);
  assert.strictEqual(best.shipmentId, 8);
});

check('voided filter is STRICT === true (not truthy-coerced)', () => {
  // Defence against SS returning voided as "false" string or 0
  // making everything look voided. Only literal `true` should filter.
  const shipments = [
    { shipmentId: 9,  voided: 'false', shipDate: '2026-08-20', trackingNumber: 'STR_FALSE' },
    { shipmentId: 10, voided: 0,       shipDate: '2026-08-18', trackingNumber: 'ZERO' },
    { shipmentId: 11, voided: null,    shipDate: '2026-08-15', trackingNumber: 'NULL' },
  ];
  const best = ss._pickBestShipment(shipments);
  // Whichever wins the sort is fine; the important assertion is
  // that ANY of these three passes the filter (not filtered as
  // voided).
  assert(best !== null, 'strict-true filter must not treat string/0/null as voided');
  assert(['STR_FALSE', 'ZERO', 'NULL'].includes(best.trackingNumber));
});

// ─── _extractShipmentFields — tracking normalization ────────────

console.log('▸ _extractShipmentFields (tracking normalization)');

const trackingCases = [
  { input: '9400150206217898689993', expected: '9400150206217898689993' },
  { input: '  9400111899223197428347  ', expected: '9400111899223197428347' },
  { input: '', expected: null },
  { input: '   ', expected: null },
  { input: null, expected: null },
  { input: undefined, expected: null },
  { input: '000000000', expected: null,
    note: 'USPS flat reference number (not real tracking)' },
  { input: '0001234', expected: null,
    note: '000-prefix still filtered (per hasRealTracking regex)' },
  { input: '9400', expected: '9400',
    note: 'short tracking passes — length is not the check, 000-prefix is' },
];
for (const c of trackingCases) {
  check(`tracking: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}${c.note ? ` (${c.note})` : ''}`, () => {
    const out = ss._extractShipmentFields({ trackingNumber: c.input, voided: false });
    assert.strictEqual(out.trackingNumber, c.expected);
  });
}

// ─── _extractShipmentFields — shipmentCost normalization ────────

console.log('▸ _extractShipmentFields (shipmentCost normalization)');

const costCases = [
  { input: 5.58, expected: 5.58 },
  { input: 0, expected: 0, note: 'zero cost is valid — do not coerce to null' },
  { input: '5.58', expected: 5.58, note: 'string-numeric coerced' },
  { input: '0.00', expected: 0 },
  { input: -1, expected: null, note: 'negative rejected' },
  { input: '-2.50', expected: null, note: 'negative string rejected' },
  { input: null, expected: null },
  { input: undefined, expected: null },
  { input: '', expected: null },
  { input: '   ', expected: null },
  { input: 'abc', expected: null, note: 'garbage rejected' },
  { input: NaN, expected: null, note: 'NaN rejected' },
  { input: Infinity, expected: null, note: 'Infinity rejected' },
];
for (const c of costCases) {
  check(`cost: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}${c.note ? ` (${c.note})` : ''}`, () => {
    const out = ss._extractShipmentFields({ shipmentCost: c.input, voided: false });
    assert.strictEqual(out.shipmentCost, c.expected);
  });
}

// ─── _extractShipmentFields — shipDate fallback ─────────────────

console.log('▸ _extractShipmentFields (shipDate fallback + passthrough)');

check('shipDate present → used directly', () => {
  const out = ss._extractShipmentFields({
    shipDate: '2026-08-20T14:00:00.000Z', voided: false,
  });
  assert.strictEqual(out.shipDate, '2026-08-20T14:00:00.000Z');
});

check('shipDate missing → falls back to createDate', () => {
  const out = ss._extractShipmentFields({
    createDate: '2026-08-15T10:00:00.000Z', voided: false,
  });
  assert.strictEqual(out.shipDate, '2026-08-15T10:00:00.000Z');
});

check('neither present → null', () => {
  const out = ss._extractShipmentFields({ voided: false });
  assert.strictEqual(out.shipDate, null);
});

check('shipDate wins over createDate when both present', () => {
  const out = ss._extractShipmentFields({
    shipDate: '2026-08-20', createDate: '2026-08-15', voided: false,
  });
  assert.strictEqual(out.shipDate, '2026-08-20');
});

// ─── _extractShipmentFields — pass-through fields ───────────────

check('carrierCode + serviceCode + packageCode + shipmentId pass through', () => {
  const out = ss._extractShipmentFields({
    shipmentId: 42, carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage',
    packageCode: 'package', voided: false, trackingNumber: 'X',
  });
  assert.strictEqual(out.shipmentId, 42);
  assert.strictEqual(out.carrierCode, 'stamps_com');
  assert.strictEqual(out.serviceCode, 'usps_ground_advantage');
  assert.strictEqual(out.packageCode, 'package');
});

check('null shipment → null result', () => {
  assert.strictEqual(ss._extractShipmentFields(null), null);
  assert.strictEqual(ss._extractShipmentFields(undefined), null);
});

check('voided flag surfaces on the extracted object', () => {
  const out1 = ss._extractShipmentFields({ voided: true });
  assert.strictEqual(out1.voided, true);
  const out2 = ss._extractShipmentFields({ voided: false });
  assert.strictEqual(out2.voided, false);
  const out3 = ss._extractShipmentFields({});
  assert.strictEqual(out3.voided, false);
});

// ─── End-to-end shape assertion using order 117452's real data ──
//
// Fixture modeled on the Sep 2026 diagnostic run of --debug-order
// against Sytist order 117452 / SS order 554343421. If SS ever
// changes the field names on the /shipments response (renames
// trackingNumber, moves shipmentCost, etc.), this exact case will
// fire — same lesson as pic_small: a real-payload-shaped fixture
// is the trip-wire that generic tests never catch.

console.log('▸ End-to-end: fixture from order 117452 diagnostic run');

check("recovers 117452's real shipment shape end-to-end", () => {
  // From the actual /shipments?orderId=554343421 response:
  //   trackingNumber: "9400150206217898689993"
  //   shipmentCost: 5.58
  //   voided: false
  //   shipmentId, shipDate present
  const shipments = [
    {
      shipmentId: 998877,
      orderId: 554343421,
      orderNumber: '117452',
      trackingNumber: '9400150206217898689993',
      carrierCode: 'stamps_com',
      serviceCode: 'usps_ground_advantage',
      packageCode: 'package',
      shipmentCost: 5.58,
      shipDate: '2026-08-30T14:12:00.000Z',
      voided: false,
    },
  ];
  const best = ss._pickBestShipment(shipments);
  const extracted = ss._extractShipmentFields(best);
  assert.deepStrictEqual(extracted, {
    shipmentId: 998877,
    trackingNumber: '9400150206217898689993',
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    packageCode: 'package',
    shipmentCost: 5.58,
    shipDate: '2026-08-30T14:12:00.000Z',
    voided: false,
  });
});

check('a void-then-repurchase scenario: skip voided, take fresh', () => {
  const shipments = [
    {
      shipmentId: 1, voided: true, shipDate: '2026-08-30T10:00:00Z',
      trackingNumber: '9400VOIDED', shipmentCost: 5.58,
    },
    {
      shipmentId: 2, voided: false, shipDate: '2026-08-30T14:00:00Z',
      trackingNumber: '9400REPRINT', shipmentCost: 6.10,
    },
  ];
  const best = ss._pickBestShipment(shipments);
  assert.strictEqual(best.shipmentId, 2);
  const extracted = ss._extractShipmentFields(best);
  assert.strictEqual(extracted.trackingNumber, '9400REPRINT');
  assert.strictEqual(extracted.shipmentCost, 6.10);
});

// ─── Summary ─────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;

console.log('');
if (failed === 0) {
  console.log(`✓ verify-shipment-extraction: ${passed}/${results.length} passed`);
  process.exit(0);
} else {
  console.log(`✗ verify-shipment-extraction: ${failed} FAILED of ${results.length}`);
  process.exit(1);
}

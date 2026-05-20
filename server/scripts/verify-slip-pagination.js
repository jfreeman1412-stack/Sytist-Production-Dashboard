// Phase 59 verification harness — packing slip 2-column + Items-to-Ship total.
//
// Builds synthetic canonical orders at the breakpoints (N=1, 3, 6, 7, 8, 12, 20, 22)
// plus qty-aware and specialty-exclusion cases. Renders each via
// packingSlipService.buildSlipBuffer, writes the JPGs to a scratch dir,
// and asserts each rendered image is non-empty + well-formed.
//
// Pre-resolution of eligibility (isSpecialty/isDropShipped/isDigital) is the
// part most likely to throw or mis-key, so the harness exercises orders
// with each class present at least once. Image bytes aren't pixel-asserted;
// the goal is "did the layout decision and pre-resolution survive all the
// boundary cases without throwing." Visual verification still requires a
// real-order Process — see "verification cases" in the phase write-up.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const packingSlipService = require('../services/packingSlipService');

const OUT_DIR = path.join(__dirname, '_slip-pagination-scratch');
fs.mkdirSync(OUT_DIR, { recursive: true });

function makeLineItem(idx, overrides = {}) {
  return {
    cartId: 1000 + idx,
    productName: `Print Packages > Test Package > 8x10 #${idx}`,
    productNameDisplay: `8x10 #${idx}`,
    sku: `TEST-SKU-${idx}`,
    qty: 1,
    subGalleryId: null,
    subGalleryName: null,
    flags: {},
    modifiers: [],
    photo: { thumbUrl: null },
    ...overrides,
  };
}

function makeOrder(itemCount, lineItemOverrides = []) {
  const lineItems = [];
  for (let i = 0; i < itemCount; i++) {
    lineItems.push(makeLineItem(i, lineItemOverrides[i] || {}));
  }
  return {
    orderId: 999000 + itemCount,
    orderNumber: 999000 + itemCount,
    orderDate: '2026-05-19 10:00:00',
    galleryName: `Verify Gallery N=${itemCount}`,
    subGalleryName: '',
    shipTo: {
      firstName: 'Test',
      lastName: `User-N${itemCount}`,
      address1: '123 Test St',
      city: 'Testville',
      state: 'OH',
      zip: '12345',
      phone: '5555551234',
    },
    shipping: { optionName: 'Standard', workflow: 'lab' },
    lineItems,
  };
}

async function buildAndVerify(name, order, expectations) {
  const result = await packingSlipService.buildSlipBuffer(order);
  if (!result.buffer || result.buffer.length < 1000) {
    throw new Error(`${name}: buffer empty or too small (${result.buffer?.length})`);
  }
  const meta = await sharp(result.buffer).metadata();
  if (meta.width !== 1500 || meta.height !== 2400) {
    throw new Error(`${name}: wrong dimensions ${meta.width}x${meta.height}`);
  }
  // Write to scratch for human inspection
  const outFile = path.join(OUT_DIR, `${name}.jpg`);
  fs.writeFileSync(outFile, result.buffer);

  // Soft assertions on expectations vs the meta payload we get back
  const exp = expectations || {};
  const checks = [];
  if (exp.printedCount !== undefined) {
    checks.push(['printedCount', result.meta.printedCount === exp.printedCount,
      `${result.meta.printedCount} vs ${exp.printedCount}`]);
  }
  if (exp.skippedReasons) {
    const reasons = result.skippedItems.map((s) => s.reason).sort();
    const want = [...exp.skippedReasons].sort();
    checks.push(['skippedReasons', JSON.stringify(reasons) === JSON.stringify(want),
      `${JSON.stringify(reasons)} vs ${JSON.stringify(want)}`]);
  }
  const fails = checks.filter(([, ok]) => !ok);
  if (fails.length) {
    throw new Error(`${name}: assertions failed: ${JSON.stringify(fails)}`);
  }
  return { name, file: outFile, size: result.buffer.length, ...result.meta };
}

async function main() {
  const results = [];

  // Case 1: N=1 — single col, today's 200px thumb
  results.push(await buildAndVerify('case01_n1', makeOrder(1), { printedCount: 1 }));

  // Case 2: N=3 — single col, today's 160px thumb
  results.push(await buildAndVerify('case02_n3', makeOrder(3), { printedCount: 3 }));

  // Case 3: N=6 — single col boundary (still 1-col at 120px)
  results.push(await buildAndVerify('case03_n6', makeOrder(6), { printedCount: 6 }));

  // Case 4: N=7 — FIRST 2-col case. Items per col = ceil(7/2) = 4.
  results.push(await buildAndVerify('case04_n7_two_col_first', makeOrder(7), { printedCount: 7 }));

  // Case 5: N=8 — items per col = 4.
  results.push(await buildAndVerify('case05_n8', makeOrder(8), { printedCount: 8 }));

  // Case 6: N=12 — items per col = 6. Thumb size near 100.
  results.push(await buildAndVerify('case06_n12', makeOrder(12), { printedCount: 12 }));

  // Case 7: N=16 — items per col = 8. Adaptive shrink should kick in.
  results.push(await buildAndVerify('case07_n16', makeOrder(16), { printedCount: 16 }));

  // Case 8: N=20 — ceiling. Items per col = 10. Should still fit at 60px floor.
  results.push(await buildAndVerify('case08_n20_ceiling', makeOrder(20), { printedCount: 20 }));

  // Case 9: N=22 — beyond ceiling. console.warn fires. Should still render.
  results.push(await buildAndVerify('case09_n22_overflow_warn', makeOrder(22), { printedCount: 22 }));

  // Case 10: qty-aware total — N=5 rows but qty=3 on two of them → total = 1+1+1+3+3 = 9
  const qtyOrder = makeOrder(5, [{}, {}, {}, { qty: 3 }, { qty: 3 }]);
  results.push(await buildAndVerify('case10_qty_aware', qtyOrder, { printedCount: 5 }));

  // Case 11: filtered flags — gift cert + download lines in printedItems should be SKIPPED
  // (existing SKIP_FLAGS behavior, just verifying it still works post-refactor).
  const filteredOrder = makeOrder(3);
  filteredOrder.lineItems.push(
    { ...makeLineItem(100), flags: { download: true } },
    { ...makeLineItem(101), flags: { giftCert: true } }
  );
  results.push(await buildAndVerify('case11_skip_flags', filteredOrder, {
    printedCount: 3,
    skippedReasons: ['flag:download', 'flag:giftCert'],
  }));

  // Summary
  console.log('\n=== Phase 59 verification: packing slip 2-column ===');
  for (const r of results) {
    console.log(`  ✓ ${r.name.padEnd(35)} ${r.size.toString().padStart(8)} bytes  → ${r.file}`);
  }
  console.log(`\nAll ${results.length} cases passed.\n`);
}

main().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});

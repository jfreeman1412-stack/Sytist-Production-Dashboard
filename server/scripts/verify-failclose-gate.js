// Phase 61 verification harness — fail-closed gate.
// Drives the REAL processingService._processSubOrder / processOrder with the
// heavy collaborators stubbed (they're module-top singletons, so patching the
// cached instances patches what processingService uses). No DB, no network.
//
// Asserts the invariant "everything is in the .txt, or the order doesn't
// complete" across all five fatal modes:
//   1. regular photo download fails        → success:false, no .txt, no SS
//   2. specialty photo download fails       → success:false, no .txt (Fork 2)
//   3. composite render throws              → success:false, no .txt
//   4. imposition throws                    → success:false, no .txt
//   5. green-screen compositing throws      → success:false, no .txt
// Case 1 also runs through processOrder to assert NO ShipStation create and
// NO Sytist status update happen when a sub-order fails.
//
// Phase 61a adds two cases on the printable-set boundary:
//   6. digital-by-config (5D, no photo) is EXCLUDED → order completes (ignored)
//   7. GUARD: a real print (not digital) with no photo STILL gate-fails —
//      proving the exclusion keys on digital-ness, not on "missing photo".
// Phase 64 adds two more on the same boundary, for pre-registration lines:
//   8. a pre-registration placeholder (flags.preRegister, no SKU, no photo) is
//      EXCLUDED → an order with it alongside real prints completes (ignored).
//   9. GUARD: a real print with no photo STILL gate-fails even when a sibling
//      pre-reg line is excluded — the exclusion is per-item by flag, not
//      order-wide and not on "missing photo".

process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const proc = require('../services/processingService');
const printOutputService = require('../services/printOutputService');
const specialtyService = require('../services/specialtyService');
const pathsService = require('../services/pathsService');
const greenscreenService = require('../services/greenscreenService');
const compositeService = require('../services/compositeService');
const overrideRenderService = require('../services/overrideRenderService');
const impositionService = require('../services/impositionService');
const darkroomService = require('../services/darkroomService');
const orderOverrideService = require('../services/orderOverrideService');
const sytistDb = require('../services/sytistDbService');
const packagingService = require('../services/packagingService');
const packingSlipService = require('../services/packingSlipService');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'failclose-'));

// Call tracker reset per case.
let calls;
function resetCalls() {
  calls = { buildOrderTxt: 0, writeTxtFile: 0, tryCreateSS: 0, updateStatus: 0, cleanup: 0 };
}

// A tiny valid-ish JPEG (SOI+EOI) so fsp.readFile in the composite/green-screen
// steps gets bytes when the download "succeeds".
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function applyDefaultStubs() {
  printOutputService.resolveOutputDir = async () => ({ dir: TMP, sortSegments: [] });
  printOutputService.buildOutputFilename = ({ lineItem }) => `out_${lineItem.cartId}.jpg`;

  specialtyService.getBasePath = async () => TMP;
  specialtyService.isSpecialty = async () => false;
  specialtyService.getSpecialtySubfolder = async () => 'spec';

  pathsService.getMode = () => 'test';
  pathsService.resolveBase = () => TMP;

  greenscreenService.shouldComposite = () => false;
  compositeService.findMapping = async () => null;
  orderOverrideService.listByOrderWithSnapshots = () => [];

  // Phase 61a: _splitIntoSubOrders reads productWeights to exclude digital-by-
  // config. Default = nothing digital; the digital case overrides this.
  packagingService.getProductWeights = async () => ({});

  // Success-path stubs (the fail cases return early before these run; the
  // Phase 61a "order completes" case needs them to reach a clean success).
  impositionService.composeSheetInPlace = async () => ({ imposed: false });
  packingSlipService.buildSlipBuffer = async () => ({});
  packingSlipService.writeSlipFile = async () => ({ filePath: path.join(TMP, 'slip.jpg') });

  // Default download SUCCEEDS (writes a real file). Fail cases override this.
  proc._downloadWithRetry = async (url, dest) => {
    await fsp.writeFile(dest, FAKE_JPEG);
    return dest;
  };

  // Spies on the things the gate must SKIP when a sub-order fails.
  darkroomService.buildOrderTxt = async () => { calls.buildOrderTxt++; return { filename: 'x.txt', filePath: path.join(TMP, 'x.txt') }; };
  darkroomService.writeTxtFile = async () => { calls.writeTxtFile++; };
  proc._tryCreateShipStation = async () => { calls.tryCreateSS++; return { ok: true }; };
  proc._cleanupOrphanOutputs = async () => { calls.cleanup++; };
  sytistDb.updateOrderStatus = async () => { calls.updateStatus++; };
}

function makeOrder(lineItems, workflow = 'ship_to_home') {
  return {
    orderId: '999',
    orderNumber: '999',
    shipping: { workflow },
    lineItems,
    galleryId: 0,
    customer: {},
    shipTo: {},
    subject: { fields: {} },
  };
}
function printItem(extra = {}) {
  return {
    cartId: '1', sku: '10', productNameDisplay: '5x7',
    photo: { fullUrl: 'http://x/p.jpg' },
    subGalleryId: 0, galleryId: 0, flags: {},
    ...extra,
  };
}

let pass = 0;
const fails = [];
async function expect(name, fn) {
  resetCalls();
  applyDefaultStubs();
  try {
    const ok = await fn();
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fails.push(name); console.log(`  FAIL  ${name} — calls=${JSON.stringify(calls)}`); }
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL  ${name} — threw ${e.message}\n${e.stack}`);
  }
}

(async () => {
  // 1. Regular photo download fails → success:false, no .txt.
  await expect('regular download fails → success:false, no .txt', async () => {
    proc._downloadWithRetry = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
    const sub = { scope: 'home', lineItems: [printItem()] };
    const r = await proc._processSubOrder(makeOrder(sub.lineItems), sub, {});
    return r.success === false && r.txtPath === null && /failed to download/.test(r.error || '') && calls.buildOrderTxt === 0 && calls.writeTxtFile === 0;
  });

  // 1b. Same failure through processOrder → NO ShipStation, NO status update, NO cleanup.
  await expect('processOrder w/ download fail → no SS, no status, no cleanup', async () => {
    proc._downloadWithRetry = async () => { throw new Error('fetch failed'); };
    const order = makeOrder([printItem()], 'ship_to_home');
    const result = await proc.processOrder(order, {});
    return (
      result.subOrders[0].success === false &&
      calls.tryCreateSS === 0 &&
      calls.updateStatus === 0 &&
      calls.cleanup === 0 &&
      calls.buildOrderTxt === 0
    );
  });

  // 2. Specialty photo download fails → success:false, no .txt (Fork 2: specialty blocks too).
  await expect('specialty download fails → success:false, no .txt', async () => {
    specialtyService.isSpecialty = async () => true;
    proc._downloadWithRetry = async () => { throw new Error('ENOENT specialty drive'); };
    const sub = { scope: 'home', lineItems: [printItem()] };
    const r = await proc._processSubOrder(makeOrder(sub.lineItems), sub, {});
    return r.success === false && r.txtPath === null && calls.buildOrderTxt === 0;
  });

  // 3. Composite render throws → success:false, no .txt.
  await expect('composite render throws → success:false, no .txt', async () => {
    compositeService.findMapping = async () => ({ layoutId: 'x', chainToImposition: false });
    overrideRenderService.resolveLayoutAndVariant = async () => ({
      layout: { id: 'x', graphics: {}, variants: { vertical: { slots: [], graphics: {} } } },
      variant: 'vertical', warnings: [], layoutSource: 'mapping',
    });
    compositeService.buildTokensFromOrder = () => ({});
    overrideRenderService.applyImageOverrides = async () => ({ buffers: { playerPhoto: FAKE_JPEG }, warnings: [] });
    compositeService.buildSheetBuffer = async () => { throw new Error('render engine boom'); };
    const sub = { scope: 'home', lineItems: [printItem()] };
    const r = await proc._processSubOrder(makeOrder(sub.lineItems), sub, {});
    return r.success === false && r.txtPath === null && /Composite render failed/.test(r.error || '') && calls.buildOrderTxt === 0;
  });

  // 4. Imposition throws → success:false, no .txt.
  await expect('imposition throws → success:false, no .txt', async () => {
    impositionService.buildContext = () => ({});
    impositionService.composeSheetInPlace = async () => { throw new Error('impose boom'); };
    const sub = { scope: 'home', lineItems: [printItem()] };
    const r = await proc._processSubOrder(makeOrder(sub.lineItems), sub, {});
    return r.success === false && r.txtPath === null && /Imposition failed/.test(r.error || '') && calls.buildOrderTxt === 0;
  });

  // 5. Green-screen compositing throws → success:false, no .txt.
  await expect('green-screen throws → success:false, no .txt', async () => {
    greenscreenService.shouldComposite = () => true;
    greenscreenService.composeWithBackground = async () => { throw new Error('keying boom'); };
    const sub = { scope: 'home', lineItems: [printItem({ flags: { greenScreen: true }, backgroundPhoto: { fullUrl: 'http://x/bg.jpg' } })] };
    const r = await proc._processSubOrder(makeOrder(sub.lineItems), sub, {});
    return r.success === false && r.txtPath === null && /Green-screen compositing failed/.test(r.error || '') && calls.buildOrderTxt === 0;
  });

  // 6. Phase 61a: a standalone digital-by-config item (5D, no photo URL) is
  // EXCLUDED from the printable set, so it never reaches the gate. An order
  // containing it alongside a real print COMPLETES — the digital is ignored,
  // not a failure. (This is the 5D false-block the original Phase 61 harness
  // missed; it only surfaced on a live digital order.)
  await expect('digital 5D (no photo) excluded → order completes, .txt written', async () => {
    packagingService.getProductWeights = async () => ({ '5D': { category: 'digital' }, '8': { category: 'flat' } });
    const order = makeOrder([
      printItem({ cartId: '1', sku: '8' }), // real print, downloads OK
      printItem({ cartId: '2', sku: '5D', productNameDisplay: 'Digital Package - 5 HiRes', photo: { fullUrl: '' } }), // digital, no photo URL
    ]);
    const subs = await proc._splitIntoSubOrders(order);
    const printableSkus = subs[0].lineItems.map((li) => li.sku);
    if (!(printableSkus.length === 1 && printableSkus[0] === '8')) return false; // 5D excluded, 8 kept
    const r = await proc._processSubOrder(order, subs[0], {});
    return r.success === true && r.photosFailed.length === 0 && calls.buildOrderTxt === 1;
  });

  // 7. Phase 61a GUARD (the proof the exclusion keys on digital-ness, NOT on
  // missing-photo): a REAL print (sku 8, NOT digital) with no photo URL stays
  // printable and STILL hard-fails the gate. Also confirms the no_photo_url
  // logging fix — the error now carries sku=8, not sku=?.
  await expect('real print (sku 8) no photo URL → STILL gate-fails (sku in error)', async () => {
    packagingService.getProductWeights = async () => ({ '8': { category: 'flat' } }); // 8 is NOT digital
    const order = makeOrder([printItem({ cartId: '1', sku: '8', photo: { fullUrl: '' } })]); // no photo URL
    const subs = await proc._splitIntoSubOrders(order);
    if (!(subs[0].lineItems.length === 1 && subs[0].lineItems[0].sku === '8')) return false; // 8 stays printable
    const r = await proc._processSubOrder(order, subs[0], {});
    return r.success === false && r.txtPath === null && /sku=8/.test(r.error || '') && calls.buildOrderTxt === 0;
  });

  // 8. Phase 64: a pre-registration placeholder (flags.preRegister, empty SKU,
  // no photo URL) is EXCLUDED from the printable set — same boundary as the
  // digital case but keyed on the cart_pre_register_id-derived flag, not on a
  // config SKU lookup. An order containing it alongside a real print COMPLETES;
  // the pre-reg line is ignored, not a failure (order 112376 false-block).
  await expect('pre-registration (no photo) excluded → order completes, .txt written', async () => {
    const order = makeOrder([
      printItem({ cartId: '1', sku: '10' }), // real print, downloads OK
      printItem({ cartId: '2', sku: '', productNameDisplay: 'Pre-registration for X', flags: { preRegister: true }, photo: { fullUrl: '' } }),
    ]);
    const subs = await proc._splitIntoSubOrders(order);
    const printableCartIds = subs[0].lineItems.map((li) => li.cartId);
    if (!(printableCartIds.length === 1 && printableCartIds[0] === '1')) return false; // pre-reg excluded, real print kept
    const r = await proc._processSubOrder(order, subs[0], {});
    return r.success === true && r.photosFailed.length === 0 && calls.buildOrderTxt === 1;
  });

  // 9. Phase 64 GUARD: the preRegister exclusion is per-item and keyed on the
  // flag, NOT order-wide and NOT on "missing photo". A real print (no
  // preRegister flag) with no photo URL STILL hard-fails even when a sibling
  // pre-reg line is correctly excluded — proving we didn't weaken the gate.
  await expect('real print no photo STILL gate-fails alongside an excluded pre-reg sibling', async () => {
    const order = makeOrder([
      printItem({ cartId: '1', sku: '10', photo: { fullUrl: '' } }), // real print, NO photo → must fail
      printItem({ cartId: '2', sku: '', flags: { preRegister: true }, photo: { fullUrl: '' } }), // pre-reg, excluded
    ]);
    const subs = await proc._splitIntoSubOrders(order);
    if (!(subs[0].lineItems.length === 1 && subs[0].lineItems[0].cartId === '1')) return false; // only the real print remains printable
    const r = await proc._processSubOrder(order, subs[0], {});
    return r.success === false && r.txtPath === null && calls.buildOrderTxt === 0;
  });

  console.log(`\n${pass}/${pass + fails.length} fail-closed gate cases pass`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})();

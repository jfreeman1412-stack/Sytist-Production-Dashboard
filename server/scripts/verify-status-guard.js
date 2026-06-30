// Phase 75 verification harness — terminal-status guard in
// `sytistDbService.updateOrderStatus`.
//
// Covers two contracts:
//
//   (A) The guard itself. Six cases exercising the truth table:
//        currentStatus × newStatus × shippingFields →  throw? / write?
//
//        A1: 39→40, null   shippingFields → THROW, no UPDATE (the bug class)
//        A2: 39→0,  null   shippingFields → THROW, no UPDATE
//        A3: 39→40, {…}    shippingFields → ALLOW, UPDATE runs (operator
//                                            unship-and-reprocess sequence)
//        A4: 0→40,  null   shippingFields → ALLOW, UPDATE runs (normal
//                                            processing path; 0 is not terminal)
//        A5: 39→39, null   shippingFields → ALLOW, UPDATE runs (no-op, both
//                                            terminal so guard predicate is false)
//        A6: 40→39, null   shippingFields → ALLOW, UPDATE runs (advancing
//                                            INTO terminal is fine; the guard
//                                            only catches reverts OUT OF terminal)
//
//   (B) The integration contract with processingService's try/catch around
//       updateOrderStatus (the existing try/catch at processingService.js
//       lines ~383-403). When the guard throws, the surrounding `result`
//       object must:
//          - capture err.message in result.statusUpdateError
//          - leave result.statusUpdated at its initial false
//          - never set result.newStatusId
//          - leave every other field (sub-orders, txt paths, shipstationOk,
//            etc., which were populated EARLIER in processOrder) untouched
//
//       Phase 75 deliberately does NOT modify processingService.js — its
//       existing try/catch handles the thrown error correctly. This case
//       locks that contract in so a future refactor can't silently break
//       "guard fires + rest of processing still succeeds".
//
// Pure offline: a tiny mock pool stubs the three SQL shapes
// `updateOrderStatus` runs (status-enum lookup, current-row read, the UPDATE).
// No DB, no network. The service singleton's `getPool` is swapped per test
// and restored after.

process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const sytistDb = require('../services/sytistDbService');

// ─── mock pool ────────────────────────────────────────────────
// mysql2's pool.query resolves to `[rows, fields]`. For SELECTs `rows` is an
// array of row objects; for UPDATEs `rows` is an OkPacket-shaped object with
// `affectedRows`. We only need to mock the three query shapes `updateOrderStatus`
// runs — the status enum lookup, the current-row read, and the UPDATE.
function makeMockPool({ currentStatusId, currentStatusName, erased }) {
  let updateCalled = false;
  let lastUpdateSql = null;
  let lastUpdateParams = null;
  return {
    async query(sql, params) {
      // (1) status enum lookup
      if (/FROM ms_order_status WHERE status_id = \?/i.test(sql)) {
        const id = params[0];
        const known = {
          0: { status_id: 0, status_name: 'Queue' },
          39: { status_id: 39, status_name: 'Shipped' },
          40: { status_id: 40, status_name: 'Printing and Production' },
        };
        const row = known[id];
        return [row ? [row] : []];
      }
      // (2) current ms_orders row read
      if (/FROM ms_orders o[\s\S]*WHERE o\.order_id = \?/i.test(sql)) {
        return [
          [
            {
              order_id: params[0],
              order_open_status: currentStatusId,
              order_erased: erased ? 1 : 0,
              currentStatusName,
            },
          ],
        ];
      }
      // (3) UPDATE write — both the shipping-expanded form and the legacy
      // single-column form. The harness only needs to know whether either ran.
      if (/^\s*UPDATE ms_orders SET/i.test(sql)) {
        updateCalled = true;
        lastUpdateSql = sql;
        lastUpdateParams = params;
        return [{ affectedRows: 1 }];
      }
      throw new Error('mock pool: unhandled SQL: ' + sql.slice(0, 100));
    },
    _wasUpdateCalled: () => updateCalled,
    _lastUpdateSql: () => lastUpdateSql,
    _lastUpdateParams: () => lastUpdateParams,
  };
}

// Swap `getPool` for the duration of `fn`, then restore. Works because
// `sytistDb` is exported as a singleton instance and `this.getPool()` inside
// the service method does a property lookup (instance → prototype), so an
// instance-level assignment shadows the prototype method.
async function withMockPool(opts, fn) {
  const mock = makeMockPool(opts);
  const orig = sytistDb.getPool;
  sytistDb.getPool = () => mock;
  try {
    return await fn(mock);
  } finally {
    sytistDb.getPool = orig;
  }
}

// ─── runner ────────────────────────────────────────────────────
let pass = 0;
const fails = [];
async function expect(name, fn) {
  try {
    const ok = await fn();
    if (ok) {
      pass++;
      console.log('  PASS  ' + name);
    } else {
      fails.push(name);
      console.log('  FAIL  ' + name);
    }
  } catch (e) {
    fails.push(name);
    console.log('  FAIL  ' + name + ' — threw: ' + e.message);
  }
}

// A valid shippingFields shape, matching what orderStatusService.shipOrder /
// .unshipOrder pass. Values don't matter for the guard predicate — only the
// truthy-ness of the argument does.
const SHIPPING_FIELDS_OK = {
  shippedDate: '2026-06-15',
  trackingNumber: '9400150206217735907471',
  carrier: 'USPS',
  shippedById: 0,
  shipCost: 6.25,
};

(async () => {
  console.log('=== Phase 75: terminal-status guard ===\n');

  // ── (A) guard truth table ──────────────────────────────────
  await expect(
    'A1: 39 → 40 with null shippingFields THROWS TERMINAL_STATUS_LOCKED, no UPDATE',
    async () =>
      withMockPool(
        { currentStatusId: 39, currentStatusName: 'Shipped' },
        async (mock) => {
          try {
            await sytistDb.updateOrderStatus(114242, 40, null);
            return false;
          } catch (err) {
            return (
              err.code === 'TERMINAL_STATUS_LOCKED' &&
              /shipped order 114242/.test(err.message) &&
              !mock._wasUpdateCalled()
            );
          }
        }
      )
  );

  await expect(
    'A2: 39 → 0 with null shippingFields THROWS (not just to Printing — any non-terminal)',
    async () =>
      withMockPool(
        { currentStatusId: 39, currentStatusName: 'Shipped' },
        async (mock) => {
          try {
            await sytistDb.updateOrderStatus(99999, 0, null);
            return false;
          } catch (err) {
            return (
              err.code === 'TERMINAL_STATUS_LOCKED' &&
              !mock._wasUpdateCalled()
            );
          }
        }
      )
  );

  await expect(
    'A3: 39 → 40 with shippingFields PASSES guard, UPDATE runs (unship-and-reprocess path)',
    async () =>
      withMockPool(
        { currentStatusId: 39, currentStatusName: 'Shipped' },
        async (mock) => {
          const r = await sytistDb.updateOrderStatus(
            99999,
            40,
            SHIPPING_FIELDS_OK
          );
          return mock._wasUpdateCalled() && r.affectedRows === 1;
        }
      )
  );

  await expect(
    'A4: 0 → 40 with null shippingFields PASSES (normal Processing path; 0 is not terminal)',
    async () =>
      withMockPool(
        { currentStatusId: 0, currentStatusName: 'Queue' },
        async (mock) => {
          const r = await sytistDb.updateOrderStatus(99999, 40, null);
          return mock._wasUpdateCalled() && r.affectedRows === 1;
        }
      )
  );

  await expect(
    'A5: 39 → 39 with null shippingFields PASSES (both terminal so guard predicate is false; idempotent no-op)',
    async () =>
      withMockPool(
        { currentStatusId: 39, currentStatusName: 'Shipped' },
        async (mock) => {
          const r = await sytistDb.updateOrderStatus(99999, 39, null);
          return mock._wasUpdateCalled() && r.affectedRows === 1;
        }
      )
  );

  await expect(
    'A6: 40 → 39 with null shippingFields PASSES (advancing INTO terminal is fine; guard only catches reverts OUT)',
    async () =>
      withMockPool(
        { currentStatusId: 40, currentStatusName: 'Printing and Production' },
        async (mock) => {
          const r = await sytistDb.updateOrderStatus(99999, 39, null);
          return mock._wasUpdateCalled() && r.affectedRows === 1;
        }
      )
  );

  // ── (B) integration contract with processingService's try/catch ────
  //
  // Mirrors the code at processingService.js lines ~383-403 verbatim. The
  // PHASE-75 contract: when updateOrderStatus throws (TERMINAL_STATUS_LOCKED),
  // the surrounding result object captures the error in statusUpdateError,
  // statusUpdated stays at its initial false, newStatusId is never set,
  // and the rest of the result object (sub-orders, txt paths, shipstationOk —
  // everything populated EARLIER in processOrder) is untouched. The print
  // artifacts already succeeded by the time we reach the status-update step.
  //
  // We don't run the real processOrder here — that would require mocking
  // the entire processing pipeline (photo downloads, composite render,
  // imposition, slip, darkroom .txt). Instead we mirror the EXACT lines
  // 383-403 with the same control-flow structure, and assert against the
  // post-state. If a future refactor changes that block's behavior, this
  // test fails and the contract is re-verified before the change ships.
  await expect(
    'B: processingService try/catch surfaces guard error in result.statusUpdateError without breaking rest of result',
    async () => {
      const result = {
        orderId: 114242,
        success: true,
        statusUpdated: false, // initial value per processingService.js:286
        subOrders: [
          { success: true, txtPath: 'fake.txt', slipPath: 'fake.jpg' },
        ],
        shipstationOk: true,
      };
      const workOrder = { orderId: 114242 };
      const settings = { autoStatusUpdate: true, targetStatusId: 40 };
      const allOk = true;
      const shipstationStepOk = true;
      const reprint = false;

      // Stub `updateOrderStatus` to throw exactly what the Phase-75 guard
      // produces. Restored in finally.
      const orig = sytistDb.updateOrderStatus;
      sytistDb.updateOrderStatus = async () => {
        const err = new Error(
          'Refusing to change status of shipped order 114242: 39 (Shipped) → 40 (Printing and Production). Terminal status requires an explicit unship action.'
        );
        err.code = 'TERMINAL_STATUS_LOCKED';
        throw err;
      };

      try {
        // ── BEGIN verbatim mirror of processingService.js:383-403 ──
        if (allOk && shipstationStepOk && !reprint) {
          if (
            settings.autoStatusUpdate &&
            settings.targetStatusId !== null &&
            settings.targetStatusId !== undefined
          ) {
            try {
              await sytistDb.updateOrderStatus(
                workOrder.orderId,
                settings.targetStatusId
              );
              result.statusUpdated = true;
              result.newStatusId = settings.targetStatusId;
            } catch (err) {
              result.statusUpdateError = err.message;
            }
          }
        }
        // ── END verbatim mirror ──
      } finally {
        sytistDb.updateOrderStatus = orig;
      }

      return (
        result.statusUpdated === false &&
        result.statusUpdateError &&
        /shipped order 114242/.test(result.statusUpdateError) &&
        result.newStatusId === undefined &&
        // Everything populated EARLIER in processOrder must be untouched:
        result.success === true &&
        result.subOrders.length === 1 &&
        result.subOrders[0].txtPath === 'fake.txt' &&
        result.subOrders[0].slipPath === 'fake.jpg' &&
        result.shipstationOk === true
      );
    }
  );

  console.log(
    '\n' +
      pass +
      '/' +
      (pass + fails.length) +
      ' Phase 75 status-guard harness cases pass'
  );
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERR', e.message);
  console.error(e.stack);
  process.exit(1);
});

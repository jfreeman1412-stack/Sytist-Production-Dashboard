// processingService.js
//
// Phase 4.6: the orchestrator. Single canonical entry point —
// `processOrder(order, options)` — that turns a Sytist canonical order
// into actual files on disk that the Darkroom watcher will pick up.
//
// One of the most safety-critical modules in the codebase. Mistakes
// here could:
//   - leave half-written .txt files for the watcher to print (=> bad customer output)
//   - clobber a file another process wrote
//   - flip an order's status without producing the artifacts
//
// Two safety invariants:
//
//   1. .txt is written LAST. Every other artifact (downloaded photos,
//      imposed sheets, slip, divider) lands before the .txt. Writing
//      .txt is the trigger for Darkroom; if anything earlier failed,
//      the .txt either doesn't get written or excludes the failing line.
//
//   2. Atomic .tmp+rename for every disk write. The .txt and the slip
//      already use this pattern in their respective services.
//      Downloads use it explicitly here.
//
// Sibling handling:
//   - ship_to_home siblings: process the whole order as one bundle (one
//     .txt, one slip, all line items together).
//   - ship_to_managers / ship_to_league: split into per-team sub-orders
//     keyed by subGalleryId; each gets its own .txt + slip. Optional
//     team divider sheet per chunk.
//
// Failure handling (per Joey's direction — continue on error):
//   - If ONE photo download fails, the line item is dropped from the .txt
//     and a warning surfaces; the rest of the sub-order still completes.
//   - If imposition fails for a downloaded photo, the original photo is
//     left in place (no .tmp rollback wipes it — composeSheetInPlace
//     either succeeds or doesn't touch the file).
//   - If the slip generation fails, the whole sub-order fails (slip is
//     part of the .txt — can't have one without the other).
//   - Sub-order failures are isolated; other sub-orders in the same
//     order proceed independently.
//
// Specialty routing:
//   - Specialty SKUs land in a separate folder (specialtyService basePath
//     + subfolder). A separate .txt is written for the specialty items
//     in each sub-order. The slip still lists all items together.
//
// Status update:
//   - If processing-settings.json has autoUpdate=true and a target
//     statusId, the order's ms_orders.order_open_status is updated to
//     that value AFTER all writes complete successfully. Failures don't
//     update the status (operator can re-process).

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const pathsService = require('./pathsService');
const folderSortService = require('./folderSortService');
const darkroomService = require('./darkroomService');
const packingSlipService = require('./packingSlipService');
const teamDividerService = require('./teamDividerService');
const impositionService = require('./impositionService');
const specialtyService = require('./specialtyService');
const qrcodeService = require('./qrcodeService');
const compositeService = require('./compositeService');
const teamPhotoService = require('./teamPhotoService');
const galleryAssetsService = require('./galleryAssetsService');
const compositeGraphicsService = require('./compositeGraphicsService');
const greenscreenService = require('./greenscreenService');
const sytistDb = require('./sytistDbService');
const composedThumbnailService = require('./composedThumbnailService');
const composedThumbnailCacheService = require('./composedThumbnailCacheService');
// Phase 52: per-order overrides now take effect during normal Process
// (not just the editor's Apply path). orderOverrideService is the SQLite
// read; overrideRenderService is the shared layout/variant + image-buffer
// resolution policy, also used by renderOverrideForOrder so the two
// paths can't drift.
const orderOverrideService = require('./orderOverrideService');
const overrideRenderService = require('./overrideRenderService');
const sharp = require('sharp');

const SETTINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'processing-settings.json'
);

const DEFAULT_SETTINGS = {
  autoStatusUpdate: false,
  targetStatusId: null,
  // Phase 13c: when true, ship_to_home orders processed via this
  // service also get auto-created in ShipStation. Default ON since
  // 13c's whole purpose is "Process this order should also send to
  // ShipStation." Operators can flip it off in Settings → Processing
  // (the existing processing settings page) if they want to fall
  // back to the manual Send button on the order detail page.
  autoShipStation: true,
};

// Skip flags shared with darkroom + slip — items with any of these aren't
// print jobs and are dropped from processing entirely.
// Skip flags shared with darkroom + slip — items with any of these aren't
// print jobs and are dropped from processing entirely.
//
// Phase 15a: isPackageHeader is the synthetic flag we attach to the
// original package row after explosion. The constituents (with
// flags.isPackageItem = true) ARE printable; the header is just a
// label for the operator/slip. Skipping it here keeps darkroom .txt
// and the print pipeline from rendering "Gold Package" as if it were
// a single product.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'isPackageHeader'];

// In-memory job registry for batch processing progress polling. Cleared
// 1 hour after job completion to avoid unbounded growth.
const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

class ProcessingService {
  constructor() {
    this._ensureSettings();
  }

  _ensureSettings() {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) {
        const dir = path.dirname(SETTINGS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          SETTINGS_PATH,
          JSON.stringify(DEFAULT_SETTINGS, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(`[Processing] Could not ensure ${SETTINGS_PATH}: ${err.message}`);
    }
  }

  // ─── SETTINGS ───────────────────────────────────────────

  async getSettings() {
    try {
      const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(updates) {
    const current = await this.getSettings();
    const merged = { ...current, ...(updates || {}) };
    // Coerce types
    merged.autoStatusUpdate = !!merged.autoStatusUpdate;
    // autoShipStation: undefined/missing → keep current; explicit
    // false/null → off. Default in DEFAULT_SETTINGS is true, so a
    // brand-new install gets the auto-create behavior.
    if (merged.autoShipStation === undefined) {
      merged.autoShipStation = true;
    } else {
      merged.autoShipStation = !!merged.autoShipStation;
    }
    merged.targetStatusId =
      merged.targetStatusId === null || merged.targetStatusId === ''
        ? null
        : Number(merged.targetStatusId);
    await fsp.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  // ─── PUBLIC API ─────────────────────────────────────────

  /**
   * Process a single order. Returns a result object detailing every
   * sub-order, what was written, what was skipped.
   *
   * @param {object} order - canonical Sytist order
   * @param {object} options
   *   generateDivider — boolean, only relevant for non-home orders
   *   includeQrCode — currently ignored for single-order; QR is for batches
   *
   * Result shape:
   *   {
   *     orderId,
   *     mode: 'test' | 'production',
   *     subOrders: [
   *       {
   *         scope: 'home' | { subGalleryId, subGalleryName },
   *         success: bool,
   *         txtPath, slipPath, dividerPath?,
   *         photosDownloaded: [{ cartId, path }],
   *         photosFailed: [{ cartId, error }],
   *         imposedSheets: [{ cartId, layout, path }],
   *         specialtyTxtPath?,
   *         warnings: [...],
   *         error?,
   *       }
   *     ],
   *     statusUpdated: bool,
   *     newStatusId?,
   *   }
   */
  async processOrder(order, options = {}) {
    if (!order || !order.orderId) {
      throw new Error('processOrder requires a canonical-shape order');
    }
    const generateDivider = !!options.generateDivider;

    // Phase 35: reprint mode. When true, processOrder:
    //   - Computes the next available "_REPRINT[_N]" suffix by
    //     scanning the output dir for existing _REPRINT files for
    //     this order. Threads the suffix through to every filename
    //     (photos, composites, slip, .txt) so reprint outputs sit
    //     alongside originals without overwriting them.
    //   - SKIPS Sytist order_open_status update (the order's status
    //     should not change just because we reprinted).
    //   - SKIPS ShipStation auto-create (existing local link or not
    //     — reprint never touches SS).
    //   - Audits the action with source='reprint' for traceability.
    //
    // Optional `lineItemFilter` is an array of cartIds. When provided,
    // only those line items are processed. Used by the per-item
    // reprint endpoint to print just one card's worth.
    const reprint = !!options.reprint;
    const lineItemFilter =
      Array.isArray(options.lineItemFilter) && options.lineItemFilter.length > 0
        ? options.lineItemFilter.map(String)
        : null;

    let reprintSuffix = '';
    let reprintNumber = 0;
    if (reprint) {
      reprintNumber = await this._nextReprintNumber(order);
      reprintSuffix =
        reprintNumber === 1 ? '_REPRINT' : `_REPRINT_${reprintNumber}`;
      console.log(
        `[Processing] Order ${order.orderId}: REPRINT mode (suffix=${reprintSuffix})` +
          (lineItemFilter ? ` filter=cartIds:${lineItemFilter.join(',')}` : '')
      );
    }

    // Apply line item filter if present. Operate on a shallow-cloned
    // order so we don't mutate the caller's object.
    let workOrder = order;
    if (lineItemFilter) {
      const filteredItems = (order.lineItems || []).filter((li) =>
        lineItemFilter.includes(String(li.cartId))
      );
      if (filteredItems.length === 0) {
        throw new Error(
          `lineItemFilter [${lineItemFilter.join(',')}] matched no items in order ${order.orderId}`
        );
      }
      workOrder = { ...order, lineItems: filteredItems };
    }

    const result = {
      orderId: workOrder.orderId,
      orderNumber: workOrder.orderNumber || workOrder.orderId,
      mode: pathsService.getMode(),
      subOrders: [],
      statusUpdated: false,
      newStatusId: null,
      reprint,
      reprintNumber: reprint ? reprintNumber : null,
      reprintSuffix: reprint ? reprintSuffix : null,
    };

    const subOrders = this._splitIntoSubOrders(workOrder);
    console.log(
      `[Processing] Order ${workOrder.orderId}: ${subOrders.length} sub-order(s) ` +
        `(workflow=${workOrder.shipping?.workflow}, items=${(workOrder.lineItems || []).length})${reprint ? ' [REPRINT]' : ''}`
    );

    for (const sub of subOrders) {
      const subResult = await this._processSubOrder(workOrder, sub, {
        generateDivider,
        reprint,
        reprintSuffix,
        lineItemFilter,
      });
      result.subOrders.push(subResult);
    }

    // Status update: only when all sub-orders succeeded
    const allOk = result.subOrders.every((s) => s.success);

    // ─── Phase 13c: auto-create ShipStation order ───────────
    //
    // Fires after all sub-orders succeed, BEFORE the status update.
    // Only runs for ship_to_home workflow — managers/league bypass
    // ShipStation entirely (those workflows ship internally, not
    // through SS).
    //
    // If the engine returns __skipShipStation (e.g. order is all
    // drop-shipped/digital), we treat that as a legitimate skip and
    // still update Sytist's status. Real SS errors (network, auth,
    // 400 from SS) leave the order's Sytist status untouched so the
    // operator notices and can reprocess.
    //
    // Reprocess behavior: if the order already has a row in
    // shipstation_links, skip create and reuse the existing link.
    // Operators who want to start over should Delete the SS order
    // from the order detail page first.
    //
    // Phase 35: reprint mode bypasses the entire SS step. A reprint
    // is an extra print run; it doesn't go through ShipStation.
    let shipstationStepOk = true; // default true for non-home workflows
    if (allOk && !reprint) {
      const settings = await this.getSettings();
      const isHome = workOrder.shipping?.workflow === 'ship_to_home';
      const autoSS = settings.autoShipStation !== false; // default ON

      if (isHome && autoSS) {
        shipstationStepOk = false; // require explicit success below
        result.shipstation = await this._tryCreateShipStation(workOrder);
        shipstationStepOk = result.shipstation.ok;
      } else if (isHome && !autoSS) {
        result.shipstation = {
          ok: true,
          skipped: true,
          reason: 'auto_shipstation_disabled',
          message: 'Auto-create disabled in settings; use manual Send button on order detail',
        };
      } else {
        // Non-home workflow — SS doesn't apply.
        result.shipstation = {
          ok: true,
          skipped: true,
          reason: 'non_home_workflow',
          message: `Workflow "${workOrder.shipping?.workflow || 'unknown'}" — ShipStation not applicable`,
        };
      }
    } else if (allOk && reprint) {
      // Phase 35: reprint never touches SS
      result.shipstation = {
        ok: true,
        skipped: true,
        reason: 'reprint',
        message: 'Reprint mode — ShipStation step skipped',
      };
    }

    // Phase 35: reprint skips the Sytist status update entirely.
    // The order's status should not change just because we reprinted.
    if (allOk && shipstationStepOk && !reprint) {
      const settings = await this.getSettings();
      if (
        settings.autoStatusUpdate &&
        settings.targetStatusId !== null &&
        settings.targetStatusId !== undefined
      ) {
        try {
          await sytistDb.updateOrderStatus(workOrder.orderId, settings.targetStatusId);
          result.statusUpdated = true;
          result.newStatusId = settings.targetStatusId;
          console.log(
            `[Processing] Order ${workOrder.orderId}: status → ${settings.targetStatusId}`
          );
        } catch (err) {
          console.warn(
            `[Processing] Status update failed for ${workOrder.orderId}: ${err.message}`
          );
          result.statusUpdateError = err.message;
        }
      }
    } else if (allOk && !shipstationStepOk) {
      // Sub-orders all succeeded but SS failed. Leave status untouched
      // so the operator can fix and reprocess. Mirrors PhotoDay's
      // behavior — never mark something as "done" if a downstream
      // step failed silently.
      console.warn(
        `[Processing] Order ${workOrder.orderId}: sub-orders OK but ShipStation step failed — NOT updating Sytist status`
      );
    }

    // Phase 35: audit reprints to order_status_audit so we have a
    // record of every reprint event for forensics. Same table the
    // ship/unship code uses. source='reprint' makes them easy to
    // filter. We insert directly rather than going through
    // orderStatusService since reprints don't fit that service's
    // ship/unship model (no status change).
    if (reprint && allOk) {
      try {
        // Make sure the audit table exists. orderStatusService
        // creates it on first ship/unship, but if no shipping has
        // happened yet on this dashboard install the table won't
        // exist when the first reprint runs.
        const orderStatusService = require('./orderStatusService');
        if (typeof orderStatusService.ensureAuditTable === 'function') {
          try { orderStatusService.ensureAuditTable(); } catch {}
        }
        const databaseService = require('./database');
        const db = databaseService.getDb();
        const note =
          `REPRINT_${reprintNumber}` +
          (lineItemFilter ? ` items=${lineItemFilter.join(',')}` : ' (full order)') +
          (options.reason ? ` reason="${options.reason}"` : '');
        db.prepare(
          `INSERT INTO order_status_audit
             (order_id, from_status, to_status, source, user_id, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          parseInt(workOrder.orderId, 10),
          null,
          0,
          'reprint',
          options.userId == null ? null : parseInt(options.userId, 10),
          note
        );
      } catch (auditErr) {
        // Audit failure must never block the reprint result.
        console.warn(
          `[Processing] Reprint audit log failed for ${workOrder.orderId}: ${auditErr.message}`
        );
      }
    }

    // ─── Phase 36: write to Sytist's ms_notes ───────────────
    //
    // On a successful Process / Reprint, append a row to ms_notes so
    // the action shows up in Sytist's order detail page next to
    // Sytist-native log entries. Non-fatal: a notes failure doesn't
    // undo the action.
    //
    // Note bodies are intentionally short and consistent — Sytist's
    // operators scan these the same way they scan Sytist's own.
    if (allOk) {
      try {
        let noteText;
        if (reprint) {
          if (lineItemFilter && lineItemFilter.length > 0) {
            // Identify the line item by product name for human readability.
            const reprintedItems = (order.lineItems || []).filter((li) =>
              lineItemFilter.includes(String(li.cartId))
            );
            const names = reprintedItems.map((li) => li.productName).join(', ');
            noteText = `Sytist Dashboard: Item "${names}" reprinted as REPRINT_${reprintNumber}`;
          } else {
            noteText = `Sytist Dashboard: Order reprinted as REPRINT_${reprintNumber}`;
          }
          if (options.reason) noteText += ` — Reason: ${options.reason}`;
        } else {
          // Regular (non-reprint) Process. Report the count of items
          // and any sub-orders so the operator has context.
          const itemCount = (workOrder.lineItems || []).length;
          noteText = `Sytist Dashboard: Order processed`;
          if (itemCount > 0) noteText += ` (${itemCount} item${itemCount === 1 ? '' : 's'})`;
          if (result.statusUpdated && result.newStatusId !== null) {
            // Phase 38 follow-up: look up the friendly status name
            // so the note reads "Printing and Production" instead of
            // just "40". Lookup is best-effort: getStatusName never
            // throws and returns a "Status N" fallback if the
            // ms_order_status row isn't found.
            let statusLabel = String(result.newStatusId);
            try {
              statusLabel = await sytistDb.getStatusName(result.newStatusId);
            } catch {
              /* keep numeric fallback */
            }
            noteText += ` — status → ${statusLabel}`;
          }
        }

        await sytistDb.insertNote({
          orderId: workOrder.orderId,
          noteText,
          who: options.userDisplayName || 'dashboard',
          ip: options.userIp || '',
          isManual: false,
        });
      } catch (noteErr) {
        console.warn(
          `[Processing] ms_notes insert failed for ${workOrder.orderId}: ${noteErr.message}`
        );
      }
    }

    return result;
  }

  /**
   * Phase 35: figure out what the next REPRINT_N number should be by
   * scanning the output directory for existing _REPRINT files for
   * this order. Returns 1 if no existing reprints, 2 if _REPRINT
   * exists, 3 if _REPRINT_2 exists, etc.
   *
   * We check the regular download dir under the resolved path
   * template. Scans for both .txt and packing_slip variants since
   * either is sufficient evidence that a reprint already happened.
   */
  async _nextReprintNumber(order) {
    try {
      const orderNum = order.orderNumber || order.orderId;
      const sortLevels = await folderSortService.getSortLevels();
      const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
      const downloadDir = pathsService.resolveFullPath(
        'downloadBase',
        order,
        sortSegments
      );

      let existing;
      try {
        existing = await fsp.readdir(downloadDir);
      } catch {
        // Dir doesn't exist yet — no prior reprints.
        return 1;
      }

      // Match: {orderNum}_REPRINT.txt, {orderNum}_REPRINT_2.txt, etc.
      // Or matching packing_slip variants. The pattern is permissive:
      // anything starting with `{orderNum}_REPRINT` counts.
      const prefix = `${orderNum}_REPRINT`;
      let maxN = 0;
      for (const name of existing) {
        if (!name.startsWith(prefix)) continue;
        // _REPRINT (no number) = treat as N=1
        // _REPRINT_2, _REPRINT_3, etc.
        const after = name.slice(prefix.length);
        const m = after.match(/^_(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxN) maxN = n;
        } else {
          // _REPRINT followed by anything other than _N (e.g. _packing_slip)
          // counts as N=1.
          if (maxN < 1) maxN = 1;
        }
      }
      return maxN + 1;
    } catch (err) {
      console.warn(
        `[Processing] _nextReprintNumber failed for ${order.orderId} — defaulting to 1: ${err.message}`
      );
      return 1;
    }
  }

  /**
   * Phase 13c: encapsulates the ShipStation create logic so processOrder
   * stays readable. Returns:
   *   {
   *     ok: boolean,
   *     skipped?: boolean,
   *     reason?: string,
   *     message?: string,
   *     orderId?: string|number,        // ShipStation order ID on success
   *     orderNumber?: string,
   *     orderStatus?: string,
   *     packageCodeSent?: string,
   *     packageCodeStored?: string,     // what SS came back with
   *     packageCodeDrift?: boolean,     // SS reassigned the package code
   *     error?: string,
   *   }
   */
  async _tryCreateShipStation(order) {
    const orderNum = order.orderNumber || String(order.orderId);
    // Phase 33: explicit entry log so we can always see the SS path
    // was entered and why. Followed by per-decision-point logs that
    // tell us exactly which branch we took.
    console.log(`[SS] ${orderNum}: _tryCreateShipStation entered`);

    let shipstationService;
    let shipstationLinkService;
    try {
      shipstationService = require('./shipstationService');
      shipstationLinkService = require('./shipstationLinkService');
    } catch (e) {
      // The services aren't installed (unlikely, but defensive). Don't
      // fail the order over a missing dep — log and treat as skip.
      console.warn(
        `[SS] ${orderNum}: services unavailable: ${e.message}`
      );
      return {
        ok: true,
        skipped: true,
        reason: 'services_unavailable',
        message: 'ShipStation services not loaded',
      };
    }

    // 1. Check for existing local link — operator may be reprocessing.
    let existingLink = null;
    try {
      existingLink = shipstationLinkService.getByOrderId(order.orderId);
    } catch (e) {
      // Link service is read-only here; if it fails just proceed.
    }
    if (existingLink) {
      console.log(
        `[SS] ${orderNum}: PATH=already_linked, SS#${existingLink.ss_order_id} ss_status=${existingLink.ss_order_status || '(none)'} — skipping create. Use "Push packaging to ShipStation" button to opt-in re-push.`
      );
      return {
        ok: true,
        skipped: true,
        reason: 'already_linked',
        message: `Already linked to ShipStation order ${existingLink.ss_order_number || existingLink.ss_order_id}`,
        orderId: existingLink.ss_order_id,
        orderNumber: existingLink.ss_order_number,
        orderStatus: existingLink.ss_order_status,
      };
    }

    // 2. Build the SS payload. The packaging engine drives carrier/
    // service/dims/weight via shipstationService.buildOrderFromSytist
    // — no overrides at the automated path (operator can still do
    // manual overrides via the Shipping card if they want to redo).
    let payload;
    try {
      payload = await shipstationService.buildOrderFromSytist(order, {});
    } catch (e) {
      console.error(
        `[SS] ${orderNum}: buildOrderFromSytist failed: ${e.message}`
      );
      return {
        ok: false,
        error: `Payload build failed: ${e.message}`,
      };
    }

    // 3. Engine-skip — order has nothing shippable (all digital/drop-
    // shipped). Treat as legitimate skip; status update should still
    // proceed since there's no actual ShipStation step that failed.
    if (payload && payload.__skipShipStation) {
      console.log(
        `[SS] ${orderNum}: PATH=engine_skip reason=${payload.reason || 'nothing_shippable'} message="${payload.message}"`
      );
      return {
        ok: true,
        skipped: true,
        reason: payload.reason || 'nothing_shippable',
        message: payload.message,
      };
    }

    // Phase 33: log the resolved payload before any API call.
    // If something goes wrong downstream we have a record of exactly
    // what the packaging engine produced.
    console.log(
      `[SS] ${orderNum}: payload built — weight=${payload.weight?.value}${payload.weight?.units || 'oz'}, ` +
        `dims=${payload.dimensions?.length || '?'}x${payload.dimensions?.width || '?'}x${payload.dimensions?.height || '?'}${payload.dimensions?.units || 'in'}, ` +
        `carrier=${payload.carrierCode}/${payload.serviceCode}, package=${payload.packageCode}`
    );

    // 4. Look up SS by orderNumber in case a duplicate exists on SS's
    // side (the operator may have created it manually, or a prior
    // dashboard run created it but the link row was lost). Adopt
    // rather than create-and-conflict.
    //
    // Phase 33: REVERSED Phase 31's auto-push during adoption. Per
    // operator preference, processing should NOT push packaging to
    // an order that already exists in SS. Doing so could overwrite
    // packaging the operator has already accepted/edited on the SS
    // side. If an operator wants to push current packaging to an
    // existing SS order, they use the dedicated "Push packaging to
    // ShipStation" button on the order detail page (added in
    // Phase 33 too).
    try {
      console.log(`[SS] ${orderNum}: calling listOrders to check for phantom`);
      const lookup = await shipstationService.listOrders({
        orderNumber: orderNum,
      });
      const lookupCount = lookup?.orders?.length || 0;
      console.log(`[SS] ${orderNum}: listOrders returned ${lookupCount} match(es)`);
      const found = (lookup?.orders || []).find(
        (o) => o.orderNumber === orderNum
      );
      if (found) {
        console.log(
          `[SS] ${orderNum}: PATH=adopt_existing — SS#${found.orderId} already has this orderNumber, adopting WITHOUT pushing packaging (Phase 33 default)`
        );
        try {
          shipstationLinkService.create({
            orderId: order.orderId,
            ssOrderId: found.orderId,
            ssOrderNumber: found.orderNumber,
            ssOrderStatus: found.orderStatus,
            // Phase 33: persist whatever the SS order currently has
            // for carrier/service/package as the link row's metadata.
            // Falls back to the payload values if SS doesn't echo them.
            carrierCode: found.carrierCode || payload.carrierCode || null,
            serviceCode: found.serviceCode || payload.serviceCode || null,
            packageCode: found.packageCode || payload.packageCode || null,
            payload,
          });
          console.log(`[SS] ${orderNum}: link row created for adopted SS#${found.orderId}`);
        } catch (linkErr) {
          console.warn(
            `[SS] ${orderNum}: link insert failed: ${linkErr.message}`
          );
        }
        return {
          ok: true,
          skipped: true,
          reason: 'adopted_existing',
          message: `Adopted existing ShipStation order ${found.orderNumber} (skipped auto-push)`,
          orderId: found.orderId,
          orderNumber: found.orderNumber,
          orderStatus: found.orderStatus,
        };
      }
    } catch (lookupErr) {
      // Lookup failing doesn't block create; we'd rather create a
      // potential duplicate than refuse to ship.
      console.warn(
        `[SS] ${orderNum}: listOrders failed (non-fatal, will proceed to create): ${lookupErr.message}`
      );
    }

    // 5. Create.
    console.log(`[SS] ${orderNum}: PATH=fresh_create — calling createOrder`);
    try {
      const ssResult = await shipstationService.createOrder(payload);
      const sentPkg = payload.packageCode;
      const storedPkg = ssResult.packageCode;
      const drift = sentPkg !== storedPkg;
      // Phase 33: explicit success log with all key fields so we can
      // verify exactly what SS accepted.
      console.log(
        `[SS] ${orderNum}: createOrder OK → SS#${ssResult.orderId} ` +
          `ss_status=${ssResult.orderStatus} ` +
          `packageCode=${storedPkg}${drift ? ` (⚠ drift from sent=${sentPkg})` : ''} ` +
          `carrier=${ssResult.carrierCode || '(echoed empty)'}/${ssResult.serviceCode || '(echoed empty)'} ` +
          `weight=${ssResult.weight?.value || '(echoed empty)'}`
      );
      try {
        shipstationLinkService.create({
          orderId: order.orderId,
          ssOrderId: ssResult.orderId,
          ssOrderNumber: ssResult.orderNumber,
          ssOrderStatus: ssResult.orderStatus,
          carrierCode: payload.carrierCode,
          serviceCode: payload.serviceCode,
          packageCode: storedPkg,
          payload,
        });
        console.log(`[SS] ${orderNum}: link row created for fresh SS#${ssResult.orderId}`);
      } catch (linkErr) {
        console.warn(
          `[SS] ${orderNum}: link insert failed (SS order created OK): ${linkErr.message}`
        );
      }
      return {
        ok: true,
        orderId: ssResult.orderId,
        orderNumber: ssResult.orderNumber,
        orderStatus: ssResult.orderStatus,
        packageCodeSent: sentPkg,
        packageCodeStored: storedPkg,
        packageCodeDrift: drift,
      };
    } catch (createErr) {
      console.error(
        `[SS] ${orderNum}: createOrder FAILED: ${createErr.message}`
      );
      return {
        ok: false,
        error: createErr.message,
      };
    }
  }

  /**
   * Phase 13d: retry ONLY the ShipStation step for an order whose
   * sub-orders processed successfully but whose SS create failed.
   * Re-runs _tryCreateShipStation against the current Sytist order
   * snapshot. Used by:
   *   - batch UI's "Retry SS sends" button after a partially-failed batch
   *   - dedicated ShipStation page's failed-sends tab (Phase 13f)
   *
   * Returns the same shape as _tryCreateShipStation, plus orderNumber.
   * Updates Sytist status if SS now succeeds (mirrors processOrder's
   * gating).
   */
  async retryShipStationForOrder(orderId) {
    const order = await sytistDb.getOrderById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const result = await this._tryCreateShipStation(order);
    result.orderId = order.orderId;
    result.orderNumber = order.orderNumber;

    // If the retry succeeded AND this is a home order, also update
    // Sytist status (since processOrder didn't get the chance to).
    if (result.ok && order.shipping?.workflow === 'ship_to_home') {
      const settings = await this.getSettings();
      if (
        settings.autoStatusUpdate &&
        settings.targetStatusId !== null &&
        settings.targetStatusId !== undefined
      ) {
        try {
          await sytistDb.updateOrderStatus(
            order.orderId,
            settings.targetStatusId
          );
          result.statusUpdated = true;
          result.newStatusId = settings.targetStatusId;
        } catch (err) {
          console.warn(
            `[Processing] Retry status update failed for ${orderId}: ${err.message}`
          );
          result.statusUpdateError = err.message;
        }
      }
    }

    return result;
  }

  /**
   * Process a batch of orders. Runs serially (parallelism = 1) to avoid
   * S3 rate-limiting and to make logs readable. Stores progress in a
   * job registry so the UI can poll.
   *
   * Returns a job ID immediately and runs the work in the background.
   */
  startBatchProcess(orderIds, options = {}) {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      status: 'queued',
      total: orderIds.length,
      completed: 0,
      results: [],
      options: { ...options },
      qrSheetPaths: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      // Phase 4.7 — graceful cancel + run-by tracking
      cancelRequested: false,
      cancelled: false,
      ranBy: options.username || null,
    };
    JOBS.set(jobId, job);

    // Run async — don't await, just kick it off
    this._runBatchJob(jobId, orderIds, options).catch((err) => {
      const j = JOBS.get(jobId);
      if (j) {
        j.status = 'failed';
        j.error = err.message;
        j.completedAt = new Date().toISOString();
      }
    });

    return jobId;
  }

  /**
   * Phase 4.7 — request a graceful cancel of an in-flight batch.
   * The currently-processing order finishes; the batch then halts.
   * Already-completed sub-orders are NOT rolled back — their files
   * are written and the watcher may have already picked them up.
   */
  cancelJob(jobId) {
    const job = JOBS.get(jobId);
    if (!job) return null;
    if (job.status === 'complete' || job.status === 'failed' || job.cancelled) {
      return job; // nothing to do
    }
    job.cancelRequested = true;
    console.log(`[Processing] Cancel requested for ${jobId}`);
    return job;
  }

  getJob(jobId) {
    this._cleanExpiredJobs();
    return JOBS.get(jobId) || null;
  }

  _cleanExpiredJobs() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of JOBS.entries()) {
      if (job.completedAt && new Date(job.completedAt).getTime() < cutoff) {
        JOBS.delete(id);
      }
    }
  }

  async _runBatchJob(jobId, orderIds, options) {
    const job = JOBS.get(jobId);
    if (!job) return;

    job.status = 'running';

    for (const orderId of orderIds) {
      // Phase 4.7 — check for graceful cancel at the top of each iteration.
      // Current order has already finished its previous iteration so we're
      // halting cleanly between orders.
      if (job.cancelRequested) {
        console.log(`[Processing] Job ${jobId} halted via cancel after ${job.completed} orders`);
        job.cancelled = true;
        break;
      }

      try {
        const order = await sytistDb.getOrderById(orderId);
        if (!order) {
          job.results.push({
            orderId,
            error: 'Order not found',
          });
        } else {
          const r = await this.processOrder(order, options);
          job.results.push(r);
        }
      } catch (err) {
        console.error(`[Processing] Batch error for ${orderId}:`, err);
        job.results.push({ orderId, error: err.message });
      }
      job.completed += 1;
    }

    // QR sheet generation if requested
    if (options.generateQrSheet) {
      try {
        const items = job.results
          .filter((r) => !r.error)
          .map((r) => ({ data: String(r.orderNumber), label: String(r.orderNumber) }));

        if (items.length > 0) {
          // Park QR sheets under today's date partition in downloadBase
          const syntheticOrder = {
            orderId: 'qr-batch',
            orderDate: new Date().toISOString().replace('T', ' ').slice(0, 19),
          };
          const qrDir = pathsService.resolveFullPath(
            'downloadBase',
            syntheticOrder,
            ['_qr-sheets']
          );
          const qrResult = await qrcodeService.writeSheets(items, qrDir);
          job.qrSheetPaths = qrResult.files.map((f) => f.filePath);
        }
      } catch (err) {
        console.warn(`[Processing] QR sheet generation failed: ${err.message}`);
        job.qrSheetError = err.message;
      }
    }

    job.status = job.cancelled ? 'cancelled' : 'complete';
    job.completedAt = new Date().toISOString();

    // Phase 13d: aggregate ShipStation outcomes across the batch so the
    // UI can show "X sent, Y skipped, Z failed" without re-walking
    // result objects. Each per-order result has its own .shipstation
    // field populated by processOrder (Phase 13c). Orders where
    // shipstation wasn't attempted (sub-order failure, or older
    // results without the field) don't count toward any bucket.
    const ssSummary = {
      created: 0,        // fresh SS order created
      skipped: 0,        // legit skip (non-home, all-digital, already-linked, etc.)
      failed: 0,         // SS step threw or returned ok:false
      notAttempted: 0,   // sub-order failed so SS step never ran
      driftCount: 0,     // packageCode drift detected
      failures: [],      // [{ orderId, orderNumber, error }] — for retry-SS UI
    };
    for (const r of job.results) {
      // Errored result with no .shipstation — sub-order failed or
      // getOrderById blew up. Doesn't go in any bucket.
      if (r.error && !r.shipstation) {
        ssSummary.notAttempted += 1;
        continue;
      }
      const ss = r.shipstation;
      if (!ss) {
        ssSummary.notAttempted += 1;
        continue;
      }
      if (!ss.ok) {
        ssSummary.failed += 1;
        ssSummary.failures.push({
          orderId: r.orderId,
          orderNumber: r.orderNumber,
          error: ss.error || 'Unknown error',
        });
      } else if (ss.skipped) {
        ssSummary.skipped += 1;
      } else {
        ssSummary.created += 1;
        if (ss.packageCodeDrift) ssSummary.driftCount += 1;
      }
    }
    job.shipstationSummary = ssSummary;
    console.log(
      `[Processing] Batch ${jobId} SS summary: ` +
        `${ssSummary.created} created, ${ssSummary.skipped} skipped, ` +
        `${ssSummary.failed} failed, ${ssSummary.notAttempted} not attempted` +
        (ssSummary.driftCount > 0 ? `, ${ssSummary.driftCount} drift` : '')
    );

    // Phase 4.7 — record to persistent history.
    // We catch any history errors here because failure to record
    // shouldn't bubble up and corrupt the in-memory job state.
    try {
      const processHistoryService = require('./processHistoryService');
      await processHistoryService.recordBatch(job, {
        username: job.ranBy,
        mode: pathsService.getMode(),
      });
    } catch (err) {
      console.warn(`[Processing] History record failed: ${err.message}`);
    }
  }

  // ─── SUB-ORDER HANDLING ────────────────────────────────

  /**
   * Decide how to split an order into sub-orders.
   * - ship_to_home (sibling or not): one sub-order, scope='home'
   * - ship_to_managers / ship_to_league: one per distinct subGalleryId
   *   (filtered to printable items only — flag-skipped items don't count)
   * - everything else: one sub-order with all items
   */
  _splitIntoSubOrders(order) {
    const workflow = order.shipping?.workflow;
    const printableItems = (order.lineItems || []).filter((li) => {
      const skip = SKIP_FLAGS.find((f) => li.flags?.[f]);
      return !skip;
    });

    if (workflow === 'ship_to_managers' || workflow === 'ship_to_league') {
      const teamMap = new Map();
      for (const li of printableItems) {
        const id = li.subGalleryId || 0;
        const name = li.subGalleryName || 'Unknown';
        if (!teamMap.has(id)) {
          teamMap.set(id, { subGalleryId: id, subGalleryName: name, lineItems: [] });
        }
        teamMap.get(id).lineItems.push(li);
      }
      // If there were no printable items, still emit one empty sub-order
      // so callers get a result entry rather than silently nothing.
      if (teamMap.size === 0) {
        return [{ scope: 'home', lineItems: [] }];
      }
      return Array.from(teamMap.values()).map((t) => ({
        scope: { subGalleryId: t.subGalleryId, subGalleryName: t.subGalleryName },
        lineItems: t.lineItems,
      }));
    }

    // Default (incl. ship_to_home): everything together
    return [{ scope: 'home', lineItems: printableItems }];
  }

  // ─── SUB-ORDER PROCESSING ──────────────────────────────

  async _processSubOrder(order, sub, options) {
    const isPerTeam = sub.scope !== 'home';
    const teamScope = isPerTeam ? sub.scope : null;
    // Phase 35: reprint suffix threaded down from processOrder. When
    // non-empty, gets appended to every output filename so reprint
    // outputs sit alongside the originals without overwriting.
    const reprintSuffix = options.reprintSuffix || '';
    const isReprint = !!options.reprint;
    const subLabel = isPerTeam
      ? `team "${teamScope.subGalleryName}"`
      : 'whole order';
    console.log(`[Processing]   sub-order: ${subLabel} (${sub.lineItems.length} items)${isReprint ? ' [REPRINT' + reprintSuffix + ']' : ''}`);

    const subResult = {
      scope: sub.scope,
      success: false,
      txtPath: null,
      specialtyTxtPath: null,
      slipPath: null,
      dividerPath: null,
      photosDownloaded: [],
      photosFailed: [],
      imposedSheets: [],
      warnings: [],
      itemCount: sub.lineItems.length,
    };

    if (sub.lineItems.length === 0) {
      subResult.warnings.push({
        type: 'empty_sub_order',
        message: 'No printable line items in this sub-order',
      });
      subResult.success = true; // empty isn't a failure
      return subResult;
    }

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
    const downloadDir = pathsService.resolveFullPath(
      'downloadBase',
      order,
      sortSegments
    );

    try {
      await fsp.mkdir(downloadDir, { recursive: true });
    } catch (err) {
      subResult.warnings.push({
        type: 'mkdir_failed',
        path: downloadDir,
        message: err.message,
      });
    }

    // Resolve specialty base for any specialty items
    const specialtyBaseConfigured = await specialtyService.getBasePath();
    const specialtyBase =
      specialtyBaseConfigured ||
      path.win32.join(
        pathsService.resolveBase('downloadBase', order),
        'Specialty'
      );

    // ─── Step 1: download every line item's pic_full ──
    // Specialty items go to specialtyBase\subfolder; regular items go to
    // downloadDir. Filename is {orderNumber}_{cartId}_{originalFilename}
    // to avoid collisions when two line items reuse the same source photo.
    const photosByCartId = {};

    for (const li of sub.lineItems) {
      if (!li.photo || !li.photo.fullUrl) {
        subResult.photosFailed.push({
          cartId: li.cartId,
          productName: li.productName,
          error: 'no_photo_url',
        });
        continue;
      }

      const isSpecialty = await specialtyService.isSpecialty(li.sku);
      let targetDir;
      if (isSpecialty) {
        const sub = await specialtyService.getSpecialtySubfolder(li.sku);
        targetDir = path.win32.join(specialtyBase, sub || li.sku);
      } else {
        targetDir = downloadDir;
      }

      try {
        await fsp.mkdir(targetDir, { recursive: true });
      } catch (mkdirErr) {
        // Don't swallow this silently (was an empty catch). The
        // download below will still fail with its own error, but a
        // mkdir failure is the earliest, clearest signal that the
        // targetDir is bad — e.g. an illegal Windows path char in a
        // specialty subfolder (order 110924 root cause). Continue;
        // the download catch records the per-item failure.
        console.warn(
          `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId} sku=${li.sku}: mkdir failed for ${isSpecialty ? 'specialty ' : ''}targetDir "${targetDir}": ${mkdirErr.message} (continuing — download will record the per-item failure)`
        );
      }

      const filename = this._buildPhotoFilename(order, li, reprintSuffix);
      const filePath = path.win32.join(targetDir, filename);

      try {
        await this._downloadFile(li.photo.fullUrl, filePath);
        photosByCartId[li.cartId] = {
          path: filePath,
          isSpecialty,
          targetDir,
        };
        subResult.photosDownloaded.push({ cartId: li.cartId, path: filePath, isSpecialty });
      } catch (err) {
        subResult.photosFailed.push({
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          error: err.message,
        });
        // Surface in the server log, not just subResult.photosFailed
        // (which only shows in the result UI). Specialty failures in
        // particular were invisible here — the CLAUDE.md "easy to
        // miss" specialty soft-failure landmine. A photo that doesn't
        // download means a product that won't print; that deserves a
        // log line regardless of regular-vs-specialty.
        console.warn(
          `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId} sku=${li.sku}${isSpecialty ? ' (SPECIALTY)' : ''}: photo download FAILED → ${filePath}: ${err.message}`
        );
      }
    }

    // ─── Step 1.4 (Phase 34): green-screen compositing ──────
    // For line items where the customer selected a background (Sytist
    // cart_photo_bg > 0, surfaced as flags.greenScreen + backgroundPhoto),
    // composite the transparent subject onto the chosen background BEFORE
    // any other step touches the downloaded photo. This ensures:
    //
    //   - Imposition (Step 2) sees the composed image, so plain prints
    //     (Mini Magnets, wallets, etc.) get the proper background instead
    //     of a transparent PNG over white.
    //   - The packing slip (Step 3) can read the same composed image
    //     from disk via composedByCartId so its thumbnails match what
    //     actually prints.
    //   - The composite engine (Step 1.5) still receives the player image
    //     it expects — composites have their own `playerBackground` slot
    //     and don't pass through this code path. We only compose for
    //     line items WITHOUT a composite mapping; composite-mapped items
    //     keep their original subject buffer for the composite engine.
    //
    // The composed file is written alongside the original with a
    // "_composed.jpg" suffix. downloaded.path is updated to point at
    // the new file. downloaded.composedPath stores the same value so
    // downstream code can identify composed vs raw files.
    //
    // Failure handling: if the compose step fails (background fetch
    // error, etc.), we keep the original file and log a warning. The
    // line item still processes — better a missing background than a
    // missing item.
    const composedByCartId = {};
    for (const li of sub.lineItems) {
      const downloaded = photosByCartId[li.cartId];
      if (!downloaded) continue;

      // Phase 42 diagnostics: log per-cart greenscreen state so we can
      // diagnose why Step 1.4 fires or skips. This helps when a line
      // item shows the green-screen badge in the UI but doesn't get
      // composed in the pipeline (mismatch between display logic and
      // shouldComposite()'s requirements).
      if (li.flags?.greenScreen || li.backgroundPhoto) {
        console.log(
          `[Processing] Order ${order.orderId} cart ${li.cartId} sku=${li.sku}: ` +
            `greenScreen=${!!li.flags?.greenScreen} ` +
            `backgroundPhoto=${li.backgroundPhoto ? 'present' : 'null'} ` +
            `bgFullUrl=${li.backgroundPhoto?.fullUrl ? 'set' : 'missing'} ` +
            `shouldComposite=${greenscreenService.shouldComposite(li)}`
        );
      }

      if (!greenscreenService.shouldComposite(li)) continue;

      // Composite-mapped SKUs handle their own background via the
      // playerBackground slot. Skip green-screen for them so we don't
      // double-composite. Note: chainToImposition composites end up
      // using the composite output as the imposition source, which
      // already has the background baked in by the composite engine.
      let mapping;
      try {
        mapping = await compositeService.findMapping(li.sku);
      } catch {
        mapping = null;
      }
      if (mapping) continue;

      try {
        const subjectBuffer = await fsp.readFile(downloaded.path);
        const { buffer: composedBuffer, warnings: gsWarnings } =
          await greenscreenService.composeWithBackground(
            subjectBuffer,
            li.backgroundPhoto.fullUrl,
            { outputFormat: 'jpeg', jpegQuality: 92 }
          );
        if (gsWarnings && gsWarnings.length > 0) {
          for (const w of gsWarnings) {
            subResult.warnings.push({
              type: 'greenscreen_' + w.type,
              cartId: li.cartId,
              message: w.message,
            });
            console.warn(
              `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId} greenscreen ${w.type}: ${w.message}`
            );
          }
        }

        // Write the composed file alongside the original. We replace
        // the original file rather than keeping a sidecar: imposition
        // and downstream code already point at downloaded.path; the
        // single-file approach avoids changing every consumer. The
        // original transparent PNG is no longer useful once composed.
        //
        // Atomic .tmp+rename to avoid half-written files if the
        // process is killed mid-write.
        const composedExt = '.jpg'; // composeWithBackground default
        const composedPath =
          downloaded.path.replace(/\.[^.]+$/, '') + '_composed' + composedExt;
        const tmpPath = composedPath + '.tmp';
        await fsp.writeFile(tmpPath, composedBuffer);
        await fsp.rename(tmpPath, composedPath);

        // Update photosByCartId so imposition reads the composed file.
        // Keep composedPath alongside so packing slip can find it.
        downloaded.path = composedPath;
        downloaded.composedPath = composedPath;
        composedByCartId[li.cartId] = composedPath;

        console.log(
          `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId}: green-screen composed → ${composedPath}`
        );

        // Phase 42: publish a thumbnail-sized version of the composed
        // image to the configured backend (default 'skip' = nothing
        // happens). When the backend is 's3-sytist' with credentials
        // set, the returned URL is mutated onto the line item as
        // `composedImageUrl`. shipstationService.buildOrderFromSytist
        // picks that up and sends it as the line's imageUrl. Result:
        // ShipStation displays the actual composed product in its
        // line-item thumbnail column, not the keyed-out subject.
        //
        // Failures are non-fatal: the publish wrapper catches errors
        // and returns null, in which case we just don't set
        // composedImageUrl. ShipStation will see no imageUrl for that
        // line, which is the right behavior (current behavior, in fact
        // — Phase 41 already didn't send imageUrl when there was no
        // good URL).
        try {
          const thumbBuffer = await sharp(composedBuffer)
            .resize({
              width: 500,
              height: 500,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 80 })
            .toBuffer();

          const publishedUrl = await composedThumbnailService.publish(
            order.orderId,
            li.cartId,
            thumbBuffer
          );
          if (publishedUrl) {
            // Mutate the line item so downstream consumers
            // (shipstationService) can read it. This is the same
            // `li` object that's in sub.lineItems — mutation
            // propagates.
            li.composedImageUrl = publishedUrl;

            // Phase 43: persist the URL to SQLite so Push Packaging
            // and other downstream code paths can hydrate it later
            // without re-running Step 1.4. Lifetime ends when the
            // scheduler detects the order's flip to Shipped and
            // calls cleanup.
            try {
              const status = composedThumbnailService.status();
              composedThumbnailCacheService.upsert({
                orderId: order.orderId,
                cartId: li.cartId,
                publicUrl: publishedUrl,
                backend: status?.active || null,
              });
            } catch (cacheErr) {
              // Non-fatal — cache miss just means Push Packaging
              // falls back to thumbUrl. Process still succeeded.
              console.warn(
                `[Processing] Order ${order.orderId} cart ${li.cartId}: thumbnail cache upsert failed (non-fatal): ${cacheErr.message}`
              );
            }
          }
        } catch (thumbErr) {
          // Non-fatal — just no thumbnail to ShipStation.
          subResult.warnings.push({
            type: 'composed_thumbnail_failed',
            cartId: li.cartId,
            message: thumbErr.message,
          });
          console.warn(
            `[Processing] Order ${order.orderId} cart ${li.cartId}: composed thumbnail publish failed (non-fatal): ${thumbErr.message}`
          );
        }
      } catch (err) {
        subResult.warnings.push({
          type: 'greenscreen_compose_error',
          cartId: li.cartId,
          message: err.message,
        });
        console.warn(
          `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId}: green-screen compose failed: ${err.message} — using original subject`
        );
      }
    }

    // ─── Step 1.5 (Phase 8b): composite rendering ──────
    // For SKUs mapped to a composite layout, build the multi-image
    // composite (player + team photo + logo + text) and write it
    // alongside the player photo. Two outcomes per line item:
    //   - composite mapping has chainToImposition: true → replace
    //     downloaded.path with the composite output so Step 2's
    //     imposition uses the composite as its source. Used for
    //     products like "memory mate magnet sheet" (composite + tile).
    //   - chainToImposition: false (or unset) → composite output IS
    //     the final, mark cartId in skipImposition set so Step 2
    //     doesn't touch it.
    //
    // Failures fall back to placeholders — the orchestrator continues
    // rather than blocking the whole sub-order. Operator sees warnings
    // in the result UI.
    // Phase 52: batch-load every saved override for this order ONCE
    // (one indexed SQLite read, snapshots included) into a Map keyed by
    // String(cartId). The composite loop below consults this instead of
    // a per-line-item .get() fan-out. Non-fatal: a read failure just
    // means we render with SKU-mapped layouts (pre-Phase-52 behavior).
    const overridesByCart = new Map();
    try {
      for (const ov of orderOverrideService.listByOrderWithSnapshots(
        order.orderId
      )) {
        overridesByCart.set(String(ov.cartId), ov);
      }
    } catch (err) {
      subResult.warnings.push({
        type: 'override_batch_load_failed',
        message: `Could not load saved overrides for order ${order.orderId}: ${err.message} (rendering SKU-mapped layouts)`,
      });
    }

    const skipImpositionCartIds = new Set();
    for (const li of sub.lineItems) {
      const downloaded = photosByCartId[li.cartId];
      if (!downloaded) continue;

      let mapping;
      try {
        mapping = await compositeService.findMapping(li.sku);
      } catch (err) {
        subResult.warnings.push({
          type: 'composite_mapping_error',
          cartId: li.cartId,
          message: err.message,
        });
        continue;
      }
      if (!mapping) continue; // no composite mapping = use default flow

      // Phase 52: resolve layout + variant via the shared helper. When a
      // saved override exists for this cart its snapshot is used
      // WHOLESALE (and its OWN variant — the one the operator edited),
      // otherwise the SKU-mapped layout + orientation pick (exactly the
      // pre-Phase-52 behavior). `mapping` is passed through so the
      // helper doesn't re-query it; chainToImposition/specialty/
      // green-screen continue to key off `mapping` unchanged.
      const resolved = await overrideRenderService.resolveLayoutAndVariant(
        {
          lineItem: li,
          override: overridesByCart.get(String(li.cartId)) || null,
          mapping,
        }
      );
      for (const w of resolved.warnings || []) {
        subResult.warnings.push({ cartId: li.cartId, ...w });
      }
      const layout = resolved.layout;
      if (!layout) {
        subResult.warnings.push({
          type: 'composite_layout_missing',
          cartId: li.cartId,
          message: `No usable layout for cart ${li.cartId} (override + SKU mapping both unresolved)`,
        });
        continue;
      }
      if (resolved.layoutSource === 'override') {
        console.log(
          `[Processing] Order ${order.orderNumber || order.orderId} cart ${li.cartId}: using SAVED OVERRIDE layout (variant=${resolved.variant})`
        );
      }

      try {
        // Read the downloaded player photo from disk (it's already the
        // S3 fetch from Step 1, no need to re-download)
        const playerBuffer = await fsp.readFile(downloaded.path);

        // Resolve team photo via teamPhotoService
        let teamBuffer = null;
        let teamLookup = null;
        if (li.subGalleryId) {
          teamLookup = await teamPhotoService.findTeamPhoto(li.subGalleryId);
          if (teamLookup.found && teamLookup.photo.fullUrl) {
            try {
              const tpResp = await fetch(teamLookup.photo.fullUrl);
              if (tpResp.ok) {
                teamBuffer = Buffer.from(await tpResp.arrayBuffer());
              } else {
                subResult.warnings.push({
                  type: 'team_photo_fetch_failed',
                  cartId: li.cartId,
                  message: `HTTP ${tpResp.status} fetching team photo`,
                });
              }
            } catch (err) {
              subResult.warnings.push({
                type: 'team_photo_fetch_error',
                cartId: li.cartId,
                message: err.message,
              });
            }
          }
          // Surface team photo lookup warnings (multi-match, portrait etc.)
          if (teamLookup.warnings) {
            for (const w of teamLookup.warnings) {
              subResult.warnings.push({
                type: 'team_photo_' + (w.type || 'warning'),
                cartId: li.cartId,
                message: w.message,
              });
            }
          }
          if (!teamLookup.found) {
            subResult.warnings.push({
              type: 'team_photo_missing',
              cartId: li.cartId,
              message: `Team photo not found for sub-gallery ${li.subGalleryId} (rendering placeholder)`,
            });
          }
        }

        // Resolve logo (per gallery — not per sub-gallery)
        // galleryId lives on each line item (set from cart_pic_date_id)
        let logoBuffer = null;
        const galleryId = li.galleryId || order.galleryId || null;
        if (galleryId) {
          logoBuffer = await galleryAssetsService.readLogoBuffer(galleryId);
        }
        if (!logoBuffer) {
          subResult.warnings.push({
            type: 'logo_missing',
            cartId: li.cartId,
            message: galleryId
              ? `No logo uploaded for gallery ${galleryId} (rendering placeholder)`
              : 'No galleryId on order — cannot resolve logo',
          });
        }

        // Phase 10: resolve background photo when the cart references one.
        // li.backgroundPhoto is populated by sytistDbService when
        // cart_photo_bg > 0. Only fetch when the layout actually has a
        // playerBackground slot — otherwise we'd download bytes that
        // never get used.
        let playerBackgroundBuffer = null;
        const layoutHasBackgroundSlot = (
          (layout.variants?.vertical?.slots || [])
            .concat(layout.variants?.horizontal?.slots || [])
        ).some((s) => s.kind === 'playerBackground');

        if (layoutHasBackgroundSlot && li.backgroundPhoto?.fullUrl) {
          try {
            const bgResp = await fetch(li.backgroundPhoto.fullUrl);
            if (bgResp.ok) {
              const bgArrayBuffer = await bgResp.arrayBuffer();
              playerBackgroundBuffer = Buffer.from(bgArrayBuffer);
            } else {
              subResult.warnings.push({
                type: 'background_photo_fetch_failed',
                cartId: li.cartId,
                message: `Background photo HTTP ${bgResp.status} from ${li.backgroundPhoto.fullUrl}`,
              });
            }
          } catch (err) {
            subResult.warnings.push({
              type: 'background_photo_fetch_error',
              cartId: li.cartId,
              message: err.message,
            });
          }
        }
        // Note: when the layout has a playerBackground slot but the cart
        // didn't reference a background, we DON'T warn. Some orders just
        // don't have green-screen backgrounds; the slot silently skips.

        // Phase 52: variant comes from resolveLayoutAndVariant — for an
        // override it's the variant the operator edited; otherwise it's
        // the orientation pick (same as the old inline pickVariant).
        const variant = resolved.variant;

        // Build tokens from the order
        const tokens = compositeService.buildTokensFromOrder(order, li);

        // Phase 9c: load any static graphics the layout references.
        // Walk the chosen variant's slots, find every staticGraphic
        // (or legacy 'overlay') slot, read the bytes from disk via
        // compositeGraphicsService, and pass them as tokens.overlays.
        // Misses are non-fatal — the renderer will warn per-slot
        // and skip the placement.
        const variantDef = layout.variants?.[variant] || { slots: [] };
        const graphicsMap = {};
        const seenKeys = new Set();
        for (const s of variantDef.slots || []) {
          if (s.kind !== 'staticGraphic' && s.kind !== 'overlay') continue;
          const key = s.graphicKey || s.overlayId;
          if (!key || seenKeys.has(key)) continue;
          seenKeys.add(key);
          const meta = layout.graphics ? layout.graphics[key] : null;
          try {
            const buf = await compositeGraphicsService.readGraphicBuffer({
              layoutId: layout.id,
              key,
              filename: meta && meta.filename,
            });
            if (buf) {
              graphicsMap[key] = buf;
            } else {
              subResult.warnings.push({
                type: 'graphic_missing',
                cartId: li.cartId,
                message: `Static graphic "${key}" referenced by layout "${layout.id}" but file not found on disk`,
              });
            }
          } catch (err) {
            subResult.warnings.push({
              type: 'graphic_load_error',
              cartId: li.cartId,
              message: `Loading graphic "${key}": ${err.message}`,
            });
          }
        }
        // The renderer expects buffers under tokens.overlays (naming
        // kept for backward compat with the existing render path).
        tokens.overlays = graphicsMap;

        // Phase 52: apply Phase 50 per-slot image overrides before
        // compositing — same shared helper renderOverrideForOrder uses,
        // so Process and Apply produce identical output. Missing-on-disk
        // override → keeps the default buffer + a warning (never fails).
        const imgOv = await overrideRenderService.applyImageOverrides({
          orderId: order.orderId,
          cartId: li.cartId,
          layout,
          variant,
          buffers: {
            playerPhoto: playerBuffer,
            teamPhoto: teamBuffer,
            logo: logoBuffer,
            playerBackground: playerBackgroundBuffer,
          },
        });
        for (const w of imgOv.warnings || []) {
          subResult.warnings.push({ cartId: li.cartId, ...w });
        }

        const result = await compositeService.buildSheetBuffer({
          layout,
          variant,
          playerPhoto: imgOv.buffers.playerPhoto,
          teamPhoto: imgOv.buffers.teamPhoto,
          logo: imgOv.buffers.logo,
          playerBackground: imgOv.buffers.playerBackground,
          tokens,
        });

        // Write the composite output. Lives next to the player photo.
        const compositeFilename = this._buildCompositeFilename(
          order,
          li,
          layout,
          reprintSuffix
        );
        const compositePath = path.win32.join(
          downloaded.targetDir,
          compositeFilename
        );
        const tmp = compositePath + '.tmp';
        await fsp.writeFile(tmp, result.buffer);
        await fsp.rename(tmp, compositePath);

        subResult.composites = subResult.composites || [];
        subResult.composites.push({
          cartId: li.cartId,
          layoutId: layout.id,
          layoutName: layout.name,
          variant,
          path: compositePath,
          chainToImposition: !!mapping.chainToImposition,
          teamPhotoFound: !!teamLookup?.found,
          logoFound: !!logoBuffer,
        });

        // Phase 44: publish a thumbnail of the composite output to
        // the configured backend (default 'skip' = no-op). This
        // matches the green-screen publish flow in Step 1.4 and
        // produces a URL that:
        //   - shipstationService picks up via li.composedImageUrl,
        //     so SS shows the actual composite (Memory Mate, etc.)
        //     instead of just the keyed-out subject
        //   - the dashboard's order detail page surfaces too, via a
        //     new endpoint that reads the cache
        //
        // Same constraints as the green-screen publish: non-fatal,
        // backend can fail silently and processing continues.
        try {
          const compositeThumbBuffer = await sharp(result.buffer)
            .resize({
              width: 500,
              height: 500,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 80 })
            .toBuffer();

          const publishedCompositeUrl =
            await composedThumbnailService.publish(
              order.orderId,
              li.cartId,
              compositeThumbBuffer
            );
          if (publishedCompositeUrl) {
            li.composedImageUrl = publishedCompositeUrl;
            try {
              const status = composedThumbnailService.status();
              composedThumbnailCacheService.upsert({
                orderId: order.orderId,
                cartId: li.cartId,
                publicUrl: publishedCompositeUrl,
                backend: status?.active || null,
              });
            } catch (cacheErr) {
              console.warn(
                `[Processing] Order ${order.orderId} cart ${li.cartId}: composite thumbnail cache upsert failed (non-fatal): ${cacheErr.message}`
              );
            }
          }
        } catch (thumbErr) {
          subResult.warnings.push({
            type: 'composite_thumbnail_failed',
            cartId: li.cartId,
            message: thumbErr.message,
          });
          console.warn(
            `[Processing] Order ${order.orderId} cart ${li.cartId}: composite thumbnail publish failed (non-fatal): ${thumbErr.message}`
          );
        }

        // Surface composite-internal warnings
        for (const w of result.warnings || []) {
          subResult.warnings.push({
            type: 'composite_' + (w.type || 'warning'),
            cartId: li.cartId,
            message: w.message,
          });
        }

        if (mapping.chainToImposition) {
          // Composite output becomes the source for imposition.
          // Replace the player photo at the same path so Step 2
          // imposition picks up the composite.
          //
          // We do this by overwriting the player photo file. Imposition
          // expects a single source path; rather than threading a "use
          // this other file" parameter through, we just replace the
          // file at the existing path.
          const tmp2 = downloaded.path + '.tmp';
          await fsp.writeFile(tmp2, result.buffer);
          await fsp.rename(tmp2, downloaded.path);
        } else {
          // Composite is the final. Step 2 should NOT run imposition
          // on this cartId. Also: the .txt should reference the
          // composite path, not the original player photo.
          // We update photosByCartId to point at the composite path
          // so the .txt-build step picks up the right file.
          downloaded.path = compositePath;
          skipImpositionCartIds.add(li.cartId);
        }
      } catch (err) {
        subResult.warnings.push({
          type: 'composite_render_error',
          cartId: li.cartId,
          message: err.message,
        });
      }
    }

    // ─── Step 2: imposition in-place on every successfully-downloaded photo
    // composeSheetInPlace is destructive (.tmp + rename), but only fires
    // when there's a rule for the SKU. Items without a rule pass through
    // untouched.
    //
    // Phase 8b: cartIds in skipImpositionCartIds are skipped (composite
    // already produced the final output for them).
    const successfullyImposedCartIds = new Set();
    for (const li of sub.lineItems) {
      const downloaded = photosByCartId[li.cartId];
      if (!downloaded) continue;
      if (skipImpositionCartIds.has(li.cartId)) continue;

      try {
        const ctx = impositionService.buildContext(order, li);
        const r = await impositionService.composeSheetInPlace(
          downloaded.path,
          li.sku,
          ctx
        );
        if (r.imposed) {
          subResult.imposedSheets.push({
            cartId: li.cartId,
            layout: r.layout?.name || null,
            path: r.path,
            warnings: r.warnings || [],
          });
          successfullyImposedCartIds.add(li.cartId);
        }
        if (r.warnings && r.warnings.length > 0) {
          for (const w of r.warnings) {
            subResult.warnings.push({
              type: 'imposition_' + (w.type || 'warning'),
              cartId: li.cartId,
              message: w.message,
            });
          }
        }
      } catch (err) {
        subResult.warnings.push({
          type: 'imposition_error',
          cartId: li.cartId,
          message: err.message,
        });
      }
    }

    // ─── Step 3: build & write the packing slip
    //
    // Phase 35: skip the slip when reprinting a SINGLE item (via the
    // lineItemFilter / per-item reprint endpoint). A one-item slip
    // is just visual noise — the operator already knows what they're
    // reprinting. Full-order reprints DO get a slip (with the
    // _REPRINT suffix in the filename).
    let slipBuildResult;
    const skipSlip = isReprint && Array.isArray(options.lineItemFilter) && options.lineItemFilter.length > 0;
    if (skipSlip) {
      subResult.slipPath = null;
      console.log(
        `[Processing] Order ${order.orderNumber || order.orderId}: skipping slip for single-item reprint`
      );
    } else {
    try {
      // Phase 44: build a per-cartId map of composite output paths.
      // The packing slip uses these to render the actual composite
      // (Memory Mate, etc.) as the thumbnail for each line item,
      // matching what gets printed. Falls back to composedByCartId
      // (green-screen composite) or photo.thumbUrl as before.
      const compositePathsByCartId = {};
      for (const c of subResult.composites || []) {
        if (c.cartId !== undefined && c.cartId !== null && c.path) {
          compositePathsByCartId[c.cartId] = c.path;
        }
      }

      slipBuildResult = await packingSlipService.buildSlipBuffer(order, {
        sortSegments,
        teamScope,
        // Phase 34: per-cartId map of disk paths for line items whose
        // photo was green-screen-composited in Step 1.4. The slip
        // service prefers these over thumbUrl fetches so thumbnails
        // match the composed images that actually print.
        composedByCartId,
        // Phase 44: per-cartId map of composite engine output paths.
        // For items with a composite layout (Memory Mate, etc.),
        // the slip shows the rendered composite as the thumbnail
        // rather than the customer's raw subject photo. Takes
        // priority over composedByCartId since the composite engine
        // output INCLUDES the chosen background (via playerBackground
        // slot) plus the rest of the layout.
        compositePathsByCartId,
        // Phase 35: append the reprint suffix to the slip filename
        // so it doesn't collide with the original slip.
        filenameSuffix: reprintSuffix,
      });
      const written = await packingSlipService.writeSlipFile(slipBuildResult);
      subResult.slipPath = written.filePath;
    } catch (err) {
      subResult.warnings.push({
        type: 'slip_failed',
        message: err.message,
      });
      subResult.error = `Slip generation failed: ${err.message}`;
      return subResult; // can't continue without slip
    }
    } // end if (!skipSlip)

    // ─── Step 4: optional team divider
    if (options.generateDivider && isPerTeam) {
      try {
        const divider = await teamDividerService.buildDividerBuffer(
          teamScope.subGalleryName,
          {
            galleryName: order.galleryName,
            order,
            sortSegments,
          }
        );
        const written = await teamDividerService.writeDividerFile(divider);
        subResult.dividerPath = written.filePath;
      } catch (err) {
        subResult.warnings.push({
          type: 'divider_failed',
          message: err.message,
        });
        // Divider isn't critical; continue
      }
    }

    // ─── Step 5: build the .txt
    // Two lists: regular items (everything that landed in downloadDir) and
    // specialty items (everything that landed in specialtyBase\subfolder).
    // Regular .txt includes the slip; specialty .txt does not (specialty
    // items go in their own bin, not the customer's).

    // We need to construct .txt entries that point at the actual paths
    // we downloaded to. darkroomService.buildOrderTxt's standard
    // behavior is to compute filepaths from order data, but since we
    // downloaded with a different filename pattern (orderNumber_cartId_orig),
    // we synthesize a custom filtered order shape that excludes the
    // failed line items and overrides the photo URLs.

    const regularLineItems = sub.lineItems.filter((li) => {
      const dl = photosByCartId[li.cartId];
      return dl && !dl.isSpecialty;
    });
    const specialtyLineItems = sub.lineItems.filter((li) => {
      const dl = photosByCartId[li.cartId];
      return dl && dl.isSpecialty;
    });

    // Failed photos: warn the operator
    for (const fail of subResult.photosFailed) {
      subResult.warnings.push({
        type: 'photo_skipped',
        cartId: fail.cartId,
        message: `${fail.productName || 'Item'} skipped: ${fail.error}`,
      });
    }

    // Regular .txt
    if (regularLineItems.length > 0 || subResult.slipPath) {
      try {
        const filteredOrder = this._buildFilteredOrder(
          order,
          regularLineItems,
          photosByCartId
        );
        const txtBuild = await darkroomService.buildOrderTxt(filteredOrder, {
          sortSegments,
          packingSlipPath: subResult.slipPath,
          slipPosition: 'last',
          teamScope,
        });

        // Override the txt's filename so per-team chunks don't collide.
        // Phase 35: also append the reprint suffix when reprinting so
        // the reprint .txt sits alongside the original instead of
        // overwriting it.
        const teamSuffix = teamScope
          ? '_' + (teamScope.subGalleryName || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_')
          : '';
        const combinedSuffix = teamSuffix + (reprintSuffix || '');
        if (combinedSuffix) {
          const orig = txtBuild.filename;
          const dot = orig.lastIndexOf('.');
          const newName = (dot > 0 ? orig.slice(0, dot) + combinedSuffix + orig.slice(dot) : orig + combinedSuffix);
          txtBuild.filename = newName;
          txtBuild.filePath = path.win32.join(downloadDir, newName);
        }

        await darkroomService.writeTxtFile(txtBuild, {
          waitForImages: true,
          timeoutMs: 30000,
        });
        subResult.txtPath = txtBuild.filePath;
      } catch (err) {
        subResult.warnings.push({
          type: 'txt_failed',
          message: err.message,
        });
        subResult.error = `Darkroom .txt generation failed: ${err.message}`;
        return subResult;
      }
    }

    // Specialty .txt (separate file in the specialty base)
    if (specialtyLineItems.length > 0) {
      try {
        const specialtyDir = path.win32.dirname(
          photosByCartId[specialtyLineItems[0].cartId].path
        );
        const filteredOrder = this._buildFilteredOrder(
          order,
          specialtyLineItems,
          photosByCartId
        );

        const txtBuild = await darkroomService.buildOrderTxt(filteredOrder, {
          sortSegments: [],
          packingSlipPath: null, // no slip in specialty bin
          slipPosition: 'last',
          teamScope,
        });

        // Override path to land in the specialty dir
        const teamSuffix = teamScope
          ? '_' + (teamScope.subGalleryName || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_')
          : '';
        const newName = `${order.orderNumber || order.orderId}${teamSuffix}${reprintSuffix || ''}_specialty.txt`;
        txtBuild.filename = newName;
        txtBuild.filePath = path.win32.join(specialtyDir, newName);

        await darkroomService.writeTxtFile(txtBuild, {
          waitForImages: true,
          timeoutMs: 30000,
        });
        subResult.specialtyTxtPath = txtBuild.filePath;
      } catch (err) {
        subResult.warnings.push({
          type: 'specialty_txt_failed',
          message: err.message,
        });
        // Don't fail the sub-order on specialty .txt failure — regular
        // .txt is the critical path. Specialty becomes a manual fix.
      }
    }

    subResult.success = true;
    return subResult;
  }

  /**
   * Build a filtered/synthesized canonical order shape suitable for
   * darkroomService.buildOrderTxt. Replaces each line item's photo with
   * a stub whose `originalFilename` matches our actual on-disk filename
   * so the .txt's Filepath= lines point at the right place.
   */
  _buildFilteredOrder(order, lineItems, photosByCartId) {
    const filtered = { ...order };
    filtered.lineItems = lineItems.map((li) => {
      const dl = photosByCartId[li.cartId];
      const onDiskFilename = path.win32.basename(dl.path);
      return {
        ...li,
        photo: {
          ...(li.photo || {}),
          // darkroomService uses originalFilename to compose Filepath= entries
          originalFilename: onDiskFilename,
        },
      };
    });
    return filtered;
  }

  _buildPhotoFilename(order, lineItem, reprintSuffix = '') {
    const orderNum = order.orderNumber || order.orderId;
    const cartId = lineItem.cartId;
    const originalName =
      lineItem.photo?.originalFilename ||
      `cart${cartId}.jpg`;
    // Sanitize
    const safe = String(originalName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    // Phase 35: reprint suffix goes between the cartId and the
    // original filename (before the dot). For an _REPRINT_2 reprint
    // of order 110685 / cart 481629:
    //   110685_481629_REPRINT_2_JV_Baseball-0016.png
    if (reprintSuffix) {
      return `${orderNum}_${cartId}${reprintSuffix}_${safe}`;
    }
    return `${orderNum}_${cartId}_${safe}`;
  }

  /**
   * Phase 8b: composite output filename. Lives next to the player photo
   * with a "_composite_{layoutId}" infix so it's distinguishable when
   * an operator browses the output folder. JPG-only since composite
   * always renders to JPG (compositeService sets quality 95 internally).
   *
   * Example:
   *   order 110855, cartId 12345, layout "memory-mate-5x7-v1" →
   *     "110855_12345_composite_memory-mate-5x7-v1.jpg"
   *
   * Phase 35: when reprintSuffix is provided, the suffix is appended
   * before the .jpg extension to keep reprint composites distinct
   * from the originals.
   */
  _buildCompositeFilename(order, lineItem, layout, reprintSuffix = '') {
    const orderNum = order.orderNumber || order.orderId;
    const cartId = lineItem.cartId;
    const layoutId = (layout && layout.id) || 'composite';
    const safeLayoutId = String(layoutId).replace(/[<>:"/\\|?*\x00-\x1F\s]/g, '_');
    return `${orderNum}_${cartId}_composite_${safeLayoutId}${reprintSuffix}.jpg`;
  }

  /**
   * Download a URL to a file path. Uses .tmp + rename so partial
   * downloads don't leave a half-written file at the destination.
   */
  async _downloadFile(url, destPath) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    const ab = await resp.arrayBuffer();
    const dir = path.win32.dirname(destPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = destPath + '.tmp';
    await fsp.writeFile(tmpPath, Buffer.from(ab));
    await fsp.rename(tmpPath, destPath);
    return destPath;
  }
}

module.exports = new ProcessingService();
module.exports.SKIP_FLAGS = SKIP_FLAGS;

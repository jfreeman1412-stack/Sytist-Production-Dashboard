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
const sytistDb = require('./sytistDbService');

const SETTINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'processing-settings.json'
);

const DEFAULT_SETTINGS = {
  autoStatusUpdate: false,
  targetStatusId: null,
};

// Skip flags shared with darkroom + slip — items with any of these aren't
// print jobs and are dropped from processing entirely.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell'];

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

    const result = {
      orderId: order.orderId,
      orderNumber: order.orderNumber || order.orderId,
      mode: pathsService.getMode(),
      subOrders: [],
      statusUpdated: false,
      newStatusId: null,
    };

    const subOrders = this._splitIntoSubOrders(order);
    console.log(
      `[Processing] Order ${order.orderId}: ${subOrders.length} sub-order(s) ` +
        `(workflow=${order.shipping?.workflow}, items=${(order.lineItems || []).length})`
    );

    for (const sub of subOrders) {
      const subResult = await this._processSubOrder(order, sub, {
        generateDivider,
      });
      result.subOrders.push(subResult);
    }

    // Status update: only when all sub-orders succeeded
    const allOk = result.subOrders.every((s) => s.success);
    if (allOk) {
      const settings = await this.getSettings();
      if (
        settings.autoStatusUpdate &&
        settings.targetStatusId !== null &&
        settings.targetStatusId !== undefined
      ) {
        try {
          await sytistDb.updateOrderStatus(order.orderId, settings.targetStatusId);
          result.statusUpdated = true;
          result.newStatusId = settings.targetStatusId;
          console.log(
            `[Processing] Order ${order.orderId}: status → ${settings.targetStatusId}`
          );
        } catch (err) {
          console.warn(
            `[Processing] Status update failed for ${order.orderId}: ${err.message}`
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
    const subLabel = isPerTeam
      ? `team "${teamScope.subGalleryName}"`
      : 'whole order';
    console.log(`[Processing]   sub-order: ${subLabel} (${sub.lineItems.length} items)`);

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
      } catch {
        /* continue — write below will fail with a clearer error */
      }

      const filename = this._buildPhotoFilename(order, li);
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

      let layout;
      try {
        layout = await compositeService.getLayout(mapping.layoutId);
      } catch {
        layout = null;
      }
      if (!layout) {
        subResult.warnings.push({
          type: 'composite_layout_missing',
          cartId: li.cartId,
          message: `Composite mapping points at layout "${mapping.layoutId}" which doesn't exist`,
        });
        continue;
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

        // Pick variant from the player photo's orientation
        const playerWidth = li.photo?.width || 0;
        const playerHeight = li.photo?.height || 0;
        const variant = compositeService.pickVariant(
          layout,
          playerWidth,
          playerHeight
        );

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

        const result = await compositeService.buildSheetBuffer({
          layout,
          variant,
          playerPhoto: playerBuffer,
          teamPhoto: teamBuffer,
          logo: logoBuffer,
          tokens,
        });

        // Write the composite output. Lives next to the player photo.
        const compositeFilename = this._buildCompositeFilename(
          order,
          li,
          layout
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
    let slipBuildResult;
    try {
      slipBuildResult = await packingSlipService.buildSlipBuffer(order, {
        sortSegments,
        teamScope,
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

        // Override the txt's filename so per-team chunks don't collide
        const teamSuffix = teamScope
          ? '_' + (teamScope.subGalleryName || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_')
          : '';
        if (teamSuffix) {
          const orig = txtBuild.filename;
          const dot = orig.lastIndexOf('.');
          const newName = (dot > 0 ? orig.slice(0, dot) + teamSuffix + orig.slice(dot) : orig + teamSuffix);
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
        const newName = `${order.orderNumber || order.orderId}${teamSuffix}_specialty.txt`;
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

  _buildPhotoFilename(order, lineItem) {
    const orderNum = order.orderNumber || order.orderId;
    const cartId = lineItem.cartId;
    const originalName =
      lineItem.photo?.originalFilename ||
      `cart${cartId}.jpg`;
    // Sanitize
    const safe = String(originalName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
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
   */
  _buildCompositeFilename(order, lineItem, layout) {
    const orderNum = order.orderNumber || order.orderId;
    const cartId = lineItem.cartId;
    const layoutId = (layout && layout.id) || 'composite';
    const safeLayoutId = String(layoutId).replace(/[<>:"/\\|?*\x00-\x1F\s]/g, '_');
    return `${orderNum}_${cartId}_composite_${safeLayoutId}.jpg`;
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

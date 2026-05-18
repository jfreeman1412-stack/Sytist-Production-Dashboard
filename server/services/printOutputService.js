// printOutputService.js
//
// Phase 56b — the single source of truth for WHERE a per-item
// print-ready file lands, under WHAT name, and that imposed SKUs get
// imposed. Shared by the two render paths that had silently drifted:
//
//   1. processingService Step 1.5/2  (normal Process / Reprint)
//   2. renderOverrideForOrder        (override editor Apply Overwrite /
//                                     Apply Reprint, + DELETE restore)
//
// Narrow extraction (Phase 56b decision B): this module owns only the
// drift-prone produce-output concern — directory resolution, filename,
// reprint numbering, the atomic write, and the impose-in-place step.
// processingService's composite loop structure is left intact; it just
// sources these values/this step here so Apply and Process can't
// diverge again (same principle as Phase 52's overrideRenderService).
//
// Four pre-existing bugs this unblocks (see SPEC §56):
//   - parseInt cartId keying (fixed in 56a)
//   - Apply never imposed chainToImposition items (56b core)
//   - Apply Reprint hardcoded "_REPRINT" → 2nd reprint collided (A)
//   - Apply wrote to the order ROOT, not the folder-sort subdir, so
//     for folder-sorted orders it never overwrote the file the .txt /
//     lab actually print (C). Process always used the sort subdir.
//
// Parity-plus-warning (56b decision): a chainToImposition mapping with
// NO imposition rule (misconfig) yields the bare composite at the
// photo-derived path — exactly Process's current behavior — but emits
// an `imposition_rule_missing` warning so it's visible, not silent.
// Hard-failing that case would change Process behavior and is out of
// scope for a parity-extraction phase.

const fsp = require('fs').promises;
const path = require('path');

const folderSortService = require('./folderSortService');
const pathsService = require('./pathsService');
const impositionService = require('./impositionService');

// Windows-reserved set, lifted verbatim from processingService's
// _buildPhotoFilename / _buildCompositeFilename so names are identical.
const RESERVED = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED_WS = /[<>:"/\\|?*\x00-\x1F\s]/g;

/**
 * The single source of truth for the per-item output directory:
 * folder-sort segments → resolved downloadBase path. Process always
 * used this; Apply used [] (order root) — bug #4 (decision C). Both
 * now call this so they can't diverge.
 *
 * @returns {Promise<{ dir: string, sortSegments: string[] }>}
 */
async function resolveOutputDir(order) {
  const sortLevels = await folderSortService.getSortLevels();
  const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
  const dir = pathsService.resolveFullPath(
    'downloadBase',
    order,
    sortSegments
  );
  return { dir, sortSegments };
}

/**
 * Next reprint ordinal for an order, by scanning `dir` for existing
 * `${orderNum}_REPRINT*` outputs. Verbatim lift of processingService
 * `_nextReprintNumber`, BUT `dir` is now a parameter the caller
 * resolves once (via resolveOutputDir) instead of being recomputed
 * internally — that's what makes Apply scan the SAME directory Process
 * writes to (fixes bug #3's collision, which only worked by accident
 * because Apply hardcoded "_REPRINT" and never scanned at all).
 *
 * CALLER CONTRACT: compute this ONCE per order/run and thread the
 * single value through every item + the .txt + packing slip. Never
 * call it per-item inside a loop — item 2 would see item 1's freshly
 * written `_REPRINT` and bump to `_REPRINT_2`, breaking Process's
 * whole-batch-shares-one-N invariant.
 *
 * Returns the ordinal: 1 = first reprint, 2 = second, …  (maxN + 1).
 */
async function nextReprintNumber(order, dir) {
  try {
    const orderNum = order.orderNumber || order.orderId;
    let existing;
    try {
      existing = await fsp.readdir(dir);
    } catch {
      return 1; // dir doesn't exist yet → no prior reprints
    }
    const prefix = `${orderNum}_REPRINT`;
    let maxN = 0;
    for (const name of existing) {
      if (!name.startsWith(prefix)) continue;
      const after = name.slice(prefix.length);
      const m = after.match(/^_(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      } else {
        // `_REPRINT` with no _N (e.g. `_REPRINT_packing_slip`) = N=1
        if (maxN < 1) maxN = 1;
      }
    }
    return maxN + 1;
  } catch (err) {
    console.warn(
      `[PrintOutput] nextReprintNumber failed for ${order.orderId} — defaulting to 1: ${err.message}`
    );
    return 1;
  }
}

/**
 * Reprint filename suffix for an ordinal. Matches processingService's
 * existing convention exactly: 1 → `_REPRINT`, ≥2 → `_REPRINT_${n}`,
 * ≤0/falsy → `` (not a reprint).
 */
function reprintSuffix(n) {
  if (!n || n <= 0) return '';
  return n === 1 ? '_REPRINT' : `_REPRINT_${n}`;
}

/**
 * The per-item output filename. Verbatim merge of processingService's
 * `_buildPhotoFilename` (chainToImposition → photo-derived, because
 * the composite is overwritten then imposed in place at that path) and
 * `_buildCompositeFilename` (composite-final). Process's decision rule
 * (`mapping.chainToImposition`) is preserved exactly — no behavior
 * change for Process; this only stops Apply from diverging.
 */
function buildOutputFilename({
  order,
  lineItem,
  layout,
  chainToImposition,
  reprintSuffix: suffix = '',
}) {
  const orderNum = order.orderNumber || order.orderId;
  const cartId = lineItem.cartId;
  if (chainToImposition) {
    const originalName =
      (lineItem.photo && lineItem.photo.originalFilename) ||
      `cart${cartId}.jpg`;
    const safe = String(originalName).replace(RESERVED, '_');
    // suffix sits between cartId and the original name (before its dot)
    return `${orderNum}_${cartId}${suffix}_${safe}`;
  }
  const layoutId = (layout && layout.id) || 'composite';
  const safeLayoutId = String(layoutId).replace(RESERVED_WS, '_');
  return `${orderNum}_${cartId}_composite_${safeLayoutId}${suffix}.jpg`;
}

/**
 * Produce the final print-ready file for ONE line item. The single
 * call renderOverrideForOrder makes (its inline version was the broken
 * one). Process keeps its own loop but sources the dir/filename/N from
 * the functions above and keeps its existing Step 2 composeSheetInPlace
 * — so both paths now produce byte/path-identical output.
 *
 * @param {object}  order
 * @param {object}  lineItem
 * @param {object}  mapping        composite mapping (.chainToImposition)
 * @param {object}  layout         resolved layout (for composite-final name)
 * @param {Buffer}  compositeBuffer the rendered composite bytes
 * @param {string}  dir            from resolveOutputDir(order).dir
 * @param {number}  reprintNumber  caller-computed-once (0 = not a reprint)
 *
 * @returns {Promise<{ finalPath, finalFilename, imposed,
 *                      impositionLayout, warnings }>}
 */
async function produceFinalOutput({
  order,
  lineItem,
  mapping,
  layout,
  compositeBuffer,
  dir,
  reprintNumber = 0,
}) {
  const warnings = [];
  const chainToImposition = !!(mapping && mapping.chainToImposition);
  const suffix = reprintSuffix(reprintNumber);
  const finalFilename = buildOutputFilename({
    order,
    lineItem,
    layout,
    chainToImposition,
    reprintSuffix: suffix,
  });
  const finalPath = path.win32.join(dir, finalFilename);

  // Ensure the (folder-sort) directory exists, then atomic write —
  // .tmp + rename, same pattern Process and the old Apply both used.
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = finalPath + '.tmp';
  await fsp.writeFile(tmpPath, compositeBuffer);
  await fsp.rename(tmpPath, finalPath);

  let imposed = false;
  let impositionLayout = null;

  if (chainToImposition) {
    // Identical to Process Step 2: build the context, impose IN PLACE
    // (composeSheetInPlace overwrites finalPath, so the .txt's
    // Filepath= keeps pointing at the same path before and after).
    const ctx = impositionService.buildContext(order, lineItem);
    const r = await impositionService.composeSheetInPlace(
      finalPath,
      lineItem.sku,
      ctx
    );
    imposed = !!r.imposed;
    impositionLayout = (r.layout && r.layout.name) || null;
    for (const w of r.warnings || []) {
      warnings.push({
        type: 'imposition_' + (w.type || 'warning'),
        message: w.message,
      });
    }
    if (!imposed) {
      // Parity-plus-warning: chainToImposition but no rule fired
      // (missing/misconfigured imposition rule). Process behaves the
      // same — bare composite at the photo-derived path — we just make
      // it visible instead of silent.
      warnings.push({
        type: 'imposition_rule_missing',
        message: `chainToImposition is set for SKU ${lineItem.sku} but no imposition rule produced a sheet — the bare composite was left at ${finalFilename}. Check imposition-layouts.json.`,
      });
    }
  }

  return { finalPath, finalFilename, imposed, impositionLayout, warnings };
}

module.exports = {
  resolveOutputDir,
  nextReprintNumber,
  reprintSuffix,
  buildOutputFilename,
  produceFinalOutput,
};

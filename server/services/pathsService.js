// pathsService.js
//
// Central path resolver for the production pipeline.
//
// Phase 4.1: PURE PATH RESOLUTION ONLY. No file writes. No directory creation.
// Downstream services (darkroomService, packingSlipService, impositionService,
// folderSortService) ask this service "where would output X for order Y land?"
// and get back a fully-resolved absolute path.
//
// Two layers compose to produce the final path:
//
//   1. The base path for an output type (downloadBase, darkroomTxtBase, etc.)
//      comes from server/config/path-overrides.json. That file has a "mode"
//      key — either "test" or "production". Test mode points everything at a
//      sandbox under Downloads; production mode points at the live Z: share.
//
//   2. Folder-sort segments produced by folderSortService get appended on
//      top of the base path. By default sortLevels = ["no_sort"] so segments
//      is [] and the resolved path is just the base. Operators can configure
//      sub-folder layouts later (gallery/team/etc) without changing code.
//
// Token replacement happens on the raw template string in path-overrides.json
// before segments are appended. Supported tokens:
//
//   {date}        — order date in YYYY-MM-DD form (from order.orderDate). Used
//                   primarily in the base template — the date partition keeps
//                   each day's orders together at the top of the tree.
//   {orderId}     — order.orderId
//   {gallery}     — order.galleryName (sanitized)
//   {subGallery}  — order.subGalleryName (sanitized; "" for non-sibling orders)
//   {workflow}    — order.shipping.workflow ("ship_to_home" / "ship_to_managers"
//                   / "ship_to_league")
//
// This service is intentionally synchronous after init; reads from a cached
// JSON file. Restart the server to pick up changes.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const OVERRIDES_PATH = path.join(__dirname, '..', 'config', 'path-overrides.json');

// Output types we know about. Adding a new one = add a key here + matching
// keys under modes.test / modes.production in path-overrides.json.
const OUTPUT_TYPES = [
  'downloadBase',
  'darkroomTxtBase',
  'packingSlipBase',
  'impositionBase',
  'darkroomTemplateBase',
];

const FALLBACK_BASE = 'C:\\Users\\Sportsline\\Downloads\\sytist-dashboard-test-output\\{date}';

class PathsService {
  constructor() {
    this._overrides = null;
    this._mode = null;
    this._loadedAt = null;
  }

  // ─── Config loading ────────────────────────────────────

  _load() {
    if (this._overrides) return this._overrides;

    try {
      const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
      const parsed = JSON.parse(raw);

      const mode = parsed.mode || 'test';
      if (!parsed.modes || !parsed.modes[mode]) {
        throw new Error(
          `path-overrides.json: mode "${mode}" has no matching entry under modes.${mode}`
        );
      }

      this._overrides = parsed;
      this._mode = mode;
      this._loadedAt = new Date().toISOString();

      console.log(
        `[PathsService] Loaded ${OVERRIDES_PATH} (mode=${mode})`
      );
      console.log(
        `[PathsService] downloadBase template: ${parsed.modes[mode].downloadBase}`
      );
    } catch (err) {
      console.warn(`[PathsService] Could not load ${OVERRIDES_PATH}: ${err.message}`);
      console.warn('[PathsService] Falling back to test sandbox under Downloads.');
      this._overrides = {
        mode: 'test',
        modes: {
          test: OUTPUT_TYPES.reduce((acc, key) => {
            acc[key] = FALLBACK_BASE;
            return acc;
          }, {}),
        },
      };
      this._mode = 'test';
    }

    return this._overrides;
  }

  /**
   * Force a re-read on next access. Useful if you've manually edited
   * path-overrides.json and don't want to bounce the server.
   */
  reload() {
    this._overrides = null;
    this._mode = null;
    return this._load();
  }

  /**
   * Returns the currently active mode ("test" | "production").
   */
  getMode() {
    this._load();
    return this._mode;
  }

  /**
   * Returns the raw template string for an output type, before token
   * replacement. Useful for diagnostics.
   */
  getTemplate(outputType) {
    this._load();
    if (!OUTPUT_TYPES.includes(outputType)) {
      throw new Error(
        `Unknown output type "${outputType}". Valid: ${OUTPUT_TYPES.join(', ')}`
      );
    }
    const modeConfig = this._overrides.modes[this._mode] || {};
    return modeConfig[outputType] || '';
  }

  // ─── Token replacement ─────────────────────────────────

  /**
   * Replaces tokens in a template string with values pulled from a canonical
   * order shape (the shape produced by sytistDbService.getOrderById /
   * getOrdersByWorkflow).
   *
   * Unknown tokens are left in place rather than silently dropped — that way
   * misspellings show up in the resolved path and get caught quickly.
   */
  _replaceTokens(template, order) {
    if (!template) return '';

    const tokens = {
      '{date}': this._extractDate(order),
      '{orderId}': order.orderId || '',
      '{gallery}': sanitize(order.galleryName || ''),
      '{subGallery}': sanitize(order.subGalleryName || ''),
      '{workflow}': order.shipping?.workflow || '',
    };

    let out = template;
    for (const [token, value] of Object.entries(tokens)) {
      out = out.split(token).join(value);
    }
    return out;
  }

  _extractDate(order) {
    // order.orderDate from MySQL (dateStrings: true) is "YYYY-MM-DD HH:MM:SS".
    // Pull the date half. Fallback to today if something's odd.
    if (order.orderDate && typeof order.orderDate === 'string') {
      const datePart = order.orderDate.split(' ')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
    }
    return new Date().toISOString().split('T')[0];
  }

  // ─── Resolution ────────────────────────────────────────

  /**
   * Resolves the base directory for an output type, given an order. No
   * folder-sort segments are applied — caller composes those on top via
   * resolveFullPath() or by joining the result of folderSortService.
   *
   * Example:
   *   resolveBase('downloadBase', order)
   *     → 'Z:\\Sytist\\__Open Orders\\2025-11-12'
   */
  resolveBase(outputType, order) {
    const template = this.getTemplate(outputType);
    return this._replaceTokens(template, order);
  }

  /**
   * Resolves the full output directory for an order — base path with
   * folder-sort segments applied. Pass the segments produced by
   * folderSortService.buildOrderPath(order).
   *
   * Example (no_sort):
   *   resolveFullPath('downloadBase', order, [])
   *     → 'Z:\\Sytist\\__Open Orders\\2025-11-12'
   *
   * Example (sort by gallery + sub_gallery):
   *   resolveFullPath('downloadBase', order, ['Lincoln HS Football', 'Varsity'])
   *     → 'Z:\\Sytist\\__Open Orders\\2025-11-12\\Lincoln HS Football\\Varsity'
   */
  resolveFullPath(outputType, order, segments = []) {
    const base = this.resolveBase(outputType, order);
    if (!segments || segments.length === 0) return base;
    return path.win32.join(base, ...segments);
  }

  /**
   * Returns a preview object describing all resolved paths for an order.
   * Used by the /api/sytist/paths/preview/:orderId endpoint and by the
   * Order Detail UI.
   *
   * Shape:
   *   {
   *     mode: 'test' | 'production',
   *     orderId, orderDate, workflow,
   *     sortLevels: [...],            // from folderSortService
   *     sortSegments: [...],          // resolved against this order
   *     paths: {
   *       downloadBase:    { template, base, full },
   *       darkroomTxtBase: { template, base, full },
   *       ...
   *     }
   *   }
   */
  buildPreview(order, sortSegments = [], sortLevels = []) {
    this._load();
    const paths = {};
    for (const type of OUTPUT_TYPES) {
      const template = this.getTemplate(type);
      const base = this._replaceTokens(template, order);
      // Template paths (e.g. darkroomTemplateBase) don't get sort segments —
      // they're inputs, not output destinations. Detect by suffix.
      const isTemplate = type.endsWith('TemplateBase');
      const full = isTemplate
        ? base
        : sortSegments.length > 0
          ? path.win32.join(base, ...sortSegments)
          : base;
      paths[type] = { template, base, full };
    }

    return {
      mode: this._mode,
      orderId: order.orderId,
      orderDate: order.orderDate,
      workflow: order.shipping?.workflow || null,
      sortLevels,
      sortSegments,
      paths,
    };
  }

  // ─── Diagnostics ───────────────────────────────────────

  /**
   * Returns a snapshot of the current config, suitable for an admin
   * settings page. Doesn't expose anything sensitive.
   */
  describe() {
    this._load();
    const modeConfig = this._overrides.modes[this._mode] || {};
    return {
      mode: this._mode,
      loadedAt: this._loadedAt,
      configPath: OVERRIDES_PATH,
      templates: { ...modeConfig },
      outputTypes: [...OUTPUT_TYPES],
      knownTokens: ['{date}', '{orderId}', '{gallery}', '{subGallery}', '{workflow}'],
    };
  }

  // ─── Settings: full config + mutations ─────────────────

  /**
   * Returns the full config including every mode's templates. Used by
   * the Settings UI so operators can edit test/production templates
   * side by side.
   */
  describeFull() {
    this._load();
    const modes = {};
    for (const [modeName, modeConfig] of Object.entries(this._overrides.modes || {})) {
      modes[modeName] = { ...modeConfig };
    }
    return {
      mode: this._mode,
      loadedAt: this._loadedAt,
      configPath: OVERRIDES_PATH,
      modes,
      outputTypes: [...OUTPUT_TYPES],
      knownTokens: ['{date}', '{orderId}', '{gallery}', '{subGallery}', '{workflow}'],
    };
  }

  /**
   * Switches the active mode. Persists to disk. Reloads in-memory state
   * so subsequent path resolutions reflect the new mode immediately.
   *
   * Allowed modes: 'test' | 'production'. The mode must already exist
   * in the modes map (i.e. you can't switch to a mode whose templates
   * haven't been defined).
   */
  setMode(newMode) {
    this._load();
    if (!newMode || typeof newMode !== 'string') {
      throw new Error('mode is required');
    }
    if (!this._overrides.modes || !this._overrides.modes[newMode]) {
      throw new Error(
        `Mode "${newMode}" has no templates defined under modes.${newMode}`
      );
    }
    const updated = { ...this._overrides, mode: newMode };
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(updated, null, 2), 'utf8');
    this._overrides = null;
    this._mode = null;
    this._load();
    console.log(`[PathsService] Mode changed → ${newMode}`);
    return this._mode;
  }

  /**
   * Updates a single template under a specific mode. Both the mode and
   * the output type must exist; this method doesn't create new modes
   * or new output types — those are controlled at the code level
   * (OUTPUT_TYPES const) and require a code change to evolve.
   */
  setTemplate(mode, outputType, template) {
    this._load();
    if (!this._overrides.modes || !this._overrides.modes[mode]) {
      throw new Error(`Mode "${mode}" not found`);
    }
    if (!OUTPUT_TYPES.includes(outputType)) {
      throw new Error(
        `Unknown output type "${outputType}". Valid: ${OUTPUT_TYPES.join(', ')}`
      );
    }
    if (typeof template !== 'string') {
      throw new Error('template must be a string');
    }

    const updated = JSON.parse(JSON.stringify(this._overrides));
    updated.modes[mode][outputType] = template;
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(updated, null, 2), 'utf8');

    // Reload so the active mode picks up the change immediately
    this._overrides = null;
    this._mode = null;
    this._load();

    return updated.modes[mode][outputType];
  }

  /**
   * Phase 4.7 — pre-flight check for path mode switch.
   *
   * Tests every output type for the requested mode by:
   *   1. Resolving the template against a synthetic order
   *   2. Trying to mkdir the resolved path
   *   3. Writing a small `.preflight-test` marker file
   *   4. Reading it back to verify
   *   5. Deleting it
   *
   * Returns a per-output-type report so the operator sees exactly which
   * paths are healthy and which aren't before flipping modes.
   *
   * Note: only output types that produce real output files are checked
   * (skips darkroomTemplateBase since that's an INPUT path the watcher
   * reads from — a write test would be wrong there).
   */
  async preflightCheck(mode) {
    this._load();
    const targetMode = mode || this._mode;
    if (!this._overrides.modes || !this._overrides.modes[targetMode]) {
      throw new Error(`Mode "${targetMode}" has no templates defined`);
    }

    // Synthetic order for token resolution
    const today = new Date().toISOString().split('T')[0];
    const syntheticOrder = {
      orderId: 'preflight',
      orderNumber: 'preflight',
      orderDate: `${today} 00:00:00`,
      galleryName: 'Preflight',
      subGalleryName: 'Test',
      shipping: { workflow: 'ship_to_home' },
    };

    const checks = [];
    const outputTypesToTest = OUTPUT_TYPES.filter(
      (t) => t !== 'darkroomTemplateBase'
    );

    for (const outputType of outputTypesToTest) {
      const check = {
        outputType,
        template: this._overrides.modes[targetMode][outputType],
        resolvedPath: null,
        ok: false,
        steps: [],
      };

      try {
        // Resolve path using temporarily-applied template (without flipping mode)
        const template = this._overrides.modes[targetMode][outputType];
        const resolved = this._applyTemplate(template, syntheticOrder, []);
        check.resolvedPath = resolved;

        // Each filesystem step gets a 5-second timeout so a hung NFS/SMB
        // mount or a bizarre special path doesn't lock the UI.
        const withTimeout = (label, promise) =>
          Promise.race([
            promise,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`${label} timed out after 5s`)),
                5000
              )
            ),
          ]);

        // mkdir
        try {
          await withTimeout('mkdir', fsp.mkdir(resolved, { recursive: true }));
          check.steps.push({ step: 'mkdir', ok: true });
        } catch (err) {
          check.steps.push({ step: 'mkdir', ok: false, error: err.message });
          throw err;
        }

        // write
        const testFile = path.join(resolved, '.preflight-test');
        const testContent = `preflight ${new Date().toISOString()}`;
        try {
          await withTimeout('write', fsp.writeFile(testFile, testContent, 'utf8'));
          check.steps.push({ step: 'write', ok: true });
        } catch (err) {
          check.steps.push({ step: 'write', ok: false, error: err.message });
          throw err;
        }

        // read
        try {
          const got = await withTimeout('read', fsp.readFile(testFile, 'utf8'));
          if (got !== testContent) {
            throw new Error('Read content mismatch');
          }
          check.steps.push({ step: 'read', ok: true });
        } catch (err) {
          check.steps.push({ step: 'read', ok: false, error: err.message });
          throw err;
        }

        // delete
        try {
          await withTimeout('delete', fsp.unlink(testFile));
          check.steps.push({ step: 'delete', ok: true });
        } catch (err) {
          check.steps.push({ step: 'delete', ok: false, error: err.message });
          throw err;
        }

        check.ok = true;
      } catch (err) {
        check.error = err.message;
      }

      checks.push(check);
    }

    return {
      mode: targetMode,
      currentMode: this._mode,
      timestamp: new Date().toISOString(),
      allOk: checks.every((c) => c.ok),
      checks,
    };
  }

  /**
   * Internal helper used by preflightCheck — applies a template with
   * the same token substitution + folder-sort logic as resolveFullPath
   * but for an arbitrary template (instead of the active one). Folder-
   * sort segments aren't appended in preflight since we're testing the
   * BASE path, not a fully-resolved per-order path.
   */
  _applyTemplate(template, order, segments) {
    if (!template) return '';
    const tokens = {
      '{date}': sanitize(order.orderDate ? order.orderDate.split(' ')[0] : new Date().toISOString().split('T')[0]),
      '{orderId}': sanitize(order.orderId || order.orderNumber || ''),
      '{gallery}': sanitize(order.galleryName || ''),
      '{subGallery}': sanitize(order.subGalleryName || ''),
      '{workflow}': sanitize(order.shipping?.workflow || ''),
    };
    let resolved = template;
    for (const [tok, val] of Object.entries(tokens)) {
      resolved = resolved.split(tok).join(val);
    }
    if (segments && segments.length > 0) {
      resolved = path.win32.join(resolved, ...segments);
    }
    return resolved;
  }
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Strip Windows-illegal filename characters and trim. Used on tokens so a
 * gallery named "Lincoln HS / Varsity" doesn't blow up path joining.
 */
function sanitize(value) {
  if (!value) return '';
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
}

module.exports = new PathsService();
module.exports.OUTPUT_TYPES = OUTPUT_TYPES;

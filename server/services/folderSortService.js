// folderSortService.js
//
// Phase 4.1: produces folder-sort segments for an order, given the
// configured sortLevels in server/config/folder-sort.json.
//
// IMPORTANT: this service reads CANONICAL order shape directly. Field
// references match what sytistDbService produces — orderDate, orderId,
// galleryName, subGalleryName, shipping.optionName, shipping.workflow.
// We do NOT translate from photo day's order shape (placedAt, num, etc.)
// because the canonical Sytist shape is the contract for the whole pipeline.
//
// Sort options (canonical-shape aware):
//
//   no_sort         All files flat in the base output folder. Default.
//                   When chosen, must be the only level — combining no_sort
//                   with anything else is a config error.
//
//   gallery         order.galleryName (e.g. "Lincoln HS Football 2025")
//
//   sub_gallery     order.subGalleryName (the team within the gallery —
//                   e.g. "Varsity", "JV"). Empty for non-sibling orders.
//
//   order_id        order.orderId
//
//   workflow        order.shipping.workflow — one of
//                     ship_to_home / ship_to_managers / ship_to_league
//
//   shipping_option order.shipping.optionName — the raw Sytist option string
//
//   date            YYYY-MM-DD from order.orderDate
//
// The returned segments are sanitized for Windows path safety. They do NOT
// include the base path — pathsService composes that.
//
// No external dependencies — uses only the built-in fs + path.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'folder-sort.json');

const SORT_OPTIONS = [
  {
    id: 'no_sort',
    label: 'No Sort',
    description: 'All files flat in the base output folder (no subfolders).',
  },
  {
    id: 'gallery',
    label: 'Gallery',
    description: 'Group by gallery name (ms_calendar.date_title).',
  },
  {
    id: 'sub_gallery',
    label: 'Sub-Gallery / Team',
    description: 'Group by team within the gallery (ms_sub_galleries.sub_name).',
  },
  {
    id: 'order_id',
    label: 'Order ID',
    description: 'Group by Sytist order number.',
  },
  {
    id: 'workflow',
    label: 'Workflow',
    description: 'Group by ship-to-home / managers / league bucket.',
  },
  {
    id: 'shipping_option',
    label: 'Shipping Option',
    description: 'Group by the raw Sytist shipping option string.',
  },
  {
    id: 'date',
    label: 'Order Date',
    description: 'Group by order date (YYYY-MM-DD).',
  },
];

const DEFAULT_SORT = ['no_sort'];

// Friendly names for workflow IDs when used as a folder name.
const WORKFLOW_LABELS = {
  ship_to_home: 'Ship to Home',
  ship_to_managers: 'Ship to Managers',
  ship_to_league: 'Ship to League',
};

class FolderSortService {
  constructor() {
    this._ensureConfig();
  }

  _ensureConfig() {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          CONFIG_PATH,
          JSON.stringify({ sortLevels: DEFAULT_SORT }, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(
        `[FolderSortService] Could not ensure ${CONFIG_PATH}: ${err.message}`
      );
    }
  }

  _read() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  }

  _write(data) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  }

  // ─── Config API ────────────────────────────────────────

  getSortOptions() {
    return SORT_OPTIONS.map((o) => ({ ...o }));
  }

  async getSortLevels() {
    try {
      const data = this._read();
      return Array.isArray(data.sortLevels) && data.sortLevels.length > 0
        ? data.sortLevels
        : DEFAULT_SORT;
    } catch {
      return DEFAULT_SORT;
    }
  }

  async setSortLevels(levels) {
    if (!Array.isArray(levels) || levels.length === 0) {
      throw new Error('At least one sort level is required.');
    }

    const validIds = SORT_OPTIONS.map((o) => o.id);
    for (const level of levels) {
      if (!validIds.includes(level)) {
        throw new Error(
          `Invalid sort level "${level}". Valid: ${validIds.join(', ')}`
        );
      }
    }

    if (levels.includes('no_sort') && levels.length > 1) {
      throw new Error('"No Sort" cannot be combined with other sort levels.');
    }

    let data;
    try {
      data = this._read();
    } catch {
      data = {};
    }
    data.sortLevels = levels;
    this._write(data);
    return levels;
  }

  // ─── Path-segment building ─────────────────────────────

  /**
   * Builds an array of folder-name segments for an order, based on the
   * configured sortLevels. Returns [] when sortLevels === ['no_sort'].
   *
   * Pass to pathsService.resolveFullPath(outputType, order, segments) to
   * get the absolute output directory. Don't join manually — pathsService
   * uses path.win32.join so the slashes come out right on the lab machine
   * regardless of where this code is running.
   */
  async buildOrderPath(order) {
    const levels = await this.getSortLevels();
    return this._buildPathFromLevels(order, levels);
  }

  /**
   * Synchronous segment building for callers that already know the levels
   * (e.g. the path-preview endpoint, which fetches both in parallel and
   * doesn't want a second async hop).
   */
  buildOrderPathSync(order, levels) {
    return this._buildPathFromLevels(order, levels);
  }

  _buildPathFromLevels(order, levels) {
    if (!Array.isArray(levels) || levels.length === 0) return [];
    if (levels.length === 1 && levels[0] === 'no_sort') return [];

    const segments = [];
    for (const level of levels) {
      if (level === 'no_sort') continue; // ignore if mixed in defensively
      const value = this._extractSortValue(order, level);
      const safe = sanitize(value) || 'Unknown';
      segments.push(safe);
    }
    return segments;
  }

  /**
   * Pulls a folder-name value from a canonical-shape order for a given
   * sort level. Anything missing falls back to a stable placeholder so
   * the path is always resolvable.
   */
  _extractSortValue(order, level) {
    switch (level) {
      case 'gallery':
        return order.galleryName || 'No Gallery';

      case 'sub_gallery':
        return order.subGalleryName || 'No Sub-Gallery';

      case 'order_id':
        return order.orderId || 'Unknown Order';

      case 'workflow': {
        const wf = order.shipping?.workflow;
        return WORKFLOW_LABELS[wf] || wf || 'Unknown Workflow';
      }

      case 'shipping_option':
        return order.shipping?.optionName || 'No Shipping Option';

      case 'date':
        return extractDate(order.orderDate);

      default:
        return 'Unknown';
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

function sanitize(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
}

function extractDate(orderDate) {
  if (orderDate && typeof orderDate === 'string') {
    const datePart = orderDate.split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return 'Unknown Date';
}

module.exports = new FolderSortService();
module.exports.SORT_OPTIONS = SORT_OPTIONS;

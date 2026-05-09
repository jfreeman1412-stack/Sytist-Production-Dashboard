// specialtyService.js
//
// Phase 4.6: registry of SKUs that get separate routing during processing.
// Specialty products print to {basePath}\{subfolder}\ instead of the
// regular per-order downloadBase folder, so the lab can identify them in
// their own bin.
//
// Two roles:
//   1. Routing override: processingService asks isSpecialty(sku) and
//      getSpecialtyFolder(sku) to decide where photos and imposed sheets
//      land.
//   2. Slip highlight: packingSlipService asks isSpecialty(sku) per
//      line item and applies an orange row tint when matched (color
//      from slip-config.json, default #fff5e6).
//
// dropShipped: true means another lab fulfills the item — orchestrator
// still writes the .txt entry but Phase 5+ ShipStation integration will
// skip label generation. For 4.6 it's a flag we record but don't act on.
//
// Direct port of photo day's specialtyService with one change:
// `../config` import is gone (Sytist doesn't have a global config). The
// basePath defaults to {downloadBase}\Specialty\ resolved at lookup time
// against the active path-overrides mode, so test/production switching
// applies automatically.
//
// No external deps — uses built-in fs only.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'specialty-products.json');

const DEFAULT_HIGHLIGHT_COLORS = {
  specialty: '#fff5e6',
  quantity: '#fff0f0',
};

class SpecialtyService {
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
          JSON.stringify(
            {
              // basePath empty = use downloadBase\Specialty fallback at
              // lookup time. Operators can override via Settings.
              basePath: '',
              products: [],
              highlightColors: { ...DEFAULT_HIGHLIGHT_COLORS },
            },
            null,
            2
          ),
          'utf8'
        );
      }

      // Migrate older configs that don't have highlightColors
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      let dirty = false;
      if (!data.highlightColors) {
        data.highlightColors = { ...DEFAULT_HIGHLIGHT_COLORS };
        dirty = true;
      }
      if (data.basePath === undefined) {
        data.basePath = '';
        dirty = true;
      }
      if (!Array.isArray(data.products)) {
        data.products = [];
        dirty = true;
      }
      if (dirty) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn(
        `[Specialty] Could not ensure ${CONFIG_PATH}: ${err.message}`
      );
    }
  }

  async _read() {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  }

  async _write(data) {
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  }

  // ─── CONFIG ───────────────────────────────────────────────

  async getConfig() {
    return this._read();
  }

  async getHighlightColors() {
    try {
      const data = await this._read();
      return { ...DEFAULT_HIGHLIGHT_COLORS, ...(data.highlightColors || {}) };
    } catch {
      return { ...DEFAULT_HIGHLIGHT_COLORS };
    }
  }

  async setHighlightColors(colors) {
    const data = await this._read();
    data.highlightColors = { ...data.highlightColors, ...colors };
    await this._write(data);
    return data.highlightColors;
  }

  async getProducts() {
    try {
      const data = await this._read();
      return data.products || [];
    } catch {
      return [];
    }
  }

  /**
   * Returns the configured basePath, or null when it's blank/unset.
   * processingService falls back to downloadBase + 'Specialty' when null
   * so a fresh install works without manual configuration.
   */
  async getBasePath() {
    try {
      const data = await this._read();
      return data.basePath && data.basePath.trim() ? data.basePath : null;
    } catch {
      return null;
    }
  }

  async setBasePath(basePath) {
    const data = await this._read();
    data.basePath = basePath || '';
    await this._write(data);
    return data.basePath;
  }

  // ─── PRODUCT CRUD ─────────────────────────────────────────

  async addProduct(product) {
    const data = await this._read();
    const externalId = String(product.externalId || '').trim();
    if (!externalId) throw new Error('externalId is required');

    const exists = (data.products || []).find(
      (p) => p.externalId === externalId
    );
    if (exists) {
      throw new Error(
        `Specialty product with externalId "${externalId}" already exists`
      );
    }
    data.products = data.products || [];
    data.products.push({
      externalId,
      productName: product.productName || '',
      subfolder:
        product.subfolder || product.productName || externalId,
      dropShipped: !!product.dropShipped,
    });
    await this._write(data);
    return data.products;
  }

  async updateProduct(externalId, updates) {
    const data = await this._read();
    const idx = (data.products || []).findIndex(
      (p) => p.externalId === String(externalId)
    );
    if (idx === -1) throw new Error('Specialty product not found');
    data.products[idx] = { ...data.products[idx], ...updates };
    // externalId is the key — never let an update change it
    data.products[idx].externalId = String(externalId);
    await this._write(data);
    return data.products[idx];
  }

  async deleteProduct(externalId) {
    const data = await this._read();
    const before = (data.products || []).length;
    data.products = (data.products || []).filter(
      (p) => p.externalId !== String(externalId)
    );
    if (data.products.length === before) {
      throw new Error('Specialty product not found');
    }
    await this._write(data);
    return data.products;
  }

  // ─── LOOKUP ───────────────────────────────────────────────

  async getProduct(externalId) {
    const products = await this.getProducts();
    return (
      products.find((p) => p.externalId === String(externalId)) || null
    );
  }

  /**
   * Boolean: is this SKU registered as a specialty product?
   */
  async isSpecialty(externalId) {
    if (!externalId) return false;
    const product = await this.getProduct(externalId);
    return !!product;
  }

  /**
   * Boolean: is this SKU a drop-ship product (fulfilled by another lab)?
   * Used by Phase 5+ ShipStation integration to skip label generation.
   * Phase 4.6 records the flag but doesn't act on it.
   */
  async isDropShipped(externalId) {
    const product = await this.getProduct(externalId);
    return !!(product && product.dropShipped);
  }

  /**
   * Returns the specialty subfolder name (relative path component) for
   * a SKU. Caller composes this with the resolved basePath.
   * Returns null when the SKU isn't a specialty product.
   */
  async getSpecialtySubfolder(externalId) {
    const product = await this.getProduct(externalId);
    if (!product) return null;
    return product.subfolder || product.productName || product.externalId;
  }
}

module.exports = new SpecialtyService();
module.exports.DEFAULT_HIGHLIGHT_COLORS = DEFAULT_HIGHLIGHT_COLORS;

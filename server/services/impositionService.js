// impositionService.js
//
// Phase 4.4: produces imposed multi-up sheets from canonical Sytist line
// items. 8 wallets per 8x10, 2 magnets per 5x8, 4 trading cards, etc. —
// pure imposition (single image arranged multiple times on a sheet,
// optionally with text overlays). NO compositing of multiple images
// (e.g. memory-mate composites with team + portrait + overlay) — that's
// Phase 8.
//
// Three flavors of the same internal engine:
//
//   buildSheetBuffer(sourceBuffer, sku, context, orientation?)
//     → { buffer, layout, warnings, meta }
//     Pure: source bytes in, sheet bytes out. No disk I/O. Used by the
//     /preview endpoint (streams the result back as image/jpeg).
//
//   composeFromUrl(sourceUrl, sku, context, orientation?)
//     → { buffer, ... }
//     Convenience: fetch the URL into a buffer, then call buildSheetBuffer.
//     Used by /preview for canonical Sytist orders where the source lives
//     on S3.
//
//   composeSheetInPlace(imagePath, sku, context)
//     → { imposed, layout, ... }
//     Photo-day-equivalent: read file from disk, build sheet, OVERWRITE
//     the source path with the imposed sheet. Used by Phase 4.6 after
//     downloading the pic_full from S3 — keeps the darkroom .txt's
//     Filepath= line pointing at the same path before and after. NO
//     standalone callers in 4.4.
//
// Layouts and SKU→layout mappings live in config/imposition-layouts.json
// (ported verbatim from photo day; SKUs match directly per Phase 4.2).
// Operators can edit/add via the future settings UI; CRUD endpoints
// already exist in the routes file.
//
// Auto-orientation: when no orientation is passed, we detect from the
// source image's actual dimensions (sharp metadata). Width > height →
// horizontal, otherwise vertical. The findRule() lookup then picks the
// matching mapping with three-tier fallback (exact orientation →
// orientation-agnostic → any). When the fallback fires, a warning is
// surfaced so operators see the gap.
//
// No external deps beyond sharp (already installed in 4.3).

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'imposition-layouts.json');

const TEXT_VARIABLES = [
  { token: '{order_id}', description: 'Sytist order number' },
  { token: '{order_uuid}', description: 'Sytist internal order ID (same as order_id for Sytist)' },
  { token: '{gallery}', description: 'Gallery name' },
  { token: '{studio}', description: 'Studio name (Sportsline Photography)' },
  { token: '{first_name}', description: 'Customer first name' },
  { token: '{last_name}', description: 'Customer last name' },
  { token: '{date}', description: 'Current date (YYYY-MM-DD)' },
  { token: '{datetime}', description: 'Current date and time' },
  { token: '{item_description}', description: 'Product description (e.g., 8 Wallets)' },
  { token: '{item_sku}', description: 'Product SKU' },
  { token: '{quantity}', description: 'Item quantity' },
  { token: '{photo_tag}', description: 'Sub-gallery / team name' },
  { token: '{team}', description: 'Same as {photo_tag}' },
  { token: '{photo_tags}', description: 'Same as {photo_tag} for Sytist (single sub-gallery)' },
];

const DEFAULT_CONFIG = {
  layouts: [],
  mappings: [],
};

class ImpositionService {
  constructor() {
    this._ensureConfig();
  }

  _ensureConfig() {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn(`[Imposition] Could not ensure ${CONFIG_PATH}: ${err.message}`);
    }
  }

  async _read() {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  }

  async _write(data) {
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  }

  getTextVariables() {
    return TEXT_VARIABLES.map((t) => ({ ...t }));
  }

  // ─── LAYOUT CRUD ──────────────────────────────────────────

  async getLayouts() {
    try {
      const data = await this._read();
      return data.layouts || [];
    } catch {
      return [];
    }
  }

  async getLayout(id) {
    const layouts = await this.getLayouts();
    return layouts.find((l) => l.id === id) || null;
  }

  async addLayout(layout) {
    const data = await this._read();
    const newLayout = {
      id: layout.id || generateId(),
      name: layout.name || 'Untitled Layout',
      cols: parseInt(layout.cols, 10) || 1,
      rows: parseInt(layout.rows, 10) || 1,
      itemWidth: parseFloat(layout.itemWidth) || 1,
      itemHeight: parseFloat(layout.itemHeight) || 1,
      sheetWidth: parseFloat(layout.sheetWidth) || 8,
      sheetHeight: parseFloat(layout.sheetHeight) || 10,
      dpi: parseInt(layout.dpi, 10) || 300,
      colGap: parseFloat(layout.colGap) || 0,
      rowGap: parseFloat(layout.rowGap) || 0,
      centerOnSheet: !!layout.centerOnSheet,
      marginLeft: parseFloat(layout.marginLeft) || 0,
      marginTop: parseFloat(layout.marginTop) || 0,
      textOverlays: layout.textOverlays || [],
    };
    data.layouts = data.layouts || [];
    data.layouts.push(newLayout);
    await this._write(data);
    return newLayout;
  }

  async updateLayout(id, updates) {
    const data = await this._read();
    const idx = (data.layouts || []).findIndex((l) => l.id === id);
    if (idx === -1) throw new Error('Layout not found');

    const parsed = {};
    if (updates.name !== undefined) parsed.name = updates.name;
    if (updates.cols !== undefined) parsed.cols = parseInt(updates.cols, 10);
    if (updates.rows !== undefined) parsed.rows = parseInt(updates.rows, 10);
    if (updates.itemWidth !== undefined) parsed.itemWidth = parseFloat(updates.itemWidth);
    if (updates.itemHeight !== undefined) parsed.itemHeight = parseFloat(updates.itemHeight);
    if (updates.sheetWidth !== undefined) parsed.sheetWidth = parseFloat(updates.sheetWidth);
    if (updates.sheetHeight !== undefined) parsed.sheetHeight = parseFloat(updates.sheetHeight);
    if (updates.dpi !== undefined) parsed.dpi = parseInt(updates.dpi, 10);
    if (updates.colGap !== undefined) parsed.colGap = parseFloat(updates.colGap);
    if (updates.rowGap !== undefined) parsed.rowGap = parseFloat(updates.rowGap);
    if (updates.centerOnSheet !== undefined) parsed.centerOnSheet = !!updates.centerOnSheet;
    if (updates.marginLeft !== undefined) parsed.marginLeft = parseFloat(updates.marginLeft);
    if (updates.marginTop !== undefined) parsed.marginTop = parseFloat(updates.marginTop);
    if (updates.textOverlays !== undefined) parsed.textOverlays = updates.textOverlays;

    data.layouts[idx] = { ...data.layouts[idx], ...parsed };
    await this._write(data);
    return data.layouts[idx];
  }

  async deleteLayout(id) {
    const data = await this._read();
    data.layouts = (data.layouts || []).filter((l) => l.id !== id);
    data.mappings = (data.mappings || []).filter((m) => m.layoutId !== id);
    await this._write(data);
    return data.layouts;
  }

  // ─── SKU → LAYOUT MAPPINGS ───────────────────────────────

  async getMappings() {
    const data = await this._read();
    const layouts = data.layouts || [];
    return (data.mappings || []).map((m) => ({
      externalId: m.externalId,
      layoutId: m.layoutId,
      orientation: m.orientation || null,
      layoutName: layouts.find((l) => l.id === m.layoutId)?.name || 'Unknown',
    }));
  }

  async addMapping(externalId, layoutId, orientation = null) {
    const data = await this._read();
    if (!(data.layouts || []).find((l) => l.id === layoutId)) {
      throw new Error('Layout not found');
    }
    const sku = String(externalId);
    const o = orientation ? String(orientation).toLowerCase() : null;
    if (o && !['vertical', 'horizontal'].includes(o)) {
      throw new Error(`Invalid orientation "${orientation}". Must be "vertical", "horizontal", or omitted.`);
    }
    const dup = (data.mappings || []).find(
      (m) => m.externalId === sku && (m.orientation || null) === o
    );
    if (dup) {
      const which = o ? `for orientation "${o}"` : '(orientation: any)';
      throw new Error(`SKU "${sku}" is already mapped ${which}. Delete it first.`);
    }
    const newMapping = { externalId: sku, layoutId };
    if (o) newMapping.orientation = o;
    data.mappings = data.mappings || [];
    data.mappings.push(newMapping);
    await this._write(data);
    return this.getMappings();
  }

  async updateMapping(externalId, oldOrientation, updates = {}) {
    const data = await this._read();
    const sku = String(externalId);
    const oldO = oldOrientation ? String(oldOrientation).toLowerCase() : null;

    const idx = (data.mappings || []).findIndex(
      (m) => m.externalId === sku && (m.orientation || null) === oldO
    );
    if (idx === -1) {
      throw new Error(`No mapping found for SKU "${sku}" with orientation "${oldO || 'any'}"`);
    }

    const existing = data.mappings[idx];
    const newLayoutId = updates.layoutId !== undefined ? updates.layoutId : existing.layoutId;
    const newO =
      updates.orientation !== undefined
        ? updates.orientation
          ? String(updates.orientation).toLowerCase()
          : null
        : existing.orientation || null;

    if (newLayoutId && !data.layouts.find((l) => l.id === newLayoutId)) {
      throw new Error('Layout not found');
    }
    if (newO && !['vertical', 'horizontal'].includes(newO)) {
      throw new Error(`Invalid orientation "${newO}". Must be "vertical", "horizontal", or empty.`);
    }
    if (newO !== oldO) {
      const conflict = data.mappings.find(
        (m, i) =>
          i !== idx &&
          m.externalId === sku &&
          (m.orientation || null) === newO
      );
      if (conflict) {
        const which = newO ? `for orientation "${newO}"` : '(orientation: any)';
        throw new Error(`A mapping already exists for "${sku}" ${which}. Remove it first.`);
      }
    }

    const updated = { externalId: sku, layoutId: newLayoutId };
    if (newO) updated.orientation = newO;
    data.mappings[idx] = updated;
    await this._write(data);
    return this.getMappings();
  }

  async deleteMapping(externalId, orientation = null) {
    const data = await this._read();
    const sku = String(externalId);
    const o = orientation ? String(orientation).toLowerCase() : null;
    if (o) {
      data.mappings = (data.mappings || []).filter(
        (m) => !(m.externalId === sku && (m.orientation || null) === o)
      );
    } else {
      data.mappings = (data.mappings || []).filter((m) => m.externalId !== sku);
    }
    await this._write(data);
    return this.getMappings();
  }

  // ─── RULE LOOKUP ─────────────────────────────────────────

  /**
   * Find the layout to use for a given SKU, optionally constrained by
   * orientation. Three-tier fallback:
   *   1. Exact orientation match
   *   2. Orientation-agnostic mapping for this SKU
   *   3. Any mapping for this SKU (returns __mappingFellBack flag)
   *
   * Returns the layout object decorated with __mapping (the mapping that
   * was matched) and __mappingFellBack (true when tier 3 fired).
   */
  async findRule(externalId, orientation = null) {
    const data = await this._read();
    const matches = (data.mappings || []).filter(
      (m) => m.externalId === String(externalId)
    );
    if (matches.length === 0) return null;

    let mapping = null;
    let fellBack = false;
    if (orientation) {
      const o = String(orientation).toLowerCase();
      mapping = matches.find((m) => m.orientation && m.orientation.toLowerCase() === o);
      if (!mapping) mapping = matches.find((m) => !m.orientation);
      if (!mapping) {
        mapping = matches[0];
        fellBack = true;
      }
    } else {
      mapping = matches.find((m) => !m.orientation) || matches[0];
    }

    if (!mapping) return null;
    const layout = (data.layouts || []).find((l) => l.id === mapping.layoutId);
    if (!layout) return null;

    return Object.assign({}, layout, {
      __mapping: mapping,
      __mappingFellBack: fellBack,
    });
  }

  async hasRule(externalId, orientation = null) {
    return !!(await this.findRule(externalId, orientation));
  }

  // ─── ORIENTATION DETECTION ───────────────────────────────

  /**
   * Detect orientation from a source image buffer. width > height →
   * horizontal, otherwise vertical. Sharp's metadata read is fast — no
   * need to memoize, the cost is negligible compared to the rest of
   * imposition.
   */
  async detectOrientation(sourceBuffer) {
    const meta = await sharp(sourceBuffer).metadata();
    if (!meta.width || !meta.height) return null;
    return meta.width > meta.height ? 'horizontal' : 'vertical';
  }

  // ─── CONTEXT BUILDING ────────────────────────────────────

  /**
   * Build a text-overlay context object from a canonical Sytist order
   * and one of its line items. Always uses order.customer for first/last
   * name (Sytist has one customer per order — no per-dancer logic needed
   * like photo day's bulk flow). Sub-gallery name supplies team /
   * photo_tag / photo_tags.
   */
  buildContext(order, lineItem, options = {}) {
    const studioName = options.studioName || 'Sportsline Photography';
    const team = lineItem.subGalleryName || '';
    return {
      orderNum: order.orderNumber || order.orderId || '',
      orderId: order.orderId || '',
      gallery: order.galleryName || '',
      studioName,
      firstName: order.customer?.firstName || '',
      lastName: order.customer?.lastName || '',
      itemDescription: lineItem.productName || '',
      itemSku: lineItem.sku || '',
      quantity: lineItem.qty || 1,
      photoTag: team,
      photoTags: team, // Sytist has only one sub-gallery per item
    };
  }

  // ─── COMPOSITION ENGINE ──────────────────────────────────

  /**
   * Build an imposed sheet from a source image buffer. Returns the
   * rendered sheet as a JPEG buffer with metadata. Pure — no disk I/O.
   *
   * Source image is resized to itemWidth × itemHeight (cover/center)
   * and tiled across cols × rows positions on a white sheet sized to
   * sheetWidth × sheetHeight inches at the layout's DPI.
   *
   * Auto-detects orientation from the source buffer when `orientation`
   * is not provided.
   */
  async buildSheetBuffer(sourceBuffer, externalId, context = {}, orientation = null) {
    if (!sourceBuffer || !Buffer.isBuffer(sourceBuffer)) {
      throw new Error('buildSheetBuffer requires a Buffer source image');
    }

    let resolvedOrientation = orientation;
    if (!resolvedOrientation) {
      try {
        resolvedOrientation = await this.detectOrientation(sourceBuffer);
      } catch (err) {
        console.warn(`[Imposition] Could not detect orientation: ${err.message}`);
      }
    }

    const rule = await this.findRule(externalId, resolvedOrientation);
    if (!rule) {
      return {
        imposed: false,
        reason: `No imposition rule for SKU "${externalId}"`,
        externalId,
        orientation: resolvedOrientation,
      };
    }

    const warnings = [];
    if (rule.__mapping && resolvedOrientation) {
      const mappedO = rule.__mapping.orientation
        ? String(rule.__mapping.orientation).toLowerCase()
        : null;
      const requestedO = String(resolvedOrientation).toLowerCase();
      if (mappedO && mappedO !== requestedO) {
        warnings.push({
          type: 'orientation_fallback',
          message: `No "${requestedO}" layout for SKU ${externalId}; using "${mappedO}" layout. Output may be rotated/cropped.`,
        });
        console.warn(`[Imposition] ${warnings[warnings.length - 1].message}`);
      }
    }

    const buffer = await this._renderSheet(sourceBuffer, rule, context);

    return {
      imposed: true,
      buffer,
      layout: {
        id: rule.id,
        name: rule.name,
        cols: rule.cols,
        rows: rule.rows,
        itemWidth: rule.itemWidth,
        itemHeight: rule.itemHeight,
        sheetWidth: rule.sheetWidth,
        sheetHeight: rule.sheetHeight,
        dpi: rule.dpi,
      },
      mapping: {
        externalId: rule.__mapping.externalId,
        orientation: rule.__mapping.orientation || null,
      },
      orientation: resolvedOrientation,
      warnings,
      meta: {
        sheetPixels: {
          width: Math.round(rule.sheetWidth * rule.dpi),
          height: Math.round(rule.sheetHeight * rule.dpi),
        },
        itemPixels: {
          width: Math.round(rule.itemWidth * rule.dpi),
          height: Math.round(rule.itemHeight * rule.dpi),
        },
        textOverlays: (rule.textOverlays || []).length,
      },
    };
  }

  /**
   * Convenience wrapper: fetch image from URL, then call buildSheetBuffer.
   * Used by the /preview endpoint when source is on S3.
   */
  async composeFromUrl(sourceUrl, externalId, context = {}, orientation = null) {
    if (!sourceUrl) {
      throw new Error('composeFromUrl requires a sourceUrl');
    }
    const resp = await fetch(sourceUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch source image: HTTP ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    return this.buildSheetBuffer(Buffer.from(ab), externalId, context, orientation);
  }

  /**
   * Photo-day-equivalent: read source from disk, build sheet, OVERWRITE
   * the source path with the imposed sheet. Atomic via .tmp + rename so
   * Darkroom never sees a half-written file.
   *
   * Used by Phase 4.6 after downloading pic_full from S3 to its target
   * path. Keeps the darkroom .txt's Filepath= line valid before AND after
   * imposition.
   *
   * Returns the same shape as buildSheetBuffer but with `path` instead of
   * `buffer`, and includes `imposed: true|false` so the orchestrator can
   * report whether the file was actually changed.
   */
  async composeSheetInPlace(imagePath, externalId, context = {}, options = {}) {
    if (!imagePath) {
      throw new Error('composeSheetInPlace requires an imagePath');
    }

    const sourceBuffer = await fsp.readFile(imagePath);

    let orientation = options.orientation || null;
    if (!orientation) {
      try {
        orientation = await this.detectOrientation(sourceBuffer);
      } catch {
        /* fall through */
      }
    }

    const built = await this.buildSheetBuffer(
      sourceBuffer,
      externalId,
      context,
      orientation
    );
    if (!built.imposed) {
      return { ...built, path: imagePath };
    }

    const tmpPath = imagePath + '.tmp';
    await fsp.writeFile(tmpPath, built.buffer);
    await fsp.rename(tmpPath, imagePath);

    console.log(
      `[Imposition] ${built.layout.name} → ${imagePath} (${built.meta.sheetPixels.width}x${built.meta.sheetPixels.height}px)`
    );

    return {
      imposed: true,
      path: imagePath,
      layout: built.layout,
      mapping: built.mapping,
      orientation: built.orientation,
      warnings: built.warnings,
      meta: built.meta,
    };
  }

  // ─── INTERNAL RENDER ─────────────────────────────────────

  /**
   * The actual sheet rendering. Direct port of photo day's compose logic
   * with the file I/O removed (works on buffers throughout).
   */
  async _renderSheet(sourceBuffer, rule, context) {
    const {
      cols,
      rows,
      itemWidth,
      itemHeight,
      sheetWidth,
      sheetHeight,
      dpi,
      textOverlays,
    } = rule;

    // Backward compatibility: layouts may use `gap` for both, or `colGap`/`rowGap`
    const colGapInches = rule.colGap !== undefined ? rule.colGap : rule.gap || 0;
    const rowGapInches = rule.rowGap !== undefined ? rule.rowGap : rule.gap || 0;

    const sheetPxW = Math.round(sheetWidth * dpi);
    const sheetPxH = Math.round(sheetHeight * dpi);
    const itemPxW = Math.round(itemWidth * dpi);
    const itemPxH = Math.round(itemHeight * dpi);
    const colGapPx = Math.round(colGapInches * dpi);
    const rowGapPx = Math.round(rowGapInches * dpi);

    const totalGapX = (cols - 1) * colGapPx;
    const totalGapY = (rows - 1) * rowGapPx;
    const contentW = cols * itemPxW + totalGapX;
    const contentH = rows * itemPxH + totalGapY;

    let offsetXPx = 0;
    let offsetYPx = 0;
    if (rule.centerOnSheet) {
      offsetXPx = Math.max(Math.round((sheetPxW - contentW) / 2), 0);
      offsetYPx = Math.max(Math.round((sheetPxH - contentH) / 2), 0);
    } else {
      offsetXPx = Math.round((rule.marginLeft || 0) * dpi);
      offsetYPx = Math.round((rule.marginTop || 0) * dpi);
    }

    // Resize source image to exact item size (cover/center, no stretch)
    const resizedItemBuffer = await sharp(sourceBuffer)
      .resize(itemPxW, itemPxH, { fit: 'cover', position: 'center' })
      .toBuffer();

    // Build composites — tile the resized item across the grid
    const composites = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        composites.push({
          input: resizedItemBuffer,
          left: offsetXPx + col * (itemPxW + colGapPx),
          top: offsetYPx + row * (itemPxH + rowGapPx),
        });
      }
    }

    // Add text overlays
    if (textOverlays && textOverlays.length > 0) {
      for (const overlay of textOverlays) {
        const resolved = this._resolveTextVariables(overlay.text || '', context);
        if (!resolved.trim()) continue;

        const overlayComposite = this._buildOverlayComposite(
          overlay,
          resolved,
          dpi,
          sheetPxW,
          sheetPxH
        );
        if (overlayComposite) composites.push(overlayComposite);
      }
    }

    // Final composition — white background, all composites layered on top
    const finalBuffer = await sharp({
      create: {
        width: sheetPxW,
        height: sheetPxH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 95 })
      .toBuffer();

    return finalBuffer;
  }

  /**
   * Build an SVG composite for a single text overlay. Returns null when
   * the overlay would be empty. Direct port of photo day's overlay
   * rendering — supports rotation, autoSize, centerAlign, multi-line via \n.
   */
  _buildOverlayComposite(overlay, resolvedText, dpi, sheetPxW, sheetPxH) {
    const color = overlay.color || '#000000';
    const rotation = overlay.rotation || 0;
    const autoSize = overlay.autoSize || false;
    const centerAlign = overlay.centerAlign || false;

    const textX = Math.round((overlay.x || 0) * dpi);
    const textY = Math.round((overlay.y || 0) * dpi);
    const boxW = overlay.width ? Math.round(overlay.width * dpi) : 0;
    const boxH = overlay.height ? Math.round(overlay.height * dpi) : 0;

    // For ±90° rotation the text runs along H, height is constrained by W
    const isRotated90 = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
    let sizeW = boxW;
    let sizeH = boxH;
    if (isRotated90 && boxW > 0 && boxH > 0) {
      sizeW = boxH;
      sizeH = boxW;
    }

    const lines = resolvedText.split('\\n').map((l) => l.trim());

    let fontSize;
    if (autoSize && sizeW > 0 && sizeH > 0) {
      const charWidthRatio = 0.6;
      const longestLine = Math.max(...lines.map((l) => l.length), 1);
      const maxFontW = Math.floor(sizeW / (longestLine * charWidthRatio));
      const lineHeightRatio = 1.3;
      const maxFontH = Math.floor(sizeH / (lines.length * lineHeightRatio));
      fontSize = Math.min(maxFontW, maxFontH);
      fontSize = Math.max(fontSize, 8);
    } else {
      fontSize = Math.round((overlay.fontSize || 12) * (dpi / 72));
    }

    const lineHeight = Math.round(fontSize * 1.3);
    const textAnchor = centerAlign ? 'middle' : 'start';
    const centerW = isRotated90 ? sizeW : boxW;
    const centerH = isRotated90 ? sizeH : boxH;

    const tspans = lines
      .map((line, i) => {
        const escaped = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        if (centerAlign && centerW > 0) {
          return `<tspan x="${Math.round(centerW / 2)}" dy="${i === 0 ? 0 : lineHeight}">${escaped}</tspan>`;
        }
        return `<tspan x="0" dy="${i === 0 ? 0 : lineHeight}">${escaped}</tspan>`;
      })
      .join('');

    let verticalOffset = fontSize;
    if (centerH > 0 && centerAlign) {
      const totalTextHeight = lines.length * lineHeight;
      verticalOffset = Math.round((centerH - totalTextHeight) / 2) + fontSize;
      verticalOffset = Math.max(verticalOffset, fontSize);
    }

    if (rotation !== 0) {
      const textXAttr = centerAlign && centerW > 0 ? Math.round(centerW / 2) : 0;
      const svgText = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetPxW}" height="${sheetPxH}">` +
          `<g transform="translate(${textX}, ${textY}) rotate(${rotation})">` +
          `<text x="${textXAttr}" y="${verticalOffset}" font-family="Arial, Helvetica, sans-serif" ` +
          `font-size="${fontSize}" fill="${color}" text-anchor="${textAnchor}">${tspans}</text>` +
          `</g></svg>`
      );
      return { input: svgText, left: 0, top: 0 };
    }

    const availW = boxW > 0 ? boxW : Math.max(sheetPxW - textX, 1);
    const availH = boxH > 0 ? boxH : Math.max(sheetPxH - textY, 1);
    const textXAttr = centerAlign && boxW > 0 ? Math.round(boxW / 2) : 0;
    const svgText = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${availW}" height="${availH}">` +
        `<text x="${textXAttr}" y="${verticalOffset}" font-family="Arial, Helvetica, sans-serif" ` +
        `font-size="${fontSize}" fill="${color}" text-anchor="${textAnchor}">${tspans}</text>` +
        `</svg>`
    );
    return { input: svgText, left: textX, top: textY };
  }

  // ─── TEXT VARIABLE RESOLUTION ───────────────────────────

  _resolveTextVariables(text, context) {
    // Case-insensitive token replacement so layout typos like {Last_name} or
    // {Order_ID} still resolve. The photo day layouts file has at least one
    // such typo ({Last_name} in the Trading Cards layout); Sytist inherits
    // them via the seed config, and we'd rather forgive than force operators
    // to clean 21 layouts by hand. Tokens replaced regardless of letter case.
    const replacements = [
      [/\{order_id\}/gi,         context.orderNum || ''],
      [/\{order_uuid\}/gi,       context.orderId || ''],
      [/\{gallery\}/gi,          context.gallery || ''],
      [/\{studio\}/gi,           context.studioName || ''],
      [/\{first_name\}/gi,       context.firstName || ''],
      [/\{last_name\}/gi,        context.lastName || ''],
      [/\{date\}/gi,             new Date().toISOString().split('T')[0]],
      [/\{datetime\}/gi,         new Date().toLocaleString()],
      [/\{item_description\}/gi, context.itemDescription || ''],
      [/\{item_sku\}/gi,         context.itemSku || ''],
      [/\{quantity\}/gi,         String(context.quantity || '')],
      [/\{photo_tag\}/gi,        context.photoTag || ''],
      [/\{team\}/gi,             context.photoTag || ''],
      [/\{photo_tags\}/gi,       context.photoTags || ''],
    ];
    let result = text;
    for (const [pattern, value] of replacements) {
      result = result.replace(pattern, value);
    }
    return result;
  }
}

// Tiny ID generator — avoids pulling in uuid as a dep just for this.
function generateId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

module.exports = new ImpositionService();
module.exports.TEXT_VARIABLES = TEXT_VARIABLES;

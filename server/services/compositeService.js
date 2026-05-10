// compositeService.js
//
// Phase 8a: renders memory-mate-style composites — single sheets that
// combine multiple images (player photo + team photo + logo) plus text
// overlays.
//
// Different from impositionService:
//   - Imposition tiles ONE source image multiple times on a sheet
//   - Composite combines MULTIPLE distinct sources on a single sheet
//
// Layout schema (composite-layouts.json):
//
//   {
//     "id": "memory-mate-5x7",
//     "name": "Memory Mate 5x7",
//     "sheetWidth": 5,
//     "sheetHeight": 7,
//     "dpi": 300,
//     "variants": {
//       "vertical":  { "slots": [...] },
//       "horizontal":{ "slots": [...] }
//     }
//   }
//
// Variants are picked based on the PLAYER photo's orientation. So if a
// customer orders a 5x7 memory mate and the player photo is portrait,
// we use the "vertical" variant. The team photo's orientation is
// independent — the layout specifies its slot dimensions explicitly.
//
// Slot kinds:
//   - { kind: "playerPhoto", x, y, w, h, fit: "cover"|"contain" }
//   - { kind: "logo",        x, y, w, h, fit: "contain" }
//   - { kind: "teamPhoto",   x, y, w, h, fit: "cover"|"contain" }
//   - { kind: "staticGraphic", x, y, w, h, graphicKey: "frame-1", fit: ... }
//     (also accepts legacy: kind="overlay", overlayId="...")
//   - { kind: "text",        x, y, w, h, text: "{customer.firstName}",
//       fontSize, fontFamily, color, align, weight, autoFit }
//
// Coordinates are in inches × DPI internally. Fit modes match sharp's
// resize fit options.
//
// Token substitution in text slots — same vocabulary documented in
// the prior schema deep-dive:
//   {customer.firstName}    {customer.lastName}
//   {customer.email}        {customer.phone}
//   {subject.athleteName}   {subject.coach}    (from subject.fields[])
//   {subject.team}          {subject.sport}    (subject.fields[] → camelCase)
//   {galleryName}           {subGalleryName}
//   {order.id}              {order.date}
//   {year}                  {date}
//
// Phase 8a deliberately does NOT wire this into the orchestrator. The
// verification endpoint exposes `previewComposite()` so you can render
// a sample for any order and visually confirm before integration.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// sharp is already a project dep (Phase 4.3 packing slip)
const sharp = require('sharp');

const LAYOUTS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'composite-layouts.json'
);
const MAPPINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'composite-mappings.json'
);

// Default seed: a single illustrative layout so the operator has
// something to look at on first run. Operators will adjust dimensions
// to match their actual print size.
const DEFAULT_LAYOUTS = {
  layouts: [
    {
      id: 'memory-mate-5x7-v1',
      name: 'Memory Mate 5×7 (default)',
      sheetWidth: 5,
      sheetHeight: 7,
      dpi: 300,
      backgroundColor: '#ffffff',
      variants: {
        vertical: {
          slots: [
            // Logo: top-left corner
            { kind: 'logo', x: 0.25, y: 0.25, w: 1.0, h: 1.0, fit: 'contain' },
            // Player photo: top-right area, dominant
            {
              kind: 'playerPhoto',
              x: 1.5, y: 0.25, w: 3.25, h: 4.0, fit: 'cover',
            },
            // Team photo: bottom strip
            {
              kind: 'teamPhoto',
              x: 0.25, y: 4.5, w: 4.5, h: 1.75, fit: 'cover',
            },
            // Text: player name
            {
              kind: 'text',
              x: 0.25, y: 6.4, w: 4.5, h: 0.4,
              text: '{subject.athleteName}',
              fontSize: 24,
              fontFamily: 'Arial',
              color: '#000000',
              align: 'center',
              weight: 'bold',
            },
          ],
        },
        horizontal: {
          slots: [
            // Logo: top-left
            { kind: 'logo', x: 0.25, y: 0.25, w: 1.0, h: 1.0, fit: 'contain' },
            // Player photo: top, full width
            {
              kind: 'playerPhoto',
              x: 0.25, y: 1.5, w: 4.5, h: 3.0, fit: 'cover',
            },
            // Team photo: bottom
            {
              kind: 'teamPhoto',
              x: 0.25, y: 4.75, w: 4.5, h: 1.5, fit: 'cover',
            },
            {
              kind: 'text',
              x: 0.25, y: 6.4, w: 4.5, h: 0.4,
              text: '{subject.athleteName}',
              fontSize: 24,
              fontFamily: 'Arial',
              color: '#000000',
              align: 'center',
              weight: 'bold',
            },
          ],
        },
      },
    },
  ],
};

const DEFAULT_MAPPINGS = { mappings: [] };

class CompositeService {
  constructor() {
    this._ensure();
  }

  _ensure() {
    try {
      const dir = path.dirname(LAYOUTS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(LAYOUTS_PATH)) {
        fs.writeFileSync(
          LAYOUTS_PATH,
          JSON.stringify(DEFAULT_LAYOUTS, null, 2),
          'utf8'
        );
      }
      if (!fs.existsSync(MAPPINGS_PATH)) {
        fs.writeFileSync(
          MAPPINGS_PATH,
          JSON.stringify(DEFAULT_MAPPINGS, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(`[Composite] Could not ensure config: ${err.message}`);
    }
  }

  // ─── Layouts CRUD ─────────────────────────────────────

  async listLayouts() {
    try {
      const raw = await fsp.readFile(LAYOUTS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.layouts) ? parsed.layouts : [];
    } catch {
      return [];
    }
  }

  async getLayout(id) {
    const layouts = await this.listLayouts();
    return layouts.find((l) => l.id === id) || null;
  }

  async addLayout(layout) {
    this._validateLayout(layout);
    const layouts = await this.listLayouts();
    if (layouts.find((l) => l.id === layout.id)) {
      throw new Error(`Layout with id "${layout.id}" already exists`);
    }
    layouts.push(layout);
    await this._writeLayouts(layouts);
    return layout;
  }

  async updateLayout(id, updates) {
    const layouts = await this.listLayouts();
    const idx = layouts.findIndex((l) => l.id === id);
    if (idx === -1) throw new Error(`Layout "${id}" not found`);
    const merged = { ...layouts[idx], ...updates, id }; // id is immutable
    this._validateLayout(merged);
    layouts[idx] = merged;
    await this._writeLayouts(layouts);
    return merged;
  }

  async deleteLayout(id) {
    const layouts = await this.listLayouts();
    const next = layouts.filter((l) => l.id !== id);
    if (next.length === layouts.length) {
      throw new Error(`Layout "${id}" not found`);
    }
    await this._writeLayouts(next);

    // Phase 9c: also remove the graphics directory for this layout.
    // Lazy require to avoid load-order issues with compositeGraphicsService
    // (it doesn't require compositeService, but the singleton init order
    // is undefined and we want to be conservative).
    try {
      const cgs = require('./compositeGraphicsService');
      await cgs.deleteLayoutGraphics(id);
    } catch (e) {
      // Non-fatal — orphaned files don't break anything, just waste disk
    }

    return { deleted: true };
  }

  async _writeLayouts(layouts) {
    const tmp = LAYOUTS_PATH + '.tmp';
    await fsp.writeFile(
      tmp,
      JSON.stringify({ layouts }, null, 2),
      'utf8'
    );
    await fsp.rename(tmp, LAYOUTS_PATH);
  }

  _validateLayout(layout) {
    if (!layout || typeof layout !== 'object') {
      throw new Error('layout must be an object');
    }
    const required = [
      'id',
      'name',
      'sheetWidth',
      'sheetHeight',
      'dpi',
      'variants',
    ];
    for (const f of required) {
      if (layout[f] === undefined) {
        throw new Error(`layout.${f} is required`);
      }
    }
    if (!layout.variants.vertical && !layout.variants.horizontal) {
      throw new Error(
        'layout.variants must have at least one of: vertical, horizontal'
      );
    }
    for (const variantName of ['vertical', 'horizontal']) {
      const v = layout.variants[variantName];
      if (!v) continue;
      if (!Array.isArray(v.slots)) {
        throw new Error(`layout.variants.${variantName}.slots must be an array`);
      }
      for (const slot of v.slots) {
        if (!slot.kind) {
          throw new Error(`slot.kind is required (variant=${variantName})`);
        }
      }
    }
  }

  // ─── Mappings CRUD ────────────────────────────────────

  async listMappings() {
    try {
      const raw = await fsp.readFile(MAPPINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.mappings) ? parsed.mappings : [];
    } catch {
      return [];
    }
  }

  async findMapping(externalId) {
    if (!externalId) return null;
    const mappings = await this.listMappings();
    return (
      mappings.find((m) => String(m.externalId) === String(externalId)) ||
      null
    );
  }

  async addMapping({ externalId, layoutId, chainToImposition }) {
    if (!externalId) throw new Error('externalId is required');
    if (!layoutId) throw new Error('layoutId is required');
    const layout = await this.getLayout(layoutId);
    if (!layout) throw new Error(`Layout "${layoutId}" not found`);

    const mappings = await this.listMappings();
    if (mappings.find((m) => String(m.externalId) === String(externalId))) {
      throw new Error(
        `A composite mapping for SKU "${externalId}" already exists`
      );
    }
    const entry = {
      externalId: String(externalId),
      layoutId,
      // Phase 8b: when true, the composite output is fed into imposition
      // (the SKU also has an imposition mapping, which gets applied
      // AFTER composite). Used for products like "memory mate magnet
      // sheet" — composite renders the memory mate, imposition tiles it.
      chainToImposition: !!chainToImposition,
    };
    mappings.push(entry);
    await this._writeMappings(mappings);
    return entry;
  }

  async updateMapping(externalId, updates) {
    const mappings = await this.listMappings();
    const idx = mappings.findIndex(
      (m) => String(m.externalId) === String(externalId)
    );
    if (idx === -1) throw new Error(`Mapping for SKU "${externalId}" not found`);
    if (updates.layoutId) {
      const layout = await this.getLayout(updates.layoutId);
      if (!layout) throw new Error(`Layout "${updates.layoutId}" not found`);
    }
    mappings[idx] = {
      ...mappings[idx],
      ...updates,
      externalId: String(externalId), // immutable
      chainToImposition:
        updates.chainToImposition === undefined
          ? mappings[idx].chainToImposition
          : !!updates.chainToImposition,
    };
    await this._writeMappings(mappings);
    return mappings[idx];
  }

  async deleteMapping(externalId) {
    const mappings = await this.listMappings();
    const next = mappings.filter(
      (m) => String(m.externalId) !== String(externalId)
    );
    if (next.length === mappings.length) {
      throw new Error(`Mapping for SKU "${externalId}" not found`);
    }
    await this._writeMappings(next);
    return { deleted: true };
  }

  async _writeMappings(mappings) {
    const tmp = MAPPINGS_PATH + '.tmp';
    await fsp.writeFile(
      tmp,
      JSON.stringify({ mappings }, null, 2),
      'utf8'
    );
    await fsp.rename(tmp, MAPPINGS_PATH);
  }

  // ─── Rendering ────────────────────────────────────────

  /**
   * Build a composite sheet from a layout + a context object.
   *
   * @param {object} opts
   * @param {object} opts.layout       The composite layout (already loaded)
   * @param {string} opts.variant      'vertical' | 'horizontal'
   * @param {Buffer} opts.playerPhoto  Player photo bytes
   * @param {Buffer|null} opts.teamPhoto   Team photo bytes (null = placeholder)
   * @param {Buffer|null} opts.logo        Logo bytes (null = placeholder)
   * @param {object} opts.tokens       Variable substitution context
   *
   * Returns: { buffer, variant, dimensions, warnings }
   */
  async buildSheetBuffer({ layout, variant, playerPhoto, teamPhoto, logo, playerBackground, tokens }) {
    if (!layout) throw new Error('layout is required');
    const variantDef = layout.variants[variant];
    if (!variantDef) {
      throw new Error(
        `Variant "${variant}" not defined on layout "${layout.id}"`
      );
    }

    const dpi = layout.dpi || 300;
    const sheetWidthPx = Math.round(layout.sheetWidth * dpi);
    const sheetHeightPx = Math.round(layout.sheetHeight * dpi);

    const composites = [];
    const warnings = [];

    for (const slot of variantDef.slots) {
      const x = Math.round((slot.x || 0) * dpi);
      const y = Math.round((slot.y || 0) * dpi);
      const w = Math.round((slot.w || 0) * dpi);
      const h = Math.round((slot.h || 0) * dpi);

      if (w <= 0 || h <= 0) {
        warnings.push({
          type: 'invalid_slot_dimensions',
          message: `Slot kind=${slot.kind} has non-positive dimensions (w=${slot.w}, h=${slot.h})`,
        });
        continue;
      }

      try {
        if (slot.kind === 'playerPhoto') {
          if (!playerPhoto) {
            warnings.push({
              type: 'missing_player_photo',
              message: 'Player photo not supplied',
            });
            composites.push(this._placeholderSvg(x, y, w, h, 'player photo missing', '#ffe4e4'));
            continue;
          }
          const fitted = await sharp(playerPhoto)
            .resize(w, h, { fit: slot.fit || 'cover' })
            .toBuffer();
          composites.push({ input: fitted, top: y, left: x });
        } else if (slot.kind === 'playerBackground') {
          // Phase 10: customer-selected background photo (from
          // ms_cart.cart_photo_bg). When absent, render NOTHING — the
          // sheet's own background or whatever's drawn behind shows
          // through the player photo's alpha. No placeholder, no warning.
          //
          // When present, behaves like a photo slot: resize/fit, place
          // at the slot's coordinates. Order matters — the layout's
          // slot order should put playerBackground BEFORE playerPhoto
          // so the background draws under the player.
          if (!playerBackground) {
            // Cart didn't reference a background — just skip this slot.
            continue;
          }
          const fitted = await sharp(playerBackground)
            .resize(w, h, { fit: slot.fit || 'cover' })
            .toBuffer();
          composites.push({ input: fitted, top: y, left: x });
        } else if (slot.kind === 'teamPhoto') {
          if (!teamPhoto) {
            warnings.push({
              type: 'missing_team_photo',
              message: 'Team photo missing — rendering placeholder',
            });
            composites.push(this._placeholderSvg(x, y, w, h, 'team photo missing', '#e4e4e4'));
            continue;
          }
          const fitted = await sharp(teamPhoto)
            .resize(w, h, { fit: slot.fit || 'cover' })
            .toBuffer();
          composites.push({ input: fitted, top: y, left: x });
        } else if (slot.kind === 'logo') {
          if (!logo) {
            warnings.push({
              type: 'missing_logo',
              message: 'Logo missing — rendering placeholder',
            });
            composites.push(this._placeholderSvg(x, y, w, h, 'no logo', '#e8eef7'));
            continue;
          }
          const fitted = await sharp(logo)
            .resize(w, h, {
              fit: slot.fit || 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();
          composites.push({ input: fitted, top: y, left: x });
        } else if (slot.kind === 'text') {
          const resolvedText = this._substituteTokens(slot.text || '', tokens || {});
          composites.push(this._textSvg(slot, x, y, w, h, resolvedText));
        } else if (slot.kind === 'overlay' || slot.kind === 'staticGraphic') {
          // Phase 9c: rename overlay → staticGraphic. Both kinds work
          // (backward compat for any existing layout JSON). Both lookup
          // paths are also supported: graphicKey (new) or overlayId
          // (legacy). The buffer is supplied by the caller via
          // tokens.overlays[key] — naming kept for compatibility.
          const key = slot.graphicKey || slot.overlayId;
          if (!key) {
            warnings.push({
              type: 'missing_graphic_key',
              message: `Static graphic slot has no graphicKey`,
            });
            continue;
          }
          const graphicBuffer =
            (tokens && tokens.overlays && tokens.overlays[key]) || null;
          if (!graphicBuffer) {
            warnings.push({
              type: 'missing_graphic',
              graphicKey: key,
              message: `Static graphic "${key}" not supplied (file may be missing or layout.graphics out of sync)`,
            });
            continue;
          }
          const fitted = await sharp(graphicBuffer)
            .resize(w, h, {
              fit: slot.fit || 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();
          composites.push({ input: fitted, top: y, left: x });
        } else {
          warnings.push({
            type: 'unknown_slot_kind',
            message: `Slot kind "${slot.kind}" is not recognized`,
          });
        }
      } catch (err) {
        warnings.push({
          type: 'slot_render_error',
          slotKind: slot.kind,
          message: err.message,
        });
      }
    }

    const bgColor = parseHexColor(layout.backgroundColor || '#ffffff');
    const buffer = await sharp({
      create: {
        width: sheetWidthPx,
        height: sheetHeightPx,
        channels: 3,
        background: bgColor,
      },
    })
      .composite(composites)
      .jpeg({ quality: 95 })
      .toBuffer();

    return {
      buffer,
      variant,
      dimensions: { width: sheetWidthPx, height: sheetHeightPx, dpi },
      warnings,
    };
  }

  /**
   * Decide which variant to use based on the player photo's orientation.
   * Falls back to whichever variant exists if only one is defined.
   */
  pickVariant(layout, playerWidth, playerHeight) {
    const isHorizontal = playerWidth >= playerHeight;
    const preferred = isHorizontal ? 'horizontal' : 'vertical';
    if (layout.variants[preferred]) return preferred;
    if (layout.variants.horizontal) return 'horizontal';
    if (layout.variants.vertical) return 'vertical';
    throw new Error(`Layout "${layout.id}" has no usable variant`);
  }

  // ─── Helpers ──────────────────────────────────────────

  _placeholderSvg(x, y, w, h, label, fillColor) {
    const svg = Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${w}" height="${h}" fill="${fillColor}" stroke="#999" stroke-width="2" stroke-dasharray="8,4"/>` +
        `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" ` +
        `font-family="Arial, sans-serif" font-size="${Math.min(w, h) * 0.08}" fill="#666">` +
        escapeXml(label) +
        `</text></svg>`
    );
    return { input: svg, top: y, left: x };
  }

  _textSvg(slot, x, y, w, h, text) {
    const requestedFontSize = slot.fontSize || 24;
    const fontFamily = slot.fontFamily || 'Arial, sans-serif';
    const color = slot.color || '#000000';
    const align = slot.align || 'center';
    const weight = slot.weight || 'normal';
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const textX = align === 'left' ? 0 : align === 'right' ? w : w / 2;

    // Phase 9f: autoFit. When slot.autoFit is enabled (or the engine
    // detects overflow even without the flag — defensive default),
    // shrink the font size so the rendered text fits within the slot's
    // width. The shrink factor is estimated from average character
    // width for Arial-class fonts; close enough for English text and
    // typical name lengths. We never scale UP — only down.
    //
    // Estimate:  textWidth ≈ chars × fontSize × 0.55  (Arial-ish)
    // Limit:     textWidth ≤ w * 0.95  (small inset)
    // So:        fontSize ≤ (w * 0.95) / (chars × 0.55)
    const charCount = (text || '').length || 1;
    const padding = 0.95;
    const avgCharWidthRatio = weight === 'bold' ? 0.6 : 0.55;
    const maxFontByWidth = (w * padding) / (charCount * avgCharWidthRatio);
    // Also bound by height: text shouldn't be taller than the slot
    const maxFontByHeight = h * padding;
    const maxFitFontSize = Math.min(maxFontByWidth, maxFontByHeight);

    // Default behavior: if slot.autoFit is explicitly true, always
    // apply the shrink. If undefined/false, only shrink when the
    // requested size would clearly overflow (this keeps existing
    // layouts unchanged unless the operator opts in).
    let fontSize = requestedFontSize;
    if (slot.autoFit) {
      fontSize = Math.min(requestedFontSize, maxFitFontSize);
    } else if (requestedFontSize > maxFitFontSize) {
      // Even without autoFit, refuse to render text that would
      // overflow drastically (more than 1.5× over). This is
      // defensive; without it, a long name in a small slot would
      // bleed past the slot bounds and possibly overlap other slots.
      if (requestedFontSize > maxFitFontSize * 1.5) {
        fontSize = maxFitFontSize;
      }
    }
    // Don't go absurdly small — minimum readable
    fontSize = Math.max(fontSize, 6);

    const svg = Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<text x="${textX}" y="${h / 2}" text-anchor="${anchor}" dominant-baseline="middle" ` +
        `font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${weight}" ` +
        `fill="${color}">` +
        escapeXml(text) +
        `</text></svg>`
    );
    return { input: svg, top: y, left: x };
  }

  /**
   * Substitute {token.path} references in a text string against a
   * flat-or-nested context. Missing tokens render as empty string.
   */
  _substituteTokens(template, ctx) {
    if (!template) return '';
    return template.replace(/\{([^}]+)\}/g, (_, key) => {
      const parts = key.split('.');
      let v = ctx;
      for (const p of parts) {
        if (v == null) return '';
        v = v[p];
      }
      return v == null ? '' : String(v);
    });
  }

  /**
   * Build the standard token context from a canonical Sytist order +
   * line item. Convenience for callers — the rendering itself takes a
   * pre-built tokens object so callers can override / extend.
   */
  buildTokensFromOrder(order, lineItem) {
    const subject = {};
    if (order.subject && Array.isArray(order.subject.fields)) {
      for (const f of order.subject.fields) {
        const key = camelCaseKey(f.label || '');
        if (key) subject[key] = f.value || '';
      }
    }
    return {
      customer: { ...(order.customer || {}) },
      subject,
      galleryName: order.galleryName || '',
      subGalleryName: order.subGalleryName || (lineItem && lineItem.subGalleryName) || '',
      order: {
        id: order.orderId || '',
        date: (order.orderDate || '').split(' ')[0] || '',
      },
      year: new Date().getFullYear(),
      date: new Date().toISOString().split('T')[0],
    };
  }
}

// ─── Module-private helpers ─────────────────────────────

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseHexColor(hex) {
  if (!hex || typeof hex !== 'string') {
    return { r: 255, g: 255, b: 255 };
  }
  const m = hex.replace('#', '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16),
  };
}

function camelCaseKey(label) {
  if (!label) return '';
  return label
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
}

module.exports = new CompositeService();
module.exports.LAYOUTS_PATH = LAYOUTS_PATH;
module.exports.MAPPINGS_PATH = MAPPINGS_PATH;

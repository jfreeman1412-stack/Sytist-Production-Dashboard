// packingSlipService.js
//
// Phase 4.3: produces a 5×8 @ 300 DPI JPG packing slip from a canonical
// Sytist order. Uses sharp + SVG composition for layout and inline
// <image href="https://..."> tags for thumbnails (sharp fetches the S3
// URLs at rasterization time — no separate fetch dance).
//
// IMPORTANT: nothing in this file gets called from a "real" file-write
// route in 4.2/4.3. The /slip/preview/:orderId endpoint streams the JPG
// buffer back as the response body without touching disk. The
// /slip/preview/:orderId/save endpoint writes ONE file under the test
// sandbox so operators can inspect the rendered output. Phase 4.6 wires
// up writeSlipFile() for the production "Process this order" flow.
//
// Layout (5×8 @ 300 DPI = 1500×2400 px):
//
//   ┌───────────────────────────────────┐  ← MARGIN
//   │           [ LOGO image ]          │
//   │      ┌─────────────────────┐      │
//   │      │    PACKING SLIP     │      │   header zone
//   │      └─────────────────────┘      │
//   │  Order #          Order Date      │
//   │  XXXX             10/15/2025      │
//   │  Gallery          Shipping        │   order info grid
//   │  XXXX             USPS Home       │   (3 rows × 2 cols)
//   │  Workflow         Team            │
//   │  ship_to_home     Varsity         │
//   │  ───────────────────────────────  │
//   │  SHIP TO                          │
//   │  Heather Matthews                 │
//   │  123 Main St                      │   ship-to block
//   │  Ramsey, MN 55330                 │
//   │  ───────────────────────────────  │
//   │  ITEMS (5)                  QTY   │
//   │  [thumb] Memory Mate         1    │
//   │  [thumb] 4 Mini Magnets      1    │   item rows (dynamic
//   │  [thumb] Trading Cards       1    │   sizing — fits more
//   │  ...                              │   items at smaller thumbs)
//   │  ───────────────────────────────  │
//   │  [QR ]  Sportsline Photography    │   footer
//   │  [code] info@sportslinephoto.com  │
//   │         (612) 839-2618            │
//   │                  [logo-footer]    │
//   └───────────────────────────────────┘
//
// Reads canonical Sytist shape directly:
//   order.orderNumber / orderId  →  Order #
//   order.orderDate              →  Order Date (date-only)
//   order.galleryName            →  Gallery
//   order.shipping.optionName    →  Shipping
//   order.shipping.workflow      →  Workflow
//   order.subGalleryName         →  Team
//   order.shipTo.{firstName, lastName, address1, address2, city, state, zip, phone}
//   lineItems[].productName      →  item name
//   lineItems[].sku              →  SKU label
//   lineItems[].qty              →  qty column
//   lineItems[].photo.thumbUrl   →  thumbnail (loaded inline by sharp via
//                                   <image href="...">)
//
// Same flag-based filtering as darkroomService: items with flags.booking,
// flags.giftCert, flags.creditProduct, flags.preSell, flags.download don't
// appear on the slip (they aren't print jobs). teamScope honored the same
// way for sibling per-team chunks.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');

const pathsService = require('./pathsService');
const specialtyService = require('./specialtyService');

// 5" × 8" at 300 DPI
const SLIP_WIDTH = 1500;
const SLIP_HEIGHT = 2400;
const MARGIN = 60;
const CONTENT_WIDTH = SLIP_WIDTH - MARGIN * 2;

const LOGO_PATH = path.join(__dirname, '..', 'config', 'logo.png');
const FOOTER_LOGO_PATH = path.join(__dirname, '..', 'config', 'logo-footer.png');
const SLIP_CONFIG_PATH = path.join(__dirname, '..', 'config', 'slip-config.json');

const DEFAULT_SLIP_CONFIG = {
  studio: {
    name: 'Sportsline Photography',
    email: 'info@sportslinephotography.com',
    phone: '',
    showReturnAddress: false,
    returnAddress: {},
  },
  highlightColors: {
    specialty: '#fff5e6',
    quantity: '#fff0f0',
  },
};

// Same skip set as darkroomService — items with these flags aren't print
// jobs and shouldn't appear on the slip.
// Phase 15a: isPackageHeader is the synthetic flag attached to the
// original package row when sytistDbService explodes a package into
// its constituent items. The header itself isn't a printable product
// — the constituents are — so we skip it from the slip the same way
// we skip digital downloads. The constituents (with flags.isPackageItem
// = true and their own SKUs) DO show on the slip as individual rows.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'isPackageHeader'];

class PackingSlipService {
  constructor() {
    this._ensureConfig();
  }

  _ensureConfig() {
    try {
      if (!fs.existsSync(SLIP_CONFIG_PATH)) {
        const dir = path.dirname(SLIP_CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          SLIP_CONFIG_PATH,
          JSON.stringify(DEFAULT_SLIP_CONFIG, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(`[PackingSlip] Could not ensure ${SLIP_CONFIG_PATH}: ${err.message}`);
    }
  }

  async getSlipConfig() {
    try {
      const raw = await fsp.readFile(SLIP_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so missing fields don't crash the renderer
      return {
        studio: { ...DEFAULT_SLIP_CONFIG.studio, ...(parsed.studio || {}) },
        highlightColors: {
          ...DEFAULT_SLIP_CONFIG.highlightColors,
          ...(parsed.highlightColors || {}),
        },
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_SLIP_CONFIG));
    }
  }

  async updateSlipConfig(updates) {
    const current = await this.getSlipConfig();
    const merged = {
      studio: { ...current.studio, ...((updates && updates.studio) || {}) },
      highlightColors: {
        ...current.highlightColors,
        ...((updates && updates.highlightColors) || {}),
      },
    };
    await fsp.writeFile(SLIP_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  // ─── ORDER → SLIP BUFFER (preview path, no writes) ──────

  /**
   * Render a packing slip as a JPG buffer, returning everything the caller
   * needs to either stream it or write it.
   *
   * Options:
   *   sortSegments — passed through to pathsService for filename target
   *                  (downloadBase + segments + filename)
   *   teamScope    — { subGalleryId, subGalleryName }. When given, only
   *                  items in this sub-gallery render in the items list
   *                  (per-team chunk slip for non-home siblings).
   *   filenameSuffix — appended to the filename before .jpg (e.g. "_preview").
   *                    Used by the preview/save endpoint to avoid clobbering
   *                    the production slip if it ever exists.
   *
   * Returns:
   *   {
   *     buffer,          // Buffer — the rendered JPG
   *     filename,        // e.g. "110855_packing_slip.jpg"
   *     filePath,        // absolute path under downloadBase
   *     targetDir,
   *     printedItems,    // array — items that appear on the slip, in order
   *     skippedItems,    // array — items dropped with reason
   *     warnings,        // array — non-fatal issues (missing thumbs, etc.)
   *     meta             // counts & dimensions
   *   }
   */
  async buildSlipBuffer(order, options = {}) {
    if (!order || !order.orderId) {
      throw new Error('buildSlipBuffer requires a canonical-shape order');
    }

    const {
      sortSegments = [],
      teamScope = null,
      filenameSuffix = '',
    } = options;

    const config = await this.getSlipConfig();
    const warnings = [];
    const skippedItems = [];

    // Filter line items to what actually prints
    const sourceLines = order.lineItems || [];
    const printedItems = [];
    for (const li of sourceLines) {
      if (teamScope && teamScope.subGalleryId) {
        if (li.subGalleryId !== teamScope.subGalleryId) continue;
      }
      const skipReason = SKIP_FLAGS.find((f) => li.flags?.[f]);
      if (skipReason) {
        skippedItems.push({
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          reason: `flag:${skipReason}`,
        });
        continue;
      }
      printedItems.push(li);
    }

    // Resolve target path. Slip lives next to the images in downloadBase.
    const targetDir = pathsService.resolveFullPath(
      'downloadBase',
      order,
      sortSegments
    );
    const orderNumber = order.orderNumber || order.orderId;
    const teamSuffix =
      teamScope && teamScope.subGalleryName
        ? '_' + sanitizeFilename(teamScope.subGalleryName)
        : '';
    const filename = `${orderNumber}_packing_slip${teamSuffix}${filenameSuffix}.jpg`;
    const filePath = path.win32.join(targetDir, filename);

    // ─── Compose the slip ──────────────────────────────────
    const buffer = await this._composeSlip(order, {
      printedItems,
      config,
      teamScope,
      warnings,
    });

    return {
      buffer,
      filename,
      filePath,
      targetDir,
      printedItems: printedItems.map((li) => ({
        cartId: li.cartId,
        productName: li.productName,
        sku: li.sku,
        qty: li.qty,
        thumbUrl: li.photo?.thumbUrl || null,
        subGalleryId: li.subGalleryId,
        subGalleryName: li.subGalleryName,
      })),
      skippedItems,
      warnings,
      meta: {
        width: SLIP_WIDTH,
        height: SLIP_HEIGHT,
        dpi: 300,
        orderId: order.orderId,
        teamScope: teamScope || null,
        printedCount: printedItems.length,
        skippedCount: skippedItems.length,
      },
    };
  }

  /**
   * Inner SVG → JPG composition. Returns a Buffer.
   *
   * Uses two sharp passes:
   *   1. Render the base SVG (background, header, text blocks) to a PNG buffer
   *   2. Composite QR code, item thumbnails, and footer logo over the base
   *      then encode JPG
   *
   * Thumbnails are placed via composite: sharp FETCHES the S3 thumb URL,
   * resizes to a fixed thumbSize, and pastes it into position. We can't
   * use inline <image href="..."> in the SVG itself because librsvg's
   * remote-image support is unreliable across versions. Composite mode is
   * deterministic.
   */
  async _composeSlip(order, ctx) {
    const { printedItems, config, teamScope, warnings } = ctx;
    const itemCount = printedItems.length;

    // ─── Sizing math ─────────────────────────────────────
    // Reserve fixed space for header / order info / ship-to / items header
    // / footer. What's left determines per-item row height.
    const HEADER_BLOCK = 250;       // logo + title bar + spacing
    const ORDER_INFO_BLOCK = 480;   // 3 rows of (label/value) at ~160px each
    const SHIP_TO_BLOCK = 360;
    const ITEMS_HEADER = 50;
    const FOOTER_BLOCK = 320;
    const reservedTop = MARGIN + HEADER_BLOCK + ORDER_INFO_BLOCK + SHIP_TO_BLOCK + ITEMS_HEADER;
    const reservedBottom = FOOTER_BLOCK + MARGIN;
    const availableForItems = SLIP_HEIGHT - reservedTop - reservedBottom;

    let thumbSize;
    if (itemCount <= 0) thumbSize = 0;
    else if (itemCount <= 2) thumbSize = 200;
    else if (itemCount <= 4) thumbSize = 160;
    else if (itemCount <= 6) thumbSize = 120;
    else thumbSize = Math.max(60, Math.floor(availableForItems / itemCount) - 20);
    const itemRowHeight = thumbSize + 20;
    const itemNameSize = Math.max(18, Math.round(thumbSize * 0.22));
    const itemDetailSize = Math.max(14, Math.round(thumbSize * 0.16));
    const itemQtySize = Math.max(28, Math.round(thumbSize * 0.35));

    // ─── Build base SVG (text + boxes only, no raster images) ──
    const svgParts = [];
    let y = MARGIN;

    // Background
    svgParts.push(`<rect width="${SLIP_WIDTH}" height="${SLIP_HEIGHT}" fill="#ffffff"/>`);

    // Logo placeholder space (logo composited later)
    const LOGO_HEIGHT = 170;
    const logoExists = fs.existsSync(LOGO_PATH);
    if (!logoExists) {
      // Fallback: studio name as text
      svgParts.push(
        `<text x="${SLIP_WIDTH / 2}" y="${y + 90}" font-family="Arial Black, Arial, sans-serif" ` +
          `font-size="64" font-weight="900" fill="#1a1a1a" text-anchor="middle">${esc(config.studio.name)}</text>`
      );
    }
    y += LOGO_HEIGHT;

    // Title bar
    svgParts.push(
      `<rect x="${MARGIN}" y="${y}" width="${CONTENT_WIDTH}" height="60" rx="8" fill="#1a1a2e"/>`
    );
    svgParts.push(
      `<text x="${SLIP_WIDTH / 2}" y="${y + 42}" font-family="Arial, sans-serif" ` +
        `font-size="32" font-weight="bold" fill="#ffffff" text-anchor="middle">PACKING SLIP</text>`
    );
    y += 80;

    // Order info grid (3 rows × 2 cols)
    const leftCol = MARGIN + 10;
    const rightCol = SLIP_WIDTH / 2 + 20;
    const labelStyle = `font-family="Arial, sans-serif" font-size="32" fill="#888888"`;
    const valueStyle = `font-family="Arial, sans-serif" font-size="44" font-weight="bold" fill="#222222"`;

    const fitValue = (x, ypos, text, maxChars = 22) => {
      let t = text == null ? '' : String(text);
      if (t.length > maxChars) t = t.slice(0, maxChars - 1).trimEnd() + '…';
      return `<text x="${x}" y="${ypos}" ${valueStyle}>${esc(t)}</text>`;
    };

    const dateOnly = extractDate(order.orderDate);
    const dateDisplay = formatDateUS(dateOnly);

    // Row 1: Order # / Order Date
    svgParts.push(`<text x="${leftCol}" y="${y + 36}" ${labelStyle}>Order #</text>`);
    svgParts.push(fitValue(leftCol, y + 92, order.orderNumber || order.orderId));
    svgParts.push(`<text x="${rightCol}" y="${y + 36}" ${labelStyle}>Order Date</text>`);
    svgParts.push(fitValue(rightCol, y + 92, dateDisplay));
    y += 150;

    // Row 2: Gallery / Shipping
    svgParts.push(`<text x="${leftCol}" y="${y + 36}" ${labelStyle}>Gallery</text>`);
    svgParts.push(fitValue(leftCol, y + 92, order.galleryName || 'N/A'));
    svgParts.push(`<text x="${rightCol}" y="${y + 36}" ${labelStyle}>Shipping</text>`);
    svgParts.push(fitValue(rightCol, y + 92, order.shipping?.optionName || 'Standard'));
    y += 150;

    // Row 3: Workflow / Team
    const workflowLabel = workflowToLabel(order.shipping?.workflow);
    const teamName = teamScope?.subGalleryName || order.subGalleryName || '';
    svgParts.push(`<text x="${leftCol}" y="${y + 36}" ${labelStyle}>Workflow</text>`);
    svgParts.push(fitValue(leftCol, y + 92, workflowLabel));
    svgParts.push(`<text x="${rightCol}" y="${y + 36}" ${labelStyle}>Team</text>`);
    svgParts.push(fitValue(rightCol, y + 92, teamName || '—'));
    y += 160;

    // Divider
    svgParts.push(
      `<line x1="${MARGIN}" y1="${y}" x2="${SLIP_WIDTH - MARGIN}" y2="${y}" stroke="#dddddd" stroke-width="2"/>`
    );
    y += 20;

    // SHIP TO block
    const shipTo = order.shipTo || {};
    const recipient = `${shipTo.firstName || ''} ${shipTo.lastName || ''}`.trim();
    svgParts.push(`<text x="${leftCol}" y="${y + 36}" ${labelStyle}>SHIP TO</text>`);
    y += 60;
    svgParts.push(
      `<text x="${leftCol}" y="${y + 50}" font-family="Arial, sans-serif" ` +
        `font-size="56" font-weight="bold" fill="#222222">${esc(recipient || '—')}</text>`
    );
    y += 70;
    if (shipTo.businessName) {
      svgParts.push(
        `<text x="${leftCol}" y="${y + 40}" font-family="Arial, sans-serif" ` +
          `font-size="36" fill="#444444">${esc(shipTo.businessName)}</text>`
      );
      y += 48;
    }
    if (shipTo.address1) {
      svgParts.push(
        `<text x="${leftCol}" y="${y + 40}" font-family="Arial, sans-serif" ` +
          `font-size="40" fill="#333333">${esc(shipTo.address1)}</text>`
      );
      y += 50;
    }
    if (shipTo.address2) {
      svgParts.push(
        `<text x="${leftCol}" y="${y + 40}" font-family="Arial, sans-serif" ` +
          `font-size="40" fill="#333333">${esc(shipTo.address2)}</text>`
      );
      y += 50;
    }
    const cityLine =
      [shipTo.city, shipTo.state].filter(Boolean).join(', ') +
      (shipTo.zip ? ` ${shipTo.zip}` : '');
    if (cityLine.trim()) {
      svgParts.push(
        `<text x="${leftCol}" y="${y + 40}" font-family="Arial, sans-serif" ` +
          `font-size="40" fill="#333333">${esc(cityLine)}</text>`
      );
      y += 50;
    }
    if (shipTo.phone) {
      svgParts.push(
        `<text x="${leftCol}" y="${y + 36}" font-family="Arial, sans-serif" ` +
          `font-size="32" fill="#666666">${esc(formatPhone(shipTo.phone))}</text>`
      );
      y += 44;
    }
    y += 20;

    // Divider
    svgParts.push(
      `<line x1="${MARGIN}" y1="${y}" x2="${SLIP_WIDTH - MARGIN}" y2="${y}" stroke="#dddddd" stroke-width="2"/>`
    );
    y += 20;

    // Items header
    svgParts.push(`<text x="${leftCol}" y="${y + 28}" ${labelStyle}>ITEMS (${itemCount})</text>`);
    svgParts.push(
      `<text x="${SLIP_WIDTH - MARGIN - 10}" y="${y + 28}" ${labelStyle} text-anchor="end">QTY</text>`
    );
    y += 50;
    const itemsStartY = y;

    // Footer divider position (we render footer before items so geometry is fixed)
    const QR_SIZE = 180;
    const footerY = SLIP_HEIGHT - MARGIN - QR_SIZE - 60;
    svgParts.push(
      `<line x1="${MARGIN}" y1="${footerY}" x2="${SLIP_WIDTH - MARGIN}" y2="${footerY}" stroke="#dddddd" stroke-width="2"/>`
    );

    // Footer contact info (right of QR code)
    const contactX = MARGIN + QR_SIZE + 30;
    let contactY = footerY + 30;
    const studio = config.studio;

    svgParts.push(
      `<text x="${contactX}" y="${contactY + 28}" font-family="Arial, sans-serif" ` +
        `font-size="32" font-weight="bold" fill="#222222">${esc(studio.name || '')}</text>`
    );
    contactY += 45;

    if (studio.email) {
      svgParts.push(
        `<text x="${contactX}" y="${contactY + 24}" font-family="Arial, sans-serif" ` +
          `font-size="26" fill="#444444">${esc(studio.email)}</text>`
      );
      contactY += 36;
    }

    if (studio.phone) {
      svgParts.push(
        `<text x="${contactX}" y="${contactY + 24}" font-family="Arial, sans-serif" ` +
          `font-size="26" fill="#444444">${esc(formatPhone(studio.phone))}</text>`
      );
      contactY += 36;
    }

    if (studio.showReturnAddress && studio.returnAddress) {
      const r = studio.returnAddress;
      const returnLine = [r.address1, r.city, r.state, r.zipCode].filter(Boolean).join(', ');
      if (returnLine) {
        svgParts.push(
          `<text x="${contactX}" y="${contactY + 22}" font-family="Arial, sans-serif" ` +
            `font-size="22" fill="#888888">${esc(returnLine)}</text>`
        );
        contactY += 32;
      }
    }

    svgParts.push(
      `<text x="${contactX}" y="${contactY + 22}" font-family="Arial, sans-serif" ` +
        `font-size="20" fill="#aaaaaa">Order: ${esc(order.orderNumber || order.orderId || '')}</text>`
    );

    // Build base SVG and rasterize
    const baseSvg = `<svg width="${SLIP_WIDTH}" height="${SLIP_HEIGHT}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`;
    const baseBuffer = await sharp(Buffer.from(baseSvg)).png().toBuffer();

    // ─── Build composites list ────────────────────────────
    const composites = [];

    // Top header logo
    if (logoExists) {
      try {
        const logoFileBuf = await fsp.readFile(LOGO_PATH);
        const meta = await sharp(logoFileBuf).metadata();
        const maxLogoW = 600;
        const maxLogoH = 140;
        const scale = Math.min(maxLogoW / meta.width, maxLogoH / meta.height, 1);
        const lw = Math.round(meta.width * scale);
        const lh = Math.round(meta.height * scale);
        const logoBuffer = await sharp(logoFileBuf).resize(lw, lh).png().toBuffer();
        composites.push({
          input: logoBuffer,
          left: Math.round((SLIP_WIDTH - lw) / 2),
          top: MARGIN + 5,
        });
      } catch (err) {
        warnings.push({ type: 'logo_load_error', message: err.message });
      }
    } else {
      warnings.push({
        type: 'missing_logo',
        message: `Header logo not found at ${LOGO_PATH}; using text fallback.`,
      });
    }

    // QR code
    try {
      const qrTarget = order.orderNumber || order.orderId || 'NO_ORDER';
      const qrDataUrl = await QRCode.toDataURL(String(qrTarget), {
        width: QR_SIZE,
        margin: 1,
        color: { dark: '#222222', light: '#ffffff' },
      });
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const qrBuffer = Buffer.from(qrBase64, 'base64');
      composites.push({
        input: qrBuffer,
        left: MARGIN + 10,
        top: footerY + 15,
      });
    } catch (err) {
      warnings.push({ type: 'qr_error', message: err.message });
    }

    // Footer logo (bottom-right)
    if (fs.existsSync(FOOTER_LOGO_PATH)) {
      try {
        const flBuf = await fsp.readFile(FOOTER_LOGO_PATH);
        const meta = await sharp(flBuf).metadata();
        const maxFW = 400;
        const maxFH = 140;
        const fScale = Math.min(maxFW / meta.width, maxFH / meta.height, 1);
        const flw = Math.round(meta.width * fScale);
        const flh = Math.round(meta.height * fScale);
        const resized = await sharp(flBuf).resize(flw, flh).png().toBuffer();
        composites.push({
          input: resized,
          left: SLIP_WIDTH - MARGIN - flw,
          top: SLIP_HEIGHT - MARGIN - flh,
        });
      } catch (err) {
        warnings.push({ type: 'footer_logo_error', message: err.message });
      }
    }

    // Item rows
    let itemY = itemsStartY;

    // Pre-resolve specialty status for each line item so the per-row loop
    // doesn't have to await on each iteration. Specialty SKUs get the
    // orange row tint from highlightColors.specialty (default #fff5e6).
    const specialtyByCartId = {};
    for (const li of printedItems) {
      try {
        specialtyByCartId[li.cartId] = await specialtyService.isSpecialty(li.sku);
      } catch {
        specialtyByCartId[li.cartId] = false;
      }
    }

    for (let idx = 0; idx < printedItems.length; idx++) {
      const li = printedItems[idx];
      const qty = li.qty || 1;
      const isHighQty = qty > 1;
      const isSpecialty = !!specialtyByCartId[li.cartId];

      // Highlight band: specialty takes precedence over qty (specialty
      // matters more for routing — operator needs to see those first).
      const bandColor = isSpecialty
        ? config.highlightColors.specialty
        : isHighQty
        ? config.highlightColors.quantity
        : null;
      if (bandColor) {
        composites.push({
          input: Buffer.from(
            `<svg width="${CONTENT_WIDTH}" height="${thumbSize + 10}" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="${CONTENT_WIDTH}" height="${thumbSize + 10}" fill="${bandColor}" rx="6"/></svg>`
          ),
          left: MARGIN,
          top: itemY - 5,
        });
      }

      // Thumbnail
      const thumbUrl = li.photo?.thumbUrl || null;
      let thumbBuffer = null;
      if (thumbUrl) {
        try {
          const resp = await fetch(thumbUrl);
          if (resp.ok) {
            const ab = await resp.arrayBuffer();
            thumbBuffer = await sharp(Buffer.from(ab))
              .resize(thumbSize, thumbSize, { fit: 'inside' })
              .png()
              .toBuffer();
          } else {
            warnings.push({
              type: 'thumb_fetch_failed',
              cartId: li.cartId,
              status: resp.status,
              url: thumbUrl,
            });
          }
        } catch (err) {
          warnings.push({
            type: 'thumb_fetch_error',
            cartId: li.cartId,
            message: err.message,
            url: thumbUrl,
          });
        }
      } else {
        warnings.push({
          type: 'no_thumb_url',
          cartId: li.cartId,
          productName: li.productName,
        });
      }

      if (thumbBuffer) {
        const thumbMeta = await sharp(thumbBuffer).metadata();
        const offsetY = Math.round((thumbSize - thumbMeta.height) / 2);
        composites.push({
          input: thumbBuffer,
          left: MARGIN + 10,
          top: itemY + offsetY,
        });
      } else {
        // Placeholder rectangle
        composites.push({
          input: Buffer.from(
            `<svg width="${thumbSize}" height="${thumbSize}" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="${thumbSize}" height="${thumbSize}" fill="#f0f0f0" rx="4"/>` +
              `<text x="${thumbSize / 2}" y="${thumbSize / 2 + 6}" font-family="Arial, sans-serif" font-size="14" fill="#cccccc" text-anchor="middle">No image</text>` +
              `</svg>`
          ),
          left: MARGIN + 10,
          top: itemY,
        });
      }

      // Item text + qty
      const textX = MARGIN + thumbSize + 25;
      const textWidth = SLIP_WIDTH - textX - MARGIN - 10;
      const qtyColor = isHighQty ? '#DC3545' : '#222222';
      const qtyBadge = isHighQty
        ? `<rect x="${textWidth - Math.round(itemNameSize * 4)}" y="${Math.round(itemNameSize * 1.8)}" ` +
          `width="${Math.round(itemNameSize * 4)}" height="${Math.round(itemNameSize * 1)}" rx="4" fill="#DC3545"/>` +
          `<text x="${textWidth - Math.round(itemNameSize * 2)}" y="${Math.round(itemNameSize * 2.55)}" ` +
          `font-family="Arial, sans-serif" font-size="${Math.round(itemNameSize * 0.6)}" ` +
          `font-weight="bold" fill="#ffffff" text-anchor="middle">CHECK QTY</text>`
        : '';

      // SPECIALTY badge — different color (orange), placed below CHECK QTY
      // (or alone if not a high-qty row).
      const specialtyBadgeY = isHighQty
        ? Math.round(itemNameSize * 3.0)
        : Math.round(itemNameSize * 1.8);
      const specialtyBadge = isSpecialty
        ? `<rect x="${textWidth - Math.round(itemNameSize * 4)}" y="${specialtyBadgeY}" ` +
          `width="${Math.round(itemNameSize * 4)}" height="${Math.round(itemNameSize * 1)}" rx="4" fill="#E87B34"/>` +
          `<text x="${textWidth - Math.round(itemNameSize * 2)}" y="${specialtyBadgeY + Math.round(itemNameSize * 0.75)}" ` +
          `font-family="Arial, sans-serif" font-size="${Math.round(itemNameSize * 0.6)}" ` +
          `font-weight="bold" fill="#ffffff" text-anchor="middle">SPECIALTY</text>`
        : '';

      const skuLine = li.sku ? `SKU: ${esc(li.sku)}` : '';
      const teamLine = li.subGalleryName && (!teamScope || teamScope.subGalleryId !== li.subGalleryId)
        ? esc(li.subGalleryName)
        : '';

      // Phase 15c: render modifier add-ons (e.g. "Frame") as a
      // highlighted line below the product name. The suffix is
      // already appended to li.productName so the Darkroom .txt
      // shows it too; this slip-only display makes it visually
      // obvious to the packer.
      const modifiers = Array.isArray(li.modifiers) ? li.modifiers : [];
      const modifierText = modifiers
        .map((m) => m.name || '')
        .filter(Boolean)
        .join(' · ');
      // Layout: when modifiers exist, push sku/team rows down to
      // make room. Reserve a row at y * 2.5 for the highlight.
      const hasMods = modifierText.length > 0;
      const modY = Math.round(itemNameSize * 2.5);
      const skuY = hasMods ? Math.round(itemNameSize * 3.7) : Math.round(itemNameSize * 2.5);
      const teamY = hasMods ? Math.round(itemNameSize * 4.8) : Math.round(itemNameSize * 3.6);
      const modifierBlock = hasMods
        ? // Highlighted background + bold label
          `<rect x="-2" y="${modY - Math.round(itemDetailSize * 1.0)}" ` +
            `width="${Math.min(textWidth, Math.round(modifierText.length * itemDetailSize * 0.62) + 14)}" ` +
            `height="${Math.round(itemDetailSize * 1.4)}" rx="3" fill="#FFE066"/>` +
          `<text x="6" y="${modY}" font-family="Arial, sans-serif" ` +
            `font-size="${itemDetailSize}" font-weight="bold" fill="#444400">` +
            `+ ${esc(modifierText)}</text>`
        : '';

      const itemSvg = Buffer.from(
        `<svg width="${textWidth + 10}" height="${thumbSize + 10}" xmlns="http://www.w3.org/2000/svg">` +
          `<text x="0" y="${Math.round(itemNameSize * 1.2)}" font-family="Arial, sans-serif" font-size="${itemNameSize}" ` +
          `font-weight="bold" fill="#222222">${esc(li.productName || 'Unknown Product')}</text>` +
          modifierBlock +
          (skuLine
            ? `<text x="0" y="${skuY}" font-family="Arial, sans-serif" ` +
              `font-size="${itemDetailSize}" fill="#666666">${skuLine}</text>`
            : '') +
          (teamLine
            ? `<text x="0" y="${teamY}" font-family="Arial, sans-serif" ` +
              `font-size="${itemDetailSize}" fill="#888888">${teamLine}</text>`
            : '') +
          `<text x="${textWidth}" y="${Math.round(itemQtySize * 1.1)}" font-family="Arial, sans-serif" ` +
          `font-size="${itemQtySize}" font-weight="bold" fill="${qtyColor}" text-anchor="end">${qty}</text>` +
          qtyBadge +
          specialtyBadge +
          `</svg>`
      );
      composites.push({
        input: itemSvg,
        left: textX,
        top: itemY,
      });

      itemY += itemRowHeight;

      if (idx < printedItems.length - 1) {
        composites.push({
          input: Buffer.from(
            `<svg width="${CONTENT_WIDTH - 20}" height="2" xmlns="http://www.w3.org/2000/svg">` +
              `<line x1="0" y1="1" x2="${CONTENT_WIDTH - 20}" y2="1" stroke="#eeeeee" stroke-width="1"/></svg>`
          ),
          left: MARGIN + 10,
          top: itemY - 10,
        });
      }
    }

    // Final composition → JPG
    const finalBuffer = await sharp(baseBuffer)
      .composite(composites)
      .jpeg({ quality: 90 })
      .toBuffer();

    return finalBuffer;
  }

  // ─── DISK WRITE (PHASE 4.6 / preview/save) ──────────────

  /**
   * Write a built slip buffer to its target path. Atomic .tmp + rename.
   * Used by the /preview/save endpoint (writes a labeled preview file)
   * and by Phase 4.6's orchestrator (writes the production slip).
   */
  async writeSlipFile(buildResult) {
    if (!buildResult || !buildResult.buffer || !buildResult.filePath) {
      throw new Error(
        'writeSlipFile requires a buildSlipBuffer() result with buffer + filePath'
      );
    }
    const targetDir = path.win32.dirname(buildResult.filePath);
    await fsp.mkdir(targetDir, { recursive: true });
    const tmpPath = buildResult.filePath + '.tmp';
    await fsp.writeFile(tmpPath, buildResult.buffer);
    await fsp.rename(tmpPath, buildResult.filePath);
    console.log(`[PackingSlip] Wrote ${buildResult.filePath}`);
    return { filePath: buildResult.filePath, filename: buildResult.filename };
  }
}

// ─── helpers ─────────────────────────────────────────────

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
}

function extractDate(orderDate) {
  if (orderDate && typeof orderDate === 'string') {
    const datePart = orderDate.split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return new Date().toISOString().split('T')[0];
}

function formatDateUS(yyyymmdd) {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return yyyymmdd;
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}/${m[1]}`;
}

function formatPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  // Strip leading 1 (US country code)
  const trimmed = digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
  if (trimmed.length === 10) {
    return `(${trimmed.slice(0, 3)}) ${trimmed.slice(3, 6)}-${trimmed.slice(6)}`;
  }
  return phone;
}

function workflowToLabel(wf) {
  const map = {
    ship_to_home: 'Ship to Home',
    ship_to_managers: 'Ship to Managers',
    ship_to_league: 'Ship to League',
  };
  return map[wf] || wf || '—';
}

module.exports = new PackingSlipService();
module.exports.SKIP_FLAGS = SKIP_FLAGS;
module.exports.SLIP_WIDTH = SLIP_WIDTH;
module.exports.SLIP_HEIGHT = SLIP_HEIGHT;

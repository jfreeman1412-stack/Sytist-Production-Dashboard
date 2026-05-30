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
const packagingService = require('./packagingService');
const greenscreenService = require('./greenscreenService');

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
// Phase 64: preRegister — a pre-registration placeholder (cart_pre_register_id
// > 0) is a $0 non-product with no photo; it must not render on the slip nor be
// counted in "Items to Ship".
// Phase 69: coupon — cart_coupon > 0; non-product, must not render on slip or
// count toward "Items to Ship".
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'preRegister', 'coupon', 'isPackageHeader'];

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
   *   composedByCartId — Phase 34: map of cartId → absolute disk path for
   *                    line items whose photo was green-screen-composited
   *                    upstream (processingService Step 1.4). When the slip
   *                    encounters a cartId in this map, it reads the
   *                    composed file from disk instead of fetching thumbUrl.
   *                    This makes slip thumbnails match what actually
   *                    prints for green-screen items.
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
      composedByCartId = {},
      // Phase 44: per-cartId map of composite engine output file
      // paths. When set for a cart_id, the slip uses that file as
      // the thumbnail source — shows the actual rendered product
      // (Memory Mate, Photo Button, etc.) rather than the raw
      // customer photo. Takes priority over composedByCartId.
      compositePathsByCartId = {},
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
      composedByCartId,
      compositePathsByCartId,
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
    const {
      printedItems,
      config,
      teamScope,
      warnings,
      composedByCartId = {},
      compositePathsByCartId = {},
    } = ctx;
    const itemCount = printedItems.length;

    // ─── Phase 59: pre-resolve per-item eligibility flags ────
    // We need these BEFORE building the SVG because:
    //   1. The "Items to Ship" total (shown in the ITEMS header band) excludes
    //      specialty/dropship/digital-by-config rows — they ship separately,
    //      not in the lab box this slip rides on top of. Rows still render on
    //      the slip for operator awareness; only the count excludes them.
    //   2. The per-row loop already needed isSpecialty for the orange tint
    //      band; co-locating all three resolutions here means one pre-pass
    //      instead of three.
    const eligibilityByCartId = {};
    for (const li of printedItems) {
      let isSpecialty = false;
      let isDropShipped = false;
      let isDigitalByConfig = false;
      try { isSpecialty = await specialtyService.isSpecialty(li.sku); } catch {}
      try { isDropShipped = await specialtyService.isDropShipped(li.sku); } catch {}
      try { isDigitalByConfig = await packagingService.isDigital(li.sku); } catch {}
      eligibilityByCartId[li.cartId] = {
        isSpecialty,
        isDropShipped,
        isDigitalByConfig,
        shipsWithLabOrder: !(isSpecialty || isDropShipped || isDigitalByConfig),
      };
    }

    // Qty-summed total of rows that actually ship with this lab order.
    // Matches what a packer arrives at by counting non-specialty rows × qty.
    let itemsToShipCount = 0;
    for (const li of printedItems) {
      if (eligibilityByCartId[li.cartId]?.shipsWithLabOrder) {
        itemsToShipCount += (li.qty || 1);
      }
    }

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

    // ─── Phase 59: two-column layout decision ────────────
    // Single-column (1–6 items) keeps today's per-N thumb sizing.
    // Two-column (≥7 items) splits the items zone into two 680-px columns
    // with a 20-px gutter; items 1..ceil(N/2) fill column 1 top-to-bottom,
    // items ceil(N/2)+1..N fill column 2 — canonical print order preserved.
    // Thumb size is adaptive within 2-col mode (100→60 floor) to extend
    // the per-column row capacity. Hard ceiling: ~20 items at 60-px floor.
    // Beyond that, items overflow the footer zone again — operator gets a
    // console.warn (see below) and is expected to handle manually.
    const use2Col = itemCount >= 7;
    const COLUMN_GUTTER = 20;
    const columnWidth = use2Col ? Math.floor((CONTENT_WIDTH - COLUMN_GUTTER) / 2) : CONTENT_WIDTH;
    const column1Left = MARGIN;                                  // x: 60 (always)
    const column2Left = use2Col ? MARGIN + columnWidth + COLUMN_GUTTER : MARGIN;
    const dividerX = use2Col ? MARGIN + columnWidth + Math.floor(COLUMN_GUTTER / 2) : null;
    const itemsPerCol = use2Col ? Math.ceil(itemCount / 2) : itemCount;

    let thumbSize;
    if (itemCount <= 0) thumbSize = 0;
    else if (use2Col) {
      // Adaptive within 2-col: start at 100, shrink toward a 60-px floor
      // as items per column rise. Mirrors today's "shrink to fit" pattern
      // applied per-column instead of full-width.
      thumbSize = Math.max(60, Math.min(100, Math.floor(availableForItems / itemsPerCol) - 20));
    }
    else if (itemCount <= 2) thumbSize = 200;
    else if (itemCount <= 4) thumbSize = 160;
    else /* itemCount <= 6 */ thumbSize = 120;
    const itemRowHeight = thumbSize + 20;
    const itemNameSize = Math.max(18, Math.round(thumbSize * 0.22));
    const itemDetailSize = Math.max(14, Math.round(thumbSize * 0.16));
    const itemQtySize = Math.max(28, Math.round(thumbSize * 0.35));

    // Phase 59: operator visibility for the rare >20-item case where
    // two-column adaptive shrink still overflows. Logged once per slip.
    if (itemCount > 20) {
      console.warn(
        `[Packing Slip] warning: order ${order.orderNumber || order.orderId} has ${itemCount} items, ` +
        `may overflow 2-column layout (ceiling ~20). Verify slip output.`
      );
    }

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

    // Items header — Phase 59: "Items to Ship" is the prominent qty-summed
    // total of lab-shippable rows (excludes specialty/dropship/digital).
    // The vertical column divider (rendered below) already communicates
    // the 2-col structure visually; a textual "— 2 COLUMNS" suffix was
    // tried in initial Phase 59 but removed after live-UI review as
    // redundant. Right-edge QTY label drops in 2-col mode since each
    // column has its own qty badges and a single-edge label is misleading.
    svgParts.push(
      `<text x="${leftCol}" y="${y + 28}" ${labelStyle}>` +
        `ITEMS TO SHIP: ${itemsToShipCount}` +
        `</text>`
    );
    if (!use2Col) {
      svgParts.push(
        `<text x="${SLIP_WIDTH - MARGIN - 10}" y="${y + 28}" ${labelStyle} text-anchor="end">QTY</text>`
      );
    }
    y += 50;
    const itemsStartY = y;

    // Footer divider position (we render footer before items so geometry is fixed)
    const QR_SIZE = 180;
    const footerY = SLIP_HEIGHT - MARGIN - QR_SIZE - 60;
    svgParts.push(
      `<line x1="${MARGIN}" y1="${footerY}" x2="${SLIP_WIDTH - MARGIN}" y2="${footerY}" stroke="#dddddd" stroke-width="2"/>`
    );

    // Phase 59: vertical divider between columns when 2-col is active.
    // Faint #eeeeee to match the inter-row dividers; spans the full items
    // zone from itemsStartY down to just above the footer divider line so
    // it frames the items zone even when column 2 is partially empty.
    if (use2Col && dividerX !== null) {
      svgParts.push(
        `<line x1="${dividerX}" y1="${itemsStartY}" x2="${dividerX}" y2="${footerY - 10}" ` +
          `stroke="#eeeeee" stroke-width="1"/>`
      );
    }

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

    // Item rows — Phase 59: in 2-col mode itemY resets to itemsStartY when
    // crossing from column 1 (idx < itemsPerCol) to column 2 (idx >=
    // itemsPerCol). Each item's horizontal anchors derive from its
    // column's colLeft + columnWidth (1-col mode collapses to the
    // full-width values, so the geometry below is unified).
    let itemY = itemsStartY;
    // Eligibility is pre-resolved at the top of _composeSlip into
    // eligibilityByCartId — used here for the specialty highlight tint
    // (today's behavior) AND for the count earlier (Phase 59).

    for (let idx = 0; idx < printedItems.length; idx++) {
      const li = printedItems[idx];
      const qty = li.qty || 1;
      const isHighQty = qty > 1;
      const isSpecialty = !!eligibilityByCartId[li.cartId]?.isSpecialty;

      // Column placement: items 0..itemsPerCol-1 in column 1, rest in column 2.
      // At the column boundary (idx === itemsPerCol in 2-col mode) reset
      // itemY back to the top of the items zone.
      const inColumn2 = use2Col && idx >= itemsPerCol;
      if (use2Col && idx === itemsPerCol) {
        itemY = itemsStartY;
      }
      const colLeft = inColumn2 ? column2Left : column1Left;
      const colWidth = columnWidth;

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
            `<svg width="${colWidth}" height="${thumbSize + 10}" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="${colWidth}" height="${thumbSize + 10}" fill="${bandColor}" rx="6"/></svg>`
          ),
          left: colLeft,
          top: itemY - 5,
        });
      }

      // Thumbnail
      // Phase 44 + 34 (revised): four-tier strategy.
      //
      //   Tier 0 — Composite engine output (Phase 44). For line items
      //   with a composite layout mapping (Memory Mate, Photo Button,
      //   etc.), processOrder writes the rendered composite to disk
      //   and passes its path here via compositePathsByCartId. This is
      //   what actually prints, so the slip thumbnail should match.
      //
      //   Tier 1 — Pre-composed green-screen disk file. processingService
      //   Step 1.4 writes a <photo>_composed.jpg for each green-screen
      //   line item (without a composite layout) and passes its path
      //   here via composedByCartId.
      //
      //   Tier 2 — On-demand compose. For preview endpoints (no Process
      //   has run yet) we still want the slip thumbnail to show the
      //   chosen background. Fetch the subject thumb URL and background
      //   URL, composite via greenscreenService, resize.
      //
      //   Tier 3 — Plain thumb fetch. Non-green-screen line items, or
      //   green-screen with no background URL configured: fetch thumbUrl
      //   and use as-is. Same as pre-Phase-34 behavior.
      const compositePath = compositePathsByCartId[li.cartId];
      const composedPath = composedByCartId[li.cartId];
      const thumbUrl = li.photo?.thumbUrl || null;
      let thumbBuffer = null;

      // Tier 0: composite engine output file from Phase 44.
      if (compositePath) {
        try {
          const fileBuf = await fsp.readFile(compositePath);
          thumbBuffer = await sharp(fileBuf)
            .resize(thumbSize, thumbSize, { fit: 'inside' })
            .png()
            .toBuffer();
        } catch (err) {
          warnings.push({
            type: 'thumb_composite_read_error',
            cartId: li.cartId,
            message: err.message,
            path: compositePath,
          });
          // Fall through to tier 1/2/3 below.
        }
      }

      // Tier 1: pre-composed green-screen file from processOrder.
      if (!thumbBuffer && composedPath) {
        try {
          const fileBuf = await fsp.readFile(composedPath);
          thumbBuffer = await sharp(fileBuf)
            .resize(thumbSize, thumbSize, { fit: 'inside' })
            .png()
            .toBuffer();
        } catch (err) {
          warnings.push({
            type: 'thumb_composed_read_error',
            cartId: li.cartId,
            message: err.message,
            path: composedPath,
          });
          // Fall through to tier 2/3 below.
        }
      }

      // Tier 2: on-demand compose for green-screen items.
      // shouldComposite() requires both flags.greenScreen and a
      // backgroundPhoto.fullUrl, so we know we have what we need.
      // Subject source is photo.fullUrl, not thumbUrl, because
      // thumbUrl is heavily compressed (small JPEG) and may have
      // lost the transparency we need for keyed-out subjects.
      if (
        !thumbBuffer &&
        greenscreenService.shouldComposite(li) &&
        li.photo?.fullUrl
      ) {
        try {
          const subjectResp = await fetch(li.photo.fullUrl);
          if (!subjectResp.ok) {
            throw new Error(`Subject fetch HTTP ${subjectResp.status}`);
          }
          const subjectBuffer = Buffer.from(await subjectResp.arrayBuffer());
          const { buffer: composedBuffer, warnings: gsWarnings } =
            await greenscreenService.composeWithBackground(
              subjectBuffer,
              li.backgroundPhoto.fullUrl,
              { outputFormat: 'jpeg', jpegQuality: 85 }
            );
          if (gsWarnings && gsWarnings.length > 0) {
            for (const w of gsWarnings) {
              warnings.push({
                type: 'thumb_greenscreen_' + w.type,
                cartId: li.cartId,
                message: w.message,
              });
            }
          }
          thumbBuffer = await sharp(composedBuffer)
            .resize(thumbSize, thumbSize, { fit: 'inside' })
            .png()
            .toBuffer();
        } catch (err) {
          warnings.push({
            type: 'thumb_greenscreen_error',
            cartId: li.cartId,
            message: err.message,
          });
          // Fall through to tier 3.
        }
      }

      // Tier 3: plain thumbUrl fetch.
      if (!thumbBuffer && thumbUrl) {
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
      } else if (!thumbBuffer && !thumbUrl) {
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
          left: colLeft + 10,
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
          left: colLeft + 10,
          top: itemY,
        });
      }

      // Item text + qty — Phase 59: textX/textWidth derive from the active
      // column rather than the full slip width. In 1-col mode these collapse
      // to the original (colLeft=MARGIN, colWidth=CONTENT_WIDTH) values.
      const textX = colLeft + thumbSize + 25;
      const textWidth = colLeft + colWidth - textX - 10;
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
          `font-weight="bold" fill="#222222">${esc(li.productNameDisplay || 'Unknown Product')}</text>` +
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

      // Inter-row divider: skip when this is the last row in its column
      // (last item overall, OR — in 2-col mode — the last item of column 1).
      const isLastInColumn1 = use2Col && idx === itemsPerCol - 1;
      const isLastOverall = idx === printedItems.length - 1;
      if (!isLastInColumn1 && !isLastOverall) {
        composites.push({
          input: Buffer.from(
            `<svg width="${colWidth - 20}" height="2" xmlns="http://www.w3.org/2000/svg">` +
              `<line x1="0" y1="1" x2="${colWidth - 20}" y2="1" stroke="#eeeeee" stroke-width="1"/></svg>`
          ),
          left: colLeft + 10,
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

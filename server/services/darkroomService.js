// darkroomService.js
//
// Phase 4.2: produces Darkroom-watcher .txt files from canonical Sytist
// orders. The .txt format is shared with photo day (key=value, header
// block + Qty/Size/[Template/]Filepath triplets, LF-terminated). What's
// new here is the input — canonical Sytist order shape with no
// translation layer.
//
// IMPORTANT: nothing in this file gets called from a route in 4.2. The
// preview endpoint asks generateTxtContent() for the rendered string only.
// writeTxtFile() exists, ready for Phase 4.6's "Process this order" button,
// but no public endpoint invokes it. Disk is untouched until 4.6.
//
// Three notable differences from the photo day port:
//
//   1. Reads canonical shape directly: order.orderNumber, order.customer,
//      order.galleryName, lineItem.sku, lineItem.productName, lineItem.qty,
//      lineItem.photo.originalFilename. No PDX-shape adaptation.
//
//   2. Uses flag-based line-item filtering instead of an external
//      specialtyService. Items where flags.booking, flags.giftCert,
//      flags.creditProduct, flags.preSell, or flags.download are true get
//      skipped (and reported as such in the preview). Phase 4.5 will add a
//      specialtyService for SKU-level overrides on top of this.
//
//   3. Three-tier size resolution: explicit SKU mapping → productName parse
//      → 5x8 default. Photo day defaulted to 0x0; Sytist defaults to 5x8
//      because (a) it's the most common print size at the lab and (b) an
//      unmapped item still produces a printable line rather than a 0x0
//      placeholder Darkroom would silently drop.
//
// No external deps — uses built-in fs / path only.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const pathsService = require('./pathsService');

const TEMPLATE_MAPPINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'template-mappings.json'
);
const FILENAME_CONFIG_PATH = path.join(
  __dirname,
  '..',
  'config',
  'filename-config.json'
);
const SIZE_MAPPINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'size-mappings.json'
);

const DEFAULT_SIZE = '5x8';
const DEFAULT_FILENAME_CONFIG = { pattern: '{order_number}', extension: '.txt' };

// Skip line items whose flags say they aren't a print job. These are
// download deliveries, prepayments, gift certs, registration credits,
// pre-sales, and pre-registration placeholders (Phase 64) — none of them
// produce a JPEG that goes to Darkroom.
// Phase 69: coupon — cart_coupon > 0; non-product line, never produces a JPEG.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'preRegister', 'coupon'];

class DarkroomService {
  constructor() {
    this._ensureConfigFiles();
  }

  _ensureConfigFiles() {
    const ensure = (p, defaultValue) => {
      try {
        if (!fs.existsSync(p)) {
          const dir = path.dirname(p);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(p, JSON.stringify(defaultValue, null, 2), 'utf8');
        }
      } catch (err) {
        console.warn(`[Darkroom] Could not ensure ${p}: ${err.message}`);
      }
    };
    ensure(TEMPLATE_MAPPINGS_PATH, { mappings: [] });
    ensure(FILENAME_CONFIG_PATH, DEFAULT_FILENAME_CONFIG);
    ensure(SIZE_MAPPINGS_PATH, { mappings: [] });
  }

  // ─── SIZE MAPPINGS ──────────────────────────────────────

  async getSizeMappings() {
    try {
      const raw = await fsp.readFile(SIZE_MAPPINGS_PATH, 'utf8');
      const data = JSON.parse(raw);
      return data.mappings || [];
    } catch {
      return [];
    }
  }

  async addSizeMapping(mapping) {
    const data = await this._readJson(SIZE_MAPPINGS_PATH, { mappings: [] });
    const externalId = String(mapping.externalId || '').trim();
    if (!externalId) throw new Error('externalId is required');
    if (!mapping.size) throw new Error('size is required');

    const existing = data.mappings.find((m) => m.externalId === externalId);
    if (existing) {
      throw new Error(
        `Size mapping already exists for externalId "${externalId}". Delete or update it.`
      );
    }

    data.mappings.push({
      externalId,
      size: mapping.size,
      productName: mapping.productName || '',
    });
    await this._writeJson(SIZE_MAPPINGS_PATH, data);
    return data.mappings;
  }

  async updateSizeMapping(externalId, updates) {
    const data = await this._readJson(SIZE_MAPPINGS_PATH, { mappings: [] });
    const idx = data.mappings.findIndex(
      (m) => m.externalId === String(externalId)
    );
    if (idx === -1) throw new Error(`Size mapping for "${externalId}" not found`);
    data.mappings[idx] = { ...data.mappings[idx], ...updates, externalId: String(externalId) };
    await this._writeJson(SIZE_MAPPINGS_PATH, data);
    return data.mappings[idx];
  }

  async deleteSizeMapping(externalId) {
    const data = await this._readJson(SIZE_MAPPINGS_PATH, { mappings: [] });
    const before = data.mappings.length;
    data.mappings = data.mappings.filter(
      (m) => m.externalId !== String(externalId)
    );
    if (data.mappings.length === before) {
      throw new Error(`Size mapping for "${externalId}" not found`);
    }
    await this._writeJson(SIZE_MAPPINGS_PATH, data);
    return data.mappings;
  }

  // ─── TEMPLATE MAPPINGS ──────────────────────────────────

  async getTemplateMappings() {
    try {
      const raw = await fsp.readFile(TEMPLATE_MAPPINGS_PATH, 'utf8');
      const data = JSON.parse(raw);
      return data.mappings || [];
    } catch {
      return [];
    }
  }

  async addTemplateMapping(mapping) {
    if (!mapping.templatePath) throw new Error('templatePath is required');

    const data = await this._readJson(TEMPLATE_MAPPINGS_PATH, { mappings: [] });
    const productName = (mapping.productName || '').trim();
    const externalId = mapping.externalId ? String(mapping.externalId).trim() : null;

    if (!productName && !externalId) {
      throw new Error('At least one of productName or externalId is required');
    }

    const existing = data.mappings.find(
      (m) =>
        (externalId && m.externalId === externalId) ||
        (productName && m.productName === productName)
    );
    if (existing) {
      throw new Error(
        `Template mapping already exists for ${externalId || productName}`
      );
    }

    data.mappings.push({
      id: generateId(),
      productName,
      externalId,
      size: mapping.size || null,
      templatePath: mapping.templatePath,
      createdAt: new Date().toISOString(),
    });
    await this._writeJson(TEMPLATE_MAPPINGS_PATH, data);
    return data.mappings;
  }

  async updateTemplateMapping(id, updates) {
    const data = await this._readJson(TEMPLATE_MAPPINGS_PATH, { mappings: [] });
    const idx = data.mappings.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error('Template mapping not found');
    data.mappings[idx] = {
      ...data.mappings[idx],
      ...updates,
      id, // never let an update change the id
      updatedAt: new Date().toISOString(),
    };
    await this._writeJson(TEMPLATE_MAPPINGS_PATH, data);
    return data.mappings[idx];
  }

  async deleteTemplateMapping(id) {
    const data = await this._readJson(TEMPLATE_MAPPINGS_PATH, { mappings: [] });
    const before = data.mappings.length;
    data.mappings = data.mappings.filter((m) => m.id !== id);
    if (data.mappings.length === before) {
      throw new Error('Template mapping not found');
    }
    await this._writeJson(TEMPLATE_MAPPINGS_PATH, data);
    return data.mappings;
  }

  // ─── FILENAME CONFIG ────────────────────────────────────

  async getFilenameConfig() {
    try {
      const raw = await fsp.readFile(FILENAME_CONFIG_PATH, 'utf8');
      return { ...DEFAULT_FILENAME_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_FILENAME_CONFIG };
    }
  }

  async updateFilenameConfig(cfg) {
    const merged = { ...DEFAULT_FILENAME_CONFIG, ...cfg };
    await this._writeJson(FILENAME_CONFIG_PATH, merged);
    return merged;
  }

  /**
   * Build the output filename for an order, applying token replacement.
   * Tokens supported: {order_number}, {first_name}, {last_name}, {gallery},
   * {date}.
   */
  async generateFilename(order) {
    const cfg = await this.getFilenameConfig();
    let filename = cfg.pattern || DEFAULT_FILENAME_CONFIG.pattern;

    const tokens = {
      '{order_number}': order.orderNumber || order.orderId || '',
      '{first_name}': order.customer?.firstName || '',
      '{last_name}': order.customer?.lastName || '',
      '{gallery}': order.galleryName || '',
      '{date}': extractDate(order.orderDate),
    };

    for (const [token, value] of Object.entries(tokens)) {
      filename = filename.split(token).join(String(value));
    }

    // Strip Windows-illegal characters
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
    return filename + (cfg.extension || '.txt');
  }

  // ─── SIZE & TEMPLATE RESOLUTION ─────────────────────────

  /**
   * Three-tier size resolution.
   *   1. Explicit mapping by SKU
   *   2. Parse first NxN out of productName (handles operator-typed
   *      products like "Prints and Downloads > 8x10 Photo")
   *   3. DEFAULT_SIZE (5x8) — the most common print size at the lab so
   *      an unmapped item still produces a usable line.
   *
   * Returns { size, source: 'mapping'|'parsed'|'default', mappedFrom? }.
   * Source is captured so the preview can show operators why a given
   * item got the size it did.
   */
  async resolveSize(lineItem) {
    const sku = String(lineItem.sku || '').trim();
    const productName = lineItem.productName || '';

    if (sku) {
      const mappings = await this.getSizeMappings();
      const match = mappings.find((m) => m.externalId === sku);
      if (match) {
        return { size: match.size, source: 'mapping', mappedFrom: sku };
      }
    }

    if (productName) {
      const m = productName.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
      if (m) {
        return { size: `${m[1]}x${m[2]}`, source: 'parsed' };
      }
    }

    return { size: DEFAULT_SIZE, source: 'default' };
  }

  /**
   * Look up a template path for a line item.
   *   1. Exact match by SKU
   *   2. Exact match by productName
   *   3. Substring match (productName contains mapping.productName)
   * Returns null when nothing matches.
   */
  async resolveTemplate(lineItem) {
    const mappings = await this.getTemplateMappings();
    if (mappings.length === 0) return null;

    const sku = String(lineItem.sku || '').trim();
    if (sku) {
      const match = mappings.find((m) => m.externalId === sku);
      if (match) return match.templatePath;
    }

    const productName = lineItem.productName || '';
    if (productName) {
      let match = mappings.find((m) => m.productName === productName);
      if (match) return match.templatePath;

      const lower = productName.toLowerCase();
      match = mappings.find(
        (m) =>
          m.productName &&
          lower.includes(m.productName.toLowerCase())
      );
      if (match) return match.templatePath;
    }

    return null;
  }

  /**
   * Check that a template path exists on disk. Async-safe and
   * forgiving — if the share is unreachable we'd rather warn than
   * blow up the preview.
   */
  async templateExists(templatePath) {
    if (!templatePath) return false;
    try {
      await fsp.access(templatePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ─── ORDER → TXT BODY (PREVIEW PATH, NO WRITES) ─────────

  /**
   * Heart of the service. Takes a canonical Sytist order, produces:
   *
   *   {
   *     content:    string,                 // the .txt body, ready to write
   *     filename:   string,                 // resolved filename per filename-config
   *     filePath:   string,                 // absolute target path (darkroomTxtBase + sortSegments + filename)
   *     printItems: PrintItem[],            // every line that made it into the txt, in order
   *     skippedItems: SkippedItem[],        // line items dropped for SKIP_FLAGS reasons
   *     warnings: Warning[],                // missing-template, default-size, etc.
   *     packingSlip: { included, position, path }
   *   }
   *
   * Doesn't touch disk. The orchestration layer in 4.6 calls this then
   * (separately) calls writeTxtFile() with the result.
   *
   * Options:
   *   sortSegments        — folder-sort segments to compose into the path
   *                          (passed in by the caller — typically from
   *                          folderSortService.buildOrderPath)
   *   packingSlipPath     — absolute path to a slip image. When present,
   *                          a Qty=1, Size=5x8 line for it is included
   *                          in the txt at the position given by
   *                          slipPosition.
   *   slipPosition        — 'first' (bottom of 5x8 stack) | 'last'
   *                          (top of stack — DEFAULT for Sportsline).
   *   teamScope           — { subGalleryId, subGalleryName }
   *                          When present, only line items belonging to
   *                          this sub-gallery are included. Used by the
   *                          orchestrator for per-team chunks of non-home
   *                          sibling orders. The customer header still
   *                          comes from order.customer (one customer per
   *                          order, regardless of teams).
   *   customerNameOverride — { firstName, lastName }. Same role as photo
   *                          day's bulk-per-dancer flow. Optional.
   */
  async buildOrderTxt(order, options = {}) {
    const {
      sortSegments = [],
      packingSlipPath = null,
      slipPosition = 'last',
      teamScope = null,
      customerNameOverride = null,
    } = options;

    if (!order || !order.orderId) {
      throw new Error('buildOrderTxt requires a canonical-shape order');
    }

    const warnings = [];
    const skippedItems = [];

    // Resolve target directory: darkroomTxtBase + folder-sort segments
    const targetDir = pathsService.resolveFullPath(
      'darkroomTxtBase',
      order,
      sortSegments
    );
    const filename = await this.generateFilename(order);
    const filePath = path.win32.join(targetDir, filename);

    // Resolve image directory the same way (downloadBase) so the Filepath=
    // entries point at where the images will land, not where the txt lands.
    // For Sportsline these are normally the same path, but pathsService keeps
    // them independent so that's not a load-bearing assumption.
    const imageDir = pathsService.resolveFullPath(
      'downloadBase',
      order,
      sortSegments
    );

    // Filter line items
    const sourceLines = order.lineItems || [];
    const printItems = [];

    for (const li of sourceLines) {
      // Team scope filter
      if (teamScope && teamScope.subGalleryId) {
        if (li.subGalleryId !== teamScope.subGalleryId) continue;
      }

      // Flag-based skip
      const skipReason = SKIP_FLAGS.find((flag) => li.flags?.[flag]);
      if (skipReason) {
        skippedItems.push({
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          reason: `flag:${skipReason}`,
        });
        continue;
      }

      // No photo means nothing to print. Preserve as a skip with an
      // explicit reason so operators see why a row didn't make it in.
      if (!li.photo) {
        skippedItems.push({
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          reason: 'no_photo',
        });
        continue;
      }

      const { size, source: sizeSource, mappedFrom } = await this.resolveSize(li);
      if (sizeSource === 'default') {
        warnings.push({
          type: 'unmapped_size',
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          message: `No size mapping for SKU "${li.sku}" and no NxN found in product name. Using default ${DEFAULT_SIZE}.`,
        });
      } else if (sizeSource === 'parsed') {
        warnings.push({
          type: 'parsed_size',
          cartId: li.cartId,
          productName: li.productName,
          sku: li.sku,
          message: `Size ${size} parsed from product name. Add a mapping for SKU "${li.sku}" to make this explicit.`,
        });
      }

      const templatePath = await this.resolveTemplate(li);
      let templateForOutput = null;
      if (templatePath) {
        const exists = await this.templateExists(templatePath);
        if (exists) {
          templateForOutput = templatePath;
        } else {
          warnings.push({
            type: 'missing_template',
            cartId: li.cartId,
            productName: li.productName,
            sku: li.sku,
            templatePath,
            message: `Configured template not found: ${templatePath}. Omitting Template= line.`,
          });
        }
      }

      // Filepath= points at where the image will be on disk after
      // download. originalFilename comes from ms_photos.pic_org and is
      // the canonical filename we'd save to.
      const imageFilename = li.photo.originalFilename ||
        `cart_${li.cartId}_pic.jpg`;
      const imageFilePath = path.win32.join(imageDir, imageFilename);

      printItems.push({
        cartId: li.cartId,
        sku: li.sku,
        productName: li.productName,
        qty: li.qty || 1,
        size,
        sizeSource,
        sizeMappedFrom: mappedFrom || null,
        templatePath: templateForOutput,
        configuredTemplatePath: templatePath || null,
        filePath: imageFilePath,
        subGalleryId: li.subGalleryId || 0,
        subGalleryName: li.subGalleryName || '',
      });
    }

    // Sort: non-5x8 first, then 5x8 group, slip placed within 5x8 group
    // per slipPosition. is5x8Paper matches both '5x8' and '8x5' since
    // both go on the same physical paper at the lab.
    const non5x8 = printItems.filter((p) => !is5x8Paper(p.size));
    const items5x8 = printItems.filter((p) => is5x8Paper(p.size));

    const slipLine = packingSlipPath
      ? {
          cartId: null,
          sku: null,
          productName: '(packing slip)',
          qty: 1,
          size: '5x8',
          sizeSource: 'slip',
          templatePath: null,
          filePath: packingSlipPath,
          isSlip: true,
        }
      : null;

    const orderedItems = [...non5x8];
    if (slipLine) {
      if (slipPosition === 'first') {
        orderedItems.push(slipLine, ...items5x8);
      } else {
        // 'last' — slip is the LAST 5x8 item, prints on top of the stack
        orderedItems.push(...items5x8, slipLine);
      }
    } else {
      orderedItems.push(...items5x8);
    }

    // Header customer name
    const customerName = customerNameOverride
      ? {
          firstName: customerNameOverride.firstName || '',
          lastName: customerNameOverride.lastName || '',
        }
      : {
          firstName: order.customer?.firstName || '',
          lastName: order.customer?.lastName || '',
        };

    // Phase 65: Darkroom-.txt-ONLY — prefix the order number to the last name
    // (e.g. "112376-Simonson") so lab print jobs sort numerically by order
    // number in Darkroom. This is deliberately contained to the value passed
    // into the .txt renderer: order.customer.lastName is NOT mutated, so the
    // packing slip (reads order.shipTo) and ShipStation (billTo reads
    // order.customer, shipTo reads order.shipTo) keep the clean last name with
    // no number. ExtOrderNum below still carries the bare order number too.
    // The divider (buildDividerTxt) calls _renderContent on its own with a
    // synthetic lastName='' and is intentionally NOT prefixed.
    const ordNum = order.orderNumber || order.orderId;
    const content = this._renderContent({
      firstName: customerName.firstName,
      lastName: `${ordNum}-${customerName.lastName || ''}`,
      email: order.customer?.email || '',
      orderNum: ordNum,
      lineItems: orderedItems,
    });

    return {
      content,
      filename,
      filePath,
      targetDir,
      imageDir,
      printItems: orderedItems,
      skippedItems,
      warnings,
      packingSlip: {
        included: Boolean(slipLine),
        position: slipLine ? slipPosition : null,
        path: packingSlipPath || null,
      },
      meta: {
        orderId: order.orderId,
        teamScope: teamScope || null,
        customerOverridden: Boolean(customerNameOverride),
        totalLineItems: sourceLines.length,
        printedLineItems: orderedItems.length,
        skippedLineItems: skippedItems.length,
      },
    };
  }

  /**
   * Pure render — header block + Qty/Size/[Template/]Filepath triplets.
   * LF-terminated to match the Darkroom watcher's expectations and the
   * sample .txt operators have on disk.
   */
  _renderContent({ firstName, lastName, email, orderNum, lineItems }) {
    const lines = [];

    lines.push(`OrderFirstName=${firstName || ''}`);
    lines.push(`OrderLastName=${lastName || ''}`);
    lines.push(`OrderEmail=${email || ''}`);
    lines.push(`ExtOrderNum=${orderNum || ''}`);

    for (const item of lineItems || []) {
      lines.push(`Qty=${item.qty || 1}`);
      lines.push(`Size=${item.size || DEFAULT_SIZE}`);
      if (item.templatePath) {
        lines.push(`Template=${item.templatePath}`);
      }
      lines.push(`Filepath=${item.filePath || ''}`);
    }

    return lines.join('\n');
  }

  // ─── FILE-STABILITY POLLING (FOR PHASE 4.6) ─────────────

  /**
   * Wait until every referenced file path is fully written and stable.
   * "Stable" means: file exists AND its size doesn't change between two
   * stat() calls separated by pollIntervalMs. Catches the race where
   * Darkroom would otherwise open an image still flushing to a network
   * share. Ported verbatim from photo day's darkroomService.
   *
   * Not called by any 4.2 endpoint — exists for 4.6 to use.
   */
  async _waitForFilesStable(filePaths, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30000;
    const pollIntervalMs = opts.pollIntervalMs ?? 250;
    const warnAfterMs = opts.warnAfterMs ?? 5000;
    const start = Date.now();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dedup = Array.from(new Set((filePaths || []).filter(Boolean)));

    let missing = [];
    let unstable = [];
    let warned = false;

    while (Date.now() - start < timeoutMs) {
      missing = [];
      unstable = [];
      const sizes = {};

      for (const p of dedup) {
        try {
          const s = await fsp.stat(p);
          sizes[p] = s.size;
        } catch {
          missing.push(p);
        }
      }

      if (missing.length === 0) {
        await sleep(pollIntervalMs);
        let allStable = true;
        for (const p of dedup) {
          try {
            const s = await fsp.stat(p);
            if (s.size !== sizes[p]) {
              unstable.push(p);
              allStable = false;
            }
          } catch {
            missing.push(p);
            allStable = false;
          }
        }
        if (allStable) {
          return {
            stable: true,
            elapsedMs: Date.now() - start,
            missing: [],
            unstable: [],
          };
        }
      }

      const elapsed = Date.now() - start;
      if (!warned && elapsed > warnAfterMs) {
        console.warn(
          `[Darkroom] Files not yet stable after ${elapsed}ms (${missing.length} missing, ${unstable.length} still writing). Waiting…`
        );
        warned = true;
      }
      await sleep(pollIntervalMs);
    }

    return {
      stable: false,
      elapsedMs: Date.now() - start,
      missing,
      unstable,
    };
  }

  // ─── DISK WRITE (FOR PHASE 4.6) ─────────────────────────

  /**
   * Atomic write: stage to .tmp then rename. Rename is atomic for files in
   * the same directory on Windows + SMB, so the Darkroom watcher either
   * sees the complete .txt or none — never a partial.
   *
   * Not called by any 4.2 endpoint. Phase 4.6's "Process this order"
   * orchestrator will:
   *   const txt = await darkroomService.buildOrderTxt(order, opts);
   *   await darkroomService.writeTxtFile(txt);
   */
  async writeTxtFile(buildResult, options = {}) {
    if (!buildResult || !buildResult.content || !buildResult.filePath) {
      throw new Error(
        'writeTxtFile requires a buildOrderTxt() result with content + filePath'
      );
    }

    const { filePath, content, printItems = [] } = buildResult;
    const tmpPath = filePath + '.tmp';
    const targetDir = path.win32.dirname(filePath);

    await fsp.mkdir(targetDir, { recursive: true });

    // Wait for every referenced image to be stable on disk
    const referencedPaths = printItems
      .map((p) => p.filePath)
      .filter(Boolean);

    if (referencedPaths.length > 0 && options.waitForImages !== false) {
      const stab = await this._waitForFilesStable(referencedPaths, {
        timeoutMs: options.timeoutMs ?? 30000,
        pollIntervalMs: options.pollIntervalMs ?? 250,
        warnAfterMs: options.warnAfterMs ?? 5000,
      });
      if (!stab.stable) {
        const detail = [
          stab.missing.length ? `missing: ${stab.missing.length}` : null,
          stab.unstable.length ? `still-writing: ${stab.unstable.length}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        const err = new Error(
          `Images for order not stable after ${stab.elapsedMs}ms (${detail}). ` +
            `Refusing to write txt — Darkroom would print incomplete output.`
        );
        err.missing = stab.missing;
        err.unstable = stab.unstable;
        throw err;
      }
    }

    await fsp.writeFile(tmpPath, content, 'utf8');
    await fsp.rename(tmpPath, filePath);

    console.log(`[Darkroom] Wrote ${filePath}`);
    return { filePath, filename: buildResult.filename, content };
  }

  // ─── INTERNAL HELPERS ───────────────────────────────────

  async _readJson(p, fallback) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      return JSON.parse(raw);
    } catch {
      return JSON.parse(JSON.stringify(fallback));
    }
  }

  async _writeJson(p, data) {
    await fsp.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ─── module helpers ───────────────────────────────────────

function is5x8Paper(size) {
  if (!size || typeof size !== 'string') return false;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return (a === 5 && b === 8) || (a === 8 && b === 5);
}

function extractDate(orderDate) {
  if (orderDate && typeof orderDate === 'string') {
    const datePart = orderDate.split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return new Date().toISOString().split('T')[0];
}

// Tiny ID generator — avoids pulling in uuid as a dep just for this.
// crypto.randomUUID() is available in Node 14.17+ and ships built-in.
function generateId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

module.exports = new DarkroomService();
module.exports.DEFAULT_SIZE = DEFAULT_SIZE;
module.exports.SKIP_FLAGS = SKIP_FLAGS;

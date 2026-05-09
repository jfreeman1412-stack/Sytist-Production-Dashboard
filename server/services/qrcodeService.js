// qrcodeService.js
//
// Phase 4.6: generates batch QR sheets for the production scan workflow.
// Each sheet is 8.5"×11" at 300 DPI with up to 20 QR codes (4 cols × 5
// rows), each encoding an order number with a label below it.
//
// Operators print these sheets and scan each QR at the production
// station as they pull the corresponding order's bag from the stack.
// This creates a fast batch-process workflow when working through 100+
// orders for a gallery.
//
// Direct port of photo day's qrcodeService with `../config` removed
// (Sytist uses pathsService for output paths instead of a global config).
//
// Three flavors matching the rest of Phase 4:
//
//   buildSheetBuffer(items, options)
//     → Buffer (a single sheet, max 20 items)
//
//   buildSheets(items, options)
//     → Array of { sheetNumber, itemCount, buffer } — paginates auto
//
//   writeSheets(items, outputDir, options)
//     → Disk-write convenience used by the orchestrator's batch flow
//
// items[] shape: { data: 'orderNumber', label: 'displayLabel' }
//   data  = string encoded into the QR
//   label = text shown below the QR (defaults to data)

const QRCode = require('qrcode');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

const SHEET_WIDTH_INCHES = 8.5;
const SHEET_HEIGHT_INCHES = 11;
const COLS = 4;
const ROWS = 5;
const MAX_PER_SHEET = COLS * ROWS;

class QRCodeService {
  /**
   * Generate a single QR code as a PNG buffer.
   */
  async generateQRCode(data, options = {}) {
    const size = options.size || 200;
    return QRCode.toBuffer(String(data || ''), {
      type: 'png',
      width: size,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Build one 8.5×11 sheet of QR codes. Items beyond MAX_PER_SHEET are
   * silently dropped — call buildSheets() for auto-pagination.
   *
   * Returns: { buffer, dpi, dimensions: { width, height }, count }
   */
  async buildSheetBuffer(items, options = {}) {
    const dpi = options.dpi || 300;
    const pageWidth = Math.round(SHEET_WIDTH_INCHES * dpi);
    const pageHeight = Math.round(SHEET_HEIGHT_INCHES * dpi);
    const margin = Math.round(0.5 * dpi);

    const usableWidth = pageWidth - 2 * margin;
    const usableHeight = pageHeight - 2 * margin;
    const cellWidth = Math.floor(usableWidth / COLS);
    const cellHeight = Math.floor(usableHeight / ROWS);

    // Leave room for the label below the QR
    const qrSize =
      Math.min(cellWidth, cellHeight) - Math.round(0.4 * dpi);

    const itemsToProcess = (items || []).slice(0, MAX_PER_SHEET);
    const composites = [];

    for (let i = 0; i < itemsToProcess.length; i++) {
      const item = itemsToProcess[i];
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      const x = margin + col * cellWidth + Math.floor((cellWidth - qrSize) / 2);
      const y = margin + row * cellHeight;

      const qrBuffer = await this.generateQRCode(item.data, { size: qrSize });
      composites.push({ input: qrBuffer, top: y, left: x });

      // Label below the QR
      const labelText = item.label || item.data || '';
      const fontSize = Math.round(dpi * 0.12);
      const labelSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${Math.round(dpi * 0.3)}">` +
          `<text x="${cellWidth / 2}" y="${fontSize + 5}" text-anchor="middle" ` +
          `font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#000000">` +
          escapeXml(labelText) +
          `</text></svg>`
      );
      composites.push({
        input: labelSvg,
        top: y + qrSize + Math.round(dpi * 0.05),
        left: margin + col * cellWidth,
      });
    }

    const buffer = await sharp({
      create: {
        width: pageWidth,
        height: pageHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    return {
      buffer,
      dpi,
      dimensions: { width: pageWidth, height: pageHeight },
      count: itemsToProcess.length,
    };
  }

  /**
   * Auto-paginate. Returns array of sheet results for any number of items.
   */
  async buildSheets(items, options = {}) {
    const sheets = [];
    const all = items || [];
    for (let i = 0; i < all.length; i += MAX_PER_SHEET) {
      const chunk = all.slice(i, i + MAX_PER_SHEET);
      const result = await this.buildSheetBuffer(chunk, options);
      sheets.push({
        sheetNumber: Math.floor(i / MAX_PER_SHEET) + 1,
        itemCount: chunk.length,
        ...result,
      });
    }
    return sheets;
  }

  /**
   * Disk-write convenience: paginate items, write each sheet to outputDir
   * with filename qr-sheet-N.png. Returns metadata about every file.
   *
   * Used by the orchestrator's batch flow when QR-sheet generation is
   * requested.
   */
  async writeSheets(items, outputDir, options = {}) {
    if (!outputDir) {
      throw new Error('writeSheets requires an outputDir');
    }
    await fsp.mkdir(outputDir, { recursive: true });

    const sheets = await this.buildSheets(items, options);
    const savedFiles = [];

    for (const sheet of sheets) {
      const filename = `qr-sheet-${sheet.sheetNumber}.png`;
      const filePath = path.win32.join(outputDir, filename);
      const tmpPath = filePath + '.tmp';
      await fsp.writeFile(tmpPath, sheet.buffer);
      await fsp.rename(tmpPath, filePath);
      savedFiles.push({
        filename,
        filePath,
        sheetNumber: sheet.sheetNumber,
        itemCount: sheet.itemCount,
      });
      console.log(`[QRCode] Wrote ${filePath}`);
    }

    return {
      totalSheets: sheets.length,
      totalItems: (items || []).length,
      files: savedFiles,
    };
  }
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = new QRCodeService();
module.exports.MAX_PER_SHEET = MAX_PER_SHEET;

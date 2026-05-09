// teamDividerService.js
//
// Phase 4.3: produces a 5×8 @ 300 DPI JPG team-divider sheet — used as a
// physical separator between team stacks in batch print runs so the lab
// person knows where each team starts. NOT included in customer bags;
// it's strictly a workflow aid for sorting prints off the printer.
//
// Direct port of photo day's teamDividerService with two changes:
//   1. Build/write split (buildDividerBuffer / writeDividerFile) to match
//      the rest of the Phase 4 services, so the preview endpoint can
//      stream the buffer back as image/jpeg without any disk write.
//   2. Inputs are pure primitives (teamName + options) rather than a PDX
//      order — divider doesn't need to know about the order shape.
//
// Layout:
//
//   ┌───────────────────────────────────┐
//   │█████████████████████████████████  │  ← black banner (0–240)
//   │                  TEAM             │     "TEAM" in white caps
//   │█████████████████████████████████  │
//   │                                   │
//   │                                   │
//   │           VARSITY                 │  ← team name, big black caps
//   │                                   │     (auto-sized to fit width)
//   │      3 customers • 12 items       │  ← optional sub-line
//   │                                   │
//   │                                   │
//   │     Lincoln HS Football 2025      │  ← optional gallery line, italic gray
//   │█████████████████████████████████  │  ← black banner (bottom)
//   └───────────────────────────────────┘

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

const pathsService = require('./pathsService');

const DIVIDER_WIDTH = 1500;
const DIVIDER_HEIGHT = 2400;

class TeamDividerService {
  /**
   * Build a divider JPG buffer. Returns everything the caller needs to
   * either stream it or save it.
   *
   * @param {string} teamName - e.g. "Varsity", "10U Black-Brian"
   * @param {object} [options]
   * @param {string} [options.galleryName] - small italic line at the bottom
   * @param {number} [options.itemCount]   - subline component
   * @param {number} [options.customerCount] - subline component
   * @param {object} [options.order] - optional canonical order, used only
   *                  to resolve a target output path (downloadBase + sortSegments).
   *                  Pass null to skip path resolution (caller will write
   *                  to its own path).
   * @param {string[]} [options.sortSegments] - passed to pathsService when order is given
   * @param {string} [options.filenameSuffix] - inserted before .jpg
   *
   * Returns: { buffer, filename, filePath?, meta }
   *   filePath is only present when `options.order` is provided.
   */
  async buildDividerBuffer(teamName, options = {}) {
    const { galleryName, itemCount, customerCount, order, sortSegments, filenameSuffix = '' } = options;

    const safeName = sanitizeFilename(teamName || 'TEAM');
    const filename = `_DIVIDER_${safeName}${filenameSuffix}.jpg`;

    let filePath = null;
    let targetDir = null;
    if (order) {
      targetDir = pathsService.resolveFullPath(
        'downloadBase',
        order,
        sortSegments || []
      );
      filePath = path.win32.join(targetDir, filename);
    }

    const subLineParts = [];
    if (customerCount != null) {
      subLineParts.push(`${customerCount} customer${customerCount === 1 ? '' : 's'}`);
    }
    if (itemCount != null) {
      subLineParts.push(`${itemCount} item${itemCount === 1 ? '' : 's'}`);
    }
    const subLine = subLineParts.join(' • ');

    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" viewBox="0 0 ${DIVIDER_WIDTH} ${DIVIDER_HEIGHT}">` +
        `<rect x="0" y="0" width="${DIVIDER_WIDTH}" height="${DIVIDER_HEIGHT}" fill="#ffffff"/>` +
        // top banner
        `<rect x="0" y="0" width="${DIVIDER_WIDTH}" height="240" fill="#1a1a1a"/>` +
        `<text x="${DIVIDER_WIDTH / 2}" y="160" font-family="Arial Black, Arial, sans-serif" font-size="120" ` +
        `font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="20">TEAM</text>` +
        // bottom banner
        `<rect x="0" y="${DIVIDER_HEIGHT - 240}" width="${DIVIDER_WIDTH}" height="240" fill="#1a1a1a"/>` +
        // team name (centered)
        renderTeamName(teamName, DIVIDER_WIDTH / 2, DIVIDER_HEIGHT / 2) +
        // sub-line
        (subLine
          ? `<text x="${DIVIDER_WIDTH / 2}" y="${DIVIDER_HEIGHT / 2 + 220}" font-family="Arial, sans-serif" ` +
            `font-size="70" fill="#444444" text-anchor="middle">${esc(subLine)}</text>`
          : '') +
        // gallery (italic, smaller, bottom)
        (galleryName
          ? `<text x="${DIVIDER_WIDTH / 2}" y="${DIVIDER_HEIGHT - 130}" font-family="Arial, sans-serif" ` +
            `font-size="60" fill="#cccccc" text-anchor="middle" font-style="italic">${esc(galleryName)}</text>`
          : '') +
      `</svg>`;

    const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();

    return {
      buffer,
      filename,
      filePath,
      targetDir,
      meta: {
        width: DIVIDER_WIDTH,
        height: DIVIDER_HEIGHT,
        dpi: 300,
        teamName: teamName || '',
        galleryName: galleryName || '',
        itemCount: itemCount ?? null,
        customerCount: customerCount ?? null,
      },
    };
  }

  /**
   * Write a built divider buffer to its target path. Atomic .tmp+rename.
   * Used by the /preview/save endpoint and by Phase 4.6's orchestrator.
   */
  async writeDividerFile(buildResult) {
    if (!buildResult || !buildResult.buffer || !buildResult.filePath) {
      throw new Error(
        'writeDividerFile requires a buildDividerBuffer() result with buffer + filePath'
      );
    }
    const targetDir = path.win32.dirname(buildResult.filePath);
    await fsp.mkdir(targetDir, { recursive: true });
    const tmpPath = buildResult.filePath + '.tmp';
    await fsp.writeFile(tmpPath, buildResult.buffer);
    await fsp.rename(tmpPath, buildResult.filePath);
    console.log(`[TeamDivider] Wrote ${buildResult.filePath}`);
    return { filePath: buildResult.filePath, filename: buildResult.filename };
  }
}

// ─── helpers ─────────────────────────────────────────────

/**
 * Render the team name as one line, auto-sized to fit ~1300px of the
 * 1500px-wide canvas. Conservative char-width estimate for Arial Black.
 */
function renderTeamName(teamName, cx, cy) {
  const name = String(teamName || '').trim() || 'UNKNOWN';
  const escaped = esc(name);
  const maxWidth = 1300;
  const charWidthRatio = 0.6;
  const idealSize = Math.floor(maxWidth / Math.max(name.length, 1) / charWidthRatio);
  const fontSize = Math.max(100, Math.min(320, idealSize));
  return (
    `<text x="${cx}" y="${cy + fontSize / 3}" font-family="Arial Black, Arial, sans-serif" ` +
    `font-size="${fontSize}" font-weight="900" fill="#1a1a1a" text-anchor="middle">${escaped}</text>`
  );
}

function esc(s) {
  return String(s == null ? '' : s)
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

module.exports = new TeamDividerService();
module.exports.DIVIDER_WIDTH = DIVIDER_WIDTH;
module.exports.DIVIDER_HEIGHT = DIVIDER_HEIGHT;

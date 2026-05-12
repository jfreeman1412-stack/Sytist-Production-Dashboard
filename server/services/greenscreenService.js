// server/services/greenscreenService.js
//
// Phase 17: composites a transparent (green-screened) subject over a
// downloaded background.
//
// The Sytist data model marks green-screen line items with
// cart_photo_bg > 0, which sytistDbService surfaces as:
//   - flags.greenScreen: true
//   - backgroundPhoto: { fullUrl, ... }  — the chosen background image
//
// The "subject" image is already a PNG with transparency (Sytist keys
// it before storage). The background is a regular JPG.
//
// COMPOSITING RULES (per Joey, 2026-05-12):
//   - Background fills the entire output canvas, subject on top.
//   - Background is sized with sharp's fit:'cover' equivalent:
//     stretched to fully cover the subject's dimensions while
//     preserving the background's aspect ratio. No blank pixels.
//     Any overflow is cropped symmetrically.
//
// FAILURE BEHAVIOR:
//   - If the background URL is missing or fetch fails, the original
//     subject buffer is returned and a warning is logged. The order
//     keeps processing — a subject-only image is better than no
//     image at all.

const sharp = require('sharp');

class GreenscreenService {
  /**
   * Composite a transparent subject over a downloaded background.
   *
   * @param {Buffer} subjectBuffer  Transparent PNG (keyed-out subject)
   * @param {string} backgroundUrl  HTTPS URL of the background image
   * @param {object} options
   * @param {string} [options.outputFormat='jpeg']  'jpeg' or 'png'
   * @param {number} [options.jpegQuality=92]
   * @returns {Promise<{ buffer: Buffer, warnings: Array<{type, message}> }>}
   */
  async composeWithBackground(subjectBuffer, backgroundUrl, options = {}) {
    const warnings = [];
    const outputFormat = options.outputFormat || 'jpeg';
    const jpegQuality = options.jpegQuality || 92;

    if (!subjectBuffer || !Buffer.isBuffer(subjectBuffer)) {
      throw new Error('composeWithBackground requires a Buffer for subject');
    }

    // Get the subject's dimensions — we'll size the background to match.
    let subjectMeta;
    try {
      subjectMeta = await sharp(subjectBuffer).metadata();
    } catch (err) {
      throw new Error(`Could not read subject image metadata: ${err.message}`);
    }
    const { width: sw, height: sh } = subjectMeta;
    if (!sw || !sh) {
      throw new Error('Subject image has no dimensions');
    }

    // If no background URL, return the subject as-is. Caller decides
    // whether that's a warning or expected.
    if (!backgroundUrl) {
      warnings.push({
        type: 'background_url_missing',
        message: 'Green-screen line has no background URL — using subject only',
      });
      return {
        buffer: await this._toOutput(subjectBuffer, outputFormat, jpegQuality),
        warnings,
      };
    }

    // Fetch background. If it fails, fall back to subject-only.
    let backgroundBuffer;
    try {
      const resp = await fetch(backgroundUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const ab = await resp.arrayBuffer();
      backgroundBuffer = Buffer.from(ab);
    } catch (err) {
      warnings.push({
        type: 'background_fetch_failed',
        message: `Could not fetch background from ${backgroundUrl}: ${err.message} — using subject only`,
      });
      return {
        buffer: await this._toOutput(subjectBuffer, outputFormat, jpegQuality),
        warnings,
      };
    }

    // Resize background to subject dimensions using cover semantics —
    // matches CSS background-size: cover. Background fills the entire
    // canvas, aspect ratio preserved, overflow cropped on the long
    // axis. No blank pixels.
    let resizedBackground;
    try {
      resizedBackground = await sharp(backgroundBuffer)
        .resize(sw, sh, {
          fit: 'cover',
          position: 'center',
        })
        .toBuffer();
    } catch (err) {
      warnings.push({
        type: 'background_resize_failed',
        message: `Could not resize background: ${err.message} — using subject only`,
      });
      return {
        buffer: await this._toOutput(subjectBuffer, outputFormat, jpegQuality),
        warnings,
      };
    }

    // Composite: subject on top of background at (0,0).
    let composedBuffer;
    try {
      const pipeline = sharp(resizedBackground).composite([
        { input: subjectBuffer, top: 0, left: 0 },
      ]);
      composedBuffer =
        outputFormat === 'png'
          ? await pipeline.png().toBuffer()
          : await pipeline.jpeg({ quality: jpegQuality }).toBuffer();
    } catch (err) {
      throw new Error(`Composite failed: ${err.message}`);
    }

    return { buffer: composedBuffer, warnings };
  }

  /**
   * Internal: re-encode a buffer to the requested output format.
   * Fallback path when no background available.
   */
  async _toOutput(buffer, format, jpegQuality) {
    if (format === 'png') {
      return sharp(buffer).png().toBuffer();
    }
    return sharp(buffer)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: jpegQuality })
      .toBuffer();
  }

  /**
   * Used by callers to decide whether to invoke composeWithBackground.
   * Returns true only if all the required fields are present.
   */
  shouldComposite(lineItem) {
    return !!(
      lineItem &&
      lineItem.flags &&
      lineItem.flags.greenScreen &&
      lineItem.backgroundPhoto &&
      lineItem.backgroundPhoto.fullUrl
    );
  }
}

module.exports = new GreenscreenService();

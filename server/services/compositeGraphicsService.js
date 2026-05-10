// compositeGraphicsService.js
//
// Phase 9c — per-layout static graphic storage.
//
// Composite layouts can include "Static Graphic" slots (kind:
// staticGraphic, formerly overlay). Each slot references a graphic
// by KEY, and the actual image file lives at:
//
//   server/config/composite-graphics/<layoutId>/<key>.<ext>
//
// The layout JSON tracks which keys exist and their filenames in a
// `graphics` map:
//
//   layout.graphics = {
//     "frame-1":   { filename: "frame-1.png",  mimeType: "image/png",  uploadedAt: "..." },
//     "sponsor":   { filename: "sponsor.jpg",  mimeType: "image/jpeg", uploadedAt: "..." }
//   }
//
// The two storage layers (layout JSON + on-disk file) need to stay in
// sync, so all CRUD goes through this service rather than touching
// either layer directly.
//
// Per-layout (vs server-global): different layouts have independent
// graphics. Multiple slots within one layout CAN share a graphic by
// referencing the same key — e.g. vertical and horizontal variants of
// a frame both reference "frame-1".
//
// Atomic writes: same .tmp + rename pattern as gallery-assets so a
// crash mid-write doesn't leave a corrupt file. Max size 10MB
// (configurable, matches gallery-assets ceiling for logos).
//
// MIME types: only PNG and JPG. Sniffed from the first few bytes of
// the file rather than trusting the extension or claimed MIME.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg'];

// Magic-byte sniffing — don't trust filename or claimed MIME
function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  return null;
}

// Sanitize a key/layoutId for safe filesystem use. Keys are user-input
// so we can't just trust them. Letters, digits, hyphens, underscores
// only. Length capped to keep paths reasonable.
function isValidKey(s) {
  return (
    typeof s === 'string' &&
    s.length >= 1 &&
    s.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(s)
  );
}

class CompositeGraphicsService {
  constructor(opts = {}) {
    this.baseDir =
      opts.baseDir ||
      path.join(__dirname, '..', 'config', 'composite-graphics');
  }

  _layoutDir(layoutId) {
    if (!isValidKey(layoutId)) {
      throw new Error(
        `Invalid layoutId: must be alphanumeric, hyphen, or underscore (1-64 chars)`
      );
    }
    return path.join(this.baseDir, layoutId);
  }

  async _ensureLayoutDir(layoutId) {
    const dir = this._layoutDir(layoutId);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Save a graphic file for a layout under a given key.
   * Returns metadata { filename, mimeType, sizeBytes, uploadedAt }
   * that the caller should store in layout.graphics[key].
   *
   * If a graphic already exists at this key, it's overwritten.
   * That's intentional — operators can swap out a graphic by
   * re-uploading at the same key.
   */
  async saveGraphic({ layoutId, key, fileBuffer, uploadedBy }) {
    if (!isValidKey(layoutId)) {
      throw new Error('Invalid layoutId');
    }
    if (!isValidKey(key)) {
      throw new Error(
        `Invalid key "${key}": must be alphanumeric, hyphen, or underscore (1-64 chars)`
      );
    }
    if (!Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer must be a Buffer');
    }
    if (fileBuffer.length === 0) {
      throw new Error('Empty file');
    }
    if (fileBuffer.length > MAX_SIZE_BYTES) {
      throw new Error(
        `File too large: ${fileBuffer.length} bytes exceeds ${MAX_SIZE_BYTES} byte limit`
      );
    }
    const mime = sniffMimeType(fileBuffer);
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      throw new Error(
        `Unsupported file type — only PNG and JPG are accepted`
      );
    }

    const ext = extensionForMime(mime);
    const filename = `${key}.${ext}`;
    const dir = await this._ensureLayoutDir(layoutId);

    // Atomic write — write to .tmp then rename. If the same key has a
    // different extension already (e.g. was PNG, now JPG), remove the
    // old file too so we don't leave orphans.
    const targetPath = path.join(dir, filename);
    const tmpPath = targetPath + '.tmp';
    await fsp.writeFile(tmpPath, fileBuffer);
    await fsp.rename(tmpPath, targetPath);

    // Cleanup: if the OTHER extension's file exists from a previous
    // upload, delete it
    for (const otherExt of ['png', 'jpg']) {
      if (otherExt === ext) continue;
      const otherPath = path.join(dir, `${key}.${otherExt}`);
      try {
        await fsp.unlink(otherPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }

    return {
      filename,
      mimeType: mime,
      sizeBytes: fileBuffer.length,
      uploadedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || null,
    };
  }

  /**
   * Read a graphic's file contents as a buffer. Returns null if the
   * file doesn't exist.
   *
   * The layout JSON's graphics map is the source of truth for "does
   * this key exist?" — but readers may pass in either the key alone
   * or the full filename from the layout JSON. We try the JSON-mapped
   * filename first, then fall back to "<key>.png" then "<key>.jpg".
   */
  async readGraphicBuffer({ layoutId, key, filename }) {
    if (!isValidKey(layoutId) || !isValidKey(key)) return null;
    const dir = this._layoutDir(layoutId);

    const candidates = [];
    if (filename) candidates.push(path.join(dir, filename));
    candidates.push(path.join(dir, `${key}.png`));
    candidates.push(path.join(dir, `${key}.jpg`));

    for (const p of candidates) {
      try {
        const buf = await fsp.readFile(p);
        return buf;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return null;
  }

  /**
   * Stream-friendly access for HTTP responses. Returns
   * { stream, mimeType, sizeBytes } or null.
   */
  async openGraphicStream({ layoutId, key, filename }) {
    if (!isValidKey(layoutId) || !isValidKey(key)) return null;
    const dir = this._layoutDir(layoutId);

    const candidates = [];
    if (filename) {
      candidates.push({
        path: path.join(dir, filename),
        mime: filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      });
    }
    candidates.push({
      path: path.join(dir, `${key}.png`),
      mime: 'image/png',
    });
    candidates.push({
      path: path.join(dir, `${key}.jpg`),
      mime: 'image/jpeg',
    });

    for (const c of candidates) {
      try {
        const stat = await fsp.stat(c.path);
        if (stat.isFile()) {
          return {
            stream: fs.createReadStream(c.path),
            mimeType: c.mime,
            sizeBytes: stat.size,
          };
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return null;
  }

  /**
   * Delete the file(s) for a graphic key. The caller is responsible
   * for also removing the entry from layout.graphics — this only
   * removes the file from disk.
   */
  async deleteGraphicFile({ layoutId, key }) {
    if (!isValidKey(layoutId) || !isValidKey(key)) return false;
    const dir = this._layoutDir(layoutId);
    let removed = false;
    for (const ext of ['png', 'jpg']) {
      const p = path.join(dir, `${key}.${ext}`);
      try {
        await fsp.unlink(p);
        removed = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return removed;
  }

  /**
   * Delete the entire graphics directory for a layout. Called when
   * the layout itself is deleted.
   */
  async deleteLayoutGraphics(layoutId) {
    if (!isValidKey(layoutId)) return false;
    const dir = this._layoutDir(layoutId);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  /**
   * List all graphics-on-disk for a layout. Returns
   * [{ key, filename, sizeBytes, mimeType }]. Useful for verifying
   * that the layout JSON's graphics map matches what's on disk.
   */
  async listGraphicsOnDisk(layoutId) {
    if (!isValidKey(layoutId)) return [];
    const dir = this._layoutDir(layoutId);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const n of names) {
      if (n.endsWith('.tmp')) continue;
      const full = path.join(dir, n);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = path.extname(n).toLowerCase();
      const key = path.basename(n, ext);
      const mimeType =
        ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : null;
      if (!mimeType) continue;
      out.push({
        key,
        filename: n,
        sizeBytes: stat.size,
        mimeType,
      });
    }
    return out;
  }
}

const singleton = new CompositeGraphicsService();
module.exports = singleton;
module.exports.CompositeGraphicsService = CompositeGraphicsService;
module.exports.MAX_SIZE_BYTES = MAX_SIZE_BYTES;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;

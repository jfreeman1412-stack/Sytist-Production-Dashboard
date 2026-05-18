// orderAssetOverrideService.js
//
// Phase 50 — Per-order, per-cart, per-slot image upload overrides.
//
// Operators occasionally need to replace the photo a composite slot
// would render — wrong subject tagged, customer requested a different
// pose, etc. Before Phase 50 the fix was indirect: rename the photo
// in Sytist, or edit the underlying layout. Phase 50 adds direct
// per-order image override via the override editor.
//
// Storage layout:
//
//   server/config/order-asset-overrides/<orderId>/<cartId>/<slotIndex>.<ext>
//
// Slot index is the position in the layout snapshot's variants[variant].slots
// array. Snapshot semantics (Phase 11) guarantee slot indices are stable
// per (orderId, cartId), so index is a safe identifier.
//
// The snapshot stores a slot.overrideImage object with filename + URL +
// metadata; this service handles the on-disk side. The client uploads via
// POST, fetches via GET (for live canvas preview), and unlinks via DELETE.
// renderOverrideForOrder reads from disk directly via this service to
// build the buffer for compositeService.buildSheetBuffer.
//
// Path safety: every read, write, unlink, and rmdir uses path.resolve +
// startsWith(BASE + path.sep) so no orderId/cartId/slotIndex value (all
// of which are validated as integers anyway, belt-and-suspenders) can
// escape the BASE directory.
//
// MIME validation: magic-byte sniff, not filename extension. PNG, JPEG,
// WebP only. SVG explicitly blocked (XSS surface for <img>). Filename
// stored on disk is server-derived (`<slotIndex>.<verified-ext>`),
// never trusted from the upload.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ELIGIBLE_SLOT_KINDS = [
  'playerPhoto',
  'teamPhoto',
  'logo',
  'playerBackground',
];

// Magic-byte sniffing. Don't trust filename ext or claimed MIME.
//   PNG:  89 50 4E 47
//   JPEG: FF D8 FF
//   WebP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP) at offset 8
function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return null;
}

function mimeForExtension(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

// Strict integer validation — orderId & slotIndex must be non-negative
// integers. Reject anything else BEFORE any path construction so a
// malicious "../" or null-byte string can't sneak in.
function isPositiveInt(n) {
  return Number.isInteger(n) && n >= 0 && n < 1e12;
}

// Phase 56: cartId is an OPAQUE string, not an integer — package
// constituents and addons have synthetic IDs ("483036-pkg-27",
// "483036-addon-69516"). It still must be safe as a SINGLE directory
// segment under order-asset-overrides/, so allow only [A-Za-z0-9_-]
// (which covers plain ints, -pkg-, -addon- and nothing path-escaping:
// no dots, slashes, colons, null bytes). Bounded length. This is the
// per-segment guard; _safeResolve still does the resolve+startsWith
// containment check as defense in depth.
function isSafeCartId(c) {
  if (c == null) return false;
  const s = String(c);
  return s.length >= 1 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

class OrderAssetOverrideService {
  constructor(opts = {}) {
    this.baseDir =
      opts.baseDir ||
      path.join(__dirname, '..', 'config', 'order-asset-overrides');
    // Resolve to absolute, canonical form once at construction so all
    // startsWith() checks compare against a stable, normalized prefix.
    this._baseAbs = path.resolve(this.baseDir);
  }

  // Resolve a sub-path and assert it stays inside the base directory.
  // Throws on any escape attempt. Used by every disk operation.
  _safeResolve(...segments) {
    const candidate = path.resolve(this._baseAbs, ...segments);
    if (
      candidate !== this._baseAbs &&
      !candidate.startsWith(this._baseAbs + path.sep)
    ) {
      throw new Error(
        `Path escape attempt: resolved path is outside the asset base`
      );
    }
    return candidate;
  }

  _cartDir(orderId, cartId) {
    if (!isPositiveInt(orderId) || !isSafeCartId(cartId)) {
      throw new Error('Invalid orderId or cartId');
    }
    return this._safeResolve(String(orderId), String(cartId));
  }

  _orderDir(orderId) {
    if (!isPositiveInt(orderId)) {
      throw new Error('Invalid orderId');
    }
    return this._safeResolve(String(orderId));
  }

  // Save an asset. Validates size + magic bytes + slot index. Returns
  // metadata the caller should record on slot.overrideImage in the
  // layout snapshot.
  //
  // Atomic write via .tmp rename. If a previous upload at this slot
  // index used a different extension, the orphan file is removed so
  // we don't accumulate dead variants.
  async saveAsset({ orderId, cartId, slotIndex, fileBuffer, uploadedBy }) {
    if (!isPositiveInt(slotIndex)) {
      throw new Error('Invalid slotIndex');
    }
    if (!Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer must be a Buffer');
    }
    if (fileBuffer.length === 0) {
      throw new Error('Empty file');
    }
    if (fileBuffer.length > MAX_SIZE_BYTES) {
      throw new Error(
        `File too large: ${fileBuffer.length} bytes exceeds ${MAX_SIZE_BYTES} byte limit (10 MB). Resize the image before uploading.`
      );
    }
    const mime = sniffMimeType(fileBuffer);
    if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
      throw new Error(
        `Unsupported file type — only PNG, JPEG, and WebP are accepted. SVG and other formats are blocked.`
      );
    }

    const ext = extensionForMime(mime);
    const filename = `${slotIndex}.${ext}`;
    const dir = this._cartDir(orderId, cartId);
    await fsp.mkdir(dir, { recursive: true });

    const targetPath = this._safeResolve(
      String(orderId),
      String(cartId),
      filename
    );
    const tmpPath = targetPath + '.tmp';
    await fsp.writeFile(tmpPath, fileBuffer);
    await fsp.rename(tmpPath, targetPath);

    // Cleanup: if the SAME slot index had a different extension from a
    // previous upload, unlink the orphan. Iterate all known extensions
    // except the one just written.
    for (const otherExt of ['png', 'jpg', 'webp']) {
      if (otherExt === ext) continue;
      const otherPath = this._safeResolve(
        String(orderId),
        String(cartId),
        `${slotIndex}.${otherExt}`
      );
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
      ext,
    };
  }

  // Read an asset buffer for the renderer. Returns null when the file
  // doesn't exist — caller falls back to default resolution path. Tries
  // each allowed extension since the snapshot's stored filename may not
  // match disk reality (e.g., backup restore mismatch).
  async readAssetBuffer({ orderId, cartId, slotIndex, filename }) {
    if (
      !isPositiveInt(orderId) ||
      !isSafeCartId(cartId) ||
      !isPositiveInt(slotIndex)
    ) {
      return null;
    }
    const candidates = [];
    if (filename && /^\d+\.(png|jpg|webp)$/.test(filename)) {
      candidates.push(filename);
    }
    for (const ext of ['png', 'jpg', 'webp']) {
      const f = `${slotIndex}.${ext}`;
      if (!candidates.includes(f)) candidates.push(f);
    }
    for (const f of candidates) {
      try {
        const p = this._safeResolve(String(orderId), String(cartId), f);
        const buf = await fsp.readFile(p);
        return { buffer: buf, mimeType: mimeForExtension(f.split('.').pop()) };
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return null;
  }

  // Stream-friendly access for HTTP GET. Returns { stream, mimeType,
  // sizeBytes } or null. Same candidate-list pattern as readAssetBuffer.
  async openAssetStream({ orderId, cartId, slotIndex, filename }) {
    if (
      !isPositiveInt(orderId) ||
      !isSafeCartId(cartId) ||
      !isPositiveInt(slotIndex)
    ) {
      return null;
    }
    const candidates = [];
    if (filename && /^\d+\.(png|jpg|webp)$/.test(filename)) {
      candidates.push(filename);
    }
    for (const ext of ['png', 'jpg', 'webp']) {
      const f = `${slotIndex}.${ext}`;
      if (!candidates.includes(f)) candidates.push(f);
    }
    for (const f of candidates) {
      try {
        const p = this._safeResolve(String(orderId), String(cartId), f);
        const stat = await fsp.stat(p);
        if (stat.isFile()) {
          return {
            stream: fs.createReadStream(p),
            mimeType: mimeForExtension(f.split('.').pop()),
            sizeBytes: stat.size,
          };
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return null;
  }

  // Delete a single slot's asset file(s). Returns true if anything was
  // removed, false if nothing existed. Iterates all extension variants
  // because we don't trust the snapshot's recorded filename to match
  // disk reality.
  async deleteAsset({ orderId, cartId, slotIndex }) {
    if (
      !isPositiveInt(orderId) ||
      !isSafeCartId(cartId) ||
      !isPositiveInt(slotIndex)
    ) {
      return false;
    }
    let removed = false;
    for (const ext of ['png', 'jpg', 'webp']) {
      const p = this._safeResolve(
        String(orderId),
        String(cartId),
        `${slotIndex}.${ext}`
      );
      try {
        await fsp.unlink(p);
        removed = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return removed;
  }

  // Wipe the entire per-cart asset directory. Called by the override
  // DELETE handler so a removed override doesn't leave orphan files.
  // Best-effort: ENOENT is fine (nothing to clean up).
  async deleteCartAssets(orderId, cartId) {
    if (!isPositiveInt(orderId) || !isSafeCartId(cartId)) return false;
    const dir = this._cartDir(orderId, cartId);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    // Best-effort: try to remove the now-possibly-empty orderId parent
    // so we don't leave empty dirs behind. Failure is fine (parent might
    // still have other cart dirs from other cart-line overrides in the
    // same order).
    try {
      const orderDir = this._orderDir(orderId);
      const remaining = await fsp.readdir(orderDir);
      if (remaining.length === 0) {
        await fsp.rmdir(orderDir);
      }
    } catch {}
    return true;
  }
}

const singleton = new OrderAssetOverrideService();
module.exports = singleton;
module.exports.OrderAssetOverrideService = OrderAssetOverrideService;
module.exports.MAX_SIZE_BYTES = MAX_SIZE_BYTES;
module.exports.ALLOWED_MIME_TYPES = ALLOWED_MIME_TYPES;
module.exports.ELIGIBLE_SLOT_KINDS = ELIGIBLE_SLOT_KINDS;

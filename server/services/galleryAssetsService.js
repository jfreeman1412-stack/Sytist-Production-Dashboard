// galleryAssetsService.js
//
// Phase 8a: registry of app-owned visual assets used by composites.
// Currently manages two asset types:
//
//   - logos: per-gallery, for the "logo top-left" slot in memory mates
//   - overlays: shared across galleries, for graphic frames/borders
//
// Why app-owned (vs. paths on the Z: share):
//   Joey's explicit requirement — logos must not be vulnerable to
//   "moved or renamed" failure modes. Storing them inside the app's
//   config dir means they:
//     1. Get backed up with the dashboard
//     2. Travel with deployment tarballs (if you choose)
//     3. Can't be silently broken by Windows file moves on the share
//
// Storage:
//   server/config/gallery-assets.json
//     - galleries: { [galleryId]: { logoFilename, uploadedAt, uploadedBy } }
//     - overlays: [ { id, name, filename, uploadedAt, uploadedBy } ]
//
//   server/config/gallery-assets/logos/{filename}     — actual logo bytes
//   server/config/gallery-assets/overlays/{filename}  — actual overlay bytes
//
// Filename strategy:
//   Uploads are renamed deterministically. Logos: `gallery-{galleryId}-{ext}`.
//   Overlays: `overlay-{slug}-{ext}` with a numeric suffix to avoid
//   collisions. This means uploading a new logo for a gallery overwrites
//   the old one — intentional, since each gallery has exactly one logo.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'gallery-assets.json');
const LOGOS_DIR = path.join(__dirname, '..', 'config', 'gallery-assets', 'logos');
const OVERLAYS_DIR = path.join(
  __dirname,
  '..',
  'config',
  'gallery-assets',
  'overlays'
);

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

class GalleryAssetsService {
  constructor() {
    this._ensure();
  }

  _ensure() {
    try {
      for (const dir of [
        path.dirname(CONFIG_PATH),
        path.join(path.dirname(CONFIG_PATH), 'gallery-assets'),
        LOGOS_DIR,
        OVERLAYS_DIR,
      ]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(
          CONFIG_PATH,
          JSON.stringify({ galleries: {}, overlays: [] }, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(
        `[GalleryAssets] Could not ensure config dir: ${err.message}`
      );
    }
  }

  async _read() {
    try {
      const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        galleries: parsed.galleries || {},
        overlays: Array.isArray(parsed.overlays) ? parsed.overlays : [],
      };
    } catch {
      return { galleries: {}, overlays: [] };
    }
  }

  async _write(data) {
    const tmp = CONFIG_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, CONFIG_PATH);
  }

  // ─── Logos ────────────────────────────────────────────

  /**
   * Upload (or replace) a logo for a gallery.
   *
   * @param {object} opts
   * @param {number} opts.galleryId   The Sytist gallery (date_id)
   * @param {Buffer} opts.fileBuffer  The raw image bytes
   * @param {string} opts.filename    Original filename (we use the extension)
   * @param {string} opts.uploadedBy  Username for audit trail
   *
   * Returns the recorded logo entry.
   */
  async setLogo({ galleryId, fileBuffer, filename, uploadedBy }) {
    if (!galleryId || galleryId <= 0) {
      throw new Error('galleryId is required');
    }
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer is required (must be a Buffer)');
    }
    if (fileBuffer.length > MAX_FILE_BYTES) {
      throw new Error(
        `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_BYTES})`
      );
    }
    const ext = path.extname(filename || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Unsupported file extension "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      );
    }

    const storedFilename = `gallery-${galleryId}${ext}`;
    const fullPath = path.join(LOGOS_DIR, storedFilename);

    // If a logo with a DIFFERENT extension exists for this gallery,
    // delete it so we don't end up with two logos
    try {
      const entries = await fsp.readdir(LOGOS_DIR);
      for (const entry of entries) {
        if (
          entry.startsWith(`gallery-${galleryId}.`) &&
          entry !== storedFilename
        ) {
          try {
            await fsp.unlink(path.join(LOGOS_DIR, entry));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* no existing logos dir, no cleanup needed */
    }

    // Atomic write
    const tmp = fullPath + '.tmp';
    await fsp.writeFile(tmp, fileBuffer);
    await fsp.rename(tmp, fullPath);

    const data = await this._read();
    data.galleries[galleryId] = {
      logoFilename: storedFilename,
      uploadedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || null,
      sizeBytes: fileBuffer.length,
    };
    await this._write(data);

    console.log(
      `[GalleryAssets] Logo set for gallery ${galleryId} → ${storedFilename}`
    );
    return { galleryId, ...data.galleries[galleryId] };
  }

  /**
   * Returns metadata for a gallery's logo, or null if not set.
   */
  async getLogo(galleryId) {
    if (!galleryId) return null;
    const data = await this._read();
    return data.galleries[galleryId] || null;
  }

  /**
   * Returns the absolute filesystem path to a gallery's logo, or null
   * if not set or the file is missing on disk. Used by compositeService
   * at render time.
   */
  async getLogoPath(galleryId) {
    const meta = await this.getLogo(galleryId);
    if (!meta || !meta.logoFilename) return null;
    const fullPath = path.join(LOGOS_DIR, meta.logoFilename);
    try {
      await fsp.access(fullPath);
      return fullPath;
    } catch {
      // Recorded in config but file gone (e.g. someone deleted from disk)
      console.warn(
        `[GalleryAssets] Logo recorded but file missing: ${fullPath}`
      );
      return null;
    }
  }

  /**
   * Returns the raw bytes of a gallery's logo. Convenience for the
   * settings UI's preview / download. Returns null if not set or
   * missing.
   */
  async readLogoBuffer(galleryId) {
    const fullPath = await this.getLogoPath(galleryId);
    if (!fullPath) return null;
    return fsp.readFile(fullPath);
  }

  async deleteLogo(galleryId) {
    if (!galleryId) throw new Error('galleryId is required');
    const data = await this._read();
    const meta = data.galleries[galleryId];
    if (!meta) return { deleted: false, reason: 'not_set' };

    const fullPath = path.join(LOGOS_DIR, meta.logoFilename);
    try {
      await fsp.unlink(fullPath);
    } catch (err) {
      // File may already be gone — that's ok, we still want to clear
      // the registry entry
      console.warn(`[GalleryAssets] Logo file unlink: ${err.message}`);
    }

    delete data.galleries[galleryId];
    await this._write(data);
    return { deleted: true };
  }

  /**
   * Returns the full registry of logo assignments.
   * Shape: { [galleryId]: { logoFilename, uploadedAt, uploadedBy, sizeBytes } }
   */
  async listLogos() {
    const data = await this._read();
    return data.galleries;
  }

  // ─── Overlays ─────────────────────────────────────────

  /**
   * Upload a new overlay (graphic frame / border PNG that gets layered
   * onto memory mates). Unlike logos, overlays are addressed by ID
   * rather than per-gallery.
   */
  async addOverlay({ name, fileBuffer, filename, uploadedBy }) {
    if (!name || !name.trim()) throw new Error('overlay name is required');
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer is required (Buffer)');
    }
    if (fileBuffer.length > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${fileBuffer.length} bytes`);
    }
    const ext = path.extname(filename || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported extension "${ext}"`);
    }

    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'overlay';
    const id = `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const storedFilename = `${id}-${slug}${ext}`;
    const fullPath = path.join(OVERLAYS_DIR, storedFilename);

    const tmp = fullPath + '.tmp';
    await fsp.writeFile(tmp, fileBuffer);
    await fsp.rename(tmp, fullPath);

    const data = await this._read();
    const entry = {
      id,
      name: name.trim(),
      filename: storedFilename,
      uploadedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || null,
      sizeBytes: fileBuffer.length,
    };
    data.overlays.push(entry);
    await this._write(data);

    console.log(`[GalleryAssets] Overlay added: ${id} (${name})`);
    return entry;
  }

  async deleteOverlay(id) {
    const data = await this._read();
    const entry = data.overlays.find((o) => o.id === id);
    if (!entry) return { deleted: false, reason: 'not_found' };

    const fullPath = path.join(OVERLAYS_DIR, entry.filename);
    try {
      await fsp.unlink(fullPath);
    } catch (err) {
      console.warn(`[GalleryAssets] Overlay unlink: ${err.message}`);
    }
    data.overlays = data.overlays.filter((o) => o.id !== id);
    await this._write(data);
    return { deleted: true };
  }

  async getOverlay(id) {
    const data = await this._read();
    return data.overlays.find((o) => o.id === id) || null;
  }

  async getOverlayPath(id) {
    const entry = await this.getOverlay(id);
    if (!entry) return null;
    const fullPath = path.join(OVERLAYS_DIR, entry.filename);
    try {
      await fsp.access(fullPath);
      return fullPath;
    } catch {
      return null;
    }
  }

  async readOverlayBuffer(id) {
    const fullPath = await this.getOverlayPath(id);
    if (!fullPath) return null;
    return fsp.readFile(fullPath);
  }

  async listOverlays() {
    const data = await this._read();
    return data.overlays;
  }

  // ─── Diagnostics ──────────────────────────────────────

  async getStats() {
    const data = await this._read();
    return {
      logoCount: Object.keys(data.galleries).length,
      overlayCount: data.overlays.length,
      logosDir: LOGOS_DIR,
      overlaysDir: OVERLAYS_DIR,
      configPath: CONFIG_PATH,
      maxFileBytes: MAX_FILE_BYTES,
      allowedExtensions: ALLOWED_EXTENSIONS,
    };
  }
}

module.exports = new GalleryAssetsService();
module.exports.LOGOS_DIR = LOGOS_DIR;
module.exports.OVERLAYS_DIR = OVERLAYS_DIR;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;

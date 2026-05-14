// server/services/photoThumbService.js
//
// Phase 49: server-side resize proxy for Sytist photo thumbnails.
//
// The dashboard's line item cards previously rendered `photo.fullUrl`
// as the tile thumbnail (Phase 12 — un-watermarked but original
// resolution). For non-composite, non-green-screen items that meant
// downloading 6–10 MB images to display at 150×150 px. Page load on
// a 30-item order took 30+ seconds.
//
// This service serves a small resized JPEG from a disk-backed cache:
//   1. Hash the (source URL + target width) into a filename.
//   2. If the cache file exists, read + return it. Touch mtime so the
//      sweep TTL doesn't evict actively-used entries.
//   3. Otherwise, fetch the source URL, resize with sharp, write the
//      cache file, return the buffer.
//   4. On source-fetch failure, return the pre-baked placeholder
//      (a small "Photo unavailable" tile) so the page doesn't show
//      broken image icons or shift layout.
//
// CACHE LOCATION
//
// `server/config/photo-cache/` relative to this service, via
// path.join(__dirname, '..', 'config', 'photo-cache'). Portable —
// works the same on Windows and Linux (path.join uses the platform-
// native separator). The directory must be on local fast disk; if
// relocated to a network share or slow tier, mtime touches and reads
// add measurable latency to every page load.
//
// SOURCE URL VALIDATION
//
// Sytist photos are hosted on S3 buckets (see
// sytistDbService._photoRowToShape: baseUrl is built from
// `pic_amazon_endpoint`/`pic_bucket`/`pic_bucket_folder`). The proxy
// accepts:
//   - https: protocol only
//   - hostname ending in `.amazonaws.com`
//   - pathname ending in `.jpg`/`.jpeg`/`.png`/`.webp` (case-insensitive)
// Anything else returns the placeholder + logs the rejection. This is
// a defense-in-depth check against the proxy being abused as a generic
// open fetcher. The auth middleware on the route is the primary gate.
//
// CLEANUP
//
// TTL-based sweep, 60-day default, called once per ~24h by
// schedulerService. Files with mtime older than TTL are deleted.
// mtime is touched on cache-hit reads so popular photos stay alive
// while orphaned ones age out. No size cap in v1 — at typical volume
// (~50 KB per cached thumb × hundreds of orders × dozens of items)
// disk usage stays under 1 GB indefinitely. If pressure ever shows
// up, layer a size cap on top.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const CACHE_DIR = path.join(__dirname, '..', 'config', 'photo-cache');
const PLACEHOLDER_FILENAME = '_placeholder.jpg';
const DEFAULT_WIDTH = 400;
const MAX_WIDTH = 800;
// Sytist S3 fetches on cold-loaded photos are sometimes wildly slow
// — measured 944 ms one run, 230 s the next for the same 7 MB photo
// over the same connection. Set the timeout high enough to accommodate
// the bad case rather than serving placeholders for legitimate but
// slow sources. After first fetch the cache hit is sub-ms, so the
// big timeout only bites once per (orderId, cartId, width).
const FETCH_TIMEOUT_MS = 60_000;
const ALLOWED_EXT_RE = /\.(jpe?g|png|webp)$/i;
const ALLOWED_HOST_SUFFIX = '.amazonaws.com';

class PhotoThumbService {
  constructor() {
    this._placeholderBuffer = null;
    this._initPromise = null;
  }

  // Idempotent. Creates the cache dir and the placeholder file if
  // they don't already exist. Safe to call multiple times.
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const placeholderPath = path.join(CACHE_DIR, PLACEHOLDER_FILENAME);
      try {
        this._placeholderBuffer = await fsp.readFile(placeholderPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        this._placeholderBuffer = await this._generatePlaceholder();
        await fsp.writeFile(placeholderPath, this._placeholderBuffer);
        console.log(
          `[PhotoThumb] Generated placeholder at ${placeholderPath}`
        );
      }
    })();
    return this._initPromise;
  }

  // Returns { buffer, fromCache, isPlaceholder } — the JPEG bytes
  // plus diagnostic flags. Never throws on source failure; returns
  // the placeholder buffer with isPlaceholder=true instead.
  async getOrCreate(src, width) {
    await this.init();
    const w = this._normalizeWidth(width);

    if (!this._isValidSource(src)) {
      console.warn(`[PhotoThumb] Rejected source URL: ${src}`);
      return { buffer: this._placeholderBuffer, fromCache: false, isPlaceholder: true };
    }

    const cachePath = this._cachePath(src, w);
    // Cache hit?
    try {
      const buf = await fsp.readFile(cachePath);
      // Touch mtime so the sweep TTL doesn't evict hot entries.
      const now = new Date();
      fsp.utimes(cachePath, now, now).catch(() => {});
      return { buffer: buf, fromCache: true, isPlaceholder: false };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[PhotoThumb] Cache read error (non-fatal): ${e.message}`);
      }
    }

    // Cache miss — fetch + resize + write.
    let sourceBuffer;
    try {
      sourceBuffer = await this._fetchSource(src);
    } catch (e) {
      console.warn(`[PhotoThumb] Source fetch failed for ${src}: ${e.message}`);
      return { buffer: this._placeholderBuffer, fromCache: false, isPlaceholder: true };
    }

    let resized;
    try {
      resized = await sharp(sourceBuffer)
        .resize({
          width: w,
          height: w,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (e) {
      console.warn(`[PhotoThumb] Resize failed for ${src}: ${e.message}`);
      return { buffer: this._placeholderBuffer, fromCache: false, isPlaceholder: true };
    }

    // Write atomically: tmp + rename. Skipping the rename if it fails
    // is fine — we still return the buffer; next request will retry.
    const tmpPath = cachePath + '.tmp';
    try {
      await fsp.writeFile(tmpPath, resized);
      await fsp.rename(tmpPath, cachePath);
    } catch (e) {
      console.warn(`[PhotoThumb] Cache write failed (non-fatal): ${e.message}`);
      // Cleanup tmp if it exists
      fsp.unlink(tmpPath).catch(() => {});
    }

    return { buffer: resized, fromCache: false, isPlaceholder: false };
  }

  // Sweep: delete cache files with mtime older than maxAgeDays.
  // Skips the placeholder. Hard time cap (default 30s) so an
  // overgrown cache doesn't block the scheduler indefinitely;
  // resumes next tick.
  async sweep({ maxAgeDays = 60, maxDurationMs = 30_000 } = {}) {
    await this.init();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const start = Date.now();
    let scanned = 0;
    let deleted = 0;
    let bytesFreed = 0;

    let entries;
    try {
      entries = await fsp.readdir(CACHE_DIR);
    } catch (e) {
      console.warn(`[PhotoCache] Sweep readdir failed: ${e.message}`);
      return { scanned: 0, deleted: 0, bytesFreed: 0, durationMs: 0, abortedByTimeout: false };
    }

    let abortedByTimeout = false;
    for (const name of entries) {
      if (name === PLACEHOLDER_FILENAME) continue;
      if (!name.endsWith('.jpg')) continue;
      if (Date.now() - start > maxDurationMs) {
        abortedByTimeout = true;
        break;
      }
      scanned += 1;
      const full = path.join(CACHE_DIR, name);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        try {
          await fsp.unlink(full);
          deleted += 1;
          bytesFreed += stat.size;
        } catch (e) {
          console.warn(`[PhotoCache] Sweep unlink failed for ${name}: ${e.message}`);
        }
      }
    }
    const durationMs = Date.now() - start;
    console.log(
      `[PhotoCache] swept ${scanned} files, freed ${(bytesFreed / 1024 / 1024).toFixed(1)} MB (${deleted} deleted, ${durationMs}ms${abortedByTimeout ? ', aborted by timeout' : ''})`
    );
    return { scanned, deleted, bytesFreed, durationMs, abortedByTimeout };
  }

  // ─── Internal helpers ────────────────────────────────────

  _normalizeWidth(w) {
    const n = parseInt(w, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WIDTH;
    return Math.min(n, MAX_WIDTH);
  }

  _isValidSource(src) {
    if (typeof src !== 'string' || src.length === 0) return false;
    let url;
    try {
      url = new URL(src);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (!url.hostname.endsWith(ALLOWED_HOST_SUFFIX)) return false;
    if (!ALLOWED_EXT_RE.test(url.pathname)) return false;
    return true;
  }

  _cachePath(src, width) {
    const key = crypto
      .createHash('sha1')
      .update(`${src}|${width}`)
      .digest('hex');
    return path.join(CACHE_DIR, `${key}.jpg`);
  }

  async _fetchSource(src) {
    // Note: deliberately NOT passing AbortSignal to fetch. Node's
    // fetch (as of v22) has a quirk where an AbortController whose
    // signal is attached to fetch will cause resp.arrayBuffer() to
    // hang forever after the body finishes — even when the signal
    // never fires. Verified empirically: same URL with no signal
    // completes in <1s, with signal hangs at body-read indefinitely.
    // Promise.race is the workaround — the fetch keeps running in
    // the background after timeout and gets GC'd, which is fine for
    // a 10s ceiling.
    const fetchPromise = (async () => {
      const resp = await fetch(src);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    })();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`)),
        FETCH_TIMEOUT_MS
      )
    );
    return Promise.race([fetchPromise, timeoutPromise]);
  }

  // One-time generator for the "Photo unavailable" tile. Sharp's
  // composite API draws a centered SVG label onto a gray background.
  // Output is ~3 KB.
  async _generatePlaceholder() {
    const w = DEFAULT_WIDTH;
    const labelSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}">
        <rect width="100%" height="100%" fill="#2a2a2a"/>
        <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="22"
              fill="#aaa" text-anchor="middle" dominant-baseline="middle">
          Photo unavailable
        </text>
      </svg>`
    );
    return await sharp(labelSvg).jpeg({ quality: 70 }).toBuffer();
  }
}

module.exports = new PhotoThumbService();

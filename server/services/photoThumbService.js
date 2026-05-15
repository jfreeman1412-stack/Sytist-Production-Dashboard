// server/services/photoThumbService.js
//
// Phase 49 v2: server-side resize proxy for Sytist photo thumbnails.
//
// The dashboard's line item card tiles render `photo.fullUrl` (the
// un-watermarked original, per Phase 12a) as the `<img src>`. Sytist
// hosts those originals on S3 at full resolution — 6–10 MB per
// photo. A 30-item order downloads 200–300 MB just to display 30
// 150-px tiles. Page load reached "up to a minute" in production
// (verified in DevTools by Joey, 2026-05-14).
//
// This service serves a small resized JPEG from a disk-backed cache:
//
//   1. Hash (source URL + target width) into a filename.
//   2. If the cache file exists, read + return it. Touch mtime so
//      the sweep TTL doesn't evict actively-used entries.
//   3. Otherwise: fetch the source, resize with sharp, write the
//      cache file atomically, return the buffer.
//   4. On source-fetch failure: return the pre-baked placeholder
//      ("Photo unavailable" tile) so the page doesn't show broken
//      image icons or shift layout.
//
// CACHE LOCATION
//
// `server/config/photo-cache/` relative to this service, via
// path.join(__dirname, '..', 'config', 'photo-cache'). Portable —
// path.join uses the platform-native separator on Windows and
// Linux. Must be on local fast disk; network shares add filesystem
// latency to every cache hit.
//
// SOURCE URL VALIDATION (SSRF protection)
//
// Sytist photos are S3-hosted (sytistDbService._photoRowToShape
// builds the URL from pic_amazon_endpoint/pic_bucket/pic_bucket_folder).
// isValidSource accepts only URLs where:
//   - protocol is https:
//   - hostname is exact-match in ALLOWED_HOSTS (env-configurable)
//   - no credentials embedded (user:pass@host)
//   - no query string
//   - no fragment
//   - pathname ends in a safe image extension
//   - pathname has no '..' or '//' (traversal protection)
// AND the fetch itself uses redirect:'error' so a 3xx from S3 to
// a different host can't slip past the validation.
//
// CLEANUP
//
// TTL-based sweep, 60-day default, called once per ~24h by
// schedulerService piggybacking on the SS-poll tick. Files with
// mtime older than TTL are deleted. mtime is touched on cache-hit
// reads so popular photos stay alive. 30-second hard time cap on
// the sweep so an overgrown cache doesn't block the scheduler.
// No size cap in v1.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const CACHE_DIR = path.join(__dirname, '..', 'config', 'photo-cache');
const PLACEHOLDER_FILENAME = '_placeholder.jpg';
const DEFAULT_WIDTH = 400;
const MAX_WIDTH = 800;

// Phase 49 v2: 20 seconds. The pathological 230s S3 case we observed
// during diagnosis was a single outlier — most slow fetches resolve
// in 5-15s. 20s captures realistic slow paths without holding an
// Express worker for a fetch the operator has already given up on.
// Placeholder has Cache-Control: max-age=60, so the operator's next
// refresh ~1 minute later will retry and likely succeed.
const FETCH_TIMEOUT_MS = 20_000;

// Phase 49 v2: SSRF allowlist. Sytist photos all come from the AWS
// dualstack S3 endpoint today. Configurable via env in case Sytist
// migrates endpoints — don't widen the matcher in code.
const ALLOWED_HOSTS = (process.env.PHOTO_PROXY_ALLOWED_HOSTS
  || 's3.dualstack.us-east-1.amazonaws.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_EXT_RE = /\.(jpe?g|png|webp)$/i;

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

  // Returns { buffer, format, fromCache, isPlaceholder }.
  //   - format: 'jpeg' or 'webp' — caller uses this to set
  //     Content-Type. WebP for transparent sources (alpha preserved),
  //     JPEG for opaque (smaller).
  //   - Never throws on source failure; returns the placeholder
  //     buffer (always JPEG) with isPlaceholder=true instead.
  //
  // Phase 49 v2.2: format is decided AFTER fetch by probing
  // sharp.metadata().hasAlpha — ground truth, not a URL-extension
  // guess. Cache lookup tries `<key>.webp` then `<key>.jpg`;
  // whichever exists wins.
  async getOrCreate(src, width) {
    await this.init();
    const w = this._normalizeWidth(width);

    if (!this._isValidSource(src)) {
      console.warn(`[PhotoThumb] Rejected source URL: ${src}`);
      return { buffer: this._placeholderBuffer, format: 'jpeg', fromCache: false, isPlaceholder: true };
    }

    const key = this._cacheKey(src, w);
    const webpPath = path.join(CACHE_DIR, `${key}.webp`);
    const jpegPath = path.join(CACHE_DIR, `${key}.jpg`);

    // Cache lookup: try webp first, then jpeg. Two readFile attempts
    // is fine — ENOENT is fast. Same URL always produces same hash,
    // so at most one of the two files exists in steady state.
    for (const [tryPath, tryFormat] of [
      [webpPath, 'webp'],
      [jpegPath, 'jpeg'],
    ]) {
      try {
        const buf = await fsp.readFile(tryPath);
        // Touch mtime so the sweep TTL doesn't evict hot entries.
        const now = new Date();
        fsp.utimes(tryPath, now, now).catch(() => {});
        return { buffer: buf, format: tryFormat, fromCache: true, isPlaceholder: false };
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn(`[PhotoThumb] Cache read error (non-fatal): ${e.message}`);
        }
      }
    }

    // Cache miss — fetch the source.
    let sourceBuffer;
    try {
      sourceBuffer = await this._fetchSource(src);
    } catch (e) {
      console.warn(`[PhotoThumb] Source fetch failed for ${src}: ${e.message}`);
      return { buffer: this._placeholderBuffer, format: 'jpeg', fromCache: false, isPlaceholder: true };
    }

    // Phase 49 v2.2: probe alpha via sharp.metadata() — reads only
    // the header bytes, cheap. hasAlpha is the ground truth.
    // URL-extension inference (v2.1) was unreliable for Sytist's
    // photo URLs and let the regression back in.
    let format = 'jpeg';
    try {
      const meta = await sharp(sourceBuffer).metadata();
      if (meta.hasAlpha) format = 'webp';
    } catch (e) {
      // Metadata probe failed — the resize step below will also
      // fail and serve placeholder. Fall through with jpeg default.
      console.warn(`[PhotoThumb] Metadata probe failed for ${src}: ${e.message}`);
    }

    let resized;
    try {
      const pipeline = sharp(sourceBuffer).resize({
        width: w,
        height: w,
        fit: 'inside',
        withoutEnlargement: true,
      });
      resized = await (
        format === 'webp'
          ? pipeline.webp({ quality: 80 })
          : pipeline.jpeg({ quality: 80 })
      ).toBuffer();
    } catch (e) {
      console.warn(`[PhotoThumb] Resize failed for ${src}: ${e.message}`);
      return { buffer: this._placeholderBuffer, format: 'jpeg', fromCache: false, isPlaceholder: true };
    }

    // Write to the format-specific path. Atomic: tmp + rename.
    const writePath = format === 'webp' ? webpPath : jpegPath;
    const tmpPath = writePath + '.tmp';
    try {
      await fsp.writeFile(tmpPath, resized);
      await fsp.rename(tmpPath, writePath);
    } catch (e) {
      console.warn(`[PhotoThumb] Cache write failed (non-fatal): ${e.message}`);
      fsp.unlink(tmpPath).catch(() => {});
    }

    return { buffer: resized, format, fromCache: false, isPlaceholder: false };
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
      // Phase 49 v2.1: handle both .jpg (opaque sources) and .webp
      // (transparent PNG sources, alpha-preserved).
      if (!name.endsWith('.jpg') && !name.endsWith('.webp')) continue;
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

  // Phase 49 v2 — SSRF validation. URL parsing only, exact-host
  // allowlist, no query string / fragment / credentials, safe
  // extension, no traversal. The fetch step adds redirect:'error'
  // for defense-in-depth.
  _isValidSource(src) {
    if (typeof src !== 'string' || src.length === 0) return false;
    let url;
    try {
      url = new URL(src);
    } catch {
      return false; // unparseable
    }
    // HTTPS only — no http:, no file:, no data:, no javascript:
    if (url.protocol !== 'https:') return false;
    // Hostname must be EXACTLY in the allowlist. Not endsWith —
    // that would let evil-amazonaws.com or amazonaws.com.attacker.tld
    // squeak through. URL constructor canonicalizes hostname
    // (lowercases, strips trailing dot) so direct includes() is safe.
    if (!ALLOWED_HOSTS.includes(url.hostname)) return false;
    // No credentials embedded in the URL
    if (url.username !== '' || url.password !== '') return false;
    // No query string. Sytist photo URLs don't have them.
    if (url.search !== '') return false;
    // No fragment
    if (url.hash !== '') return false;
    // Path must be a safe image extension
    if (!ALLOWED_EXT_RE.test(url.pathname)) return false;
    // Path traversal / weird separator stuffing. URL constructor
    // normalizes most of these but be explicit.
    if (url.pathname.includes('..')) return false;
    if (url.pathname.includes('//')) return false;
    return true;
  }

  // Phase 49 v2.2: return just the hash key (no extension). Format
  // is determined at write time from the source's actual alpha
  // channel, not from URL inference. Cache lookup tries both
  // <key>.webp and <key>.jpg variants.
  //
  // The URL-extension-based inference in v2.1 turned out to be
  // unreliable: Sytist serves transparent green-screen subject
  // photos at URLs that don't end in .png, so the inference
  // defaulted to JPEG and killed the alpha. v2.2 switches to
  // sharp.metadata().hasAlpha as the ground truth.
  _cacheKey(src, width) {
    return crypto
      .createHash('sha1')
      .update(`${src}|${width}`)
      .digest('hex');
  }

  async _fetchSource(src) {
    // Phase 49 v2:
    //   - redirect:'error' so S3 can't redirect us to a host outside
    //     the SSRF allowlist (fetch throws on 3xx).
    //   - Promise.race for the timeout, NOT AbortSignal — Node 22's
    //     fetch has a bug where signal:controller.signal causes
    //     resp.arrayBuffer() to hang indefinitely after headers
    //     arrive (verified empirically Phase 49 v1). The orphaned
    //     fetch on Promise.race timeout gets GC'd.
    const fetchPromise = (async () => {
      const resp = await fetch(src, { redirect: 'error' });
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

  // One-time generator for the "Photo unavailable" tile. Sharp
  // composites a centered SVG label onto a dark background. ~2-3 KB.
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

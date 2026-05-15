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
  //     Content-Type. WebP is produced for PNG sources (which may
  //     have transparency, like Sytist's green-screen keyed-out
  //     subjects); JPEG for everything else (smaller for opaque).
  //   - Never throws on source failure; returns the placeholder
  //     buffer (always JPEG) with isPlaceholder=true instead.
  async getOrCreate(src, width) {
    await this.init();
    const w = this._normalizeWidth(width);

    if (!this._isValidSource(src)) {
      console.warn(`[PhotoThumb] Rejected source URL: ${src}`);
      return { buffer: this._placeholderBuffer, format: 'jpeg', fromCache: false, isPlaceholder: true };
    }

    const { path: cachePath, format } = this._cachePath(src, w);
    // Cache hit?
    try {
      const buf = await fsp.readFile(cachePath);
      // Touch mtime so the sweep TTL doesn't evict hot entries.
      const now = new Date();
      fsp.utimes(cachePath, now, now).catch(() => {});
      return { buffer: buf, format, fromCache: true, isPlaceholder: false };
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
      return { buffer: this._placeholderBuffer, format: 'jpeg', fromCache: false, isPlaceholder: true };
    }

    let resized;
    try {
      // Phase 49 v2.1: conditional output format. PNG sources may
      // be transparent (Sytist's green-screen keyed-out subjects).
      // JPEG output flattens transparency against black, which
      // broke green-screen tile display in v2 — the player photo
      // covered the background `<img>` with a black rectangle.
      // WebP preserves alpha and is significantly smaller than PNG.
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

    // Write atomically: tmp + rename.
    const tmpPath = cachePath + '.tmp';
    try {
      await fsp.writeFile(tmpPath, resized);
      await fsp.rename(tmpPath, cachePath);
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

  // Phase 49 v2.1: pick output format based on source URL extension.
  // PNG sources MAY have transparency (Sytist green-screen subjects
  // are keyed-out transparent PNGs). Output WebP for those to
  // preserve alpha — JPEG flattening against black is what broke v2.
  // Everything else (JPEG, WebP source) is treated as opaque and
  // gets JPEG output for size.
  //
  // Determining format from URL extension (not from sharp.metadata)
  // keeps the cache lookup a single readFile against a deterministic
  // path. Probing alpha would require fetching the source before
  // deciding the cache filename — defeats the cache.
  _inferOutputFormat(src) {
    try {
      const u = new URL(src);
      const ext = path.extname(u.pathname).toLowerCase();
      return ext === '.png' ? 'webp' : 'jpeg';
    } catch {
      return 'jpeg';
    }
  }

  _cachePath(src, width) {
    const format = this._inferOutputFormat(src);
    // Hash key doesn't include format because format is derived
    // deterministically from src (same URL → same extension → same
    // format). The filename extension serves as the format hint
    // for sweep + the response Content-Type.
    const key = crypto
      .createHash('sha1')
      .update(`${src}|${width}`)
      .digest('hex');
    return {
      path: path.join(CACHE_DIR, `${key}.${format === 'webp' ? 'webp' : 'jpg'}`),
      format,
    };
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

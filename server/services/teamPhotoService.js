// teamPhotoService.js
//
// Phase 8a: locates team photos in Sytist for memory-mate composites.
//
// The discovery rule (verified against live data):
//   - ms_blog_photos.bp_pl = <teamPhotoListId>   (default 268, configurable)
//   - ms_blog_photos.bp_sub = <subGalleryId>     (the order's team)
//   - LIMIT 1
//
// This is purely a structural lookup — no filename matching, no
// orientation discrimination at the WHERE level. Sytist's price list
// assignment is the authoritative discriminator: a photo is a team
// photo if the operator has assigned it to the team-photo price list.
//
// We DO record orientation as a sanity check on the result. If a
// matched team photo turns out to be portrait-oriented (rare —
// composites are designed for horizontal team photos), we surface that
// as a warning rather than silently returning the wrong image.
//
// The teamPhotoListId is configurable in Settings because:
//   - Different installations / studios may use a different ID
//   - Sytist admin may renumber lists in the future
//   - Future: support multiple list IDs (e.g. "team photos OR team
//     panos" depending on the SKU)
//
// Caching: results are cached per-process for 60 seconds. Memory mates
// often process in batches that all reference the same gallery; caching
// avoids hammering the DB with duplicate queries.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const SETTINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'team-photo-settings.json'
);

const DEFAULT_SETTINGS = {
  teamPhotoListId: 268,
  // If the matched team photo is portrait-oriented, treat as a soft
  // warning rather than a hard failure. Composites can render with
  // it but the layout will probably look wrong.
  warnOnPortraitOrientation: true,
};

const CACHE_TTL_MS = 60 * 1000;

class TeamPhotoService {
  constructor() {
    this._ensureSettings();
    this._cache = new Map(); // key: `${listId}:${subGalleryId}` → { result, expiresAt }
    // Lazy-resolved at first call so the require order doesn't matter
    this._sytistDb = null;
  }

  _ensureSettings() {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) {
        const dir = path.dirname(SETTINGS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          SETTINGS_PATH,
          JSON.stringify(DEFAULT_SETTINGS, null, 2),
          'utf8'
        );
      }
    } catch (err) {
      console.warn(
        `[TeamPhoto] Could not ensure ${SETTINGS_PATH}: ${err.message}`
      );
    }
  }

  _getDb() {
    if (!this._sytistDb) {
      // Lazy require so circular deps with sytistDbService don't bite us
      this._sytistDb = require('./sytistDbService');
    }
    return this._sytistDb;
  }

  // ─── Settings ─────────────────────────────────────────

  async getSettings() {
    try {
      const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async updateSettings(updates) {
    const current = await this.getSettings();
    const merged = { ...current, ...(updates || {}) };
    if (merged.teamPhotoListId !== null && merged.teamPhotoListId !== undefined) {
      merged.teamPhotoListId = parseInt(merged.teamPhotoListId, 10);
      if (Number.isNaN(merged.teamPhotoListId)) {
        throw new Error('teamPhotoListId must be a number');
      }
    }
    merged.warnOnPortraitOrientation = !!merged.warnOnPortraitOrientation;
    await fsp.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    // Settings change → invalidate cache (results were keyed by old listId)
    this._cache.clear();
    return merged;
  }

  // ─── Public lookup ────────────────────────────────────

  /**
   * Find the team photo for a sub-gallery.
   *
   * Returns:
   *   { found: true, photo: { fullUrl, thumbUrl, originalFilename, width,
   *       height, orientation }, warnings: [...] }
   * OR
   *   { found: false, reason: 'no_match' | 'sub_gallery_id_missing' | 'db_error',
   *       message: '...', warnings: [] }
   *
   * The returned photo shape matches sytistDbService's buildPhotoUrls()
   * output so it can be passed straight to compositeService.
   *
   * NOTE: this method takes the sub-gallery ID directly. If the caller
   * only has a sub-gallery name, look up the ID via sytistDbService
   * first — name-based matching is unreliable (sub-gallery names can
   * differ from filenames).
   */
  async findTeamPhoto(subGalleryId, options = {}) {
    if (!subGalleryId || subGalleryId <= 0) {
      return {
        found: false,
        reason: 'sub_gallery_id_missing',
        message: 'subGalleryId is required and must be > 0',
        warnings: [],
      };
    }

    const settings = await this.getSettings();
    const listId = options.listId || settings.teamPhotoListId;

    // Cache check
    const cacheKey = `${listId}:${subGalleryId}`;
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    let result;
    try {
      const photo = await this._getDb().findTeamPhoto({
        subGalleryId,
        listId,
      });

      if (!photo) {
        result = {
          found: false,
          reason: 'no_match',
          message: `No team photo found in price list ${listId} for sub-gallery ${subGalleryId}`,
          warnings: [],
          listIdUsed: listId,
        };
      } else {
        const orientation =
          photo.width >= photo.height ? 'horizontal' : 'vertical';
        const warnings = [];
        if (
          orientation === 'vertical' &&
          settings.warnOnPortraitOrientation
        ) {
          warnings.push({
            type: 'portrait_team_photo',
            message: `Team photo for sub-gallery ${subGalleryId} is portrait-oriented (${photo.width}x${photo.height}). Composite layouts expect horizontal.`,
          });
        }
        // Phase 8b: warn if the underlying query returned multiple
        // candidates. Common in legacy data where old sub-galleries
        // had multiple team photos assigned. We return the most-
        // recently-added (ORDER BY bp_id DESC) but surface the
        // ambiguity so the operator knows.
        if (photo.candidateCount && photo.candidateCount > 1) {
          warnings.push({
            type: 'multiple_team_photos',
            message: `Multiple team photos exist for this sub-gallery on list ${listId}. Using the most recently added one (${photo.originalFilename}). Consider cleaning up legacy assignments.`,
          });
        }
        result = {
          found: true,
          photo: {
            ...photo,
            orientation,
          },
          warnings,
          listIdUsed: listId,
        };
      }
    } catch (err) {
      console.error('[TeamPhoto] DB error during lookup:', err);
      result = {
        found: false,
        reason: 'db_error',
        message: err.message,
        warnings: [],
        listIdUsed: listId,
      };
    }

    this._cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return result;
  }

  /**
   * Diagnostic — returns metadata about the cache (size + sample keys).
   * Useful for the verification UI to confirm the service is healthy.
   */
  getCacheStats() {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    for (const entry of this._cache.values()) {
      if (entry.expiresAt > now) active++;
      else expired++;
    }
    return { size: this._cache.size, active, expired, ttlMs: CACHE_TTL_MS };
  }

  /**
   * Force-clear the cache. Useful after settings changes or for
   * testing.
   */
  clearCache() {
    const before = this._cache.size;
    this._cache.clear();
    return { cleared: before };
  }
}

module.exports = new TeamPhotoService();
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

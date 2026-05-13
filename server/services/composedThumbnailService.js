// ─────────────────────────────────────────────────────────────
// composedThumbnailService.js — pluggable backend for serving
// composed green-screen thumbnails to external systems
// ─────────────────────────────────────────────────────────────
//
// Phase 42. The problem: ShipStation accepts a single imageUrl per
// line item. For non-green-screen items, Sytist's thumbUrl works
// fine — it's the customer's photo, no compositing needed. But for
// green-screen items, the customer's photo is a transparent PNG
// (subject keyed out); Sytist doesn't host a pre-composed version
// (subject + chosen background) with a public URL.
//
// This service abstracts "publish a composed thumbnail and get a
// public URL back." Multiple backends can implement it:
//
//   - 'skip'        — no-op, always returns null. Default. Used when
//                     S3 isn't configured. Result: green-screen
//                     items have no imageUrl sent to ShipStation.
//                     Non-green-screen items keep their normal
//                     thumbUrl. Honest default.
//
//   - 's3-sytist'   — uploads the composed JPEG to a configured S3
//                     bucket. Returns the public URL. Object key
//                     is deterministic so re-processing overwrites
//                     cleanly.
//
//   - 'dashboard'   — (future) writes to a public folder served by
//                     the dashboard itself. Requires the dashboard
//                     to be publicly reachable (production deploy
//                     to a droplet with a domain name).
//
// Backend selection: at module load time, reads
// composedThumbnailBackend from appSettings. Validates the chosen
// backend's required credentials are present; if any are missing,
// silently falls back to 'skip' with a one-time warning. This means
// "fill in S3 creds in Settings, restart, done" is the upgrade
// path — no code changes.
//
// Failure modes are NON-FATAL:
//   - publish() throws → caught, logged, returns null
//   - cleanup() throws → caught, logged, returns false
// The calling pipeline should NEVER block on publishing/cleanup.

const appSettings = require('../config/appSettings');

// Lazy-loaded backend module cache. Keyed by backend name.
const backendCache = new Map();

/**
 * Load and return the backend module by name. Returns null if the
 * backend module doesn't exist, fails to require, or its
 * `isConfigured()` check returns false.
 */
function _resolveBackend(name) {
  if (backendCache.has(name)) return backendCache.get(name);

  let backend = null;
  try {
    backend = require(`./thumbnailBackends/${_backendFileName(name)}`);
  } catch (err) {
    console.warn(
      `[composedThumbnailService] Backend "${name}" failed to load: ${err.message}. Falling back to 'skip'.`
    );
  }

  // Validate the backend's configuration. Each backend implements
  // isConfigured() to report whether its required dependencies and
  // credentials are present.
  if (backend && typeof backend.isConfigured === 'function') {
    try {
      const ok = backend.isConfigured();
      if (!ok) {
        console.warn(
          `[composedThumbnailService] Backend "${name}" reports it's not configured. Falling back to 'skip'.`
        );
        backend = null;
      }
    } catch (err) {
      console.warn(
        `[composedThumbnailService] Backend "${name}" isConfigured() threw: ${err.message}. Falling back to 'skip'.`
      );
      backend = null;
    }
  }

  if (!backend) {
    // Fall back to skip
    try {
      backend = require('./thumbnailBackends/skip');
    } catch (err) {
      // Skip itself failed — shouldn't happen, but defensively make
      // a stub so callers don't crash.
      console.error(
        `[composedThumbnailService] Even the 'skip' backend failed to load: ${err.message}`
      );
      backend = _stubBackend();
    }
  }

  backendCache.set(name, backend);
  return backend;
}

function _backendFileName(name) {
  // 's3-sytist' → 's3Sytist'
  return name
    .split('-')
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join('');
}

function _stubBackend() {
  return {
    name: 'stub',
    async publish() {
      return null;
    },
    async cleanup() {
      return false;
    },
    isConfigured() {
      return true;
    },
  };
}

/**
 * Get the currently-active backend module. Reads the setting fresh
 * each time it's called so a server restart isn't required after
 * editing the setting — but the BACKEND MODULES themselves are
 * cached, so per-backend setup cost is paid once.
 */
function _activeBackend() {
  let name = 'skip';
  try {
    name = appSettings.getRawValueSync('composedThumbnailBackend') || 'skip';
  } catch (err) {
    // If appSettings throws, stick with skip.
    console.warn(
      `[composedThumbnailService] Could not read backend setting: ${err.message}. Using 'skip'.`
    );
  }
  return _resolveBackend(name);
}

/**
 * Publish a composed JPEG buffer and return a public URL.
 *
 * @param {number|string} orderId  Sytist order id
 * @param {number|string} cartId   Cart row id within the order
 * @param {Buffer}        composedJpegBuffer  JPEG bytes (already composed)
 * @returns {Promise<string|null>} public URL, or null if the backend
 *          is 'skip' / publishing failed.
 */
async function publish(orderId, cartId, composedJpegBuffer) {
  const backend = _activeBackend();
  if (!backend) return null;
  try {
    return await backend.publish(orderId, cartId, composedJpegBuffer);
  } catch (err) {
    console.warn(
      `[composedThumbnailService] publish(${orderId}, ${cartId}) failed: ${err.message}`
    );
    return null;
  }
}

/**
 * Delete all composed thumbnails for an order.
 *
 * Called by schedulerService after an order's Sytist status flips
 * to Shipped, so we don't accumulate orphaned objects forever.
 *
 * @param {number|string} orderId
 * @returns {Promise<{ok: boolean, deleted: number}>}
 */
async function cleanup(orderId) {
  const backend = _activeBackend();
  if (!backend) return { ok: false, deleted: 0 };
  try {
    const result = await backend.cleanup(orderId);
    if (typeof result === 'object') return result;
    // Older backends may return just a boolean
    return { ok: !!result, deleted: result ? -1 : 0 };
  } catch (err) {
    console.warn(
      `[composedThumbnailService] cleanup(${orderId}) failed: ${err.message}`
    );
    return { ok: false, deleted: 0 };
  }
}

/**
 * Diagnostic info for the dashboard UI / logs. Returns the
 * currently-selected backend name and its configured/healthy state.
 */
function status() {
  let configuredName = 'skip';
  try {
    configuredName =
      appSettings.getRawValueSync('composedThumbnailBackend') || 'skip';
  } catch {
    /* ignore */
  }
  const backend = _activeBackend();
  return {
    requested: configuredName,
    active: backend?.name || 'unknown',
    fellBack: configuredName !== (backend?.name || 'skip'),
  };
}

/**
 * Force re-evaluation of the backend on the next call. Useful after
 * the operator updates credentials in Settings without restarting
 * the server. (Server WILL still need a restart in many cases —
 * AWS SDK clients are usually constructed at module load — but
 * this clears the cache so the next publish() picks up new env
 * vars where the backend supports it.)
 */
function resetBackendCache() {
  backendCache.clear();
}

module.exports = {
  publish,
  cleanup,
  status,
  resetBackendCache,
};

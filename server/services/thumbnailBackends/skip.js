// ─────────────────────────────────────────────────────────────
// thumbnailBackends/skip.js — no-op backend
// ─────────────────────────────────────────────────────────────
//
// Used when no thumbnail publishing is configured (or as a fallback
// when a real backend's prerequisites are missing). Always returns
// null from publish() so the calling code knows there's no URL to
// send to ShipStation.
//
// This is the DEFAULT backend. The dashboard will use this until
// the operator configures S3 credentials in Settings → API Keys
// AND switches the Composed Thumbnail Backend setting to
// 's3-sytist'.

module.exports = {
  name: 'skip',

  /**
   * Always returns null (no URL). The calling pipeline interprets
   * this as "skip the imageUrl for this item."
   */
  async publish(/* orderId, cartId, composedJpegBuffer */) {
    return null;
  },

  /**
   * Nothing to clean up — nothing was ever published.
   */
  async cleanup(/* orderId */) {
    return { ok: true, deleted: 0 };
  },

  /**
   * Skip is always considered configured — it has nothing to
   * configure.
   */
  isConfigured() {
    return true;
  },
};

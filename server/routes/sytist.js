// Routes that talk to the Sytist MySQL database.
// All require auth — we don't expose Sytist data to unauthenticated callers.

const express = require('express');
const router = express.Router();

const sytistDb = require('../services/sytistDbService');
const { requireAuth } = require('../middleware/auth');

// All Sytist endpoints require an authenticated user.
router.use(requireAuth);

/**
 * GET /api/sytist/health
 * Verifies the dashboard can reach the Sytist MySQL server.
 */
router.get('/health', async (req, res) => {
  try {
    const result = await sytistDb.healthCheck();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: err.message,
      code: err.code,
    });
  }
});

module.exports = router;

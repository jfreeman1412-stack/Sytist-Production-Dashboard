// Sytist Production Dashboard — server entry point
//
// Phase 1: auth wired in.
// Phase 2a: Sytist MySQL data layer (connectivity health check).

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const databaseService = require('./services/database');
const authService = require('./services/authService');
const sytistDb = require('./services/sytistDbService');

const authRoutes = require('./routes/auth');
const sytistRoutes = require('./routes/sytist');
const shipstationRoutes = require('./routes/shipstation');

const PORT = process.env.PORT || 3011;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Initialize local SQLite ───────────────────────────────
databaseService.init();

// ─── Initialize Sytist MySQL pool ──────────────────────────
// The pool is lazy — connections are created on first use. Calling init() now
// just validates env vars are present so we fail fast at startup if not.
try {
  sytistDb.init();
} catch (err) {
  console.warn(`[startup] Sytist DB pool not initialized: ${err.message}`);
  console.warn('[startup] /api/sytist/* endpoints will fail until SYTIST_DB_* env vars are set.');
}

// ─── Phase 13a: app settings + ShipStation ─────────────────
// appSettings persists ShipStation API credentials and shipping
// defaults to a JSON file and applies them to process.env so the
// shipstation service picks them up. Done early so it runs before
// any service registration that reads from env.
try {
  require('./config/appSettings').init();
} catch (err) {
  console.warn(`[startup] appSettings init failed: ${err.message}`);
}

// ─── Initial admin bootstrap ───────────────────────────────
async function bootstrapInitialAdmin() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) return;

  if (authService.hasAnyUsers()) return;

  try {
    const user = await authService.createUser(
      username,
      password,
      process.env.INITIAL_ADMIN_DISPLAY_NAME || username,
      'admin'
    );
    console.log(`[bootstrap] Created initial admin user: ${user.username}`);
    console.log(`[bootstrap] You can now log in at http://localhost:3010`);
    console.log(`[bootstrap] Remove INITIAL_ADMIN_* from .env after first login`);
  } catch (err) {
    console.error('[bootstrap] Failed to create initial admin:', err.message);
  }
}
bootstrapInitialAdmin();

// ─── Periodic session cleanup ──────────────────────────────
setInterval(() => {
  authService.cleanupExpiredSessions();
}, 60 * 60 * 1000);

// ─── Express app ───────────────────────────────────────────
const app = express();

// Phase 71: 25mb cap accommodates the override editor's base64-in-JSON image
// uploads. Base64 inflates binary by ~4/3, so 25mb JSON ≈ ~18.7mb raw image —
// the client pre-flight in OverrideEditorPage.uploadSlotAsset caps the raw
// file at 18mb (with margin for the JSON wrapper). This global parser runs
// BEFORE any per-route express.json(...) middleware — raising a per-route
// limit without raising this one is a no-op (the original Phase 50 author hit
// this; we removed the vestigial 15mb route parser in Phase 71). If a future
// upload uses multipart/form-data instead, multer has its own fileSize limit
// independent of this one.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use(
  cors({
    origin: NODE_ENV === 'development' ? 'http://localhost:3010' : true,
    credentials: true,
  })
);

// ─── Routes ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'sytist-dashboard',
    version: '0.1.0',
    phase: '2a',
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/sytist', sytistRoutes);
app.use('/api/shipstation', shipstationRoutes);

// 404 catch-all for /api/*
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[sytist-dashboard] server listening on http://localhost:${PORT}`);
  console.log(`[sytist-dashboard] env: ${NODE_ENV}`);
  console.log(`[sytist-dashboard] health: http://localhost:${PORT}/api/health`);

  // Phase 13e: start the ShipStation shipped-status poller. Lazy-loaded
  // so import errors (e.g. missing better-sqlite3 in fresh installs)
  // don't crash startup — the scheduler just doesn't run.
  try {
    require('./services/schedulerService').start();
  } catch (err) {
    console.warn(`[startup] Scheduler did not start: ${err.message}`);
  }

  // Phase 62: log Customer Manager push config state. One line at
  // startup so a config typo can't silently disable the whole
  // feature. See services/pushShippingMetaToCM.js header for the
  // reason this logging exists (initial ship was a silent no-op).
  try {
    require('./services/pushShippingMetaToCM').logStartupState();
  } catch (err) {
    console.warn(`[startup] pushShippingMetaToCM startup log failed: ${err.message}`);
  }
});

// ─── Graceful shutdown ─────────────────────────────────────
async function shutdown() {
  console.log('\n[sytist-dashboard] shutting down…');
  try {
    require('./services/schedulerService').stop();
  } catch (err) {
    // Scheduler may not have started; ignore.
  }
  try {
    await sytistDb.close();
  } catch (err) {
    console.error('[shutdown] Error closing Sytist pool:', err.message);
  }
  databaseService.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

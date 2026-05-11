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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
});

// ─── Graceful shutdown ─────────────────────────────────────
async function shutdown() {
  console.log('\n[sytist-dashboard] shutting down…');
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

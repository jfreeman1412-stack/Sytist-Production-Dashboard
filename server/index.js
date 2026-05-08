// Sytist Production Dashboard — server entry point
//
// Phase 1: auth wired in. Database initialized at startup, expired sessions
// cleaned every hour, optional initial admin user created if env vars set.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const databaseService = require('./services/database');
const authService = require('./services/authService');
const authRoutes = require('./routes/auth');

const PORT = process.env.PORT || 3011;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Initialize database ───────────────────────────────────
databaseService.init();

// ─── Initial admin bootstrap ───────────────────────────────
// If no users exist yet AND env vars are set, create one. Useful for first-run
// convenience without baking creds into source.
async function bootstrapInitialAdmin() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) return;

  if (authService.hasAnyUsers()) {
    return; // someone exists already, skip
  }

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
// Once an hour, drop sessions whose expires_at has passed.
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
    phase: 1,
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);

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

// Graceful shutdown — close DB cleanly.
process.on('SIGINT', () => {
  console.log('\n[sytist-dashboard] shutting down…');
  databaseService.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  databaseService.close();
  process.exit(0);
});

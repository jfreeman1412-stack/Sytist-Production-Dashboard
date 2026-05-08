// Sytist Production Dashboard — server entry point
//
// Phase 0: just an Express app with a health endpoint.
// Phase 1+ adds auth, routes, services as we go.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3011;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

// ─── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS: in dev, allow the React dev server on 3010 to call us on 3011.
// In production (when client and server are served from the same origin),
// this becomes a no-op.
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
    phase: 0,
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Catch-all 404 for /api/* — keeps stray requests from hanging
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[sytist-dashboard] server listening on http://localhost:${PORT}`);
  console.log(`[sytist-dashboard] env: ${NODE_ENV}`);
  console.log(`[sytist-dashboard] health: http://localhost:${PORT}/api/health`);
});

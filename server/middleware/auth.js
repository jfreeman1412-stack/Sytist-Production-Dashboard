// Auth middleware. Validates session from X-Session-Id header.
// Adapted from photo day dashboard — same shape, no functional changes.

const authService = require('../services/authService');

async function requireAuth(req, res, next) {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res
      .status(401)
      .json({ error: 'Authentication required', code: 'NO_SESSION' });
  }

  try {
    const user = await authService.validateSession(sessionId);
    if (!user) {
      return res
        .status(401)
        .json({ error: 'Invalid or expired session', code: 'INVALID_SESSION' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth] validation error:', err.message);
    return res
      .status(401)
      .json({ error: 'Authentication error', code: 'AUTH_ERROR' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: `Requires ${roles.join(' or ')} role` });
    }
    next();
  };
}

async function optionalAuth(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    try {
      const user = await authService.validateSession(sessionId);
      if (user) req.user = user;
    } catch (err) {
      // silent — invalid session shouldn't block on optional auth
    }
  }
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };

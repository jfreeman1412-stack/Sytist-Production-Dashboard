// Auth routes. Mirrors photo day dashboard's auth.js.
// User management endpoints will get role-gated (requireRole('admin')) when
// we wire admin-only UI. For now they're authenticated-only.

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── Login ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await authService.login(username, password);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// ─── Logout ───────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (sessionId) await authService.logout(sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Validate Session ─────────────────────────────────────
router.get('/session', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const user = await authService.validateSession(sessionId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    res.json({ user });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// ─── Update Own Profile ───────────────────────────────────
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { displayName, password } = req.body;
    const allowed = {};
    if (displayName !== undefined) allowed.displayName = displayName;
    if (password) allowed.password = password;

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const updated = await authService.updateUser(req.user.id, allowed);
    res.json({ success: true, user: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── User Management (admin only) ─────────────────────────
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = authService.getAllUsers();
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = await authService.createUser(username, password, displayName, role);
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const user = await authService.updateUser(parseInt(req.params.id), req.body);
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await authService.deactivateUser(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;

// Authentication service.
//
// Sessions are stored in SQLite (survives restarts) and identified by a UUID
// the client holds and sends as the X-Session-Id header.
//
// Adapted from the photo day dashboard's authService:
//   - Removed download_path (photo-day-specific).
//   - Removed activity log (not used per Joey).
//   - Schema is fresh, so no migration helpers.

const databaseService = require('./database');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const SESSION_DURATION_HOURS = 24;
const VALID_ROLES = ['admin', 'operator', 'viewer'];
const BCRYPT_ROUNDS = 10;

class AuthService {
  get db() {
    return databaseService.getDb();
  }

  // ─── Authentication ─────────────────────────────────────

  async login(username, password) {
    const user = this.db
      .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
      .get(username);
    if (!user) throw new Error('Invalid username or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid username or password');

    const sessionId = uuidv4();
    const expiresAt = new Date(
      Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000
    ).toISOString();

    this.db
      .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sessionId, user.id, expiresAt);

    this.db
      .prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .run(user.id);

    return {
      sessionId,
      user: this._sanitizeUser(user),
      expiresAt,
    };
  }

  async validateSession(sessionId) {
    if (!sessionId) return null;

    const row = this.db
      .prepare(
        `SELECT s.id AS session_id, s.expires_at, u.*
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ?
           AND s.expires_at > datetime('now')
           AND u.active = 1`
      )
      .get(sessionId);

    if (!row) return null;
    return this._sanitizeUser(row);
  }

  async logout(sessionId) {
    if (!sessionId) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  cleanupExpiredSessions() {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expires_at < datetime('now')")
      .run();
    if (result.changes > 0) {
      console.log(`[AuthService] Cleaned up ${result.changes} expired sessions`);
    }
  }

  // ─── User management ────────────────────────────────────

  async createUser(username, password, displayName, role = 'operator') {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existing) throw new Error(`Username "${username}" already exists`);

    if (!VALID_ROLES.includes(role)) {
      throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = this.db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, ?)`
      )
      .run(username, hash, displayName || username, role);

    return this.getUser(result.lastInsertRowid);
  }

  async updateUser(userId, updates) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found');

    const fields = [];
    const values = [];

    if (updates.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.displayName);
    }
    if (updates.role !== undefined) {
      if (!VALID_ROLES.includes(updates.role)) throw new Error('Invalid role');
      fields.push('role = ?');
      values.push(updates.role);
    }
    if (updates.active !== undefined) {
      fields.push('active = ?');
      values.push(updates.active ? 1 : 0);
    }
    if (updates.password) {
      const hash = await bcrypt.hash(updates.password, BCRYPT_ROUNDS);
      fields.push('password_hash = ?');
      values.push(hash);
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(userId);
      this.db
        .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values);
    }

    return this.getUser(userId);
  }

  async deactivateUser(userId) {
    return this.updateUser(userId, { active: false });
  }

  getUser(userId) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return user ? this._sanitizeUser(user) : null;
  }

  getAllUsers() {
    const users = this.db
      .prepare('SELECT * FROM users ORDER BY created_at')
      .all();
    return users.map((u) => this._sanitizeUser(u));
  }

  hasAnyUsers() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get();
    return row.count > 0;
  }

  _sanitizeUser(user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      active: !!user.active,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      lastLoginAt: user.last_login_at,
    };
  }
}

module.exports = new AuthService();

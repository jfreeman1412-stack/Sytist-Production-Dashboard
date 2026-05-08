// Sytist MySQL data layer.
//
// Phase 2a: connection pool + health check only. Phase 2b adds the real query
// methods (orders, status list, gallery hierarchy). Phase 2c adds writes
// (status updates back to ms_orders.order_open_status).
//
// Uses mysql2/promise — async/await friendly, with a connection pool so we
// don't open/close a connection per request.

const mysql = require('mysql2/promise');

class SytistDbService {
  constructor() {
    this.pool = null;
    this._lastError = null;
  }

  /**
   * Initialize the connection pool. Idempotent — safe to call multiple times.
   * Reads config from process.env. Caller decides when to call this; we don't
   * auto-init in the constructor because env may not be loaded yet.
   */
  init() {
    if (this.pool) return this.pool;

    const config = {
      host: process.env.SYTIST_DB_HOST,
      port: parseInt(process.env.SYTIST_DB_PORT || '3306', 10),
      user: process.env.SYTIST_DB_USER,
      password: process.env.SYTIST_DB_PASSWORD,
      database: process.env.SYTIST_DB_NAME,

      // Pool sizing — generous for a single-user dev tool, conservative
      // enough not to stress the droplet. Tune in prod.
      connectionLimit: 5,
      queueLimit: 0,
      waitForConnections: true,

      // Sytist's tables are mixed utf8mb3/utf8mb4. utf8mb4 is the safe
      // superset for the connection.
      charset: 'utf8mb4',

      // Reasonable timeouts. The droplet should respond quickly; if it's
      // slow, we want to know rather than hang.
      connectTimeout: 10_000,

      // Sytist uses old-style date defaults like '0000-00-00'. mysql2 by
      // default returns Date objects; configure to return strings so we can
      // detect/handle these zero-dates without timezone surprises.
      dateStrings: true,
    };

    if (!config.host || !config.user || !config.database) {
      throw new Error(
        'SYTIST_DB_HOST, SYTIST_DB_USER, and SYTIST_DB_NAME must be set in .env'
      );
    }

    this.pool = mysql.createPool(config);

    console.log(
      `[SytistDB] Pool created → ${config.user}@${config.host}:${config.port}/${config.database}`
    );
    return this.pool;
  }

  getPool() {
    if (!this.pool) this.init();
    return this.pool;
  }

  /**
   * Quick connectivity check. Returns { ok: true, ... } or throws.
   *
   * Runs `SELECT 1 AS ok` and a couple of identity queries (DB name + version)
   * so we surface useful diagnostics if a connection works but something else
   * is off (e.g., wrong database selected).
   */
  async healthCheck() {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const [[ping]] = await pool.query('SELECT 1 AS ok');
      const [[ident]] = await pool.query(
        'SELECT DATABASE() AS db, VERSION() AS version, USER() AS user'
      );
      const elapsedMs = Date.now() - start;

      this._lastError = null;
      return {
        ok: ping.ok === 1,
        database: ident.db,
        version: ident.version,
        user: ident.user,
        elapsedMs,
      };
    } catch (err) {
      this._lastError = err;
      // Re-throw a redacted version (avoid leaking the password if it appears
      // in some driver error messages).
      const safeMsg = String(err.message || err)
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/PASSWORD\s*=\s*'[^']*'/gi, "PASSWORD='***'");
      const wrapped = new Error(`Sytist DB health check failed: ${safeMsg}`);
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  /**
   * Close the pool. Used in tests and during graceful shutdown.
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = new SytistDbService();

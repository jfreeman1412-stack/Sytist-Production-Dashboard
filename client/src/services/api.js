// API client. Wraps fetch with:
//   - automatic X-Session-Id header from localStorage
//   - JSON request/response handling
//   - consistent error throwing
//
// Auth methods (login/logout/getSession) plus generic get/post/put/del for
// future calls in later phases.

const SESSION_KEY = 'sytist_session_id';

function getSessionId() {
  return localStorage.getItem(SESSION_KEY);
}

function setSessionId(id) {
  if (id) localStorage.setItem(SESSION_KEY, id);
  else localStorage.removeItem(SESSION_KEY);
}

async function _fetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const sessionId = getSessionId();
  if (sessionId) headers['X-Session-Id'] = sessionId;

  const response = await fetch(path, { ...options, headers });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = (data && data.error) || `Request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.code = data && data.code;
    throw err;
  }

  return data;
}

const api = {
  // ─── Auth ──────────────────────────────────────────────
  async login(username, password) {
    const result = await _fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (result.sessionId) setSessionId(result.sessionId);
    return result;
  },

  async logout() {
    try {
      await _fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setSessionId(null);
    }
  },

  async getSession() {
    if (!getSessionId()) return null;
    try {
      const result = await _fetch('/api/auth/session');
      return result.user;
    } catch (err) {
      if (err.status === 401) {
        // Session expired or invalid — clear and report no user.
        setSessionId(null);
        return null;
      }
      throw err;
    }
  },

  async updateProfile(updates) {
    return _fetch('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  // ─── Generic ───────────────────────────────────────────
  get(path) {
    return _fetch(path);
  },
  post(path, body) {
    return _fetch(path, { method: 'POST', body: JSON.stringify(body) });
  },
  put(path, body) {
    return _fetch(path, { method: 'PUT', body: JSON.stringify(body) });
  },
  del(path) {
    return _fetch(path, { method: 'DELETE' });
  },

  // Exposed for debugging.
  _fetch,
  getSessionId,
  setSessionId,
};

export default api;

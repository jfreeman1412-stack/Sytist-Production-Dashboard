// API client. Wraps fetch with:
//   - automatic X-Session-Id header from localStorage
//   - JSON request/response handling
//   - consistent error throwing
//
// Auth methods (login/logout/getSession) plus generic get/post/put/del for
// future calls in later phases.
//
// getBlob() is a sibling to get() that bypasses the JSON-parsing pipeline
// for binary responses (slip JPGs, divider JPGs, etc). It still attaches
// the X-Session-Id header so the request authenticates properly. Returns
// a Blob the caller can hand to URL.createObjectURL().

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

/**
 * Authenticated binary fetch. Returns a Blob the caller can pass to
 * URL.createObjectURL() to render in an <img>. Used for slip and divider
 * preview endpoints, which return image/jpeg.
 */
async function _fetchBlob(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const sessionId = getSessionId();
  if (sessionId) headers['X-Session-Id'] = sessionId;

  const response = await fetch(path, { ...options, headers });

  if (!response.ok) {
    // Try to surface a useful error if the server returned JSON
    let message = `Request failed (${response.status})`;
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.error) message = parsed.error;
        } catch {
          /* not JSON, fall through */
        }
      }
    } catch {
      /* ignore */
    }
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  return response.blob();
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

  /**
   * Authenticated binary fetch. Returns a Blob.
   * Use with URL.createObjectURL(blob) for inline image rendering.
   */
  getBlob(path) {
    return _fetchBlob(path);
  },

  // Exposed for debugging.
  _fetch,
  _fetchBlob,
  getSessionId,
  setSessionId,
};

export default api;

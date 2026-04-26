// apps/dashboard/src/services/api.js
// Axios instance with:
//   - Request interceptor: attach Bearer token from localStorage
//   - Response interceptor: silently refresh token on 401 TOKEN_EXPIRED, then retry

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ─── Token helpers ────────────────────────────────────────────────────────────

export const storage = {
  getAccessToken: () => localStorage.getItem('accessToken'),
  getRefreshToken: () => localStorage.getItem('refreshToken'),
  setTokens: (access, refresh) => {
    localStorage.setItem('accessToken', access);
    localStorage.setItem('refreshToken', refresh);
  },
  clear: () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  },
};

// ─── Core fetch wrapper ────────────────────────────────────────────────────────

let isRefreshing = false;
let pendingQueue = []; // queue of { resolve, reject } waiting on token refresh

function processQueue(error, token) {
  pendingQueue.forEach(({ resolve, reject }) => {
    error ? reject(error) : resolve(token);
  });
  pendingQueue = [];
}

/**
 * Thin fetch wrapper that handles auth headers and token refresh.
 * @param {string} path  - e.g. '/templates'
 * @param {RequestInit} options
 * @returns {Promise<any>}
 */
export async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const token = storage.getAccessToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(url, { ...options, headers });

  // Silent token refresh on 401 TOKEN_EXPIRED
  if (response.status === 401) {
    const body = await response.clone().json().catch(() => ({}));

    if (body.code === 'TOKEN_EXPIRED') {
      if (isRefreshing) {
        // Another request is already refreshing — wait for it.
        const newToken = await new Promise((resolve, reject) => {
          pendingQueue.push({ resolve, reject });
        });
        headers['Authorization'] = `Bearer ${newToken}`;
        return fetch(url, { ...options, headers });
      }

      isRefreshing = true;
      try {
        const refreshToken = storage.getRefreshToken();
        const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (!refreshRes.ok) throw new Error('Refresh failed');

        const data = await refreshRes.json();
        storage.setTokens(data.accessToken, data.refreshToken);
        processQueue(null, data.accessToken);

        // Retry the original request with the new token.
        headers['Authorization'] = `Bearer ${data.accessToken}`;
        return fetch(url, { ...options, headers });
      } catch (err) {
        processQueue(err, null);
        storage.clear();
        window.location.href = '/';
        throw err;
      } finally {
        isRefreshing = false;
      }
    }

    // 401 without TOKEN_EXPIRED → redirect to login.
    if (body.code !== 'TOKEN_EXPIRED') {
      storage.clear();
      window.location.href = '/';
    }
  }

  if (!response.ok && response.status !== 401) {
    const errorBody = await response.json().catch(() => ({ error: 'Request failed' }));
    throw Object.assign(new Error(errorBody.error || 'Request failed'), errorBody);
  }

  if (response.status === 204) return null;
  return response.json();
}

// ─── API Methods ──────────────────────────────────────────────────────────────

export const api = {
  // Auth
  login: (apiKey) =>
    apiFetch('/auth/token', { method: 'POST', body: JSON.stringify({ apiKey }) }),

  logout: () =>
    apiFetch('/auth/logout', { method: 'POST' }),

  // Templates
  getTemplates: (page = 1, limit = 20) =>
    apiFetch(`/templates?page=${page}&limit=${limit}`),

  getTemplate: (name) =>
    apiFetch(`/templates/${name}`),

  createTemplate: (data) =>
    apiFetch('/templates', { method: 'POST', body: JSON.stringify(data) }),

  updateTemplate: (name, data) =>
    apiFetch(`/templates/${name}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteTemplate: (name) =>
    apiFetch(`/templates/${name}`, { method: 'DELETE' }),

  previewTemplate: (name, data) =>
    apiFetch(`/templates/${name}/preview?data=${encodeURIComponent(JSON.stringify(data))}`),

  // Analytics
  getSummary: () =>
    apiFetch('/analytics/summary'),

  getLogs: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined))
    ).toString();
    return apiFetch(`/analytics/logs${qs ? `?${qs}` : ''}`);
  },

  // Notify
  sendNotification: (payload) =>
    apiFetch('/notify', { method: 'POST', body: JSON.stringify(payload) }),
};

export default api;

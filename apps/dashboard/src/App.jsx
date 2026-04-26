// apps/dashboard/src/App.jsx
// Root application component — handles auth state, navigation, and routing.

import { useState, useEffect } from 'react';
import { storage, api } from './services/api.js';
import Dashboard from './pages/Dashboard.jsx';
import Templates from './pages/Templates.jsx';
import NotificationToast from './components/NotificationToast.jsx';

// ─── Login Page ───────────────────────────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.login(apiKey.trim());
      storage.setTokens(data.accessToken, data.refreshToken);
      onLogin(data.tenantName || 'NotifyFlow');
    } catch (err) {
      setError(err.error || err.message || 'Login failed. Check your API key.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-icon">🔔</div>
          <h1 className="login-title">NotifyFlow</h1>
          <p className="login-subtitle">Distributed Notification Engine</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="api-key-input">API Key</label>
            <input
              id="api-key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your tenant API key"
              autoFocus
              required
            />
          </div>
          <button
            id="login-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading || !apiKey}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {loading ? (
              <><span className="spinner" style={{ width: 16, height: 16 }} /> Authenticating…</>
            ) : (
              '→ Sign In'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Main App Shell ───────────────────────────────────────────────────────────

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [tenantName, setTenantName] = useState('');
  const [currentPage, setCurrentPage] = useState('dashboard');

  useEffect(() => {
    // Check if we already have tokens in localStorage.
    const token = storage.getAccessToken();
    if (token) {
      setIsAuthenticated(true);
      setTenantName(localStorage.getItem('tenantName') || 'NotifyFlow');
    }
  }, []);

  const handleLogin = (name) => {
    localStorage.setItem('tenantName', name);
    setTenantName(name);
    setIsAuthenticated(true);
  };

  const handleLogout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    localStorage.removeItem('tenantName');
    storage.clear();
    setIsAuthenticated(false);
    setTenantName('');
  };

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="app-shell">
      {/* Navigation */}
      <nav className="nav">
        <div className="nav-brand">
          <div className="nav-brand-icon">🔔</div>
          NotifyFlow
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>
            {tenantName}
          </span>
        </div>

        <div className="nav-links">
          <button
            id="nav-dashboard"
            className={`nav-link ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            📊 Dashboard
          </button>
          <button
            id="nav-templates"
            className={`nav-link ${currentPage === 'templates' ? 'active' : ''}`}
            onClick={() => setCurrentPage('templates')}
          >
            📄 Templates
          </button>
        </div>

        <div className="nav-actions">
          <button
            id="logout-btn"
            className="btn btn-ghost btn-sm"
            onClick={handleLogout}
          >
            Sign Out
          </button>
        </div>
      </nav>

      {/* Page Content */}
      <main className="main-content">
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'templates' && <Templates />}
      </main>

      {/* Global Toast Container */}
      <NotificationToast />
    </div>
  );
}

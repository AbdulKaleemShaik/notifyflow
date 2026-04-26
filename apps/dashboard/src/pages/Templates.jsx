// apps/dashboard/src/pages/Templates.jsx
// Two-panel templates page: left list, right editor.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api.js';
import TemplateEditor from '../components/TemplateEditor.jsx';

function TemplateCard({ template, selected, onClick }) {
  const channelClass = (ch) => {
    const map = { 'in-app': 'inapp', email: 'email', webhook: 'webhook' };
    return map[ch] || 'inapp';
  };

  return (
    <div
      className={`template-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <div className="template-card-name">{template.name}</div>
      <div className="template-card-meta">
        <div className="template-card-channels">
          {template.channels?.map((ch) => (
            <span key={ch} className={`badge badge-${channelClass(ch)}`}>{ch}</span>
          ))}
        </div>
        <div>
          <span className="template-card-version">v{template.version}</span>
          {!template.isActive && (
            <span className="badge" style={{ marginLeft: 6, background: 'rgba(100,100,100,0.2)', color: '#666' }}>
              inactive
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getTemplates(page, 20);
      setTemplates(result.data || []);
      setTotalPages(result.pagination?.pages || 1);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleCreate = () => {
    setSelectedTemplate(null);
    setIsNew(true);
  };

  const handleSelect = (t) => {
    setSelectedTemplate(t);
    setIsNew(false);
  };

  const handleSaved = () => {
    fetchTemplates();
    setIsNew(false);
  };

  const handleDeleted = () => {
    setSelectedTemplate(null);
    fetchTemplates();
  };

  return (
    <div className="templates-layout">
      {/* Left panel — list */}
      <div>
        <div className="templates-panel-header">
          <h2 className="dashboard-section-title" style={{ margin: 0 }}>📄 Templates</h2>
          <button id="new-template-btn" className="btn btn-primary btn-sm" onClick={handleCreate}>
            + New
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <div className="spinner" />
          </div>
        ) : templates.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📄</div>
            <div className="empty-state-text">No templates yet. Create one →</div>
          </div>
        ) : (
          <div className="template-list">
            {templates.map((t) => (
              <TemplateCard
                key={t._id}
                template={t}
                selected={selectedTemplate?._id === t._id}
                onClick={() => handleSelect(t)}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="pagination" style={{ marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              ← Prev
            </button>
            <span className="text-xs text-muted">{page} / {totalPages}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Right panel — editor */}
      <div>
        {(selectedTemplate || isNew) ? (
          <TemplateEditor
            template={selectedTemplate}
            isNew={isNew}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
          />
        ) : (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">✎</div>
              <div className="empty-state-text">Select a template to edit, or click + New</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

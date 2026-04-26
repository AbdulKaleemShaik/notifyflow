// apps/dashboard/src/components/TemplateEditor.jsx
// Right-panel editor: create and update templates with preview modal.

import { useState, useEffect } from 'react';
import { api } from '../services/api.js';

const EMPTY_TEMPLATE = {
  name: '',
  subject: '',
  body: '<h1>Hello, {{user.firstName}}!</h1>\n<p>{{message}}</p>',
  channels: ['in-app'],
};

export default function TemplateEditor({ template, onSaved, onDeleted, isNew }) {
  const [form, setForm] = useState(EMPTY_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState('{}');
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (template) {
      setForm({
        name: template.name,
        subject: template.subject || '',
        body: template.body,
        channels: template.channels || ['in-app'],
      });
    } else {
      setForm(EMPTY_TEMPLATE);
    }
    setError(null);
  }, [template]);

  const toggleChannel = (channel) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await api.createTemplate(form);
      } else {
        await api.updateTemplate(form.name, {
          subject: form.subject,
          body: form.body,
          channels: form.channels,
        });
      }
      onSaved?.();
    } catch (err) {
      setError(err.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!template?.name) return;
    setDeleting(true);
    try {
      await api.deleteTemplate(template.name);
      onDeleted?.();
    } catch (err) {
      setError(err.error || err.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const handlePreview = async () => {
    setPreviewLoading(true);
    setPreviewResult(null);
    try {
      let data = {};
      try { data = JSON.parse(previewData); } catch { /* use empty */ }
      const result = await api.previewTemplate(form.name, data);
      setPreviewResult(result);
    } catch (err) {
      setPreviewResult({ error: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="dashboard-section-title" style={{ margin: 0 }}>
          {isNew ? '✦ New Template' : `✎ ${form.name}`}
        </h3>
        {template && (
          <span className="text-xs text-muted">v{template.version}</span>
        )}
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      <div className="form-group">
        <label htmlFor="template-name">Template Name (slug)</label>
        <input
          id="template-name"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          readOnly={!isNew}
          placeholder="order_confirmed"
          style={!isNew ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
        />
      </div>

      <div className="form-group">
        <label htmlFor="template-subject">Subject (email)</label>
        <input
          id="template-subject"
          value={form.subject}
          onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))}
          placeholder="Your order {{order.id}} is confirmed!"
        />
      </div>

      <div className="form-group">
        <label>Channels</label>
        <div className="checkbox-group">
          {['in-app', 'email', 'webhook'].map((ch) => (
            <label key={ch} className="checkbox-label">
              <input
                type="checkbox"
                checked={form.channels.includes(ch)}
                onChange={() => toggleChannel(ch)}
              />
              {ch}
            </label>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="template-body">Body (HTML with {'{{variables}}'})</label>
        <textarea
          id="template-body"
          value={form.body}
          onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
          rows={10}
          placeholder="<h1>Hello {{user.firstName}}!</h1>"
        />
      </div>

      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
        <button
          id="save-template-btn"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !form.name || !form.body || form.channels.length === 0}
        >
          {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : '💾 Save'}
        </button>

        {!isNew && (
          <>
            <button
              id="preview-template-btn"
              className="btn btn-ghost"
              onClick={() => setShowPreview(true)}
              disabled={!form.name}
            >
              👁 Preview
            </button>
            <button
              id="delete-template-btn"
              className="btn btn-danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : '🗑 Delete'}
            </button>
          </>
        )}
      </div>

      {/* Preview Modal */}
      {showPreview && (
        <div className="modal-overlay" onClick={() => setShowPreview(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Preview — {form.name}</h3>
              <button className="toast-close" onClick={() => setShowPreview(false)}>×</button>
            </div>

            <div className="form-group">
              <label htmlFor="preview-data">Test Data (JSON)</label>
              <textarea
                id="preview-data"
                value={previewData}
                onChange={(e) => setPreviewData(e.target.value)}
                rows={4}
                placeholder='{"user": {"firstName": "Alice"}, "order": {"id": "ORD-001"}}'
              />
            </div>

            <button
              id="render-preview-btn"
              className="btn btn-primary"
              onClick={handlePreview}
              disabled={previewLoading}
            >
              {previewLoading ? 'Rendering…' : '▶ Render'}
            </button>

            {previewResult && !previewResult.error && (
              <div style={{ marginTop: 16 }}>
                {previewResult.subject && (
                  <div style={{ marginBottom: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Subject: <strong style={{ color: 'var(--text-primary)' }}>{previewResult.subject}</strong>
                  </div>
                )}
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <iframe
                    title="Template Preview"
                    srcDoc={previewResult.body}
                    style={{ width: '100%', height: 300, background: '#fff', border: 'none' }}
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            )}

            {previewResult?.error && (
              <div className="login-error" style={{ marginTop: 12 }}>{previewResult.error}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

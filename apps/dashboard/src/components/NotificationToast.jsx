// apps/dashboard/src/components/NotificationToast.jsx
// Fixed bottom-right toast container. Max 3 visible. Auto-dismisses after 4s.

import { useState, useEffect, useCallback } from 'react';

let toastIdCounter = 0;

// Singleton event emitter for toast management.
const listeners = new Set();
export function showToast(notification) {
  listeners.forEach((fn) => fn(notification));
}

function Toast({ toast, onDismiss }) {
  const [dismissing, setDismissing] = useState(false);

  const dismiss = useCallback(() => {
    setDismissing(true);
    setTimeout(() => onDismiss(toast.id), 300);
  }, [toast.id, onDismiss]);

  useEffect(() => {
    const timer = setTimeout(dismiss, 4000);
    return () => clearTimeout(timer);
  }, [dismiss]);

  const channelClass = toast.channel || 'inapp';

  return (
    <div className={`toast ${dismissing ? 'dismissing' : ''}`}>
      <div className="toast-header">
        <span className="toast-title">
          <span className={`badge badge-${channelClass.replace('-', '')}`} style={{ marginRight: 6 }}>
            {toast.templateName || 'Notification'}
          </span>
        </span>
        <button className="toast-close" onClick={dismiss} aria-label="Dismiss">×</button>
      </div>
      <div className="toast-body">
        User <span className="text-mono">{toast.userId || toast.data?.userId || '—'}</span>
        {toast.timestamp && (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
            just now
          </span>
        )}
      </div>
    </div>
  );
}

export default function NotificationToast() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = (notification) => {
      const id = ++toastIdCounter;
      setToasts((prev) => {
        // Max 3 toasts visible simultaneously.
        const next = [{ ...notification, id }, ...prev].slice(0, 3);
        return next;
      });
    };

    listeners.add(handler);
    return () => listeners.delete(handler);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}

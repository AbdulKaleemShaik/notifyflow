// apps/worker/src/services/templateRenderer.js
// Custom handlebars-style renderer — built from scratch, no external library.
// Supports {{variable}} and {{nested.variable}} dot-notation placeholders.

/**
 * Render a template string by replacing {{variable}} placeholders with data values.
 *
 * @param {string} template - HTML/text string with {{placeholder}} markers.
 * @param {object} data     - Key-value pairs to substitute.
 * @returns {string}        - Rendered string with placeholders replaced.
 *
 * Rules:
 *   - If a key resolves to a non-undefined value, it is stringified and inserted.
 *   - If a key is not found in data, the original {{placeholder}} is kept unchanged
 *     (so broken templates are obvious rather than silently producing empty strings).
 *   - Null/undefined data param is treated as an empty object (safe fallback).
 */
export function render(template, data) {
  if (!template || typeof template !== 'string') return template;
  const safeData = data && typeof data === 'object' ? data : {};

  return template.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
    // Support dot-notation: {{order.id}} → data.order.id
    const value = key.split('.').reduce((obj, k) => obj?.[k], safeData);
    return value !== undefined ? String(value) : match;
  });
}

export default { render };

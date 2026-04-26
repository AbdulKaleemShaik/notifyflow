// apps/worker/tests/templateRenderer.test.js
// Unit tests for the custom handlebars-style template renderer.

import { render } from '../src/services/templateRenderer.js';

describe('templateRenderer.render()', () => {
  test('renders single-level variables', () => {
    const result = render('Hello, {{name}}!', { name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  test('renders dot-notation nested variables', () => {
    const result = render('Order {{order.id}} — total: {{order.total}}', {
      order: { id: 'ORD-001', total: '$49.99' },
    });
    expect(result).toBe('Order ORD-001 — total: $49.99');
  });

  test('renders deeply nested dot-notation (3 levels)', () => {
    const result = render('Hello {{user.address.city}}', {
      user: { address: { city: 'Mumbai' } },
    });
    expect(result).toBe('Hello Mumbai');
  });

  test('leaves unknown placeholders unchanged', () => {
    const result = render('Hello {{unknown}}!', { name: 'Alice' });
    expect(result).toBe('Hello {{unknown}}!');
  });

  test('handles null data gracefully — leaves placeholders unchanged', () => {
    const result = render('Hello {{name}}!', null);
    expect(result).toBe('Hello {{name}}!');
  });

  test('handles undefined data gracefully — leaves placeholders unchanged', () => {
    const result = render('Total: {{order.total}}', undefined);
    expect(result).toBe('Total: {{order.total}}');
  });

  test('handles empty data object gracefully', () => {
    const result = render('{{greeting}} world', {});
    expect(result).toBe('{{greeting}} world');
  });

  test('coerces numeric values to strings', () => {
    const result = render('Count: {{count}}', { count: 42 });
    expect(result).toBe('Count: 42');
  });

  test('handles multiple placeholders in one template', () => {
    const result = render(
      'Dear {{user.firstName}}, your order {{order.id}} is {{status}}.',
      { user: { firstName: 'Bob' }, order: { id: 'ORD-002' }, status: 'shipped' }
    );
    expect(result).toBe('Dear Bob, your order ORD-002 is shipped.');
  });

  test('returns the template unchanged when template is empty string', () => {
    const result = render('', { name: 'Alice' });
    expect(result).toBe('');
  });

  test('partially resolves template — unknown keys stay, known keys resolve', () => {
    const result = render('{{known}} and {{unknown}}', { known: 'hello' });
    expect(result).toBe('hello and {{unknown}}');
  });
});

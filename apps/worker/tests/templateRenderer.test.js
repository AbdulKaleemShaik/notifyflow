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

// ─── Edge cases ───────────────────────────────────────────────────────────────
// These pin down current behaviour so changes to the renderer are deliberate.

describe('templateRenderer.render() — edge cases', () => {
  test('returns non-string templates untouched', () => {
    expect(render(null, { a: 1 })).toBeNull();
    expect(render(undefined, { a: 1 })).toBeUndefined();
    expect(render(42, { a: 1 })).toBe(42);
  });

  test('falsy-but-defined values are rendered, not treated as missing', () => {
    expect(render('{{zero}}|{{no}}|{{empty}}', { zero: 0, no: false, empty: '' })).toBe('0|false|');
  });

  test('null values render as the string "null"', () => {
    expect(render('Hi {{name}}', { name: null })).toBe('Hi null');
  });

  test('object values are stringified with String() (not JSON)', () => {
    expect(render('{{order}}', { order: { id: 1 } })).toBe('[object Object]');
    expect(render('{{tags}}', { tags: ['a', 'b'] })).toBe('a,b');
  });

  test('a missing intermediate key keeps the placeholder (no TypeError)', () => {
    expect(render('{{user.address.city}}', { user: {} })).toBe('{{user.address.city}}');
    expect(render('{{user.name}}', { user: null })).toBe('{{user.name}}');
  });

  test('array indexes work via dot-notation', () => {
    expect(render('{{items.0.sku}}', { items: [{ sku: 'SKU-1' }] })).toBe('SKU-1');
  });

  test('the same placeholder is replaced everywhere it appears', () => {
    expect(render('{{n}} + {{n}} = {{sum}}', { n: 2, sum: 4 })).toBe('2 + 2 = 4');
  });

  test('placeholders with spaces or hyphens are not recognised (kept verbatim)', () => {
    expect(render('{{ name }} {{first-name}}', { name: 'A', 'first-name': 'B' })).toBe('{{ name }} {{first-name}}');
  });

  test('single braces and unclosed tags are left alone', () => {
    expect(render('{name} {{name}', { name: 'A' })).toBe('{name} {{name}');
  });

  test('does NOT HTML-escape values (callers must sanitise untrusted data)', () => {
    expect(render('<p>{{msg}}</p>', { msg: '<script>x</script>' })).toBe('<p><script>x</script></p>');
  });

  test('inserted values are not re-scanned for placeholders (no template injection)', () => {
    expect(render('{{a}}', { a: '{{b}}', b: 'secret' })).toBe('{{b}}');
  });

  test('non-object data (string/number) is treated as empty', () => {
    expect(render('{{length}}', 'hello')).toBe('{{length}}');
    expect(render('{{x}}', 5)).toBe('{{x}}');
  });

  test('renders large templates quickly (linear single pass)', () => {
    const tpl = 'Hi {{name}}! '.repeat(10_000);
    const started = Date.now();
    const out = render(tpl, { name: 'Bob' });
    expect(out).toBe('Hi Bob! '.repeat(10_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

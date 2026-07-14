import { describe, it, expect } from 'vitest';
import { diffPayloads, formatDiffValue } from '@/lib/payloadDiff';

describe('diffPayloads', () => {
  it('reports changed scalar values with their path', () => {
    const d = diffPayloads({ temp: 20, unit: 'C' }, { temp: 21, unit: 'C' });
    expect(d).toEqual([{ path: 'temp', kind: 'changed', from: 20, to: 21 }]);
  });

  it('reports added and removed keys', () => {
    const d = diffPayloads({ a: 1 }, { b: 2 });
    expect(d).toContainEqual({ path: 'a', kind: 'removed', from: 1 });
    expect(d).toContainEqual({ path: 'b', kind: 'added', to: 2 });
  });

  it('walks nested objects and arrays', () => {
    const d = diffPayloads(
      { metrics: [{ name: 'x', value: 1 }], meta: { seq: 1 } },
      { metrics: [{ name: 'x', value: 2 }], meta: { seq: 2 } }
    );
    expect(d).toContainEqual({ path: 'metrics.0.value', kind: 'changed', from: 1, to: 2 });
    expect(d).toContainEqual({ path: 'meta.seq', kind: 'changed', from: 1, to: 2 });
  });

  it('returns empty for identical payloads (deep)', () => {
    expect(diffPayloads({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toEqual([]);
    expect(diffPayloads('same', 'same')).toEqual([]);
  });

  it('handles non-object payloads and type changes', () => {
    expect(diffPayloads('on', 'off')).toEqual([{ path: '(value)', kind: 'changed', from: 'on', to: 'off' }]);
    expect(diffPayloads(5, { v: 5 })).toEqual([{ path: '(value)', kind: 'changed', from: 5, to: { v: 5 } }]);
  });

  it('formatDiffValue truncates long objects', () => {
    const long = { data: 'x'.repeat(200) };
    expect(formatDiffValue(long).length).toBeLessThanOrEqual(80);
    expect(formatDiffValue(undefined)).toBe('∅');
  });
});

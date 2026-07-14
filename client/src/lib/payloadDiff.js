// Structural diff between two message payloads, for the topic history panel.
// Objects (and arrays, keyed by index) are walked deeply; anything else is a
// single value comparison. Returns a flat list of changes:
//   [{ path, kind: 'added' | 'removed' | 'changed', from?, to? }]
function isObj(v) {
  return v !== null && typeof v === 'object';
}

export function diffPayloads(a, b, path = '', out = []) {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, kind: 'added', to: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: 'removed', from: a[k] });
      else diffPayloads(a[k], b[k], p, out);
    }
    return out;
  }
  const same = Object.is(a, b) || (isObj(a) === isObj(b) && JSON.stringify(a) === JSON.stringify(b));
  if (!same) out.push({ path: path || '(value)', kind: 'changed', from: a, to: b });
  return out;
}

export function formatDiffValue(v) {
  if (v === undefined) return '∅';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 80 ? `${s.slice(0, 79)}…` : s;
    } catch {
      return '[object]';
    }
  }
  return String(v);
}

// Vitest runs in node — give browser-flavored modules the two globals they
// touch at import time (localStorage in the store, window checks in renderers).
const mem = new Map();
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear()
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

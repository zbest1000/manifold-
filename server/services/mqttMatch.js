'use strict';

/**
 * Per-message MQTT filter matching (3.1.1/5.0 semantics), for the DataOps
 * engines that test each tapped message against configured filters. The trie
 * answers "what does this filter match across all observed topics"; this
 * answers the inverse, "does this one topic match this filter" — O(segments),
 * no allocation beyond the splits.
 *
 * - `+` matches exactly one level; `#` the remainder (including zero levels).
 * - Wildcards at the first level do not match `$`-topics.
 * - Empty segments are significant (`a//b`).
 */
function matchParts(f, t) {
  for (let i = 0; i < f.length; i++) {
    const seg = f[i];
    if (seg === '#') {
      return !(i === 0 && t[0].charCodeAt(0) === 36 /* '$' */);
    }
    if (i >= t.length) return false;
    if (seg === '+') {
      if (i === 0 && t[0].charCodeAt(0) === 36) return false;
      continue;
    }
    if (seg !== t[i]) return false;
  }
  return t.length === f.length;
}

function matchFilter(filter, topic) {
  if (filter === topic) return true;
  return matchParts(String(filter).split('/'), String(topic).split('/'));
}

/**
 * Cached compiled view over profile-store config for per-message engines.
 * `build()` runs only when profiles.rev changes (every save bumps it), so the
 * per-message cost is one integer compare instead of Object.values() + filter
 * splitting per engine per message. Test fakes without a `rev` rebuild every
 * call, which preserves the naive semantics.
 */
function compiledView(profiles, build) {
  let rev = -1;
  let value = null;
  return () => {
    const cur = profiles.rev ?? rev + 1;
    if (cur !== rev) {
      rev = cur;
      value = build();
    }
    return value;
  };
}

module.exports = { matchFilter, matchParts, compiledView };

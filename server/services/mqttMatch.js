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
function matchFilter(filter, topic) {
  if (filter === topic) return true;
  const f = String(filter).split('/');
  const t = String(topic).split('/');
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

module.exports = { matchFilter };

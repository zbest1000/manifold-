'use strict';

const dns = require('dns').promises;
const net = require('net');
const { fetchWithTimeout } = require('./httpTimeout');

/**
 * Egress guard — one chokepoint every outbound connection the *caller* cannot
 * make directly (network scan probes, i3X / CESMII / broker-admin HTTP fetches)
 * must pass through, so Manifold cannot be turned into an SSRF pivot or an
 * internal port scanner.
 *
 * Two tiers of blocking:
 *
 *  - ALWAYS blocked, no opt-out — ranges that have no legitimate reason to be a
 *    broker / i3X / scan target and are the classic SSRF crown jewels:
 *    loopback, the cloud-metadata link-local block (169.254.0.0/16 incl.
 *    169.254.169.254), IPv6 link-local, unspecified, multicast, and reserved /
 *    carrier-grade-NAT space.
 *
 *  - Blocked BY DEFAULT (fail-closed), allowed with MANIFOLD_ALLOW_PRIVATE_TARGETS=1
 *    — RFC1918 and IPv6 ULA. This is the SSRF-sensitive tier: an internet-exposed
 *    instance must not become a pivot into a LAN. On-prem/LAN deployments, where
 *    Discovery scanning the plant subnet and reaching on-prem i3X/CESMII is the
 *    point, opt in explicitly (the Docker demo sets it, since it is a local-only
 *    demo). The server logs a loud startup warning whenever this opt-in is on.
 *
 * Hostnames are resolved and every returned address is checked before the
 * connection is made. This stops literal-IP SSRF and hostname-points-inward
 * SSRF. It does NOT fully stop DNS rebinding (a name that passes the check then
 * re-resolves to an internal IP on the real connection) — closing that requires
 * pinning the validated IP, which global fetch does not expose; documented as a
 * residual risk rather than silently implied.
 */

// Fail-closed: private/RFC1918/ULA targets are blocked unless the operator
// explicitly opts in. Loopback, cloud metadata, multicast and reserved ranges
// are ALWAYS blocked regardless of this flag.
const ALLOW_PRIVATE = process.env.MANIFOLD_ALLOW_PRIVATE_TARGETS === '1';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidrV4(ipInt, baseIp, prefix) {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

// Never-legitimate IPv4 ranges — blocked regardless of the private opt-in.
const HARD_BLOCK_V4 = [
  ['0.0.0.0', 8], // "this host"
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local INCLUDING 169.254.169.254 cloud metadata
  ['100.64.0.0', 10], // carrier-grade NAT
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved
];

// RFC1918 — dual-use on a plant LAN, blocked unless the operator opts in.
const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
];

function classifyV4(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return 'invalid';
  if (HARD_BLOCK_V4.some(([b, p]) => inCidrV4(ipInt, b, p))) return 'hard-blocked';
  if (PRIVATE_V4.some(([b, p]) => inCidrV4(ipInt, b, p))) return 'private';
  return 'public';
}

function classifyV6(ip) {
  const lower = ip.toLowerCase().split('%')[0]; // strip zone id
  // IPv4-mapped (::ffff:1.2.3.4) — classify by the embedded v4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyV4(mapped[1]);
  if (lower === '::1') return 'hard-blocked'; // loopback
  if (lower === '::' || lower === '') return 'hard-blocked'; // unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return 'hard-blocked'; // fe80::/10 link-local
  }
  if (lower.startsWith('ff')) return 'hard-blocked'; // multicast
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private'; // fc00::/7 ULA
  return 'public';
}

function classifyAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) return classifyV4(ip);
  if (version === 6) return classifyV6(ip);
  return 'invalid';
}

/** True if a raw IP string is an acceptable connection target under current policy. */
function isAllowedAddress(ip) {
  const cls = classifyAddress(ip);
  if (cls === 'public') return true;
  if (cls === 'private') return ALLOW_PRIVATE;
  return false; // hard-blocked or invalid
}

class EgressBlockedError extends Error {
  constructor(target, reason) {
    super(
      `Egress to ${target} blocked: ${reason}.` +
        (reason === 'private/internal address'
          ? ' Set MANIFOLD_ALLOW_PRIVATE_TARGETS=1 to allow RFC1918/LAN targets (safe only on a trusted network).'
          : '')
    );
    this.name = 'EgressBlockedError';
    this.target = target;
    this.code = 'EGRESS_BLOCKED';
  }
}

function reasonFor(cls) {
  if (cls === 'invalid') return 'unresolvable or malformed address';
  if (cls === 'hard-blocked') return 'loopback/link-local/reserved address';
  return 'private/internal address';
}

/**
 * Resolve `host` and throw EgressBlockedError unless every resolved address is
 * allowed. A literal IP is checked directly (no DNS).
 */
async function assertAllowedHost(host) {
  if (!host) throw new EgressBlockedError(String(host), 'unresolvable or malformed address');
  if (net.isIP(host)) {
    if (!isAllowedAddress(host)) throw new EgressBlockedError(host, reasonFor(classifyAddress(host)));
    return;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new EgressBlockedError(host, 'unresolvable or malformed address');
  }
  if (!records.length) throw new EgressBlockedError(host, 'unresolvable or malformed address');
  for (const { address } of records) {
    if (!isAllowedAddress(address)) {
      throw new EgressBlockedError(`${host} (${address})`, reasonFor(classifyAddress(address)));
    }
  }
}

/** fetchWithTimeout with an SSRF pre-check on the URL host. */
async function guardedFetch(url, options = {}, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(String(url), 'unresolvable or malformed address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError(parsed.protocol, 'only http(s) is allowed');
  }
  await assertAllowedHost(parsed.hostname);
  return fetchWithTimeout(url, options, timeoutMs);
}

module.exports = {
  guardedFetch,
  assertAllowedHost,
  isAllowedAddress,
  classifyAddress,
  EgressBlockedError,
  ALLOW_PRIVATE
};

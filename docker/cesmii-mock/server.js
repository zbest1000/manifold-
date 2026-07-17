'use strict';

// Minimal mock of the CESMII SMIP GraphQL API — just enough for Manifold's
// Cesmii page to authenticate, list equipment/attributes, and chart history.
// It does NOT parse GraphQL; it dispatches on the operation text Manifold sends.

const express = require('express');

const PORT = Number(process.env.PORT || 4000);

// ---- Synthetic SMIP object model ------------------------------------------
const EQUIPMENT = [
  { id: 1, displayName: 'Filling Line 1' },
  { id: 2, displayName: 'Packaging Robot' },
  { id: 3, displayName: 'Boiler House' }
];

const PLACES = [
  { id: 10, displayName: 'Plant A' },
  { id: 11, displayName: 'Plant A / Line 1' }
];

// `id` here is what Manifold feeds back into the history query.
const ATTRIBUTES = [
  { id: 101, displayName: 'Filling Line 1 / Flow Rate (L/min)', base: 42, amp: 8, period: 3600 },
  { id: 102, displayName: 'Filling Line 1 / Fill Temp (C)', base: 68, amp: 4, period: 5400 },
  { id: 103, displayName: 'Packaging Robot / Cycle Time (s)', base: 2.4, amp: 0.3, period: 1800 },
  { id: 104, displayName: 'Packaging Robot / Vibration (mm/s)', base: 1.1, amp: 0.6, period: 900 },
  { id: 105, displayName: 'Boiler House / Steam Pressure (bar)', base: 9.5, amp: 1.2, period: 7200 },
  { id: 106, displayName: 'Boiler House / Water Level (%)', base: 75, amp: 10, period: 4800 }
];

// ---- Helpers ---------------------------------------------------------------
function parseTs(value, fallbackMs) {
  if (!value) return fallbackMs;
  let t = String(value).trim().replace(' ', 'T');
  // SMIP "+00" -> ISO "Z"; bare "+07" -> "+07:00"
  t = t.replace(/\+00(:00)?$/i, 'Z').replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? fallbackMs : ms;
}

function fmtTs(ms) {
  // SMIP-flavoured timestamp: "2026-07-10 00:00:00.000+00"
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
}

function synthSeries(id, startMs, endMs, maxSamples) {
  const attr = ATTRIBUTES.find((a) => String(a.id) === String(id)) || { base: 50, amp: 10, period: 3600 };
  const n = Math.max(2, Math.min(Number(maxSamples) > 0 ? Number(maxSamples) : 100, 5000));
  const span = Math.max(1, endMs - startMs);
  const step = span / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const tMs = startMs + i * step;
    const phase = (tMs / 1000 / attr.period) * 2 * Math.PI;
    const noise = (Math.sin(tMs / 137) + Math.cos(tMs / 311)) * attr.amp * 0.15;
    const value = attr.base + Math.sin(phase) * attr.amp + noise;
    out.push({
      id: String(id),
      ts: fmtTs(tMs),
      floatvalue: Number(value.toFixed(4)),
      stringvalue: null,
      dataType: 'Double'
    });
  }
  return out;
}

let challengeSeq = 0;
const gql = (res, data) => res.json({ data });
const gqlError = (res, message) => res.json({ errors: [{ message }] });

// ---- Server ----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'cesmii-mock' }));

app.post('/graphql', (req, res) => {
  const { query = '', variables = {} } = req.body || {};

  // Auth step 1 -> challenge
  if (query.includes('authenticationRequest')) {
    const challenge = `chal-${Date.now()}-${challengeSeq++}`;
    return gql(res, {
      authenticationRequest: {
        jwtRequest: { challenge, message: 'sign this challenge with your secret' }
      }
    });
  }

  // Auth step 2 -> jwtClaim (mock accepts any secret)
  if (query.includes('authenticationValidation')) {
    const signed = String(variables.signedChallenge || '');
    if (!signed.split('|')[0]) return gqlError(res, 'authenticationValidation: missing signedChallenge');
    const payload = Buffer.from(
      JSON.stringify({
        role: 'smip',
        authenticator: variables.authenticator || 'mock',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 1800
      })
    ).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.mock-signature`;
    return gql(res, { authenticationValidation: { jwtClaim: jwt } });
  }

  // History (checked before catalog matches)
  if (query.includes('getRawHistoryDataWithSampling')) {
    const ids = Array.isArray(variables.ids) ? variables.ids : [];
    const now = Date.now();
    const startMs = parseTs(variables.startTime, now - 7 * 864e5);
    const endMs = parseTs(variables.endTime, now);
    const samples = ids.flatMap((id) => synthSeries(id, startMs, endMs, variables.maxSamples));
    return gql(res, { getRawHistoryDataWithSampling: samples });
  }

  // Catalog queries
  if (query.includes('equipments')) return gql(res, { equipments: EQUIPMENT });
  if (query.includes('places')) return gql(res, { places: PLACES });
  if (query.includes('attributes')) {
    return gql(res, { attributes: ATTRIBUTES.map((a) => ({ id: a.id, displayName: a.displayName })) });
  }

  return gqlError(res, 'mock SMIP: unrecognised query');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`cesmii-mock SMIP GraphQL listening on http://0.0.0.0:${PORT}/graphql`);
});

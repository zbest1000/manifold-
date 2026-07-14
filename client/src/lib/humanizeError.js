// Translate a raw backend/network error string into a clear summary + a short
// code + an actionable hint. Rules are checked most-specific-first; anything
// unrecognized passes through unchanged so no information is lost. The original
// text is always kept alongside (as meta.raw) for the technically curious.

const RULES = [
  // DNS / connectivity
  { test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i, code: 'ENOTFOUND', summary: 'Host not found.', hint: 'Check the hostname or IP is correct and resolvable.' },
  { test: /ECONNREFUSED/i, code: 'ECONNREFUSED', summary: 'Connection refused — nothing is listening on that host and port.', hint: 'Verify the broker is running and the port is right.' },
  { test: /ETIMEDOUT|timed?\s?out/i, code: 'ETIMEDOUT', summary: 'Connection timed out.', hint: 'The host may be unreachable or blocked by a firewall.' },
  { test: /ECONNRESET/i, code: 'ECONNRESET', summary: 'Connection reset by the remote host.', hint: 'The broker closed the connection unexpectedly.' },
  { test: /EHOSTUNREACH|ENETUNREACH/i, code: 'EHOSTUNREACH', summary: 'Host unreachable — no network route.', hint: 'Check you are on the same network / VPN.' },
  { test: /EPIPE/i, code: 'EPIPE', summary: 'Connection broke while sending data.', hint: 'The connection dropped mid-write; retry.' },
  { test: /Failed to fetch|NetworkError|Load failed/i, code: 'NETWORK', summary: "Can't reach the server.", hint: 'Is the backend running on the expected port?' },

  // TLS
  { test: /CERT_HAS_EXPIRED/i, code: 'TLS', summary: "The broker's TLS certificate has expired.", hint: 'Renew it, or allow untrusted certs for local testing.' },
  { test: /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT/i, code: 'TLS', summary: 'The broker uses a self-signed TLS certificate.', hint: 'Add its CA, or allow self-signed certs for testing.' },
  { test: /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i, code: 'TLS', summary: "Couldn't verify the TLS certificate chain.", hint: 'Provide the CA certificate.' },
  { test: /ALTNAME|does not match certificate|Hostname\/IP does not match/i, code: 'TLS', summary: 'TLS certificate hostname mismatch.', hint: 'The certificate was issued for a different host.' },

  // MQTT CONNACK refusals
  { test: /not authoriz|not authorised/i, code: 'MQTT', summary: 'Broker refused the connection: not authorized.', hint: 'Check the username, password, and broker ACLs.' },
  { test: /bad user\s?name or password|bad username/i, code: 'MQTT', summary: 'Broker rejected the username or password.', hint: 'Verify the credentials.' },
  { test: /identifier reject/i, code: 'MQTT', summary: 'Broker rejected the client ID.', hint: 'Use a different, unique client ID.' },
  { test: /server unavailable/i, code: 'MQTT', summary: 'Broker is unavailable.', hint: 'It is reachable but not accepting connections right now.' },
  { test: /unacceptable protocol version/i, code: 'MQTT', summary: 'Broker rejected the MQTT protocol version.', hint: 'Try switching between MQTT 3.1.1 and 5.0.' }
];

const HTTP = {
  400: ['Bad request.', 'The request was malformed.'],
  401: ['Unauthorized.', 'Set the access token (MANIFOLD_AUTH_TOKEN) and unlock.'],
  403: ['Forbidden.', 'You do not have permission for this action.'],
  404: ['Not found.', 'That resource or endpoint does not exist.'],
  408: ['Request timed out.', 'The server took too long to respond.'],
  409: ['Conflict.', 'The resource is in a conflicting state.'],
  413: ['Payload too large.', 'Reduce the request size.'],
  429: ['Rate limited.', 'Too many requests — slow down and retry.'],
  500: ['Server error.', 'Something failed on the backend — check the server logs.'],
  502: ['Bad gateway.', 'The upstream server is unreachable.'],
  503: ['Service unavailable.', 'The server is overloaded or down.'],
  504: ['Gateway timeout.', 'The upstream server did not respond in time.']
};

export function humanizeError(raw) {
  const message = String(raw ?? '').trim() || 'Unknown error';

  const httpMatch = message.match(/\((\d{3})\)/) || message.match(/\bstatus\s(\d{3})\b/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const [summary, hint] = HTTP[status] || [`Request failed (HTTP ${status}).`, ''];
    return { code: `HTTP ${status}`, summary, hint };
  }

  for (const rule of RULES) {
    if (rule.test.test(message)) {
      return { code: rule.code, summary: rule.summary, hint: rule.hint };
    }
  }

  return { code: null, summary: message, hint: '' };
}

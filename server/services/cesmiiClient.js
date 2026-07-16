const { guardedFetch } = require('./egressGuard');
const { EventEmitter } = require('events');

/**
 * Client for the CESMII Smart Manufacturing Innovation Platform (SMIP) GraphQL API.
 *
 * SMIP normalizes manufacturing data behind an OPC-UA-based object model exposed
 * over GraphQL, which pairs naturally with this tool's MQTT + OPC UA views. The
 * client handles the platform's two-step JWT handshake, caches the token until it
 * nears expiry, and offers helpers for the common equipment / attribute / history
 * queries plus a raw passthrough.
 *
 * Auth flow (per the CESMII GraphQL-API docs):
 *   1. authenticationRequest(authenticator, role, userName) -> { challenge }
 *   2. authenticationValidation(signedChallenge: "<challenge>|<secret>", authenticator) -> jwtClaim
 *   3. Send "Authorization: Bearer <jwtClaim>" on subsequent requests.
 */
class CesmiiClient extends EventEmitter {
  constructor() {
    super();
    this.config = null; // { endpoint, authenticator, role, userName, secret }
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  isConfigured() {
    return Boolean(this.config?.endpoint);
  }

  configure(config = {}) {
    if (!config.endpoint) throw new Error('endpoint is required (e.g. https://<instance>.cesmii.net/graphql)');
    if (!config.authenticator) throw new Error('authenticator is required');
    if (!config.role) throw new Error('role is required');
    if (!config.userName) throw new Error('userName is required');
    if (!config.secret) throw new Error('secret (password/API key) is required');

    this.config = {
      endpoint: config.endpoint,
      authenticator: config.authenticator,
      role: config.role,
      userName: config.userName,
      secret: config.secret
    };
    // Force re-auth against the new config
    this.token = null;
    this.tokenExpiresAt = 0;
    return this.status();
  }

  status() {
    return {
      configured: this.isConfigured(),
      endpoint: this.config?.endpoint || null,
      authenticated: Boolean(this.token) && Date.now() < this.tokenExpiresAt,
      userName: this.config?.userName || null,
      role: this.config?.role || null
    };
  }

  reset() {
    this.config = null;
    this.token = null;
    this.tokenExpiresAt = 0;
    return this.status();
  }

  async post(body, headers = {}) {
    if (!this.isConfigured()) throw new Error('CESMII client is not configured');
    let res;
    try {
      res = await guardedFetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(`CESMII request failed: ${error.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.errors?.[0]?.message || `CESMII HTTP ${res.status}`);
    }
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }
    return json.data;
  }

  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { authenticator, role, userName, secret } = this.config;

    // Step 1 — request a challenge
    const requestData = await this.post({
      query: `mutation Req($authenticator: String!, $role: String!, $userName: String!) {
        authenticationRequest(input: { authenticator: $authenticator, role: $role, userName: $userName }) {
          jwtRequest { challenge message }
        }
      }`,
      variables: { authenticator, role, userName }
    });

    const challenge = requestData?.authenticationRequest?.jwtRequest?.challenge;
    if (!challenge) throw new Error('CESMII authentication: no challenge returned');

    // Step 2 — validate the signed challenge to obtain the JWT
    const validateData = await this.post({
      query: `mutation Val($signedChallenge: String!, $authenticator: String!) {
        authenticationValidation(input: { signedChallenge: $signedChallenge, authenticator: $authenticator }) {
          jwtClaim
        }
      }`,
      variables: { signedChallenge: `${challenge}|${secret}`, authenticator }
    });

    const jwt = validateData?.authenticationValidation?.jwtClaim;
    if (!jwt) throw new Error('CESMII authentication: no JWT returned (check credentials)');

    this.token = jwt;
    // Tokens default to 30 minutes; refresh a minute early to avoid edge expiry
    this.tokenExpiresAt = Date.now() + 29 * 60 * 1000;
    this.emit('authenticated', this.status());
    return jwt;
  }

  async query(gql, variables = {}) {
    const token = await this.authenticate();
    return this.post({ query: gql, variables }, { Authorization: `Bearer ${token}` });
  }

  listEquipment() {
    return this.query(`query { equipments { id displayName } }`).then((d) => d?.equipments || []);
  }

  listPlaces() {
    return this.query(`query { places { id displayName } }`).then((d) => d?.places || []);
  }

  listAttributes() {
    return this.query(`query { attributes { id displayName } }`).then((d) => d?.attributes || []);
  }

  /**
   * Retrieve historical samples for one or more attribute (tag) ids.
   * @param {string[]} ids attribute ids
   * @param {string} startTime ISO / SMIP timestamp
   * @param {string} endTime ISO / SMIP timestamp
   * @param {number} maxSamples 0 disables down-sampling
   */
  async getHistory(ids, startTime, endTime, maxSamples = 100) {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids must be a non-empty array');
    if (!startTime || !endTime) throw new Error('startTime and endTime are required');

    return this.query(
      `query History($ids: [BigInt]!, $startTime: Datetime!, $endTime: Datetime!, $maxSamples: Int!) {
        getRawHistoryDataWithSampling(ids: $ids, startTime: $startTime, endTime: $endTime, maxSamples: $maxSamples) {
          id
          ts
          floatvalue
          stringvalue
          dataType
        }
      }`,
      { ids: ids.map(String), startTime, endTime, maxSamples }
    ).then((d) => d?.getRawHistoryDataWithSampling || []);
  }
}

module.exports = CesmiiClient;

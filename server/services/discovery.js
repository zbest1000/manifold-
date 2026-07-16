const net = require('net');
const os = require('os');
const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { isAllowedAddress } = require('./egressGuard');

const DEFAULT_MQTT_PORTS = [1883, 8883];
const DEFAULT_OPCUA_PORTS = [4840];
const DEFAULT_I3X_PORTS = [80, 443, 8080];
// Common base paths an i3X server might be mounted under; each open HTTP port is
// checked for a live /info document at one of these prefixes.
const DEFAULT_I3X_PATHS = ['', '/v1', '/i3x', '/i3x/v1'];
const PROBE_TIMEOUT_MS = 1200;
const IDENTIFY_TIMEOUT_MS = 4000;
const MAX_CONCURRENT_PROBES = 64;

/**
 * Honest network discovery: TCP port probing across a CIDR range followed by a
 * real protocol handshake to confirm what is listening. No synthetic results.
 */
class DiscoveryService extends EventEmitter {
  constructor(io, deps = {}) {
    super();
    this.io = io;
    this.i3x = deps.i3x || null; // used to verify discovered i3X HTTP endpoints
    this.scanning = false;
    this.abortRequested = false;
    this.lastResults = [];
  }

  async identifyI3xServer(host, port) {
    if (!this.i3x) return null;
    const scheme = port === 443 ? 'https' : 'http';
    for (const path of DEFAULT_I3X_PATHS) {
      const baseUrl = `${scheme}://${host}:${port}${path}`;
      const info = await this.i3x.probe(baseUrl);
      if (info) {
        return { verified: true, baseUrl, serverName: info.serverName || null, specVersion: info.specVersion || null };
      }
    }
    return null;
  }

  isScanning() {
    return this.scanning;
  }

  getLastResults() {
    return this.lastResults;
  }

  detectLocalSubnet() {
    const interfaces = os.networkInterfaces();
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const octets = addr.address.split('.');
          return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
        }
      }
    }
    return null;
  }

  expandCidr(cidr) {
    const [base, prefixStr] = cidr.split('/');
    const prefix = Number(prefixStr ?? 32);
    const octets = base.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      throw new Error(`Invalid CIDR: ${cidr}`);
    }
    if (Number.isNaN(prefix) || prefix < 16 || prefix > 32) {
      throw new Error('CIDR prefix must be between /16 and /32');
    }

    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const hostBits = 32 - prefix;
    const network = (baseInt >> hostBits << hostBits) >>> 0;
    const count = 2 ** hostBits;

    const hosts = [];
    const start = count > 2 ? 1 : 0; // skip network address for real subnets
    const end = count > 2 ? count - 1 : count; // skip broadcast address
    for (let i = start; i < end; i++) {
      const ip = (network + i) >>> 0;
      hosts.push([ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'));
    }
    return hosts;
  }

  probePort(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (open) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  identifyMqttBroker(host, port) {
    return new Promise((resolve) => {
      const protocol = port === 8883 ? 'mqtts' : 'mqtt';
      const client = mqtt.connect(`${protocol}://${host}:${port}`, {
        connectTimeout: IDENTIFY_TIMEOUT_MS,
        reconnectPeriod: 0,
        rejectUnauthorized: false,
        clientId: `tc-probe_${Math.random().toString(16).slice(2, 10)}`
      });

      const timer = setTimeout(() => {
        client.end(true);
        resolve(null);
      }, IDENTIFY_TIMEOUT_MS + 1000);

      client.once('connect', (connack) => {
        clearTimeout(timer);
        client.end(true);
        resolve({ verified: true, anonymousAccess: true, connack: { sessionPresent: connack.sessionPresent } });
      });

      client.once('error', (error) => {
        clearTimeout(timer);
        client.end(true);
        // Auth errors still prove an MQTT broker is answering
        if (/not authorized|bad user name|identifier rejected/i.test(error.message)) {
          resolve({ verified: true, anonymousAccess: false, error: error.message });
        } else {
          resolve(null);
        }
      });
    });
  }

  async startScan(options = {}) {
    if (this.scanning) {
      throw new Error('A scan is already running');
    }

    const range = options.range || this.detectLocalSubnet();
    if (!range) {
      throw new Error('No scan range provided and no local subnet detected');
    }

    const mqttPorts = options.mqttPorts || DEFAULT_MQTT_PORTS;
    const opcuaPorts = options.opcuaPorts || DEFAULT_OPCUA_PORTS;
    const i3xPorts = options.i3xPorts || (options.includeI3x === false ? [] : DEFAULT_I3X_PORTS);
    const ports = [
      ...mqttPorts.map((p) => ({ port: p, kind: 'mqtt' })),
      ...opcuaPorts.map((p) => ({ port: p, kind: 'opcua' })),
      ...i3xPorts.map((p) => ({ port: p, kind: 'i3x' }))
    ];

    const allHosts = this.expandCidr(range);
    // Every probe target passes the egress guard: loopback, link-local (incl.
    // 169.254.169.254 cloud metadata), multicast and reserved space are always
    // rejected; RFC1918 requires MANIFOLD_ALLOW_PRIVATE_TARGETS=1. This stops the
    // scanner being used as an unauthenticated internal recon / SSRF pivot.
    const hosts = allHosts.filter((host) => isAllowedAddress(host));
    const blocked = allHosts.length - hosts.length;
    if (hosts.length === 0) {
      throw new Error(
        `Every host in ${range} is a blocked target (loopback/link-local/reserved, ` +
          `or RFC1918 without MANIFOLD_ALLOW_PRIVATE_TARGETS=1). Nothing to scan.`
      );
    }

    const jobs = [];
    hosts.forEach((host) => ports.forEach(({ port, kind }) => jobs.push({ host, port, kind })));

    this.scanning = true;
    this.abortRequested = false;
    this.lastResults = [];
    this.io.emit('discovery-started', { range, ports: ports.map((p) => p.port), totalProbes: jobs.length, blockedHosts: blocked });

    let completed = 0;
    const results = [];

    const worker = async () => {
      while (jobs.length > 0 && !this.abortRequested) {
        const job = jobs.shift();
        const open = await this.probePort(job.host, job.port);
        completed++;

        if (open) {
          const candidate = {
            host: job.host,
            port: job.port,
            kind: job.kind,
            verified: false,
            discoveredAt: new Date().toISOString()
          };

          if (job.kind === 'mqtt') {
            const identity = await this.identifyMqttBroker(job.host, job.port);
            if (identity) {
              Object.assign(candidate, identity);
            }
          } else if (job.kind === 'opcua') {
            // An open 4840 is a strong OPC UA signal; full verification happens on connect
            candidate.endpointUrl = `opc.tcp://${job.host}:${job.port}`;
          } else if (job.kind === 'i3x') {
            const identity = await this.identifyI3xServer(job.host, job.port);
            if (!identity) {
              // Open HTTP port that isn't an i3X server — not a result we report
              continue;
            }
            Object.assign(candidate, identity);
          }

          results.push(candidate);
          this.io.emit('discovery-result', candidate);
        }

        if (completed % 50 === 0 || jobs.length === 0) {
          this.io.emit('discovery-progress', {
            completed,
            total: completed + jobs.length,
            found: results.length
          });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_PROBES, jobs.length) },
      () => worker()
    );

    // Run scan asynchronously; callers observe progress via socket events
    Promise.all(workers)
      .then(() => {
        this.scanning = false;
        this.lastResults = results;
        this.io.emit('discovery-complete', {
          range,
          aborted: this.abortRequested,
          found: results.length,
          results
        });
      })
      .catch((error) => {
        this.scanning = false;
        this.io.emit('discovery-error', { error: error.message });
      });

    return { range, totalProbes: jobs.length, status: 'scanning' };
  }

  stopScan() {
    this.abortRequested = true;
    return { status: 'stopping' };
  }
}

module.exports = DiscoveryService;

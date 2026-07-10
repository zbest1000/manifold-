// Wait for a set of host:port TCP endpoints to accept connections, so the app
// only tries to restore its saved broker/OPC UA profiles once they are up.
// Usage: node wait-for.js host1 port1 host2 port2 ...
const net = require('net');

const pairs = [];
for (let i = 2; i + 1 < process.argv.length; i += 2) {
  pairs.push([process.argv[i], Number(process.argv[i + 1])]);
}

const OVERALL_TIMEOUT_MS = 60000;
const deadline = Date.now() + OVERALL_TIMEOUT_MS;

function probe(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

(async () => {
  for (const [host, port] of pairs) {
    process.stdout.write(`wait-for: ${host}:${port} ... `);
    let up = false;
    while (Date.now() < deadline) {
      if (await probe(host, port)) {
        up = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(up ? 'up' : 'timeout (continuing)');
  }
})();

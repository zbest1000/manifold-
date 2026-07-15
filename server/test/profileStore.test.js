const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ProfileStore = require('../services/profileStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tc-profiles-'));
}

test('profiles persist across instances (restart survival)', () => {
  const dir = tmpDir();
  const a = new ProfileStore(dir);
  a.upsertBroker('b1', { id: 'b1', host: '10.0.0.5', port: 1883, username: 'u', password: 'p' });
  a.setBrokerAdmin('b1', { type: 'emqx', url: 'http://h:18083/api/v5', apiKey: 'k', apiSecret: 's' });
  a.upsertOpcua('o1', { id: 'o1', endpointUrl: 'opc.tcp://plc:4840' });
  a.setCesmii({ endpoint: 'https://smip/graphql', userName: 'x' });
  a.setI3x({ baseUrl: 'http://i3x:8080' });

  const b = new ProfileStore(dir); // fresh instance = simulated restart
  assert.strictEqual(b.brokers().length, 1);
  assert.strictEqual(b.brokers()[0].config.host, '10.0.0.5');
  assert.strictEqual(b.brokers()[0].admin.apiSecret, 's');
  assert.strictEqual(b.opcuaEndpoints()[0].endpointUrl, 'opc.tcp://plc:4840');
  assert.strictEqual(b.data.cesmii.endpoint, 'https://smip/graphql');
  assert.strictEqual(b.data.i3x.baseUrl, 'http://i3x:8080');
});

test('removals persist too', () => {
  const dir = tmpDir();
  const a = new ProfileStore(dir);
  a.upsertBroker('b1', { id: 'b1', host: 'h' });
  a.removeBroker('b1');
  a.setI3x({ baseUrl: 'http://x' });
  a.clearI3x();

  const b = new ProfileStore(dir);
  assert.strictEqual(b.brokers().length, 0);
  assert.strictEqual(b.data.i3x, null);
});

test('profiles file is owner-only (0600)', () => {
  const dir = tmpDir();
  const a = new ProfileStore(dir);
  a.upsertBroker('b1', { id: 'b1', host: 'h', password: 'secret' });
  const mode = fs.statSync(path.join(dir, 'profiles.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('corrupt file falls back to empty state without crashing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{not json');
  const a = new ProfileStore(dir);
  assert.deepStrictEqual(a.brokers(), []);
});

test('corrupt profiles file is backed up to .bak, not silently discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-prof-bak-'));
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, '{ this is not json');
  const ProfileStore = require('../services/profileStore');
  const store = new ProfileStore(dir);
  assert.deepStrictEqual(store.listMqtt?.() ?? [], []);
  assert.ok(fs.existsSync(`${file}.bak`), 'corrupt content must be preserved as .bak');
  assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), '{ this is not json');
  fs.rmSync(dir, { recursive: true, force: true });
});

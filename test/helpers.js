'use strict';

const { Store } = require('../lib/store');
const { createAuth } = require('../lib/auth');
const { createApp } = require('../lib/app');
const loadConfig = require('../lib/config');

const silent = { log() {}, warn() {}, error() {} };

function testConfig(overrides = {}) {
  return {
    ...loadConfig({
      TUYA_ACCESS_ID: 'id', TUYA_SECRET_KEY: 'secret',
      GOOGLE_CLIENT_ID: 'client-id', ALLOWED_EMAIL: 'Me@Example.com',
      SESSION_SECRET: 'x'.repeat(40),
    }),
    ...overrides,
  };
}

function memoryStore(initial) {
  let saved = initial || null;
  const backend = {
    name: 'memory',
    async load() { return saved; },
    async save(state) { saved = JSON.parse(JSON.stringify(state)); },
    get saved() { return saved; },
  };
  return new Store(backend);
}

function fakeTuya() {
  const calls = [];
  const svc = {
    calls,
    failNext: 0,
    invalidate() {},
    async execute(task) {
      calls.push({ ...task });
      if (svc.failNext > 0) { svc.failNext -= 1; throw new Error('boom'); }
      return true;
    },
    async listDevices() { return [{ id: 'dev1234', name: 'דוד', category: 'kg', status: [] }]; },
    async listRemotes() { return []; },
    async sendSwitch(id, commands) { calls.push({ sw: id, commands }); return true; },
    async sendAcCommand(hub, id, code, value) { calls.push({ ac: id, code, value }); return true; },
    async getAcStatus() { return { power: 1, mode: 0, temp: 24, wind: 0 }; },
    async sendTvKey() { return true; },
    async describeDevice(id) { return { deviceId: id }; },
  };
  return svc;
}

function fakeGoogle(payloadByToken) {
  return {
    async verifyIdToken({ idToken }) {
      const payload = payloadByToken[idToken];
      if (!payload) throw new Error('bad token');
      return { getPayload: () => payload };
    },
  };
}

async function startApp({ store, tuya } = {}) {
  const config = testConfig();
  store = store || (await memoryStore().init());
  tuya = tuya || fakeTuya();
  const auth = createAuth({
    config,
    googleClient: fakeGoogle({
      good: { email: 'me@example.com', email_verified: true, name: 'Me' },
      stranger: { email: 'other@example.com', email_verified: true, name: 'Other' },
      unverified: { email: 'me@example.com', email_verified: false },
    }),
  });
  const app = createApp({ config, store, tuya, auth, logger: silent });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };

  const login = async () => (await request('/api/auth/google', { method: 'POST', body: { credential: 'good' } })).json.token;
  return { request, login, store, tuya, config, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { silent, testConfig, memoryStore, fakeTuya, startApp };

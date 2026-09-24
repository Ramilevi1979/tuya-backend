'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTuyaService, isHub } = require('../lib/tuya');
const loadConfig = require('../lib/config');
const { skipTodayIfPast } = require('../lib/scheduler');
const { silent } = require('./helpers');

function clientWith(handler) {
  const requests = [];
  return {
    requests,
    async request({ method, path, body }) {
      requests.push({ method, path, body });
      return handler({ method, path, body });
    },
  };
}

test('only real IR hubs are detected (not anything with "ir" in its name)', () => {
  assert.equal(isHub({ category: 'wnykq' }), true);
  assert.equal(isHub({ category: 'kg', name: 'Air purifier', product_name: 'Fireplace mirror' }), false);
  assert.equal(isHub({ category: 'x', product_name: 'Smart IR Hub' }), true);
});

test('AC "on" uses one scene command with all settings', async () => {
  const client = clientWith(() => ({ success: true, result: true }));
  const svc = createTuyaService({ client, commandGapMs: 0, logger: silent });
  await svc.execute({ type: 'ac', action: 'turn_on', infraredId: 'hub12345', deviceId: 'rem12345', temp: 23, mode: 0, wind: 1 });
  assert.equal(client.requests.length, 1);
  assert.match(client.requests[0].path, /scenes\/command$/);
  assert.deepEqual(client.requests[0].body, { power: 1, mode: 0, temp: 23, wind: 1 });
});

test('AC "on" falls back to separate commands when the scene route is rejected', async () => {
  const client = clientWith(({ path }) =>
    path.endsWith('/scenes/command') ? { success: false, msg: 'nope' } : { success: true });
  const svc = createTuyaService({ client, commandGapMs: 0, logger: silent });
  await svc.execute({ type: 'ac', action: 'turn_on', infraredId: 'hub12345', deviceId: 'rem12345', temp: 23, mode: 0, wind: 1 });
  const codes = client.requests.filter((r) => !r.path.endsWith('/scenes/command')).map((r) => r.body.code);
  assert.deepEqual(codes, ['power', 'mode', 'temp', 'wind']);
});

test('a command Tuya rejects surfaces as an error instead of silently succeeding', async () => {
  const client = clientWith(() => ({ success: false, msg: 'permission deny' }));
  const svc = createTuyaService({ client, logger: silent });
  await assert.rejects(() => svc.sendSwitch('dev1234', [{ code: 'switch_1', value: true }]), /permission deny/);
});

test('device list merges IR remotes onto their hub, in parallel', async () => {
  const client = clientWith(({ path }) => {
    if (path.includes('/users/')) {
      return { success: true, result: [
        { id: 'hub1', category: 'wnykq', online: true, name: 'IR hub' },
        { id: 'plug1', category: 'cz', name: 'Air purifier' },
      ] };
    }
    return { success: true, result: [{ remote_id: 'ac1', remote_name: 'מזגן', category_id: 5 }] };
  });
  const svc = createTuyaService({ client, userId: 'u1', logger: silent });
  const devices = await svc.listDevices();
  const ac = devices.find((d) => d.id === 'ac1');
  assert.equal(ac.category, 'infrared_ac');
  assert.equal(ac.infraredId, 'hub1');
  assert.equal(devices.length, 3);
});

test('a schedule created for a time that already passed today waits until tomorrow', () => {
  const now = new Date('2026-09-24T04:03:00Z'); // 07:03 in Israel
  const past = { time: '07:00' };
  skipTodayIfPast(past, now, 'Asia/Jerusalem');
  assert.equal(past.lastRunDate, '2026-09-24');
  const future = { time: '07:30', lastRunDate: 'x' };
  skipTodayIfPast(future, now, 'Asia/Jerusalem');
  assert.equal(future.lastRunDate, null);
});

test('the server refuses to start without auth configuration', () => {
  assert.throws(() => loadConfig({ TUYA_ACCESS_ID: 'a', TUYA_SECRET_KEY: 'b' }), /GOOGLE_CLIENT_ID.*ALLOWED_EMAIL.*SESSION_SECRET/);
  assert.throws(() => loadConfig({
    TUYA_ACCESS_ID: 'a', TUYA_SECRET_KEY: 'b', GOOGLE_CLIENT_ID: 'c', ALLOWED_EMAIL: 'd@e.f', SESSION_SECRET: 'short',
  }), /SESSION_SECRET/);
});

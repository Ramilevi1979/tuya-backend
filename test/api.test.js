'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('every /api route rejects requests without a session', async () => {
  const t = await startApp();
  for (const [method, path] of [
    ['GET', '/api/devices'], ['GET', '/api/automations'], ['DELETE', '/api/automations/x'],
    ['POST', '/api/devices/dev1234/command'], ['GET', '/api/debug/device/dev1234'],
  ]) {
    const res = await t.request(path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  await t.close();
});

test('the health check stays public', async () => {
  const t = await startApp();
  assert.equal((await t.request('/')).status, 200);
  await t.close();
});

test('login: only the allowed, verified Google account gets a session', async () => {
  const t = await startApp();
  const post = (credential) => t.request('/api/auth/google', { method: 'POST', body: { credential } });
  assert.equal((await post('good')).status, 200);
  assert.equal((await post('stranger')).status, 403);
  assert.equal((await post('unverified')).status, 403);
  assert.equal((await post('forged')).status, 401);
  assert.equal((await post(undefined)).status, 400);
  await t.close();
});

test('a tampered session token is rejected', async () => {
  const t = await startApp();
  const token = await t.login();
  assert.equal((await t.request('/api/devices', { token })).status, 200);
  assert.equal((await t.request('/api/devices', { token: token.slice(0, -3) + 'abc' })).status, 401);
  await t.close();
});

test('CORS: unknown origins get no allow-origin header', async () => {
  const t = await startApp();
  const evil = await t.request('/', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const good = await t.request('/', { headers: { Origin: 'https://tuya-frontend.vercel.app' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://tuya-frontend.vercel.app');
  await t.close();
});

test('automations: create, validate, toggle, delete', async () => {
  const t = await startApp();
  const token = await t.login();
  const valid = {
    title: 'דוד בבוקר', deviceId: 'dev1234', type: 'switch', action: 'turn_on',
    time: '05:00', days: [0, 1, 2], durationMinutes: 45,
  };

  const bad = await t.request('/api/automations', { method: 'POST', token, body: { ...valid, time: '25:99' } });
  assert.equal(bad.status, 400);
  const noDays = await t.request('/api/automations', { method: 'POST', token, body: { ...valid, days: [] } });
  assert.equal(noDays.status, 400);

  const created = await t.request('/api/automations', { method: 'POST', token, body: valid });
  assert.equal(created.status, 201);
  const id = created.json.automation.id;
  assert.equal(created.json.automation.enabled, true);

  const off = await t.request(`/api/automations/${id}`, { method: 'PATCH', token, body: { enabled: false } });
  assert.equal(off.json.automation.enabled, false);
  assert.equal((await t.request('/api/automations/nope', { method: 'PATCH', token, body: { enabled: true } })).status, 404);

  assert.equal((await t.request(`/api/automations/${id}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await t.request('/api/automations', { token })).json.automations.length, 0);
  await t.close();
});

test('AC and switch commands are validated before reaching Tuya', async () => {
  const t = await startApp();
  const token = await t.login();
  const ac = (body) => t.request('/api/ir/hub12345/remotes/rem12345/ac-command', { method: 'POST', token, body });
  assert.equal((await ac({ code: 'temp', value: 24 })).status, 200);
  assert.equal((await ac({ code: 'temp', value: 99 })).status, 400);
  assert.equal((await ac({ code: 'reboot', value: 1 })).status, 400);
  const sw = (body) => t.request('/api/devices/dev1234/command', { method: 'POST', token, body });
  assert.equal((await sw({ commands: [{ code: 'switch_1', value: true }] })).status, 200);
  assert.equal((await sw({ commands: [{ code: '../x', value: true }] })).status, 400);
  assert.equal((await sw({})).status, 400);
  await t.close();
});

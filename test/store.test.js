'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, fileBackend, normalize } = require('../lib/store');
const { validateAutomation } = require('../lib/validate');

test('legacy automations.json (a bare array) is migrated', () => {
  const state = normalize([{ id: '1', title: 'x' }]);
  assert.equal(state.automations.length, 1);
  assert.deepEqual(state.pendingOffs, []);
});

test('file store round-trips and serialises concurrent writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-'));
  const file = path.join(dir, 'nested', 'state.json');
  const store = await new Store(fileBackend(file)).init();
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.mutate((s) => { s.automations.push({ id: String(i) }); })));
  const reloaded = await new Store(fileBackend(file)).init();
  assert.equal(reloaded.state.automations.length, 20);
});

test('validation normalises days and rejects nonsense', () => {
  const ok = validateAutomation({ title: ' a ', deviceId: 'dev1234', time: '07:05', days: [3, 1, 3], durationMinutes: '30' });
  assert.deepEqual(ok.value.days, [1, 3]);
  assert.equal(ok.value.title, 'a');
  assert.equal(ok.value.durationMinutes, 30);
  assert.ok(validateAutomation({ title: 'a', deviceId: 'dev1234', time: '7:5', days: [1] }).errors);
  assert.ok(validateAutomation({ title: 'a', deviceId: 'dev1234', time: '07:05', days: [7] }).errors);
  assert.ok(validateAutomation({ title: 'a', deviceId: 'dev1234', time: '07:05', days: [1], temp: 5 }).errors);
});

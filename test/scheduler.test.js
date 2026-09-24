'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, zonedParts } = require('../lib/scheduler');
const { memoryStore, fakeTuya, silent } = require('./helpers');

// 2026-09-24 is a Thursday (day 4). Israel is UTC+3 in September, so 04:00Z = 07:00 local.
const at = (hhmmUtc, date = '2026-09-24') => new Date(`${date}T${hhmmUtc}:00Z`);
const auto = (over = {}) => ({
  id: 'a1', title: 'דוד', enabled: true, deviceId: 'dev1234', type: 'switch', action: 'turn_on',
  time: '07:00', days: [0, 1, 2, 3, 4, 5, 6], durationMinutes: 0, lastRunDate: null, ...over,
});

async function setup(automations, tuyaOverrides = {}) {
  const store = await memoryStore({ automations, pendingOffs: [] }).init();
  const tuya = Object.assign(fakeTuya(), tuyaOverrides);
  const scheduler = createScheduler({ store, tuya, timeZone: 'Asia/Jerusalem', graceMinutes: 5, logger: silent });
  return { store, tuya, scheduler };
}

test('zonedParts reads Israel time and weekday', () => {
  const p = zonedParts(at('04:00'), 'Asia/Jerusalem');
  assert.deepEqual(p, { dateKey: '2026-09-24', day: 4, minutes: 7 * 60 });
});

test('runs at the scheduled minute and only once', async () => {
  const { tuya, scheduler } = await setup([auto()]);
  await scheduler.tick(at('04:00'));
  await scheduler.tick(at('04:00'));
  await scheduler.tick(at('04:01'));
  assert.equal(tuya.calls.length, 1);
});

test('does not run early, on other weekdays, or when disabled', async () => {
  const { tuya, scheduler } = await setup([
    auto({ id: 'early', time: '07:30' }),
    auto({ id: 'wrongday', days: [0, 1] }),
    auto({ id: 'off', enabled: false }),
  ]);
  await scheduler.tick(at('04:00'));
  assert.equal(tuya.calls.length, 0);
});

test('a late start still runs within the grace window, but not after it', async () => {
  const a = await setup([auto()]);
  await a.scheduler.tick(at('04:04'));
  assert.equal(a.tuya.calls.length, 1);
  const b = await setup([auto()]);
  await b.scheduler.tick(at('04:06'));
  assert.equal(b.tuya.calls.length, 0);
});

test('a failed run is retried on the next tick and records the error', async () => {
  const { store, tuya, scheduler } = await setup([auto()]);
  tuya.failNext = 1;
  await scheduler.tick(at('04:00'));
  assert.equal(store.state.automations[0].lastError, 'boom');
  assert.equal(store.state.automations[0].lastRunDate, null);
  await scheduler.tick(at('04:01'));
  assert.equal(tuya.calls.length, 2);
  assert.equal(store.state.automations[0].lastError, null);
  assert.equal(store.state.automations[0].lastRunDate, '2026-09-24');
});

test('auto-off is stored, survives a "restart", and fires once it is due', async () => {
  const { store, tuya, scheduler } = await setup([auto({ durationMinutes: 45 })]);
  await scheduler.tick(at('04:00'));
  assert.equal(store.state.pendingOffs.length, 1);

  // New scheduler instance over the same persisted state = server restart.
  const reloaded = await memoryStore(JSON.parse(JSON.stringify(store.state))).init();
  const s2 = createScheduler({ store: reloaded, tuya, timeZone: 'Asia/Jerusalem', logger: silent });

  await s2.tick(at('04:30'));
  assert.equal(tuya.calls.filter((c) => c.action === 'turn_off').length, 0);
  await s2.tick(at('04:46'));
  const offs = tuya.calls.filter((c) => c.action === 'turn_off');
  assert.equal(offs.length, 1);
  assert.equal(offs[0].deviceId, 'dev1234');
  assert.equal(reloaded.state.pendingOffs.length, 0);
});

test('a failed auto-off keeps trying until it succeeds', async () => {
  const { store, tuya, scheduler } = await setup([auto({ durationMinutes: 10 })]);
  await scheduler.tick(at('04:00'));
  tuya.failNext = 2;
  await scheduler.tick(at('04:11'));
  await scheduler.tick(at('04:12'));
  assert.equal(store.state.pendingOffs.length, 1);
  await scheduler.tick(at('04:13'));
  assert.equal(store.state.pendingOffs.length, 0);
});

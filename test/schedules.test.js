'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, activePulse, isInFuture } = require('../lib/scheduler');
const { validateAutomation } = require('../lib/validate');
const { memoryStore, fakeTuya, silent, startApp } = require('./helpers');

const TZ = 'Asia/Jerusalem';
// 2026-09-24 is a Thursday. Israel is UTC+3 in September: 20:00Z = 23:00 Thursday, 21:00Z = 00:00 Friday.
const utc = (iso) => new Date(iso);
const MIN = 60_000;

const night = (over = {}) => ({
  id: 'n1', title: 'מזגן בלילה', enabled: true, kind: 'interval', deviceId: 'ac000001', type: 'ac',
  action: 'turn_on', time: '23:00', endTime: '06:00', everyMinutes: 60, durationMinutes: 20,
  days: [0, 1, 2, 3, 4, 5, 6], temp: 25, mode: 0, wind: 0, lastPulseKey: null, ...over,
});

const once = (over = {}) => ({
  id: 'o1', title: 'חד פעמי', enabled: true, kind: 'once', deviceId: 'dev1234', type: 'switch',
  action: 'turn_on', date: '2026-09-24', time: '23:00', days: [], durationMinutes: 0, ...over,
});

async function setup(automations) {
  const store = await memoryStore({ automations, pendingOffs: [] }).init();
  const tuya = fakeTuya();
  const scheduler = createScheduler({ store, tuya, timeZone: TZ, graceMinutes: 5, logger: silent });
  return { store, tuya, scheduler };
}

async function runMinutes(scheduler, fromIso, toIso) {
  for (let t = utc(fromIso).getTime(); t <= utc(toIso).getTime(); t += MIN) await scheduler.tick(new Date(t));
}

test('activePulse: pulses count from the window start, across midnight', () => {
  const a = night();
  assert.deepEqual(activePulse(a, utc('2026-09-24T20:03:00Z'), TZ), { key: '2026-09-24#0', late: 3 });
  assert.deepEqual(activePulse(a, utc('2026-09-24T21:30:00Z'), TZ), { key: '2026-09-24#1', late: 30 }); // 00:30 Friday
  assert.equal(activePulse(a, utc('2026-09-25T03:00:00Z'), TZ), null); // 06:00: window closed
  assert.equal(activePulse(a, utc('2026-09-24T12:00:00Z'), TZ), null); // midday
});

test('every hour from 23:00 to 06:00: seven pulses, each switched off again', async () => {
  const { tuya, scheduler, store } = await setup([night()]);
  await runMinutes(scheduler, '2026-09-24T19:30:00Z', '2026-09-25T04:30:00Z');
  const ons = tuya.calls.filter((c) => c.action === 'turn_on');
  const offs = tuya.calls.filter((c) => c.action === 'turn_off');
  assert.equal(ons.length, 7);   // 23:00, 00:00, 01:00, 02:00, 03:00, 04:00, 05:00
  assert.equal(offs.length, 7);
  assert.equal(ons[0].temp, 25);
  assert.equal(store.state.pendingOffs.length, 0);
});

test('a window belongs to the day it starts on', async () => {
  const fri = await setup([night({ days: [5] })]); // Friday-night window only
  await runMinutes(fri.scheduler, '2026-09-24T19:30:00Z', '2026-09-25T04:30:00Z'); // Thursday night
  assert.equal(fri.tuya.calls.length, 0);

  const thu = await setup([night({ days: [4] })]); // Thursday-night window
  await runMinutes(thu.scheduler, '2026-09-24T19:30:00Z', '2026-09-25T04:30:00Z');
  assert.equal(thu.tuya.calls.filter((c) => c.action === 'turn_on').length, 7);
});

test('a pulse more than the grace period late is skipped', async () => {
  const { tuya, scheduler } = await setup([night()]);
  await scheduler.tick(utc('2026-09-24T21:06:00Z'));
  assert.equal(tuya.calls.length, 0);
});

test('one-time: runs once at its moment, then closes itself', async () => {
  const { tuya, scheduler, store } = await setup([once({ durationMinutes: 30 })]);
  await scheduler.tick(utc('2026-09-24T19:59:00Z'));
  assert.equal(tuya.calls.length, 0);
  await scheduler.tick(utc('2026-09-24T20:00:00Z'));
  await scheduler.tick(utc('2026-09-24T20:01:00Z'));
  assert.equal(tuya.calls.filter((c) => c.action === 'turn_on').length, 1);
  assert.equal(store.state.automations[0].enabled, false);
  assert.ok(store.state.automations[0].completedAt);
  await scheduler.tick(utc('2026-09-24T20:31:00Z'));
  assert.equal(tuya.calls.filter((c) => c.action === 'turn_off').length, 1);
  await scheduler.tick(utc('2026-09-25T20:00:00Z')); // never again
  assert.equal(tuya.calls.filter((c) => c.action === 'turn_on').length, 1);
});

test('one-time: retried after a failure, marked missed if it never succeeds', async () => {
  const retry = await setup([once()]);
  retry.tuya.failNext = 1;
  await retry.scheduler.tick(utc('2026-09-24T20:00:00Z'));
  await retry.scheduler.tick(utc('2026-09-24T20:01:00Z'));
  assert.ok(retry.store.state.automations[0].completedAt);

  const late = await setup([once()]);
  late.tuya.failNext = 99;
  for (let m = 0; m <= 8; m += 1) await late.scheduler.tick(new Date(utc('2026-09-24T20:00:00Z').getTime() + m * MIN));
  const a = late.store.state.automations[0];
  assert.equal(a.enabled, false);
  assert.ok(a.missedAt);
  assert.equal(a.lastError, 'boom');
});

test('one-time: a moment that passed while the server was down is closed as missed', async () => {
  const { tuya, scheduler, store } = await setup([once({ date: '2026-09-23' })]);
  await scheduler.tick(utc('2026-09-24T05:00:00Z'));
  assert.equal(tuya.calls.length, 0);
  assert.equal(store.state.automations[0].enabled, false);
  assert.ok(store.state.automations[0].missedAt);
});

test('isInFuture compares in Israel time', () => {
  const now = utc('2026-09-24T20:03:00Z'); // 23:03
  assert.equal(isInFuture('2026-09-24', '23:04', now, TZ), true);
  assert.equal(isInFuture('2026-09-24', '23:03', now, TZ), false);
  assert.equal(isInFuture('2026-09-25', '00:01', now, TZ), true);
  assert.equal(isInFuture('2026-09-23', '23:59', now, TZ), false);
});

test('validation of the new kinds', () => {
  const base = { title: 't', deviceId: 'dev1234', type: 'switch', time: '23:00' };
  const interval = { ...base, kind: 'interval', endTime: '06:00', everyMinutes: 60, durationMinutes: 20, days: [1] };
  assert.equal(validateAutomation(interval).value.action, 'turn_on');
  assert.ok(validateAutomation({ ...interval, endTime: '23:00' }).errors);
  assert.ok(validateAutomation({ ...interval, durationMinutes: 60 }).errors);
  assert.ok(validateAutomation({ ...interval, durationMinutes: 0 }).errors);
  assert.ok(validateAutomation({ ...interval, everyMinutes: 5 }).errors);
  assert.ok(validateAutomation({ ...interval, action: 'turn_off' }).errors);
  assert.ok(validateAutomation({ ...interval, type: 'tv' }).errors);
  assert.ok(validateAutomation({ ...interval, endTime: undefined }).errors);

  const single = { ...base, kind: 'once', date: '2099-01-01' };
  assert.deepEqual(validateAutomation(single).value.days, []);
  assert.ok(validateAutomation({ ...single, date: '2026-02-31' }).errors);
  assert.ok(validateAutomation({ ...single, date: undefined }).errors);
  assert.ok(validateAutomation({ ...base, kind: 'monthly', days: [1] }).errors);
  // existing schedules (no kind) still validate as weekly
  assert.equal(validateAutomation({ ...base, days: [1, 2] }).value.kind, 'weekly');
});

test('API: one-time and repeating schedules', async () => {
  const t = await startApp();
  const token = await t.login();
  const post = (body) => t.request('/api/automations', { method: 'POST', token, body });
  const base = { title: 'x', deviceId: 'dev1234', type: 'switch', time: '23:00' };

  assert.equal((await post({ ...base, kind: 'once', date: '2020-01-01' })).status, 400); // in the past
  const future = await post({ ...base, kind: 'once', date: '2099-01-01' });
  assert.equal(future.status, 201);
  assert.equal(future.json.automation.kind, 'once');

  const cyc = await post({ ...base, kind: 'interval', endTime: '06:00', everyMinutes: 60, durationMinutes: 20, days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(cyc.status, 201);
  assert.equal(cyc.json.automation.everyMinutes, 60);

  // a one-time schedule that already ran cannot be switched back on
  await t.store.mutate((s) => { s.automations.find((a) => a.id === future.json.automation.id).completedAt = 'now'; });
  const re = await t.request(`/api/automations/${future.json.automation.id}`, { method: 'PATCH', token, body: { enabled: true } });
  assert.equal(re.status, 400);
  await t.close();
});

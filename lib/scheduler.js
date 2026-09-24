'use strict';

const cron = require('node-cron');
const crypto = require('crypto');

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MAX_OFF_ATTEMPTS = 10;

/** Calendar day, weekday (0 = Sunday) and minutes-since-midnight in the given time zone. */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    day: WEEKDAYS[get('weekday')],
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * A schedule created (or moved) to a time that has already passed today should
 * wait for its next occurrence instead of firing straight away.
 */
function skipTodayIfPast(automation, now, timeZone) {
  const { dateKey, minutes } = zonedParts(now, timeZone);
  automation.lastRunDate = minutesOf(automation.time) <= minutes ? dateKey : null;
}

const previousDateKey = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

/**
 * For a repeating ("interval") schedule: the pulse that most recently started
 * inside an active window, as { key, late } (late = minutes since it was due),
 * or null when no window is open. A window belongs to the day it starts on and
 * may run past midnight.
 */
function activePulse(automation, now, timeZone) {
  const { dateKey, day, minutes } = zonedParts(now, timeZone);
  const start = minutesOf(automation.time);
  const length = (minutesOf(automation.endTime) - start + 1440) % 1440;
  if (!length) return null;

  const candidates = [
    { startDay: day, key: dateKey, elapsed: minutes - start },
    { startDay: (day + 6) % 7, key: previousDateKey(dateKey), elapsed: minutes + 1440 - start },
  ];
  for (const c of candidates) {
    if (!automation.days.includes(c.startDay)) continue;
    if (c.elapsed < 0 || c.elapsed >= length) continue;
    const index = Math.floor(c.elapsed / automation.everyMinutes);
    return { key: `${c.key}#${index}`, late: c.elapsed - index * automation.everyMinutes };
  }
  return null;
}

/** Is `date` + `time` (Israel time) still ahead of `now`? */
function isInFuture(date, time, now, timeZone) {
  const { dateKey, minutes } = zonedParts(now, timeZone);
  return date > dateKey || (date === dateKey && minutesOf(time) > minutes);
}

function createScheduler({ store, tuya, timeZone, graceMinutes = 5, logger = console }) {
  const running = new Set();
  let ticking = false;
  let task = null;

  async function runPendingOffs(now) {
    const due = store.state.pendingOffs.filter((p) => p.offAt <= now.getTime());
    for (const pending of due) {
      try {
        await tuya.execute({ ...pending, action: 'turn_off' });
        await store.mutate((s) => { s.pendingOffs = s.pendingOffs.filter((p) => p.id !== pending.id); });
        logger.log(`⏱️ כיבוי אוטומטי בוצע: ${pending.title}`);
      } catch (err) {
        logger.error(`❌ כיבוי אוטומטי נכשל (${pending.title}): ${err.message}`);
        await store.mutate((s) => {
          const item = s.pendingOffs.find((p) => p.id === pending.id);
          if (!item) return;
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= MAX_OFF_ATTEMPTS) {
            logger.error(`❌ מוותר על כיבוי אוטומטי אחרי ${MAX_OFF_ATTEMPTS} ניסיונות: ${pending.title}`);
            s.pendingOffs = s.pendingOffs.filter((p) => p.id !== pending.id);
          }
        });
      }
    }
  }

  async function runAutomation(auto, now, onSuccess) {
    if (running.has(auto.id)) return;
    running.add(auto.id);
    try {
      await tuya.execute(auto);
      await store.mutate((s) => {
        const stored = s.automations.find((a) => a.id === auto.id);
        if (stored) {
          stored.lastRunAt = now.toISOString();
          stored.lastError = null;
          onSuccess(stored);
        }
        if (auto.action === 'turn_on' && auto.durationMinutes > 0) {
          s.pendingOffs.push({
            id: crypto.randomUUID(),
            automationId: auto.id,
            title: auto.title,
            type: auto.type,
            deviceId: auto.deviceId,
            infraredId: auto.infraredId || null,
            remoteIndex: auto.remoteIndex || null,
            switchCode: auto.switchCode || null,
            offAt: now.getTime() + auto.durationMinutes * 60_000,
            attempts: 0,
          });
        }
      });
      logger.log(`⏰ תזמון הופעל: ${auto.title}`);
    } catch (err) {
      logger.error(`❌ תזמון נכשל (${auto.title}): ${err.message}`);
      await store.mutate((s) => {
        const stored = s.automations.find((a) => a.id === auto.id);
        if (stored) stored.lastError = String(err.message).slice(0, 200);
      }).catch(() => {});
    } finally {
      running.delete(auto.id);
    }
  }

  /** One pass. Runs every minute; pass a Date to test a specific moment. */
  async function tick(now = new Date()) {
    if (ticking) return;
    ticking = true;
    try {
      await runPendingOffs(now);

      const { dateKey, day, minutes } = zonedParts(now, timeZone);
      const work = [];
      const missed = [];

      for (const a of store.state.automations) {
        if (a.enabled === false) continue;
        const kind = a.kind || 'weekly';

        if (kind === 'weekly') {
          if (a.lastRunDate === dateKey || !Array.isArray(a.days) || !a.days.includes(day)) continue;
          const late = minutes - minutesOf(a.time);
          if (late >= 0 && late <= graceMinutes) {
            work.push({ auto: a, onSuccess: (s) => { s.lastRunDate = dateKey; } });
          }
        } else if (kind === 'once') {
          if (a.completedAt) continue;
          const late = a.date === dateKey ? minutes - minutesOf(a.time) : null;
          if (late !== null && late >= 0 && late <= graceMinutes) {
            work.push({
              auto: a,
              onSuccess: (s) => { s.lastRunDate = dateKey; s.completedAt = now.toISOString(); s.enabled = false; },
            });
          } else if (a.date < dateKey || (late !== null && late > graceMinutes)) {
            missed.push(a.id);
          }
        } else if (kind === 'interval') {
          const pulse = activePulse(a, now, timeZone);
          if (pulse && pulse.key !== a.lastPulseKey && pulse.late <= graceMinutes) {
            work.push({ auto: a, onSuccess: (s) => { s.lastPulseKey = pulse.key; } });
          }
        }
      }

      for (const { auto, onSuccess } of work) await runAutomation(auto, now, onSuccess);

      // A one-time schedule whose moment passed without running is closed, not left waiting forever.
      if (missed.length) {
        await store.mutate((s) => {
          for (const id of missed) {
            const stored = s.automations.find((a) => a.id === id);
            if (stored && !stored.completedAt) {
              stored.enabled = false;
              stored.missedAt = now.toISOString();
              stored.lastError = stored.lastError || 'לא בוצע: השרת לא היה זמין בזמן התזמון';
            }
          }
        });
      }
    } catch (err) {
      logger.error('Scheduler tick failed:', err);
    } finally {
      ticking = false;
    }
  }

  function start() {
    task = cron.schedule('* * * * *', () => tick(), { timezone: timeZone });
    // Catch anything that came due while the server was starting up.
    setTimeout(() => tick(), 3000).unref();
  }

  function stop() {
    if (task) task.stop();
  }

  return { tick, start, stop };
}

module.exports = { createScheduler, zonedParts, skipTodayIfPast, activePulse, isInFuture };

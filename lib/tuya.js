'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TuyaError extends Error {
  constructor(message, { code, status = 502 } = {}) {
    super(message);
    this.name = 'TuyaError';
    this.code = code;
    this.status = status;
    this.publicMessage = message;
  }
}

function unwrap(res, fallback) {
  if (res && res.success) return res.result === undefined ? true : res.result;
  throw new TuyaError((res && res.msg) || fallback, { code: res && res.code });
}

// Categories Tuya uses for universal IR hubs.
const HUB_CATEGORIES = new Set(['wnykq', 'pjkq', 'ykq']);
const isHub = (device) =>
  HUB_CATEGORIES.has(device.category) || /\bIR\b/i.test(device.product_name || '');

function categoryOf(remote, existing) {
  if (String(remote.category_id) === '5') return 'infrared_ac';
  if (String(remote.category_id) === '2') return 'infrared_tv';
  return remote.category || existing.category;
}

/**
 * Everything that talks to Tuya lives here, so routes and the scheduler share
 * one implementation and tests can swap the client for a fake.
 */
function createTuyaService({
  client,
  userId = '',
  irHubId = '',
  commandGapMs = 1500,
  cacheMs = 10_000,
  logger = console,
}) {
  let cache = null;
  const invalidate = () => { cache = null; };

  const call = (method, path, body) =>
    client.request({ method, path, ...(body ? { body } : {}) });

  function resolveHub(infraredId) {
    const id = infraredId && infraredId !== 'undefined' && infraredId !== 'null' ? infraredId : irHubId;
    if (!id) throw new TuyaError('לא נמצאה רכזת IR עבור השלט הזה', { status: 400 });
    return id;
  }

  // ---- devices -------------------------------------------------------------

  async function listDevices({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < cacheMs) return cache.devices;

    const listPath = userId
      ? `/v1.0/users/${userId}/devices?page_no=1&page_size=100`
      : '/v1.0/iot-03/devices?page_no=1&page_size=100';
    const result = unwrap(await call('GET', listPath), 'Failed to fetch devices');
    const raw = Array.isArray(result) ? result : (result && (result.list || result.devices)) || [];

    const byId = new Map(raw.map((device) => [device.id, { ...device }]));

    // Each hub's remotes are independent, so fetch them in parallel.
    await Promise.all(
      raw.filter(isHub).map(async (hub) => {
        try {
          const res = await call('GET', `/v2.0/infrareds/${hub.id}/remotes`);
          if (!(res && res.success && Array.isArray(res.result))) return;
          for (const remote of res.result) {
            const remoteId = remote.remote_id || remote.id;
            const existing = byId.get(remoteId) || {};
            byId.set(remoteId, {
              ...existing,
              ...remote,
              id: remoteId,
              infraredId: hub.id,
              isVirtualIr: true,
              category: categoryOf(remote, existing),
              online: hub.online,
            });
          }
        } catch (err) {
          logger.warn(`Failed to fetch remotes for hub ${hub.id}: ${err.message}`);
        }
      })
    );

    const devices = Array.from(byId.values());
    cache = { at: Date.now(), devices };
    return devices;
  }

  async function listRemotes(infraredId) {
    return unwrap(await call('GET', `/v2.0/infrareds/${infraredId}/remotes`), 'Failed to fetch remotes') || [];
  }

  // ---- switches / plugs ----------------------------------------------------

  async function sendSwitch(deviceId, commands) {
    const res = await call('POST', `/v1.0/iot-03/devices/${deviceId}/commands`, { commands });
    invalidate();
    return unwrap(res, 'הפקודה נדחתה על ידי Tuya');
  }

  // ---- air conditioners (IR) -----------------------------------------------

  /** One setting at a time (power / mode / temp / wind). Tries each known route in turn. */
  async function sendAcCommand(infraredId, remoteId, code, value) {
    const hub = resolveHub(infraredId);
    const numeric = Number(value);
    const attempts = [
      () => call('POST', `/v1.0/infrareds/${hub}/air-conditioners/${remoteId}/command`, { code, value: numeric }),
      () => call('POST', `/v1.0/infrareds/${hub}/air-conditioners/${remoteId}/command`, { [code]: numeric }),
      () => call('POST', `/v2.0/infrareds/${hub}/air-conditioners/${remoteId}/command`, { code, value: numeric }),
      () => call('POST', `/v1.0/infrareds/${hub}/remotes/${remoteId}/command`, { code, value: numeric }),
    ];
    let lastError = new TuyaError('הפקודה נדחתה על ידי Tuya');
    for (const attempt of attempts) {
      try {
        const res = await attempt();
        if (res && res.success) return true;
        lastError = new TuyaError((res && res.msg) || lastError.message, { code: res && res.code });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * Turn the AC on with mode / temperature / fan in a single IR transmission
   * (Tuya's "scenes/command"). If that route isn't available for this remote,
   * fall back to separate commands with a pause between them so none are dropped.
   */
  async function sendAcOn(infraredId, remoteId, { mode, temp, wind } = {}) {
    const hub = resolveHub(infraredId);
    const state = { power: 1 };
    if (mode !== undefined && mode !== null) state.mode = Number(mode);
    if (temp !== undefined && temp !== null) state.temp = Number(temp);
    if (wind !== undefined && wind !== null) state.wind = Number(wind);

    try {
      const res = await call('POST', `/v2.0/infrareds/${hub}/air-conditioners/${remoteId}/scenes/command`, state);
      if (res && res.success) return true;
      logger.warn(`AC scene command rejected (${res && res.msg}); falling back to single commands`);
    } catch (err) {
      logger.warn(`AC scene command failed (${err.message}); falling back to single commands`);
    }

    let first = true;
    for (const code of ['power', 'mode', 'temp', 'wind']) {
      if (state[code] === undefined) continue;
      if (!first) await sleep(commandGapMs);
      first = false;
      await sendAcCommand(hub, remoteId, code, state[code]);
    }
    return true;
  }

  /** The state Tuya's cloud believes the AC is in (IR is one-way, so this is the last command sent). */
  async function getAcStatus(infraredId, remoteId) {
    const hub = resolveHub(infraredId);
    const raw = unwrap(await call('GET', `/v2.0/infrareds/${hub}/remotes/${remoteId}/ac/status`), 'Failed to fetch AC status');
    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    return { power: num(raw.power), mode: num(raw.mode), temp: num(raw.temp), wind: num(raw.wind) };
  }

  // ---- TVs (IR) ------------------------------------------------------------

  /** Sends a standard key. IR power is a toggle: "on" and "off" are the same key. */
  async function sendTvKey(infraredId, remoteId, { key = 'power', remoteIndex, categoryId = 2 } = {}) {
    const hub = resolveHub(infraredId);
    for (const candidate of [key, key.charAt(0).toUpperCase() + key.slice(1)]) {
      try {
        const res = await call('POST', `/v2.0/infrareds/${hub}/remotes/${remoteId}/command`, {
          categoryId: Number(categoryId),
          ...(remoteIndex ? { remoteIndex: Number(remoteIndex) } : {}),
          key: candidate,
        });
        if (res && res.success) return true;
      } catch (_) { /* try the next form */ }
    }
    // Last resort: the route the app used before.
    return sendAcCommand(hub, remoteId, key, 1);
  }

  // ---- one entry point for both the API and the scheduler -------------------

  async function execute(task) {
    const on = task.action === 'turn_on';
    switch (task.type) {
      case 'ac':
        return on
          ? sendAcOn(task.infraredId, task.deviceId, { mode: task.mode, temp: task.temp, wind: task.wind })
          : sendAcCommand(task.infraredId, task.deviceId, 'power', 0);
      case 'tv':
        return sendTvKey(task.infraredId, task.deviceId, { remoteIndex: task.remoteIndex });
      default:
        return sendSwitch(task.deviceId, [{ code: task.switchCode || 'switch_1', value: on }]);
    }
  }

  async function describeDevice(id) {
    const [details, status, functions] = await Promise.all([
      call('GET', `/v1.0/iot-03/devices/${id}`),
      call('GET', `/v1.0/iot-03/devices/${id}/status`),
      call('GET', `/v1.0/iot-03/devices/${id}/functions`),
    ]);
    return {
      deviceId: id,
      details: (details && details.result) || {},
      status: (status && status.result) || [],
      functions: (functions && functions.result) || {},
    };
  }

  return {
    listDevices, listRemotes, sendSwitch, sendAcCommand, sendAcOn,
    getAcStatus, sendTvKey, execute, describeDevice, invalidate,
  };
}

module.exports = { createTuyaService, TuyaError, isHub };

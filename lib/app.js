'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { httpError, wrap } = require('./http');
const { validateAutomation, CODE_RE } = require('./validate');
const { skipTodayIfPast, activePulse, isInFuture } = require('./scheduler');

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_AUTOMATIONS = 100;
const AC_LIMITS = { power: [0, 1], mode: [0, 4], temp: [16, 30], wind: [0, 3] };

function assertId(value, label = 'מזהה') {
  if (!ID_RE.test(String(value))) throw httpError(400, `${label} לא תקין`);
  return String(value);
}

function createApp({ config, store, tuya, auth, logger = console }) {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: needed for correct client IPs
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
  }));
  app.use(express.json({ limit: '20kb' }));

  // Public: used by uptime monitors to keep the server awake.
  app.get('/', (req, res) => res.json({ success: true, message: 'Tuya backend is running' }));

  const limiter = (windowMs, limit) =>
    rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false,
      message: { success: false, error: 'יותר מדי בקשות, נסו שוב בעוד רגע' } });

  const api = express.Router();
  api.use(limiter(60_000, 240));

  // ---- auth ----------------------------------------------------------------
  api.post('/auth/google', limiter(15 * 60_000, 20), wrap(async (req, res) => {
    const session = await auth.loginWithGoogle(req.body && req.body.credential);
    res.json({ success: true, ...session });
  }));

  api.get('/auth/me', auth.requireAuth, (req, res) =>
    res.json({ success: true, user: { email: req.user.email, name: req.user.name } }));

  // Everything below requires a valid session.
  api.use(auth.requireAuth);

  // ---- devices -------------------------------------------------------------
  api.get('/devices', wrap(async (req, res) => {
    const devices = await tuya.listDevices({ force: req.query.refresh === '1' });
    res.json({ success: true, devices });
  }));

  api.get('/ir/:infraredId/remotes', wrap(async (req, res) => {
    const remotes = await tuya.listRemotes(assertId(req.params.infraredId, 'מזהה רכזת'));
    res.json({ success: true, remotes });
  }));

  api.post('/devices/:id/command', wrap(async (req, res) => {
    const id = assertId(req.params.id, 'מזהה מכשיר');
    const { commands } = req.body || {};
    const valid = Array.isArray(commands) && commands.length > 0 && commands.length <= 8 &&
      commands.every((c) => c && typeof c.code === 'string' && CODE_RE.test(c.code) &&
        ['boolean', 'number', 'string'].includes(typeof c.value));
    if (!valid) throw httpError(400, 'פקודה לא תקינה');
    await tuya.sendSwitch(id, commands);
    res.json({ success: true });
  }));

  api.post('/ir/:infraredId/remotes/:remoteId/ac-command', wrap(async (req, res) => {
    const infraredId = assertId(req.params.infraredId, 'מזהה רכזת');
    const remoteId = assertId(req.params.remoteId, 'מזהה שלט');
    const { code, value } = req.body || {};
    const limits = AC_LIMITS[code];
    const n = Number(value);
    if (!limits || !Number.isInteger(n) || n < limits[0] || n > limits[1]) {
      throw httpError(400, 'פקודת מזגן לא תקינה');
    }
    await tuya.sendAcCommand(infraredId, remoteId, code, n);
    tuya.invalidate();
    res.json({ success: true });
  }));

  api.get('/ir/:infraredId/remotes/:remoteId/ac-status', wrap(async (req, res) => {
    const status = await tuya.getAcStatus(
      assertId(req.params.infraredId, 'מזהה רכזת'),
      assertId(req.params.remoteId, 'מזהה שלט')
    );
    res.json({ success: true, status });
  }));

  api.post('/ir/:infraredId/remotes/:remoteId/tv-command', wrap(async (req, res) => {
    const { key, remoteIndex } = req.body || {};
    if (key !== 'power') throw httpError(400, 'פקודת טלוויזיה לא נתמכת');
    await tuya.sendTvKey(
      assertId(req.params.infraredId, 'מזהה רכזת'),
      assertId(req.params.remoteId, 'מזהה שלט'),
      { key, remoteIndex }
    );
    res.json({ success: true });
  }));

  api.get('/debug/device/:id', wrap(async (req, res) => {
    res.json({ success: true, ...(await tuya.describeDevice(assertId(req.params.id, 'מזהה מכשיר'))) });
  }));

  // ---- automations ---------------------------------------------------------
  api.get('/automations', (req, res) =>
    res.json({ success: true, automations: store.state.automations }));

  api.post('/automations', wrap(async (req, res) => {
    const { value, errors } = validateAutomation(req.body);
    if (errors) throw httpError(400, errors[0]);
    if (value.type !== 'ac') { delete value.temp; delete value.mode; delete value.wind; }
    if (value.kind === 'once' && !isInFuture(value.date, value.time, new Date(), config.timeZone)) {
      throw httpError(400, 'התאריך והשעה שנבחרו כבר עברו');
    }

    const automation = await store.mutate((s) => {
      if (s.automations.length >= MAX_AUTOMATIONS) throw httpError(400, 'הגעתם למספר התזמונים המרבי');
      const created = {
        id: crypto.randomUUID(),
        enabled: true,
        createdAt: new Date().toISOString(),
        lastRunDate: null,
        ...value,
      };
      const kind = created.kind || 'weekly';
      if (kind === 'weekly') skipTodayIfPast(created, new Date(), config.timeZone);
      // A repeating schedule created mid-window waits for its next pulse instead of firing at once.
      if (kind === 'interval') {
        const pulse = activePulse(created, new Date(), config.timeZone);
        created.lastPulseKey = pulse ? pulse.key : null;
      }
      s.automations.push(created);
      return created;
    });
    logger.log(`✅ נוצר תזמון: ${automation.title} (${automation.time})`);
    res.status(201).json({ success: true, automation });
  }));

  api.patch('/automations/:id', wrap(async (req, res) => {
    const { value, errors } = validateAutomation(req.body, { partial: true });
    if (errors) throw httpError(400, errors[0]);

    const automation = await store.mutate((s) => {
      const existing = s.automations.find((a) => a.id === req.params.id);
      if (!existing) throw httpError(404, 'התזמון לא נמצא');
      const kind = existing.kind || 'weekly';
      if (value.enabled === true && kind === 'once' && (existing.completedAt || existing.missedAt)) {
        throw httpError(400, 'תזמון חד פעמי שכבר עבר לא ניתן להפעלה מחדש. צרו תזמון חדש');
      }
      if (value.enabled === true && kind === 'interval') {
        const pulse = activePulse(existing, new Date(), config.timeZone);
        existing.lastPulseKey = pulse ? pulse.key : null;
      }
      const timeChanged = value.time !== undefined && value.time !== existing.time;
      const daysChanged = value.days !== undefined && JSON.stringify(value.days) !== JSON.stringify(existing.days);
      Object.assign(existing, value);
      if (kind === 'weekly' && (timeChanged || daysChanged)) skipTodayIfPast(existing, new Date(), config.timeZone);
      return existing;
    });
    res.json({ success: true, automation });
  }));

  api.delete('/automations/:id', wrap(async (req, res) => {
    // Pending auto-off timers are kept on purpose: deleting a schedule must never leave a device on.
    await store.mutate((s) => { s.automations = s.automations.filter((a) => a.id !== req.params.id); });
    res.json({ success: true });
  }));

  app.use('/api', api);

  app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'הנתיב לא נמצא' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: 'גוף הבקשה אינו JSON תקין' });
    }
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ success: false, error: err.publicMessage || 'שגיאת שרת פנימית' });
  });

  return app;
}

module.exports = { createApp };

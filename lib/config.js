'use strict';

const path = require('path');

const DEFAULT_ORIGINS = ['https://tuya-frontend.vercel.app', 'http://localhost:5173'];

/**
 * Reads and validates environment variables. Throws (with every problem listed)
 * when something required is missing, so the server never starts half-open.
 */
function loadConfig(env = process.env) {
  const problems = [];
  const need = (...names) => {
    for (const name of names) if (env[name]) return env[name];
    problems.push(names.join(' / '));
    return '';
  };

  const config = {
    port: Number(env.PORT) || 5000,
    timeZone: env.TIME_ZONE || 'Asia/Jerusalem',
    // A scheduled run that was missed (server asleep / restarting) still fires if it is
    // at most this many minutes late.
    graceMinutes: Number(env.GRACE_MINUTES ?? 5),
    sessionDays: Number(env.SESSION_DAYS) || 30,

    tuya: {
      accessKey: need('TUYA_ACCESS_KEY', 'TUYA_ACCESS_ID'),
      secretKey: need('TUYA_SECRET_KEY'),
      endpoint: env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com',
      userId: env.TUYA_USER_ID || env.TUYA_UID || '',
      // Optional fallback for remotes that don't carry their hub id.
      irHubId: env.TUYA_IR_HUB_ID || '',
    },

    googleClientId: need('GOOGLE_CLIENT_ID'),
    allowedEmail: need('ALLOWED_EMAIL').trim().toLowerCase(),
    sessionSecret: need('SESSION_SECRET'),

    allowedOrigins: (env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ORIGINS),

    databaseUrl: env.DATABASE_URL || '',
    dataFile: env.DATA_FILE || path.join(__dirname, '..', 'automations.json'),
  };

  if (config.sessionSecret && config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET (must be at least 32 characters)');
  }
  if (problems.length) {
    throw new Error(`Missing or invalid environment variables: ${problems.join(', ')}`);
  }
  return config;
}

module.exports = loadConfig;

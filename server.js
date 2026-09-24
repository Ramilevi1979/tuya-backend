'use strict';

require('dotenv').config();

const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const loadConfig = require('./lib/config');
const { createStore } = require('./lib/store');
const { createTuyaService } = require('./lib/tuya');
const { createAuth } = require('./lib/auth');
const { createScheduler } = require('./lib/scheduler');
const { createApp } = require('./lib/app');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error('   See .env.example for the full list.');
    process.exit(1);
  }

  const store = createStore(config);
  await store.init();
  console.log(`💾 אחסון: ${store.backend.name}, ${store.state.automations.length} תזמונים נטענו`);

  const tuya = createTuyaService({
    client: new TuyaContext({
      baseUrl: config.tuya.endpoint,
      accessKey: config.tuya.accessKey,
      secretKey: config.tuya.secretKey,
    }),
    userId: config.tuya.userId,
    irHubId: config.tuya.irHubId,
  });

  const auth = createAuth({ config });
  const scheduler = createScheduler({
    store, tuya, timeZone: config.timeZone, graceMinutes: config.graceMinutes,
  });
  const app = createApp({ config, store, tuya, auth });

  const server = app.listen(config.port, () => {
    console.log(`🚀 השרת רץ על פורט ${config.port}`);
    scheduler.start();
  });

  const shutdown = () => { scheduler.stop(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});

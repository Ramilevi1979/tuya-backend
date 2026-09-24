'use strict';

const fsp = require('fs').promises;
const path = require('path');

const emptyState = () => ({ automations: [], pendingOffs: [] });

/** Accepts the current shape and the legacy one (a bare array of automations). */
function normalize(raw) {
  if (Array.isArray(raw)) return { automations: raw, pendingOffs: [] };
  return {
    automations: Array.isArray(raw && raw.automations) ? raw.automations : [],
    pendingOffs: Array.isArray(raw && raw.pendingOffs) ? raw.pendingOffs : [],
  };
}

function fileBackend(filePath) {
  return {
    name: `file (${filePath})`,
    async load() {
      try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(state) {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fsp.rename(tmp, filePath); // atomic replace: a crash never leaves half a file
    },
  };
}

function postgresBackend(databaseUrl) {
  const { Pool } = require('pg');
  const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  return {
    name: 'postgres',
    async load() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)'
      );
      const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'state'");
      return rows[0] ? rows[0].value : null;
    },
    async save(state) {
      await pool.query(
        `INSERT INTO app_state (key, value) VALUES ('state', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(state)]
      );
    },
  };
}

/**
 * Keeps the whole state in memory and writes it through on every change.
 * All changes go through mutate(), which runs them one at a time.
 */
class Store {
  constructor(backend) {
    this.backend = backend;
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  async init() {
    this.state = normalize(await this.backend.load());
    return this;
  }

  mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.state);
      await this.backend.save(this.state);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function createStore(config) {
  const backend = config.databaseUrl
    ? postgresBackend(config.databaseUrl)
    : fileBackend(config.dataFile);
  return new Store(backend);
}

module.exports = { createStore, Store, fileBackend, normalize };

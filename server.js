require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// אתחול חיבור ל-Tuya
const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_SECRET_KEY,
});
const TUYA_UID = process.env.TUYA_UID;

// אתחול מסד נתונים SQLite
const db = new sqlite3.Database('./tuya.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    type TEXT,
    deviceId TEXT,
    action TEXT,
    time TEXT,
    days TEXT,
    durationMinutes INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    title TEXT,
    source TEXT,
    status TEXT,
    action TEXT,
    details TEXT
  )`);
});

// פונקציית עזר לרישום אירועים בלוג
const addLog = (title, source, status, action, details) => {
  const timestamp = new Date().toLocaleString('he-IL');
  db.run(
    `INSERT INTO logs (timestamp, title, source, status, action, details) VALUES (?, ?, ?, ?, ?, ?)`,
    [timestamp, title, source, status, action, details]
  );
};

// --- נתיבי API ---

// 1. קבלת כל המכשירים
app.get('/api/devices', async (req, res) => {
  try {
    if (!TUYA_UID) {
      return res.status(400).json({ success: false, error: 'TUYA_UID is not defined' });
    }
    const response = await tuya.request({
      path: `/v1.0/users/${TUYA_UID}/devices`,
      method: 'GET',
    });

    if (response.success) {
      res.json({ success: true, devices: response.result });
    } else {
      res.status(400).json({ success: false, error: response.msg });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. שליחת פקודות ישירות לכל מכשיר (הדרך המקורית שעבדה ללא סיבוכי IR)
app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands, deviceName } = req.body;

  try {
    const cleanCommands = commands ? commands.filter(c => c.code && c.value !== undefined) : [];
    
    console.log(`Sending command to device [${id}]:`, cleanCommands);

    const response = await tuya.request({
      path: `/v1.0/devices/${id}/commands`,
      method: 'POST',
      body: { commands: cleanCommands }
    });

    if (response && response.success) {
      addLog(deviceName || id, 'manual', 'success', 'command', JSON.stringify(cleanCommands));
      res.json({ success: true, result: response.result });
    } else {
      const errMsg = response?.msg || JSON.stringify(response) || 'נדחה על ידי Tuya';
      addLog(deviceName || id, 'manual', 'failed', 'command', errMsg);
      res.status(400).json({ success: false, error: errMsg });
    }
  } catch (err) {
    console.error('Command Error:', err);
    const errDetails = err.message || JSON.stringify(err);
    addLog(deviceName || id, 'manual', 'failed', 'error', errDetails);
    res.status(500).json({ success: false, error: errDetails });
  }
});

// 3. קבלת אוטומציות
app.get('/api/automations', (req, res) => {
  db.all(`SELECT * FROM automations`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    const automations = rows.map(r => ({
      ...r,
      days: r.days ? JSON.parse(r.days) : []
    }));
    res.json({ success: true, automations });
  });
});

// 4. יצירת אוטומציה חדשה
app.post('/api/automations', (req, res) => {
  const { title, type, deviceId, action, time, days, durationMinutes } = req.body;
  const daysStr = JSON.stringify(days || []);

  db.run(
    `INSERT INTO automations (title, type, deviceId, action, time, days, durationMinutes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [title, type, deviceId, action, time, daysStr, durationMinutes || 0],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 5. מחיקת אוטומציה
app.delete('/api/automations/:id', (req, res) => {
  db.run(`DELETE FROM automations WHERE id = ?`, req.params.id, function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

// 6. קבלת לוגים
app.get('/api/logs', (req, res) => {
  db.all(`SELECT * FROM logs ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, logs: rows });
  });
});

// 7. מחיקת לוגים
app.delete('/api/logs', (req, res) => {
  db.run(`DELETE FROM logs`, function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

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

// מזהה רכזת ה-IR שלך (שנלקח מהלוגים המאומתים)
const FIXED_IR_HUB_ID = 'bf818853ec3c1fa781w3vo';

// מפות תרגום למצבי מזגן ב-Tuya IR
const MODE_MAP = { cool: 0, heat: 1, auto: 2, fan: 3, dry: 4 };
const WIND_MAP = { auto: 0, low: 1, medium: 2, high: 3 };

// אתחול מסד נתונים SQLite מקומי
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

// 2. שליחת פקודות (מתגים רגילים מול מזגני IR בנתיב הייעודי)
app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands, deviceName, isAc, acPayload } = req.body;

  try {
    let response;

    // מקרה 1: הפעלת מזגן דרך נתיב ה-IR של הרכזת
    if (isAc && acPayload) {
      const irPayload = {
        power: acPayload.power ?? 1,
        temp: Number(acPayload.temperature || 24),
        mode: MODE_MAP[acPayload.mode] ?? 0,
        wind: WIND_MAP[acPayload.wind] ?? 0
      };

      console.log(`Sending IR command via Hub [${FIXED_IR_HUB_ID}] to AC [${id}]:`, irPayload);

      response = await tuya.request({
        path: `/v1.0/infrareds/${FIXED_IR_HUB_ID}/air-conditioners/${id}/command`,
        method: 'POST',
        body: irPayload
      });
    } 
    // מקרה 2: מתג או שקע חכם רגיל
    else {
      const cleanCommands = commands ? commands.filter(c => c.code && c.value !== undefined) : [];
      console.log(`Sending standard command to device [${id}]:`, cleanCommands);

      response = await tuya.request({
        path: `/v1.0/devices/${id}/commands`,
        method: 'POST',
        body: { commands: cleanCommands }
      });
    }

    if (response && response.success) {
      addLog(deviceName || id, 'manual', 'success', isAc ? 'הפעלת מזגן' : 'מתג', 'הפקודה נשלחה בהצלחה');
      res.json({ success: true, result: response.result });
    } else {
      const errMsg = response?.msg || JSON.stringify(response) || 'נדחה על ידי Tuya';
      addLog(deviceName || id, 'manual', 'failed', 'שגיאת פקודה', errMsg);
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

// --- מנגנון תזמונים (Cron) ---
cron.schedule('* * * * *', () => {
  const now = new Date();
  const currentHour = now.getHours().toString().padStart(2, '0');
  const currentMinute = now.getMinutes().toString().padStart(2, '0');
  const currentTime = `${currentHour}:${currentMinute}`;
  const currentDay = now.getDay();

  db.all(`SELECT * FROM automations WHERE time = ?`, [currentTime], (err, automations) => {
    if (err) return;

    automations.forEach(async (auto) => {
      const days = auto.days ? JSON.parse(auto.days) : [];
      if (!days.includes(currentDay)) return;

      try {
        const commandValue = auto.action === 'turn_on' ? true : false;
        
        if (auto.type === 'ac') {
          const irPayload = { power: commandValue ? 1 : 0, temp: 24, mode: 0, wind: 0 };
          await tuya.request({
            path: `/v1.0/infrareds/${FIXED_IR_HUB_ID}/air-conditioners/${auto.deviceId}/command`,
            method: 'POST',
            body: irPayload
          });
          addLog(auto.title, 'automation', 'success', auto.action, 'מזגן הופעל אוטומטית');
        } else {
          const commands = [{ code: 'switch_1', value: commandValue }];
          await tuya.request({
            path: `/v1.0/devices/${auto.deviceId}/commands`,
            method: 'POST',
            body: { commands }
          });
          addLog(auto.title, 'automation', 'success', auto.action, 'מתג הופעל אוטומטית');
        }
      } catch (err) {
        addLog(auto.title, 'automation', 'failed', auto.action, err.message);
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

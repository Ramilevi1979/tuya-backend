const express = require('express');
const cors = require('cors');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// הגדרת חיבור ל-Tuya
const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_KEY,
  secretKey: process.env.TUYA_SECRET_KEY,
});

const TUYA_UID = process.env.TUYA_UID;

// הגדרת מסד נתונים SQLite מקומי
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// יצירת טבלאות בסיסיות אם אינן קיימות
db.run(`CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  action TEXT,
  status TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  cron_expression TEXT,
  payload TEXT
)`);

// מיפוי מצבים למזגנים ב-Tuya IR
const MODE_MAP = {
  cool: 0,
  heat: 1,
  auto: 2,
  fan: 3,
  dry: 4
};

const WIND_MAP = {
  auto: 0,
  low: 1,
  medium: 2,
  high: 3
};

// נקודת קצה לשליטה במכשירים ובמזגנים
app.post('/api/device/command', async (req, res) => {
  try {
    const { id, commands, isAc, acPayload } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, error: 'Device ID is required' });
    }

    let response;

    // מקרה 1: הפעלת מזגן (IR)
    if (isAc && acPayload) {
      let hubId = null;

      // 1. ננסה לאתר את הרכזת דרך ה-parent_id
      try {
        const devDetails = await tuya.request({
          path: `/v1.0/devices/${id}`,
          method: 'GET'
        });
        if (devDetails.success && devDetails.result && devDetails.result.parent_id) {
          hubId = devDetails.result.parent_id;
        }
      } catch (e) {
        console.log('Could not fetch parent_id, searching hub manually...');
      }

      // 2. אם לא נמצא parent_id, נחפש אוטומטית את מכשיר ה-IR ברשימת המכשירים
      if (!hubId && TUYA_UID) {
        const devicesRes = await tuya.request({
          path: `/v1.0/users/${TUYA_UID}/devices`,
          method: 'GET'
        });
        if (devicesRes.success && devicesRes.result) {
          const irHub = devicesRes.result.find(d => 
            (d.category && (d.category.toLowerCase().includes('ir') || d.category.toLowerCase().includes('wk'))) ||
            (d.name && d.name.toLowerCase().includes('ir'))
          );
          if (irHub) {
            hubId = irHub.id;
          }
        }
      }

      if (!hubId) {
        throw new Error('לא הצלחתי לאתר אף רכזת IR מקושרת בחשבון Tuya שלך.');
      }

      const irPayload = {
        power: acPayload.power ?? 1,
        temp: Number(acPayload.temperature || 24),
        mode: MODE_MAP[acPayload.mode] ?? 0,
        wind: WIND_MAP[acPayload.wind] ?? 0
      };

      response = await tuya.request({
        path: `/v1.0/infrareds/${hubId}/air-conditioners/${id}/command`,
        method: 'POST',
        body: irPayload
      });
    } 
    // מקרה 2: מכשיר רגיל (Standard Tuya Device)
    else if (commands) {
      response = await tuya.request({
        path: `/v1.0/devices/${id}/commands`,
        method: 'POST',
        body: { commands }
      });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid payload or command structure' });
    }

    // שמירת לוג פעולה במסד הנתונים
    db.run(`INSERT INTO logs (action, status) VALUES (?, ?)`, [`Command to ${id}`, response.success ? 'SUCCESS' : 'FAILED']);

    res.json(response);
  } catch (error) {
    console.error('Command Error:', error.message || error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

// נקודת קצה לקבלת רשימת המכשירים
app.get('/api/devices', async (req, res) => {
  try {
    if (!TUYA_UID) {
      return res.status(400).json({ success: false, error: 'TUYA_UID is not defined in environment variables' });
    }
    const devices = await tuya.request({
      path: `/v1.0/users/${TUYA_UID}/devices`,
      method: 'GET'
    });
    res.json(devices);
  } catch (error) {
    console.error('Fetch Devices Error:', error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

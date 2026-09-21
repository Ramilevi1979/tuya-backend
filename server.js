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

// אתחול חיבור ל-Tuya עם המשתנים הקיימים בדיוק כפי שהם מוגדרים ב-Render
const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_ENDPOINT,
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_SECRET_KEY,
});
const TUYA_UID = process.env.TUYA_UID;

// מפות תרגום למצבי מזגן ב-Tuya IR
const MODE_MAP = { cool: 0, heat: 1, auto: 2, fan: 3, dry: 4 };
const WIND_MAP = { auto: 0, low: 1, medium: 2, high: 3 };

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
    infraredId TEXT,
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
  // השימוש ב-TZ ב-Render ידאג שהשעה כאן תהיה לפי שעון ישראל
  const timestamp = new Date().toLocaleString('he-IL');
  db.run(
    `INSERT INTO logs (timestamp, title, source, status, action, details) VALUES (?, ?, ?, ?, ?, ?)`,
    [timestamp, title, source, status, action, details]
  );
};

// --- נתיבי API ---

// 1. קבלת כל המכשירים של המשתמש
app.get('/api/devices', async (req, res) => {
  try {
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

// 2. שליחת פקודות (זיהוי אוטומטי בין מתג רגיל למזגן IR)
app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands, deviceName, isAc, acPayload } = req.body;

  try {
    let response;
    
    // מקרה 1: הפעלת מזגן (IR)
    if (isAc && acPayload) {
      // חילוץ מזהה הרכזת באופן דינמי כדי לא לדרוש משתנה סביבה חדש
      const devDetails = await tuya.request({
        path: `/v1.0/devices/${id}`,
        method: 'GET'
      });

      if (devDetails.success && devDetails.result.parent_id) {
        const hubId = devDetails.result.parent_id;
        
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
      } else {
        throw new Error('לא הצלחתי לאתר את הרכזת המשוייכת למזגן (parent_id).');
      }
    } 
    // מקרה 2: הפעלת מתג או שקע חכם רגיל
    else {
      const cleanCommands = commands ? commands.filter(c => c.code && c.value !== undefined) : [];
      response = await tuya.request({
        path: `/v1.0/smart/devices/${id}/commands`,
        method: 'POST',
        body: { commands: cleanCommands }
      });
    }

    if (response && response.success) {
      addLog(deviceName || id, 'manual', 'success', isAc ? 'הפעלת מזגן' : 'מתג', 'הפקודה נשלחה בהצלחה');
      res.json({ success: true, result: response.result });
    } else {
      const errMsg = response?.msg || 'נדחה על ידי Tuya';
      addLog(deviceName || id, 'manual', 'failed', 'שגיאת פקודה', errMsg);
      res.status(400).json({ success: false, error: errMsg });
    }
  } catch (err) {
    console.error('Command Error:', err);
    addLog(deviceName || id, 'manual', 'failed', 'שגיאת שרת', err.message);
    res.status(500).json({ success: false, error: err.message });
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
  const { title, type, deviceId, infraredId, action, time, days, durationMinutes } = req.body;
  const daysStr = JSON.stringify(days || []);

  db.run(
    `INSERT INTO automations (title, type, deviceId, infraredId, action, time, days, durationMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, type, deviceId, infraredId, action, time, daysStr, durationMinutes || 0],
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

// 6. קבלת לוגים (100 אחרונים)
app.get('/api/logs', (req, res) => {
  db.all(`SELECT * FROM logs ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, logs: rows });
  });
});

// 7. מחיקת כל הלוגים
app.delete('/api/logs', (req, res) => {
  db.run(`DELETE FROM logs`, function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// --- מנגנון תזמונים (Cron Jobs) הרץ כל דקה ---
cron.schedule('* * * * *', () => {
  const now = new Date();
  const currentHour = now.getHours().toString().padStart(2, '0');
  const currentMinute = now.getMinutes().toString().padStart(2, '0');
  const currentTime = `${currentHour}:${currentMinute}`;
  const currentDay = now.getDay();

  db.all(`SELECT * FROM automations WHERE time = ?`, [currentTime], (err, automations) => {
    if (err) {
      console.error('Cron DB Error:', err.message);
      return;
    }

    automations.forEach(async (auto) => {
      const days = auto.days ? JSON.parse(auto.days) : [];
      if (!days.includes(currentDay)) return;

      try {
        const commandValue = auto.action === 'turn_on' ? true : false;
        
        // במידה וזה מזגן נשלח פקודת כיבוי/הדלקה דרך ה-IR Path
        if (auto.type === 'ac') {
          const devDetails = await tuya.request({ path: `/v1.0/devices/${auto.deviceId}`, method: 'GET' });
          if (devDetails.success && devDetails.result.parent_id) {
            const hubId = devDetails.result.parent_id;
            const irPayload = { power: commandValue ? 1 : 0, temp: 24, mode: 0, wind: 0 };
            
            await tuya.request({
              path: `/v1.0/infrareds/${hubId}/air-conditioners/${auto.deviceId}/command`,
              method: 'POST',
              body: irPayload
            });
            addLog(auto.title, 'automation', 'success', auto.action, 'מזגן הופעל אוטומטית');
          }
        } 
        // במידה וזה מתג רגיל
        else {
          const commands = [{ code: 'switch_1', value: commandValue }];
          await tuya.request({
            path: `/v1.0/smart/devices/${auto.deviceId}/commands`,
            method: 'POST',
            body: { commands }
          });
          addLog(auto.title, 'automation', 'success', auto.action, 'מתג הופעל אוטומטית');
          
          // מנגנון כיבוי אוטומטי (Timeout) למתגים בלבד
          if (auto.durationMinutes > 0 && commandValue === true) {
            setTimeout(async () => {
              try {
                await tuya.request({
                  path: `/v1.0/smart/devices/${auto.deviceId}/commands`,
                  method: 'POST',
                  body: { commands: [{ code: 'switch_1', value: false }] }
                });
                addLog(auto.title, 'auto_off', 'success', 'turn_off', `כיבוי אוטומטי לאחר ${auto.durationMinutes} דקות`);
              } catch (offErr) {
                addLog(auto.title, 'auto_off', 'failed', 'turn_off', offErr.message);
              }
            }, auto.durationMinutes * 60000);
          }
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

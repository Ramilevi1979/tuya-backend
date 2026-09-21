const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TUYA_ACCESS_KEY = process.env.TUYA_ACCESS_KEY || process.env.TUYA_ACCESS_ID;
const TUYA_SECRET_KEY = process.env.TUYA_SECRET_KEY;
const TUYA_ENDPOINT = process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com';
const TUYA_USER_ID = process.env.TUYA_USER_ID || process.env.TUYA_UID;

if (!TUYA_ACCESS_KEY || !TUYA_SECRET_KEY) {
  console.error('❌ שגיאה קריטית: מפתחות ה-API של Tuya אינם מוגדרים!');
}

const tuya = new TuyaContext({
  baseUrl: TUYA_ENDPOINT,
  accessKey: TUYA_ACCESS_KEY,
  secretKey: TUYA_SECRET_KEY,
});

// קבצי אחסון
const AUTOMATIONS_FILE = path.join(__dirname, 'automations.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');

// --- ניהול אוטומציות ---
function loadAutomations() {
  try {
    if (fs.existsSync(AUTOMATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading automations file:', err);
  }
  return [];
}

function saveAutomations(data) {
  try {
    fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving automations file:', err);
  }
}

// --- ניהול לוגים ---
function loadLogs() {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading logs file:', err);
  }
  return [];
}

function saveLogs(logs) {
  try {
    // שמירת 100 הלוגים האחרונים בלבד
    const trimmed = logs.slice(-100);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving logs file:', err);
  }
}

function addLog({ source, title, action, status, details = '' }) {
  const logs = loadLogs();
  const israelTimeStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  
  const newLog = {
    id: Date.now().toString(),
    timestamp: israelTimeStr,
    source, // 'manual' | 'automation' | 'auto_off'
    title,
    action,
    status, // 'success' | 'failed'
    details
  };

  logs.unshift(newLog); // חדש בראש הרשימה
  saveLogs(logs);
  return newLog;
}

let automations = loadAutomations();
const triggeredThisMinute = new Set();

// פונקציית עזר לשליחת פקודות למזגן
async function sendAcCommandToTuya(infraredId, remoteId, code, value) {
  const numericValue = Number(value);

  try {
    const res1 = await tuya.request({
      method: 'POST',
      path: `/v1.0/infrareds/${infraredId}/air-conditioners/${remoteId}/command`,
      body: { code, value: numericValue },
    });
    if (res1 && res1.success) return res1;
  } catch (e) {
    console.warn('Attempt 1 failed:', e.message);
  }

  try {
    const res2 = await tuya.request({
      method: 'POST',
      path: `/v1.0/infrareds/${infraredId}/air-conditioners/${remoteId}/command`,
      body: { [code]: numericValue },
    });
    if (res2 && res2.success) return res2;
  } catch (e) {
    console.warn('Attempt 2 failed:', e.message);
  }

  return await tuya.request({
    method: 'POST',
    path: `/v1.0/infrareds/${infraredId}/remotes/${remoteId}/command`,
    body: { code, value: numericValue },
  });
}

// --- API ROUTES ---

// 1. קבלת לוג פעילות
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: loadLogs() });
});

// 2. מחיקת לוגים
app.delete('/api/logs', (req, res) => {
  saveLogs([]);
  res.json({ success: true, message: 'Logs cleared' });
});

// 3. קבלת מכשירים
app.get('/api/devices', async (req, res) => {
  try {
    const pathUrl = TUYA_USER_ID ? `/v1.0/users/${TUYA_USER_ID}/devices` : `/v1.0/iot-03/devices`;
    const response = await tuya.request({ method: 'GET', path: pathUrl });
    if (response.success) {
      res.json({ success: true, devices: response.result || [] });
    } else {
      res.status(400).json({ success: false, error: response.msg });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. קבלת שלטי IR
app.get('/api/ir/:infraredId/remotes', async (req, res) => {
  try {
    const response = await tuya.request({
      method: 'GET',
      path: `/v2.0/infrareds/${req.params.infraredId}/remotes`,
    });
    if (response.success) {
      res.json({ success: true, remotes: response.result || [] });
    } else {
      res.status(400).json({ success: false, error: response.msg });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. הפעלה ידנית - מתג / דוד
app.post('/api/devices/:deviceId/command', async (req, res) => {
  const { deviceId } = req.params;
  const { commands, deviceName } = req.body;
  try {
    const response = await tuya.request({
      method: 'POST',
      path: `/v1.0/iot-03/devices/${deviceId}/commands`,
      body: { commands },
    });

    const isSuccess = !!(response && response.success);
    const actionDesc = commands.map(c => `${c.code}: ${c.value}`).join(', ');

    addLog({
      source: 'manual',
      title: deviceName || `מכשיר (${deviceId.slice(-4)})`,
      action: actionDesc,
      status: isSuccess ? 'success' : 'failed',
      details: isSuccess ? 'הופעל בהצלחה' : response?.msg || 'שגיאה'
    });

    if (isSuccess) {
      res.json({ success: true, result: response.result });
    } else {
      res.status(400).json({ success: false, error: response.msg });
    }
  } catch (error) {
    addLog({
      source: 'manual',
      title: `מכשיר (${deviceId.slice(-4)})`,
      action: 'פקודת מתג',
      status: 'failed',
      details: error.message
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. הפעלה ידנית - מזגן
app.post('/api/ir/:infraredId/remotes/:remoteId/ac-command', async (req, res) => {
  const { infraredId, remoteId } = req.params;
  const { code, value, deviceName } = req.body;
  try {
    const response = await sendAcCommandToTuya(infraredId, remoteId, code, value);
    const isSuccess = !!(response && response.success);
    const actionDesc = `${code} -> ${value}`;

    addLog({
      source: 'manual',
      title: deviceName || `מזגן (${remoteId.slice(-4)})`,
      action: actionDesc,
      status: isSuccess ? 'success' : 'failed',
      details: isSuccess ? 'הופעל בהצלחה' : response?.msg || 'שגיאה'
    });

    if (isSuccess) {
      res.json({ success: true, result: response.result });
    } else {
      res.status(400).json({ success: false, error: response?.msg });
    }
  } catch (error) {
    addLog({
      source: 'manual',
      title: `מזגן (${remoteId.slice(-4)})`,
      action: `${code} -> ${value}`,
      status: 'failed',
      details: error.message
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. קבלת אוטומציות
app.get('/api/automations', (req, res) => {
  res.json({ success: true, automations });
});

// 8. יצירת אוטומציה חדשה
app.post('/api/automations', (req, res) => {
  try {
    const newAuto = {
      id: Date.now().toString(),
      title: req.body.title || 'ללא שם',
      deviceId: req.body.deviceId,
      infraredId: req.body.infraredId || null,
      type: req.body.type || 'switch', // 'ac' | 'switch'
      action: req.body.action || 'turn_on', // 'turn_on' | 'turn_off'
      time: req.body.time, // 'HH:mm'
      days: req.body.days || [], // [0..6]
      durationMinutes: Number(req.body.durationMinutes) || 0
    };

    automations.push(newAuto);
    saveAutomations(automations);
    res.json({ success: true, automation: newAuto });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. מחיקת אוטומציה
app.delete('/api/automations/:id', (req, res) => {
  const { id } = req.params;
  try {
    automations = automations.filter(a => a.id !== id);
    saveAutomations(automations);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- מנגנון תזמון אוטומציות ---
setInterval(async () => {
  const now = new Date();
  const israelTimeString = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  const israelDateObj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const israelDay = israelDateObj.getDay();

  for (const auto of automations) {
    const triggerKey = `${auto.id}_${israelTimeString}_${israelDay}`;

    if (auto.time === israelTimeString && Array.isArray(auto.days) && auto.days.includes(israelDay)) {
      if (triggeredThisMinute.has(triggerKey)) continue;
      triggeredThisMinute.add(triggerKey);

      try {
        let response;
        const actionText = auto.action === 'turn_on' ? 'הדלקה' : 'כיבוי';
        const typeText = auto.type === 'ac' ? 'מזגן' : 'מתג/דוד';

        if (auto.type === 'ac') {
          const powerValue = auto.action === 'turn_on' ? 1 : 0;
          response = await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'power', powerValue);
        } else {
          const switchValue = auto.action === 'turn_on';
          response = await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${auto.deviceId}/commands`,
            body: { commands: [{ code: 'switch_1', value: switchValue }] }
          });
        }

        const isSuccess = !!(response && response.success);
        addLog({
          source: 'automation',
          title: auto.title,
          action: `${typeText} - ${actionText}`,
          status: isSuccess ? 'success' : 'failed',
          details: isSuccess ? `הופעל בזמן (${auto.time})` : response?.msg || 'שגיאה'
        });

        // כיבוי אוטומטי במידה והוגדר durationMinutes
        if (isSuccess && auto.durationMinutes > 0) {
          setTimeout(async () => {
            try {
              let offRes;
              if (auto.type === 'ac') {
                offRes = await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'power', 0);
              } else {
                offRes = await tuya.request({
                  method: 'POST',
                  path: `/v1.0/iot-03/devices/${auto.deviceId}/commands`,
                  body: { commands: [{ code: 'switch_1', value: false }] }
                });
              }

              const isOffSuccess = !!(offRes && offRes.success);
              addLog({
                source: 'auto_off',
                title: auto.title,
                action: `${typeText} - כיבוי אוטומטי`,
                status: isOffSuccess ? 'success' : 'failed',
                details: isOffSuccess ? `כובה בתום ${auto.durationMinutes} דקות` : offRes?.msg || 'שגיאה'
              });
            } catch (err) {
              addLog({
                source: 'auto_off',
                title: auto.title,
                action: `${typeText} - כיבוי אוטומטי`,
                status: 'failed',
                details: err.message
              });
            }
          }, auto.durationMinutes * 60 * 1000);
        }
      } catch (error) {
        addLog({
          source: 'automation',
          title: auto.title,
          action: `${auto.type === 'ac' ? 'מזגן' : 'מתג'}`,
          status: 'failed',
          details: error.message
        });
      }
    }
  }

  if (triggeredThisMinute.size > 50) triggeredThisMinute.clear();
}, 60000);

app.listen(PORT, () => {
  console.log(`🚀 השרת רץ בהצלחה על פורט ${PORT}`);
});

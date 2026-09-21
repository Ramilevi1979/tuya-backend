require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_SECRET_KEY,
});

let automations = [];

async function sendCommandToTuya(deviceId, code, value) {
  const response = await tuya.request({ 
    path: `/v1.0/devices/${deviceId}/commands`, 
    method: 'POST', 
    body: { commands: [{ code, value }] } 
  });
  if (!response.success) {
    throw new Error(response.msg || 'Failed to send command');
  }
  return response.result;
}

app.get('/', (req, res) => res.send('🚀 Tuya Backend Service is running successfully!'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

app.get('/api/devices', async (req, res) => {
  try {
    const uid = process.env.TUYA_UID;
    const response = await tuya.request({ path: `/v1.0/users/${uid}/devices`, method: 'GET' });
    if (!response.success) return res.status(400).json({ error: response.msg });
    res.json({ success: true, devices: response.result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands } = req.body; 
  try {
    const cmds = Array.isArray(commands) ? commands : [commands];
    const response = await tuya.request({ path: `/v1.0/devices/${id}/commands`, method: 'POST', body: { commands: cmds } });
    if (!response.success) return res.status(400).json({ error: response.msg });
    res.json({ success: true, result: response.result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send command' });
  }
});

app.get('/api/ir/:infraredId/remotes', async (req, res) => {
  try {
    const response = await tuya.request({ path: `/v1.0/infrareds/${req.params.infraredId}/remotes`, method: 'GET' });
    if (!response.success) return res.status(400).json({ error: response.msg });
    res.json({ success: true, remotes: response.result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch IR remotes' });
  }
});

app.post('/api/ir/:infraredId/remotes/:remoteId/ac-command', async (req, res) => {
  try {
    const { infraredId, remoteId } = req.params;
    const { code, value } = req.body; 

    const response = await tuya.request({
      path: `/v1.0/infrareds/${infraredId}/air-conditioners/${remoteId}/command`,
      method: 'POST',
      body: { code: code, value: value },
    });

    if (!response.success) return res.status(400).json({ error: response.msg });
    res.json({ success: true, result: response.result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send AC command' });
  }
});

// ==========================================
// ניהול אוטומציות ותזמונים
// ==========================================

app.get('/api/automations', (req, res) => {
  res.json({ success: true, automations });
});

app.post('/api/automations', (req, res) => {
  const { title, deviceId, code, value, time, days, durationMinutes } = req.body;
  
  if (!deviceId || !time) {
    return res.status(400).json({ success: false, error: 'חובה לספק מזהה מכשיר ושעה' });
  }

  const newAuto = {
    id: Date.now().toString(),
    title: title || 'אוטומציה חדשה',
    deviceId,
    code: code || 'switch_1',
    value: value !== undefined ? value : true,
    time, 
    days: days || [0, 1, 2, 3, 4, 5, 6],
    durationMinutes: durationMinutes || 0 
  };

  automations.push(newAuto);
  console.log('✅ נוצרה אוטומציה חדשה:', newAuto);
  res.json({ success: true, automation: newAuto });
});

app.delete('/api/automations/:id', (req, res) => {
  const { id } = req.params;
  automations = automations.filter(a => a.id !== id);
  console.log(`🗑️ נמחקה אוטומציה עם מזהה: ${id}`);
  res.json({ success: true });
});

// לולאה רצה כל דקה עם לוגים מפורטים לדיבוג
setInterval(async () => {
  try {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    const currentDay = now.getDay();
    
    console.log(`🔍 [Interval] שעון ישראל כעת: ${currentTime}, יום בשבוע: ${currentDay}, סך אוטומציות בזיכרון: ${automations.length}`);

    for (const auto of automations) {
      console.log(`- בדיקת אוטומציה "${auto.title}": מיועדת לשעה ${auto.time}`);
      if (auto.time === currentTime && (!auto.days || auto.days.includes(currentDay))) {
        console.log(`⏰ מפעיל אוטומציה מתוזמנת: ${auto.title}`);
        
        try {
          await sendCommandToTuya(auto.deviceId, auto.code, auto.value);
          console.log(`✨ פקודה נשלחה בהצלחה עבור: ${auto.title}`);
        } catch (cmdErr) {
          console.error(`❌ שגיאה בהפעלת אוטומציה ${auto.title}:`, cmdErr.message);
        }

        if (auto.durationMinutes && auto.durationMinutes > 0) {
          setTimeout(async () => {
            try {
              console.log(`⏱️ מפעיל כיבוי אוטומטי עבור: ${auto.title}`);
              const offValue = typeof auto.value === 'boolean' ? !auto.value : false;
              await sendCommandToTuya(auto.deviceId, auto.code, offValue);
              console.log(`✨ כיבוי אוטומטי בוצע בהצלחה עבור: ${auto.title}`);
            } catch (err) {
              console.error(`❌ שגיאה בביצוע כיבוי אוטומטי ל-${auto.title}:`, err.message);
            }
          }, auto.durationMinutes * 60 * 1000);
        }
      }
    }
  } catch (err) {
    console.error('❌ שגיאה בלולאת האוטומציות:', err);
  }
}, 60 * 1000);

app.listen(PORT, () => console.log(`🚀 Tuya Automation Backend running on http://localhost:${PORT}`));

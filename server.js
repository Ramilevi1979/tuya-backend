const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// תמיכה גמישה בשמות משתני הסביבה (Render ומקומי)
const TUYA_ACCESS_KEY = process.env.TUYA_ACCESS_KEY || process.env.TUYA_ACCESS_ID;
const TUYA_SECRET_KEY = process.env.TUYA_SECRET_KEY;
const TUYA_ENDPOINT = process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com';
const TUYA_USER_ID = process.env.TUYA_USER_ID || process.env.TUYA_UID;
const TUYA_IR_HUB_ID = process.env.TUYA_IR_HUB_ID || 'bf818853ec3c1fa781w3vo';

if (!TUYA_ACCESS_KEY || !TUYA_SECRET_KEY) {
  console.error('❌ שגיאה קריטית: מפתחות ה-API של Tuya (ACCESS_KEY / SECRET_KEY) אינם מוגדרים במשתני הסביבה!');
}

// הגדרת חיבור Tuya OpenAPI
const tuya = new TuyaContext({
  baseUrl: TUYA_ENDPOINT,
  accessKey: TUYA_ACCESS_KEY,
  secretKey: TUYA_SECRET_KEY,
});

// קובץ אחסון אוטומציות
const AUTOMATIONS_FILE = path.join(__dirname, 'automations.json');

function loadAutomations() {
  try {
    if (fs.existsSync(AUTOMATIONS_FILE)) {
      const data = fs.readFileSync(AUTOMATIONS_FILE, 'utf8');
      return JSON.parse(data);
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

let automations = loadAutomations();
const triggeredThisMinute = new Set();

// פונקציית עזר לשליחת פקודות למזגן עם מנגנון גיבוי
async function sendAcCommandToTuya(infraredId, remoteId, code, value) {
  const numericValue = Number(value);
  const targetInfraredId = infraredId || TUYA_IR_HUB_ID;

  // ניסיון 1: נתיב מזגנים תקני ב-Tuya OpenAPI
  try {
    const res1 = await tuya.request({
      method: 'POST',
      path: `/v1.0/infrareds/${targetInfraredId}/air-conditioners/${remoteId}/command`,
      body: { code, value: numericValue },
    });
    if (res1 && res1.success) return res1;
  } catch (e) {
    console.warn('Attempt 1 (air-conditioners standard) failed:', e.message);
  }

  // ניסיון 2: נתיב מזגנים עם מבנה פיילוד ישיר
  try {
    const res2 = await tuya.request({
      method: 'POST',
      path: `/v1.0/infrareds/${targetInfraredId}/air-conditioners/${remoteId}/command`,
      body: { [code]: numericValue },
    });
    if (res2 && res2.success) return res2;
  } catch (e) {
    console.warn('Attempt 2 (air-conditioners direct key) failed:', e.message);
  }

  // ניסיון 3: נתיב שלט כללי
  return await tuya.request({
    method: 'POST',
    path: `/v1.0/infrareds/${targetInfraredId}/remotes/${remoteId}/command`,
    body: { code, value: numericValue },
  });
}

// --- API ROUTES ---

// 0. נתיב ראשי / בדיקת תקינות (Health Check)
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Tuya Backend API is running smoothly 🚀' });
});

// 1. קבלת כל המכשירים
app.get('/api/devices', async (req, res) => {
  try {
    const pathUrl = TUYA_USER_ID 
      ? `/v1.0/users/${TUYA_USER_ID}/devices` 
      : `/v1.0/iot-03/devices`;

    const response = await tuya.request({
      method: 'GET',
      path: pathUrl,
    });

    if (response.success) {
      res.json({ success: true, devices: response.result || [] });
    } else {
      res.status(400).json({ success: false, error: response.msg || 'Failed to fetch devices' });
    }
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. קבלת שלטי IR עבור רכזת
app.get('/api/ir/:infraredId/remotes', async (req, res) => {
  const { infraredId } = req.params;
  try {
    const response = await tuya.request({
      method: 'GET',
      path: `/v2.0/infrareds/${infraredId}/remotes`,
    });

    if (response.success) {
      res.json({ success: true, remotes: response.result || [] });
    } else {
      res.status(400).json({ success: false, error: response.msg || 'Failed to fetch remotes' });
    }
  } catch (error) {
    console.error('Error fetching remotes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. שליחת פקודות (גשר מאוחד למתגים רגילים ולמזגנים)
app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands, isAc, acPayload, infraredId } = req.body;

  try {
    // אם המשתמש מפעיל מזגן דרך הממשק
    if (isAc && acPayload) {
      const response = await sendAcCommandToTuya(infraredId, id, 'power', acPayload.power);
      return res.json({ success: true, result: response });
    }

    // מתג / שקע חכם רגיל
    const cleanCommands = commands ? commands.filter(c => c.code && c.value !== undefined) : [];
    const response = await tuya.request({
      method: 'POST',
      path: `/v1.0/iot-03/devices/${id}/commands`,
      body: { commands: cleanCommands },
    });

    if (response && response.success) {
      res.json({ success: true, result: response.result });
    } else {
      res.status(400).json({ success: false, error: response?.msg || 'נדחה על ידי Tuya' });
    }
  } catch (error) {
    console.error('Error sending device command:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. שליחת פקודה למזגן IR דרך הנתיב הישיר
app.post('/api/ir/:infraredId/remotes/:remoteId/ac-command', async (req, res) => {
  const { infraredId, remoteId } = req.params;
  const { code, value } = req.body;
  try {
    const response = await sendAcCommandToTuya(infraredId, remoteId, code, value);

    if (response && response.success) {
      res.json({ success: true, result: response.result });
    } else {
      res.status(400).json({ success: false, error: response ? response.msg : 'Failed to send AC command' });
    }
  } catch (error) {
    console.error('Error sending AC command:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. קבלת אוטומציות
app.get('/api/automations', (req, res) => {
  res.json({ success: true, automations });
});

// 6. יצירת אוטומציה חדשה
app.post('/api/automations', (req, res) => {
  try {
    const newAuto = {
      id: Date.now().toString(),
      title: req.body.title || 'ללא שם',
      deviceId: req.body.deviceId,
      infraredId: req.body.infraredId || null,
      type: req.body.type || 'switch', // 'ac', 'tv', או 'switch'
      action: req.body.action || 'turn_on', // 'turn_on' או 'turn_off'
      time: req.body.time, // 'HH:mm'
      days: req.body.days || [], // [0..6]
      durationMinutes: Number(req.body.durationMinutes) || 0,
      ...(req.body.temp !== undefined && { temp: req.body.temp }),
      ...(req.body.mode !== undefined && { mode: req.body.mode }),
      ...(req.body.wind !== undefined && { wind: req.body.wind })
    };

    automations.push(newAuto);
    saveAutomations(automations);
    console.log('✅ נוצרה אוטומציה חדשה:', newAuto);
    res.json({ success: true, automation: newAuto });
  } catch (error) {
    console.error('❌ שגיאה בשמירת אוטומציה:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. מחיקת אוטומציה
app.delete('/api/automations/:id', (req, res) => {
  const { id } = req.params;
  try {
    automations = automations.filter(a => a.id !== id);
    saveAutomations(automations);
    console.log(`🗑️ נמחקה אוטומציה עם מזהה: ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ שגיאה במחיקת אוטומציה:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. ראוט מחקר - משיכת מפרט ופקודות של מכשיר מ-Tuya
app.get('/api/debug/device/:id', async (req, res) => {
  const { id } = req.params;
  try {
    console.log(`[Debug] שולף מפרט עבור מכשיר: ${id}`);

    // פרטי המכשיר והקטגוריה
    const detailsRes = await tuya.request({
      method: 'GET',
      path: `/v1.0/iot-03/devices/${id}`,
    });

    // סטטוס נוכחי
    const statusRes = await tuya.request({
      method: 'GET',
      path: `/v1.0/iot-03/devices/${id}/status`,
    });

    // רשימת הפקודות והערכים המותרים
    const functionsRes = await tuya.request({
      method: 'GET',
      path: `/v1.0/iot-03/devices/${id}/functions`,
    });

    res.json({
      success: true,
      deviceId: id,
      details: detailsRes.result || {},
      status: statusRes.result || [],
      functions: functionsRes.result || {},
    });
  } catch (error) {
    console.error('Error in debug device endpoint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- מנגנון בדיקת והפעלת אוטומציות לפי שעון ישראל ---
setInterval(async () => {
  const now = new Date();
  
  const israelTimeString = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  const israelDateObj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const israelDay = israelDateObj.getDay();

  console.log(`🔍 [Interval] שעון ישראל כעת: ${israelTimeString}, יום בשבוע: ${israelDay}, סך אוטומציות בזיכרון: ${automations.length}`);

  for (const auto of automations) {
    console.log(`- בדיקת אוטומציה "${auto.title}": מיועדת לשעה ${auto.time}`);

    const triggerKey = `${auto.id}_${israelTimeString}_${israelDay}`;

    if (auto.time === israelTimeString && Array.isArray(auto.days) && auto.days.includes(israelDay)) {
      if (triggeredThisMinute.has(triggerKey)) {
        continue;
      }
      triggeredThisMinute.add(triggerKey);

      console.log(`⏰ מפעיל אוטומציה מתוזמנת: ${auto.title}`);
      
      try {
        let response;
        if (auto.type === 'ac') {
          if (auto.action === 'turn_on') {
            response = await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'power', 1);
            
            if (auto.temp) await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'temp', auto.temp);
            if (auto.mode !== undefined) await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'mode', auto.mode);
            if (auto.wind !== undefined) await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'wind', auto.wind);
          } else {
            response = await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'power', 0);
          }
        } else {
          const switchValue = auto.action === 'turn_on' ? true : false;
          response = await tuya.request({
            method: 'POST',
            path: `/v1.0/iot-03/devices/${auto.deviceId}/commands`,
            body: { commands: [{ code: 'switch_1', value: switchValue }] }
          });
        }

        if (response && response.success) {
          console.log(`✅ אוטומציה ${auto.title} הופעלה בהצלחה`);

          // כיבוי אוטומטי במידה והוגדר
          if (auto.durationMinutes > 0) {
            console.log(`⏱️ נקבע כיבוי אוטומטי בעוד ${auto.durationMinutes} דקות עבור: ${auto.title}`);
            setTimeout(async () => {
              console.log(`⏱️ מפעיל כיבוי אוטומטי עבור: ${auto.title}`);
              try {
                if (auto.type === 'ac') {
                  await sendAcCommandToTuya(auto.infraredId, auto.deviceId, 'power', 0);
                } else {
                  await tuya.request({
                    method: 'POST',
                    path: `/v1.0/iot-03/devices/${auto.deviceId}/commands`,
                    body: { commands: [{ code: 'switch_1', value: false }] }
                  });
                }
                console.log(`✅ כיבוי אוטומטי הושלם בהצלחה: ${auto.title}`);
              } catch (err) {
                console.error(`❌ שגיאה בביצוע כיבוי אוטומטי ל-${auto.title}:`, err.message || err);
              }
            }, auto.durationMinutes * 60 * 1000);
          }
        } else {
          console.error(`❌ כישלון בהפעלת אוטומציה ${auto.title}:`, response ? response.msg : 'Unknown error');
        }
      } catch (error) {
        console.error(`❌ שגיאה בהפעלת אוטומציה ${auto.title}:`, error.message || error);
      }
    }
  }

  if (triggeredThisMinute.size > 50) {
    triggeredThisMinute.clear();
  }
}, 60000);

app.listen(PORT, () => {
  console.log(`🚀 השרת רץ בהצלחה על פורט ${PORT}`);
});

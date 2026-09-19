require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// אתחול חיבור ל-Tuya SDK
const tuya = new TuyaContext({
  baseUrl: process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com',
  accessKey: process.env.TUYA_ACCESS_ID,
  secretKey: process.env.TUYA_SECRET_KEY,
});

// נתיב ראשי לבדיקה
app.get('/', (req, res) => {
  res.send('🚀 Tuya Backend Service is running successfully!');
});

// בדיקת תקינות השרת
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// קבלת רשימת כל המכשירים
app.get('/api/devices', async (req, res) => {
  try {
    const uid = process.env.TUYA_UID;
    if (!uid) {
      return res.status(400).json({ error: 'TUYA_UID is not defined in .env' });
    }

    const response = await tuya.request({
      path: `/v1.0/users/${uid}/devices`,
      method: 'GET',
    });

    if (!response.success) {
      return res.status(400).json({ error: response.msg });
    }

    res.json({ success: true, devices: response.result });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices from Tuya' });
  }
});

// שליחת פקודה למכשיר רגיל (מתג/שקע)
app.post('/api/devices/:id/command', async (req, res) => {
  const { id } = req.params;
  const { commands } = req.body; 

  try {
    const response = await tuya.request({
      path: `/v1.0/devices/${id}/commands`,
      method: 'POST',
      body: { commands },
    });

    if (!response.success) {
      return res.status(400).json({ error: response.msg });
    }

    res.json({ success: true, result: response.result });
  } catch (error) {
    console.error(`Error sending command to device ${id}:`, error);
    res.status(500).json({ error: 'Failed to send command' });
  }
});

// ==========================================
// נתיבים חדשים עבור שלטי IR / רכזת אינפרא-אדום
// ==========================================

// 1. קבלת רשימת השלטים המשויכים לרכזת IR
app.get('/api/ir/:infraredId/remotes', async (req, res) => {
  try {
    const { infraredId } = req.params;
    const response = await tuya.request({
      path: `/v1.0/infrareds/${infraredId}/remotes`,
      method: 'GET',
    });

    if (!response.success) {
      return res.status(400).json({ error: response.msg });
    }

    res.json({ success: true, remotes: response.result });
  } catch (error) {
    console.error('Error fetching IR remotes:', error);
    res.status(500).json({ error: 'Failed to fetch IR remotes' });
  }
});

// 2. שליחת פקודת IR למזגן (Power, Temp, Mode)
app.post('/api/ir/:infraredId/remotes/:remoteId/ac-command', async (req, res) => {
  try {
    const { infraredId, remoteId } = req.params;
    const { power, mode, temp } = req.body; // power: 1/0, mode: 0-4, temp: 16-30

    const response = await tuya.request({
      path: `/v1.0/infrareds/${infraredId}/ac-remotes/${remoteId}/command`,
      method: 'POST',
      body: {
        power: power !== undefined ? power : 1,
        mode: mode !== undefined ? mode : 0,
        temp: temp !== undefined ? temp : 24,
      },
    });

    if (!response.success) {
      return res.status(400).json({ error: response.msg });
    }

    res.json({ success: true, result: response.result });
  } catch (error) {
    console.error('Error sending AC command:', error);
    res.status(500).json({ error: 'Failed to send AC command' });
  }
});

// הפעלת השרת
app.listen(PORT, () => {
  console.log(`🚀 Tuya Automation Backend running on http://localhost:${PORT}`);
});

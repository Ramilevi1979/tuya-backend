require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const app = express();
// ב-Render חובה להשתמש ב-process.env.PORT שאינו קבוע
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

// נתיב ראשי למניעת 404 כשנכנסים לכתובת הבסיס
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
      return res.status(400).json({ error: 'TUYA_UID is not defined in environment variables' });
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

// שליחת פקודה למכשיר (הדלקה/כיבוי)
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

// הפעלת השרת
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Tuya Automation Backend running on port ${PORT}`);
});

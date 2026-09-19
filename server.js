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
    const response = await tuya.request({ path: `/v1.0/devices/${id}/commands`, method: 'POST', body: { commands } });
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

// נתיב מתוקן - מקבל בדיוק 'code' ו-'value' כפי ש-Tuya דורשים
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

app.listen(PORT, () => console.log(`🚀 Tuya Automation Backend running on http://localhost:${PORT}`));

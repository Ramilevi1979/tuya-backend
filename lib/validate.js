'use strict';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_RE = /^[a-z0-9_]{1,40}$/i;
const TYPES = ['ac', 'tv', 'switch'];
const ACTIONS = ['turn_on', 'turn_off'];

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Validates an automation payload. With partial=true only the fields that are
 * present are checked (used for PATCH). Returns { value } or { errors }.
 */
function validateAutomation(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  const errors = [];
  const has = (key) => input[key] !== undefined;

  if (!partial || has('title')) {
    const title = String(input.title ?? '').trim();
    if (!title || title.length > 60) errors.push('שם התזמון חייב להכיל 1 עד 60 תווים');
    else out.title = title;
  }

  if (!partial || has('deviceId')) {
    const id = String(input.deviceId ?? '');
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) errors.push('לא נבחר מכשיר');
    else out.deviceId = id;
  }

  if (has('deviceName')) out.deviceName = String(input.deviceName).slice(0, 80);
  if (has('infraredId')) out.infraredId = input.infraredId ? String(input.infraredId).slice(0, 64) : null;
  if (has('remoteIndex')) out.remoteIndex = input.remoteIndex ? String(input.remoteIndex).slice(0, 16) : null;

  if (has('switchCode')) {
    if (input.switchCode && !CODE_RE.test(input.switchCode)) errors.push('קוד המתג אינו תקין');
    else out.switchCode = input.switchCode || null;
  }

  if (!partial || has('type')) {
    const type = input.type ?? 'switch';
    if (!TYPES.includes(type)) errors.push('סוג מכשיר לא נתמך');
    else out.type = type;
  }

  if (!partial || has('action')) {
    const action = input.action ?? 'turn_on';
    if (!ACTIONS.includes(action)) errors.push('הפעולה חייבת להיות הדלקה או כיבוי');
    else out.action = action;
  }

  if (!partial || has('time')) {
    if (!TIME_RE.test(String(input.time ?? ''))) errors.push('השעה חייבת להיות בפורמט HH:mm');
    else out.time = input.time;
  }

  if (!partial || has('days')) {
    const days = Array.isArray(input.days) ? input.days.map((d) => intInRange(d, 0, 6)) : [];
    if (!days.length || days.includes(null)) errors.push('יש לבחור לפחות יום אחד');
    else out.days = [...new Set(days)].sort((a, b) => a - b);
  }

  if (!partial || has('durationMinutes')) {
    const minutes = intInRange(input.durationMinutes ?? 0, 0, 1440);
    if (minutes === null) errors.push('משך הכיבוי האוטומטי חייב להיות בין 0 ל-1440 דקות');
    else out.durationMinutes = minutes;
  }

  for (const [key, min, max, label] of [
    ['temp', 16, 30, 'הטמפרטורה'],
    ['mode', 0, 4, 'המצב'],
    ['wind', 0, 3, 'עוצמת המאוורר'],
  ]) {
    if (has(key) && input[key] !== null) {
      const n = intInRange(input[key], min, max);
      if (n === null) errors.push(`${label} מחוץ לטווח`);
      else out[key] = n;
    }
  }

  if (has('enabled')) {
    if (typeof input.enabled !== 'boolean') errors.push('ערך הפעלה לא תקין');
    else out.enabled = input.enabled;
  }

  return errors.length ? { errors } : { value: out };
}

module.exports = { validateAutomation, TIME_RE, CODE_RE };

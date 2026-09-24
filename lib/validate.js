'use strict';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[a-z0-9_]{1,40}$/i;
const TYPES = ['ac', 'tv', 'switch'];
const ACTIONS = ['turn_on', 'turn_off'];
const KINDS = ['weekly', 'once', 'interval'];

function intInRange(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validates an automation payload. With partial=true only the fields that are
 * present are checked (used for PATCH). Returns { value } or { errors }.
 *
 * Kinds:
 *  - weekly   (default): runs at `time` on the chosen `days`, every week
 *  - once:    runs once, on `date` at `time`
 *  - interval: inside the window `time` → `endTime` (which may cross midnight),
 *              switches on for `durationMinutes` every `everyMinutes`
 */
function validateAutomation(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  const errors = [];
  const has = (key) => input[key] !== undefined;

  const kind = partial ? input.kind : (input.kind ?? 'weekly');
  if (!partial || has('kind')) {
    if (!KINDS.includes(kind)) errors.push('סוג תזמון לא נתמך');
    else out.kind = kind;
  }

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

  if (kind === 'once' && !partial) {
    out.days = [];
  } else if (!partial || has('days')) {
    const days = Array.isArray(input.days) ? input.days.map((d) => intInRange(d, 0, 6)) : [];
    if (!days.length || days.includes(null)) errors.push('יש לבחור לפחות יום אחד');
    else out.days = [...new Set(days)].sort((a, b) => a - b);
  }

  if (!partial || has('durationMinutes')) {
    const minutes = intInRange(input.durationMinutes ?? 0, 0, 1440);
    if (minutes === null) errors.push('משך ההפעלה חייב להיות בין 0 ל-1440 דקות');
    else out.durationMinutes = minutes;
  }

  if (has('date') || (!partial && kind === 'once')) {
    if (!isRealDate(input.date)) errors.push('יש לבחור תאריך תקין');
    else out.date = input.date;
  }

  if (has('endTime') || (!partial && kind === 'interval')) {
    if (!TIME_RE.test(String(input.endTime ?? ''))) errors.push('שעת הסיום חייבת להיות בפורמט HH:mm');
    else out.endTime = input.endTime;
  }

  if (has('everyMinutes') || (!partial && kind === 'interval')) {
    const every = intInRange(input.everyMinutes, 15, 720);
    if (every === null) errors.push('המרווח בין ההפעלות חייב להיות בין 15 ל-720 דקות');
    else out.everyMinutes = every;
  }

  if (!partial && kind === 'interval') {
    if (out.time && out.endTime && out.time === out.endTime) {
      errors.push('שעת הסיום חייבת להיות שונה משעת ההתחלה');
    }
    if (input.action === 'turn_off') errors.push('תזמון מחזורי מדליק את המכשיר ומכבה אותו לבד');
    if (out.type === 'tv') errors.push('תזמון מחזורי לא נתמך לטלוויזיה');
    if (out.durationMinutes !== undefined && out.everyMinutes !== undefined &&
        (out.durationMinutes < 1 || out.durationMinutes >= out.everyMinutes)) {
      errors.push('משך ההפעלה חייב להיות קצר מהמרווח בין ההפעלות');
    }
    if (!errors.length) out.action = 'turn_on';
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

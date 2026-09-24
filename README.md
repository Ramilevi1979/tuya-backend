# הבית שלי – שרת (Backend)

Express + Tuya Cloud API. מריץ גם את התזמונים.

## משתני סביבה חובה
`TUYA_ACCESS_ID`, `TUYA_SECRET_KEY`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAIL`, `SESSION_SECRET` (32 תווים ומעלה).
בלי אחד מהם השרת לא עולה (בכוונה). הרשימה המלאה ב-`.env.example`.

יצירת `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## שמירת תזמונים בין הפעלות
בתוכנית החינמית של Render הדיסק נמחק בכל פריסה. כדי שהתזמונים יישמרו, הגדירו `DATABASE_URL` של מסד Postgres (Render, Neon או Supabase). הטבלה נוצרת אוטומטית. בלי זה נעשה שימוש בקובץ `automations.json`.

## שרת שנרדם
בתוכנית החינמית השרת נרדם אחרי כמה דקות בלי בקשות, ותזמונים לא רצים בזמן שהוא ישן. הפתרון: שירות ניטור חינמי (UptimeRobot, cron-job.org) שפונה ל-`/` כל 5 דקות. תזמון שהוחמץ בגלל הפעלה מחדש ירוץ אם איחר עד `GRACE_MINUTES` (ברירת מחדל 5).

## בדיקות
```bash
npm test
```

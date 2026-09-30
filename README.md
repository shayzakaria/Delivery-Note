# MODY · דיווח משלוחים לפורטל סולל בונה

אתר פנימי של MODY לדיווח **תעודות משלוח** ו**חשבוניות** לפורטל הספקים של שיכון ובינוי / סולל בונה.
האתר מחליף את קובץ ה-HTML הבודד (Netlify + אחסון בדפדפן) באפליקציה עם בסיס נתונים משותף ב-Supabase,
התחברות משתמשים, היסטוריה מרכזית ושמירה אוטומטית של העבודה.

> ניתוח מלא של המערכת, פורמטי הקבצים והתיקונים שבוצעו: [`docs/ANALYSIS.md`](docs/ANALYSIS.md)

## מה יש באתר

| לשונית | תפקיד |
|---|---|
| 📦 תעודות משלוח | טעינת קובץ "הזמנות פתוחות" מהפורטל, סימון פריטים שסופקו, מספר תעודה ותאריך לכל הזמנה, צירוף תיקיית ה-PDF (`S<מספר>.pdf`) והורדת חבילה (CSV + PDF) לקליטה בפורטל |
| 📋 היסטוריה | כל הייצואים של כל המשתמשים, עם פירוט שורות והורדה חוזרת של ה-CSV |
| 🧾 חשבוניות | דיווח חשבונית לפי הזמנה (כמו באפליקציה המקורית) |
| ⚖ התאמת חשבוניות | הצלבת דוח החשבוניות מהתוכנה מול דוח "סטטוס משלוחים" מהפורטל (כולל מע"מ), והפקת קובץ ממשק החשבוניות (12 עמודות) + PDF `I<מספר>.pdf` |
| 👥 משתמשים | (מנהלים בלבד) ניהול רשימת המשתמשים המורשים |

הקבצים המיוצאים זהים בפורמט לאפליקציה המקורית (אותן עמודות, BOM, תאריכים ושמות קבצים), ולכן מדריך העבודה הקיים ממשיך להיות רלוונטי.

## ארכיטקטורה

- **Frontend:** React + TypeScript + Vite — אתר סטטי (מתאים ל-Cloudflare Pages / Workers).
- **Backend:** Supabase (פרויקט `lpqbdvoknexpomhcopbz` — "Delivery Note"): Postgres + Auth.
- **אבטחה:** כל הטבלאות מוגנות ב-Row Level Security. גישה ניתנת רק למשתמש מחובר, בעל מייל מאומת, **שמופיע** בטבלת `app_members`. ה-publishable key שבקוד ציבורי מעצם הגדרתו.
- **קבצי Excel** נקראים בדפדפן בתוך Web Worker מבודד (SheetJS), כך שקובץ פגום לא יכול להשפיע על האפליקציה.
- **קבצי PDF** לא עולים לשרת — הם נארזים ב-ZIP מקומית בדפדפן, כמו במקור.

סכמת בסיס הנתונים נמצאת ב-[`supabase/migrations`](supabase/migrations) (הוחלה כבר על הפרויקט).

## הרצה מקומית

```bash
npm install
npm run dev          # מול Supabase האמיתי
npm run dev:mock     # מצב הדגמה — ללא שרת, כל הנתונים נשמרים בדפדפן בלבד
npm test             # בדיקות יחידה
npm run e2e          # בדיקות דפדפן מלאות (מצב הדגמה)
npm run build        # בנייה לפרודקשן → dist/
```

## העלאה ל-Cloudflare

### אפשרות א׳ — Cloudflare Pages (מומלץ)
1. ב-Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** ובחירת הריפו `shayzakaria/Delivery-Note`.
2. הגדרות בנייה: Framework preset: `Vite` · Build command: `npm run build` · Output directory: `dist`.
3. (לא חובה) משתני סביבה — ברירות המחדל כבר מצביעות על הפרויקט:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. אחרי הרכישה: **Custom domains → Set up a custom domain** והזנת הדומיין (למשל `delivery.mody.co.il`).

### אפשרות ב׳ — Workers (static assets)
```bash
npm run build && npx wrangler deploy     # משתמש ב-wrangler.jsonc
```

### אחרי שיש כתובת קבועה — חובה ב-Supabase
**Authentication → URL Configuration**:
- **Site URL**: כתובת האתר (למשל `https://delivery.mody.co.il`)
- **Redirect URLs**: אותה כתובת — נדרש כדי שקישורי "שכחתי סיסמה" יחזרו לאתר.

אם משנים את כתובת Supabase, יש לעדכן גם את `connect-src` ב-[`public/_headers`](public/_headers).

## ניהול משתמשים

1. **Supabase → Authentication → Users → Add user → Create new user**: מייל + סיסמה זמנית, לסמן **Auto Confirm User**.
2. **באתר → 👥 משתמשים**: להוסיף את אותו מייל ולבחור הרשאה (משתמש / מנהל).
3. המשתמש נכנס ומחליף סיסמה בתפריט המשתמש ← "שינוי סיסמה".

מומלץ לכבות הרשמה עצמית: **Authentication → Sign In / Providers → Allow new users to sign up = Off**
(גם אם מישהו נרשם, אין לו גישה לנתונים כל עוד אינו ברשימה).

**המנהל הראשון** מוגדר בטבלת `app_members`. להוספה ידנית (SQL Editor ב-Supabase):
```sql
insert into public.app_members (email, role) values ('name@example.com', 'admin');
```

## הרשאות

| פעולה | משתמש | מנהל |
|---|---|---|
| טעינת קובץ הזמנות, בחירות, ייצוא, צפייה בהיסטוריה | ✓ | ✓ |
| מחיקת רשומת היסטוריה | – | ✓ |
| ניהול משתמשים | – | ✓ |

הבחירות (טיוטות) של כל משתמש פרטיות לו ונשמרות אוטומטית. קובץ ההזמנות הפתוחות משותף לכולם (הטעינה האחרונה קובעת).

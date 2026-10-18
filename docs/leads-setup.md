# הקמת קליטת לידים — Preview בלבד

הקוד מיועד לברנץ `client-review-2026-10-15`. ההגדרות במאגר כבויות בכוונה.
כתיבת הקוד והבדיקות המקומיות אינן יוצרות שירותים בחשבונות Google/Cloudflare.
הפקודות והשלבים הכוללים פריסה במסמך זה מיועדים לביצוע ידני, לאחר אישור.
אין לבצע Merge ל־main, לשנות את GitHub Pages, לערוך CNAME או לשנות DNS של glattai.com.

## מה הוקם בקוד

```text
טופס קיים → Worker בכתובת workers.dev → Apps Script → Google Sheets
                                              └→ MailApp → כתובת התראות
```

- האתר מקבל תשובת JSON רק לאחר שהשרת אישר שמירה. כישלון מייל אינו מבטל את השמירה.
- כל שליחה מקבלת request_id. ניסיון חוזר ללא שינוי הפרטים משתמש באותו מזהה.
- השרת שומר גם lead_id פנימי, hash של התוכן ומצב התראה עמיד לתקלות.
- כל שדות המתעניין נשמרים ב־Sheets עם `valueInputOption: RAW` למניעת הרצת נוסחאות.
- הגדרות חשבון אינן בקוד העסקי: קובץ הגדרות ציבורי לאתר, vars/Secrets ב־Worker, ו־Script Properties ב־Google.
- Worker ההתראות הישן שב־`worker/` אינו משתנה. השירות החדש נמצא ב־`lead-gateway/` ושמו `glattai-leads-review`.

## 1. הכנות

1. בחרי חשבון Google לבדיקות וכתובת מייל שתקבל התראות. מומלץ גיליון חדש וריק, ללא נתוני לקוחות קיימים.
2. העתיקי את כתובת ה־Vercel Preview המדויקת של הברנץ, רצוי כתובת ה־branch alias הקבועה.
   Origin הוא `https://HOST.vercel.app` בלבד — ללא נתיב, `/` בסוף או query string.
3. צרי/בחרי חשבון Cloudflare במסלול **Workers Free**. אין צורך להעביר אליו דומיין.
4. ודאי שבמחשב יש Node.js 22 ומעלה; סביבת הבדיקות המקומית השתמשה ב־Node.js 24.
5. ודאי שאת בתיקייה ובברנץ הנכונים:

```bash
cd "/Users/estherweinstock/Downloads/app 9/glatt-ai-preview"
git branch --show-current
git status --short
```

הברנץ חייב להיות `client-review-2026-10-15`. אין לבצע reset או למחוק שינויים.

## 2. יצירת Google Sheet

1. צרי גיליון חדש בשם `Glatt AI — Preview Leads`.
2. השאירי את השיתוף במצב Restricted; אין לפרסם את הגיליון לציבור.
3. העתיקי את המזהה מתוך הכתובת: החלק שבין `/d/` לבין `/edit`.
4. אין צורך להכין עמודות ידנית. `setupLeads` ייצור לשונית `Leads` וכותרות.

## 3. יצירת Apps Script

1. פתחי `https://script.google.com/` ובחרי **New project**. קראי לו `Glatt AI Leads — Preview`.
2. החליפי את תוכן `Code.gs` בתוכן הקובץ `google-apps-script/Code.gs` שבמאגר.
3. צרי קובץ Script נוסף בשם **Core** (בעורך יופיע `Core.gs`). העתיקי אליו את **כל** תוכן `assets/leads-core.js`.
   זהו אותו קוד ולידציה שנבדק באתר וב־Worker; אין ליצור גרסה נפרדת או לשנות אותו רק ב־Google.
4. תחת **Project Settings**, הפעילי **Show appsscript.json manifest file in editor**.
5. החליפי את תוכן המניפסט בתוכן `google-apps-script/appsscript.json` ושמרי.
6. תחת **Services**, ודאי שמופיע **Google Sheets API v4**, עם identifier בשם `Sheets`.
   המניפסט אמור להוסיף אותו; אם חסר, לחצי `+` והוסיפי Google Sheets API.
   בפרויקט Cloud הרגיל ש־Apps Script יוצר אוטומטית, הפעלת השירות מפעילה גם את ה־API.
   אם בחרת לחבר פרויקט Google Cloud קיים משלך, יש להפעיל בו ידנית את Google Sheets API.

השירות המתקדם משמש לכתיבה במצב RAW. אין להחליף אותה ב־`appendRow` או ב־`setValues` עבור קלט של מתעניינים.
[הפעלת שירותים מתקדמים](https://developers.google.com/apps-script/guides/services/advanced),
[מצב RAW ב־Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).

## 4. Script Properties וסוד משותף

צרי סוד אקראי של 32 bytes, מיוצג ב־64 תווי hex. במק אפשר ליצור אותו ישירות ללוח ההעתקה:

```bash
openssl rand -hex 32 | pbcopy
```

שמרי אותו במנהל סיסמאות. אל תשלחי אותו בצ'אט ואל תוסיפי אותו לקובץ במאגר.
שני הצדדים משתמשים **ב־64 התווים כמחרוזת UTF-8**, לא מפענחים אותם לבתים של hex.

ב־Apps Script, תחת **Project Settings → Script Properties**, הוסיפי:

| מפתח | ערך |
|---|---|
| `ENVIRONMENT` | `preview` |
| `ENABLED` | `false` בשלב ההקמה |
| `SHEET_ID` | מזהה הגיליון הפרטי שיצרת |
| `SHEET_NAME` | `Leads` |
| `NOTIFICATION_EMAIL` | כתובת התראות אחת, בלי רשימה מופרדת בפסיקים |
| `ALLOWED_ORIGINS` | למשל `["https://your-exact-preview.vercel.app"]` |
| `HMAC_SECRET` | הסוד בן 64 התווים שיצרת |

הקובץ `google-apps-script/settings.example.json` הוא דוגמה בלבד, לא קובץ סודות ולא קובץ לטעינה אוטומטית.

אין להוסיף כאן את `glattai.com`, `www.glattai.com` או GitHub Pages. הגרסה הזו דוחה אותם גם אם הוכנסו בטעות לרשימה.
בדיקה מקומית אמיתית, בהמשך, יכולה להוסיף Origin מפורש כגון `http://localhost:8080` לכל שלוש רשימות ההרשאה.

## 5. הרשאות ואתחול

1. בעורך Apps Script בחרי את הפונקציה `setupLeads` ולחצי **Run**.
2. אשרי בחשבון שלך את ההרשאות: עבודה עם Sheets, שליחת מייל ויצירת טריגר.
   אין צורך בסיסמת Gmail, ב־App Password, ב־OAuth client secret או בהרשאת קריאת תיבת המייל.
3. אם מופיעה אזהרת אפליקציה שלא אומתה, ודאי שזה הפרויקט שאת יצרת והקוד שהעתקת, לפני אישור ההרשאות.
4. בדקי שנוצרה לשונית `Leads`, שהכותרות מופיעות ושהגיליון מימין לשמאל.
5. תחת **Triggers** ודאי שנוצר טריגר אחד ל־`retryNotifications`, כל 5 דקות.
   הפעלה חוזרת של `setupLeads` לא אמורה ליצור טריגר כפול או למחוק נתונים.

`setupLeads` לא שולחת הודעת ניסיון. אם מופיעה `LEAD_SETUP_ERROR...`, בדקי את ההגדרות, השירות `Sheets`, ההרשאות והכותרות.
הקוד מסרב לדרוס גיליון שהכותרות שלו אינן תואמות.

## 6. פרסום Apps Script לבדיקות

זהו שלב ידני בחשבון Google, לא פריסת האתר הראשי.

1. בחרי **Deploy → New deployment → Web app**.
2. הגדירי **Execute as: Me**.
3. הגדירי **Who has access: Anyone** (כולל מי שאינו מחובר לחשבון Google).
   אם מדיניות ארגונית אינה מאפשרת זאת, יש לפתור את ההרשאות עם מנהל החשבון לפני ההמשך.
4. לחצי **Deploy**, ואשרי הרשאות אם נדרש.
5. העתיקי את כתובת ה־Web App שמסתיימת ב־`/exec`, לא `/dev`.

הכתובת נגישה מבחוץ, אבל `doPost` דוחה בקשות ללא חתימה תקינה. אין API ציבורי לקריאת לידים או לשליחת התראות חוזרת.
פתיחת הכתובת בדפדפן מחזירה `METHOD_NOT_ALLOWED` — זו התנהגות תקינה ל־GET, לא בדיקת שמירה.
אין להעביר למבקרים OAuth tokens. [הגדרת Web App](https://developers.google.com/apps-script/guides/web).

## 7. הקמת Cloudflare Worker נפרד

השתמשי ב־Wrangler 4.36 ומעלה, התומך ב־`ratelimits`. הפקודות כאן משתמשות בגרסה 4.
אין לחבר את ה־Worker ל־Git לפריסה אוטומטית ואין להוסיף routes או Custom Domain.

1. ב־`lead-gateway/wrangler.jsonc`, החליפי את `ALLOWED_ORIGINS` ברשימת ה־Origins המדויקת. זהו **מחרוזת JSON**:

```json
"ALLOWED_ORIGINS": "[\"https://your-exact-preview.vercel.app\"]"
```

2. השאירי `ENABLED: "false"`, `ENVIRONMENT: "preview"`, את השם `glattai-leads-review`, ו־`routes: []`.
3. ודאי ש־`namespace_id` של שני ה־rate limiters אינו בשימוש על ידי Worker אחר בחשבון.
   אלו מזהים מספריים שתבחרי; אין צורך ליצור KV, מסד נתונים או WAF בתשלום.
4. התחברי לחשבון הנכון:

```bash
npx wrangler@4 login
npx wrangler@4 whoami
```

5. לאחר אישור לפריסת שירות הבדיקות, פרסי את ה־Worker כשהוא עדיין כבוי:

```bash
npx wrangler@4 deploy --config lead-gateway/wrangler.jsonc
```

יש להשתמש **בדיוק** בנתיב config הזה — לא ב־`worker/wrangler.jsonc` של המימוש הישן.
הפקודה תיצור/תעדכן רק את Worker הבדיקות. העתיקי את כתובת ה־`workers.dev` שמוחזרת.

6. הגדירי את שני הסודות דרך בקשות הקלט האינטראקטיביות, בלי לכתוב ערכים בתוך פקודת shell:

```bash
npx wrangler@4 secret put HMAC_SECRET --config lead-gateway/wrangler.jsonc
npx wrangler@4 secret put APPS_SCRIPT_URL --config lead-gateway/wrangler.jsonc
```

לראשון הדביקי את אותו סוד שב־Script Properties; לשני את כתובת ה־`/exec`.

7. בדקי בחשבון שזו תוכנית **Workers Free**. היישום משתמש ב־Rate Limiting Binding של Workers, לא בחבילת WAF בתשלום.
   אין בקוד משאבים או fallback שדורשים שדרוג בתשלום. אם החשבון מסרב ליצור binding, עצרי ובדקי את הזמינות; אל תסירי את ההגנה ואל תשדרגי אוטומטית.
8. שימי לב: counters של ה־binding הם אזוריים ובעלי עקביות הדרגתית, לא מכסה גלובלית מדויקת. ההגדרות הן 10 בקשות POST בדקה לכל IP ו־60 בדקה לכל השירות, **לכל מיקום Cloudflare**.
   IP נשמר רק כמפתח HMAC במגביל, לא בגיליון או בלוג האפליקציה. משתמשים ברשת משותפת עלולים לחלוק מכסה.
   [תיעוד Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## 8. חיבור Preview והפעלה מבוקרת

1. ב־Script Properties, שַני `ENABLED` ל־`true`.
2. ב־`lead-gateway/wrangler.jsonc`, שַני `ENABLED` ל־`"true"` ופרסי שוב רק את Worker הבדיקות עם אותה פקודת deploy.
3. ב־`assets/leads-config.js`, עדכני רק את ההגדרות הציבוריות:

```js
window.GLATT_LEADS_CONFIG = Object.freeze({
  environment: 'preview',
  enabled: true,
  allowedOrigins: ['https://your-exact-preview.vercel.app'],
  endpoint: 'https://glattai-leads-review.YOUR-SUBDOMAIN.workers.dev/leads',
  timeoutMs: 25000,
  privacy: { text: '', url: '' }
});
```

4. את הודעת הפרטיות המאושרת אפשר לשים ב־`privacy.text`; קישור לעמוד מדיניות באותו אתר אפשר לשים ב־`privacy.url`.
   הטקסט מוכנס באמצעות `textContent`, ללא HTML. אין במסמך נוסח משפטי מאושר; יש להשלים אותו לפני איסוף נתונים אמיתיים.
5. אחרי אישור מפורש להעלאת גרסת הבדיקה, בצעי commit ו־push **לברנץ הבדיקות בלבד** כדי לעדכן את Vercel Preview.
   לא בוצעו במסגרת המימוש commit, push, deploy או שינוי בחשבונות. Push עשוי להפעיל את פריסת Vercel המחוברת למאגר.
6. פתחי את ה־Preview ב־HTTPS ובחלון פרטי, ושלחי פרטי בדיקה בלבד. אין צורך שהמבקר יתחבר ל־Google.
7. ודאי שרק לאחר השליחה מופיעה הודעת הצלחה, שבגיליון יש שורה עם `חדש`, ושהמייל כולל את כל הפרטים ואת קישור WhatsApp.
   קישור WhatsApp פותח שיחה; המערכת אינה שולחת הודעת WhatsApp דרך Meta ואינה משתמשת בשירות בתשלום.

אין חיבור לייצור בגרסה זו. מעבר עתידי לייצור מחייב אישור נפרד והחלפת מגבלת ה־Preview בקוד המשותף, מעבר להחלפת כתובות.

בעדכון קוד Apps Script בהמשך, שמירה בעורך לבדה אינה מעדכנת את `/exec`: בחרי **Deploy → Manage deployments → Edit → New version → Deploy**.
כך נשמרת כתובת ה־deployment הקיימת. שינוי Script Properties נכנס לתוקף בלי גרסת קוד חדשה.
אם שינית את `leads-core.js`, העתיקי את אותה גרסה גם ל־`Core.gs` ובדקי תאימות לפני הפעלת השירות.

## 9. בדיקות מקומיות וחיות

בדיקות ללא תלות בחשבונות, ללא התקנת חבילות וללא שליחת מייל:

```bash
node --test tests/leads/*.test.mjs
git diff --check
```

בדיקות הדפדפן משתמשות בשרת HTTP מקומי ובתגובות מדומות. להפעלה במק:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port=9338 \
  --user-data-dir=/private/tmp/glatt-leads-browser-tests about:blank
```

בטרמינל נוסף, מתוך המאגר:

```bash
node tests/leads/browser-smoke.mjs
```

הבדיקה סוגרת את דפדפן הבדיקות בסיום. ניתן לשנות כתובת באמצעות `CDP_URL`.
היא משווה את מידות הטופס ל־HEAD ובודקת טעינה, לחיצה כפולה, כשל, timeout, תשובה מאוחרת, ניסיון חוזר, הצלחה והגדרות כבויות.

לאחר ההקמה הידנית יש לבצע גם בדיקת קצה־לקצה אמיתית ב־Preview:

- שליחה תקינה עם/בלי אימייל; טלפון לא תקין ואימייל לא תקין.
- לחיצה כפולה מהירה: שורה אחת והתראה אחת.
- חסימת רשת בדפדפן: הודעת שגיאה ללא מחיקת השדות; ניסיון חוזר עם אותם פרטים.
- בדיקת מצב `notification_status`, קישור WhatsApp ושעת ישראל.
- הפעלה ידנית של `retryNotifications` אינה שולחת שוב התראות שמסומנות `sent`.
- כשל מייל ומכסות נבדקו מקומית באמצעות שירותים מדומים; אין צורך לבזבז מכסת Gmail אמיתית כדי לדמות חריגה.
- CORS אמיתי, הרשאות Google, הפניות ContentService, זמינות ה־binding והגעת מייל בפועל מחייבים את החשבונות המוגדרים; בדיקות מקומיות אינן מוכיחות אותם.

## 10. טיפול בתקלות וניסיונות חוזרים

| מצב בגיליון | משמעות ופעולה |
|---|---|
| `pending` | הליד נשמר וממתין להתראה; הטריגר ינסה לשלוח |
| `sending` | ניסיון בתהליך; אחרי 10 דקות אפשר לשחזר ניסיון שנקטע |
| `sent` | MailApp קיבל את פעולת השליחה ללא שגיאה; אין בכך אישור מסירה לתיבה |
| `retry` + `MAIL_SEND_FAILED` | ניסיון נוסף לאחר 5, 10, 20 או 40 דקות, עד 5 ניסיונות בסך הכול |
| `retry` + `EMAIL_QUOTA` | המכסה נגמרה; ניסיון נוסף אחרי שעה, בלי לצרוך את מונה הניסיונות |
| `failed` | הסתיים תקציב הניסיונות; לאחר תיקון התקלה הפעילי ידנית `requeueFailedNotifications` בעורך |

לאחר requeue אפשר להריץ `retryNotifications` או להמתין לטריגר. אין לבצע פעולה זו מהאתר הציבורי.
אל תשני את הכותרות או את עמודות J:R, ואל תמחקי שורות בזמן טיפול. עמודה H מיועדת לעדכון סטטוס הטיפול האנושי.
למיון מומלץ להשתמש ב־Filter Views, כדי לא להזיז שורות בזמן שהסקריפט עובד.

בהודעת שגיאה בטופס אין הבטחה שהבקשה לא נשמרה: ייתכן שהשמירה הצליחה והתשובה אבדה.
לחיצה חוזרת עם אותם פרטים תשתמש באותו request_id ותאשר את השורה הקיימת.
שינוי פרטים, לחיצה על "חזרה לאתר" אחרי הצלחה, לשונית חדשה או פקיעת המטא־נתונים אחרי 24 שעות יוצרים פנייה חדשה בכוונה.
אין חסימה קבועה לפי מספר טלפון, כדי לא לאבד פנייה חדשה אמיתית של אותו אדם.

שמירה והתראה אינן טרנזקציה אחת. אם MailApp שלח מייל והתהליך קרס לפני עדכון `sent`, שחזור אחרי פקיעת ה־lease עשוי לשלוח התראה נוספת.
מזהה הליד זהה בשתי ההודעות; לא תיווצר שורת ליד נוספת. זהו מנגנון at-least-once למייל, לא הבטחת exactly-once.

לכיבוי מהיר: `ENABLED=false` ב־Script Properties עוצר שמירה ושליחת התראות נוספות; הטריגר נשאר קיים אך אינו עובד.
אפשר לכבות גם את Worker הבדיקות ואת `enabled` בקובץ הציבורי. לידים שכבר נשמרו אינם נמחקים.

## 11. פרוטוקול חתימה, Replay ו־CORS

ה־Worker שולח JSON עם `version`, `environment`, `timestamp`, `requestId`, `payload` ו־`signature`.
`payload` הוא מחרוזת JSON מדויקת; אין צורך לסמוך על סדר מפתחות שמגיע מהדפדפן.
החתימה היא HMAC-SHA256, ב־hex, על מחרוזת UTF-8 הבאה (LF בין השורות, ללא LF בסוף):

```text
glatt-leads-v1
preview
TIMESTAMP_IN_MILLISECONDS
REQUEST_UUID
EXACT_PAYLOAD_STRING
```

Apps Script מאמת את החתימה באמצעות `Utilities.computeHmacSha256Signature`, כולל התאמת signed bytes ל־hex.
החתימה מכסה את התוכן, הסביבה, הזמן ומזהה הבקשה. אין שימוש בכותרת HTTP פרטית: `doPost` קורא את גוף הבקשה.
חלון הזמן הוא 5 דקות, עם סבילות של 30 שניות לעתיד.
Replay בתוך החלון מקבל לכל היותר אישור לאותה רשומה, ללא כתיבה/מייל נוספים; ID קיים עם תוכן שונה נדחה.
Replay ישן נדחה. ניסיון לגיטימי מאוחר נחתם מחדש ב־Worker, אבל משתמש באותו ID ומאושר מול הרשומה העמידה ב־Sheets.
אין הסתמכות על CacheService או על זיכרון Worker לשמירת מפתחות הכפילות.

הדפדפן מקבל CORS רק ל־Origin מורשה מדויק. ה־Worker שולח ל־Google בצד השרת ועוקב אחרי redirect של ContentService.
`Origin` ו־CORS אינם אימות: לקוח שאינו דפדפן יכול לזייף Origin. הגנת הכניסה הציבורית היא הגבלת קצב, ולידציה, honeypot וגודל בקשה;
החתימה מגינה על Apps Script מפני עקיפת ה־Worker, ולא מוכיחה שהמתעניין הוא אדם.
הגנה בסיסית זו אינה הגנת DDoS או CAPTCHA. בוט ממוקד עדיין יכול לשלוח פניות תקינות; אם יידרש חיזוק, יש לתכננו בנפרד.

## 12. פרטיות, מכסות והעברה ללקוח

- לא נכתבים פרטים אישיים ללוגים בקוד. Exceptions של Apps Script אינם נשלחים ל־Stackdriver, ו־Worker observability כבוי.
  ספקי התשתית עדיין עשויים לשמור נתוני תפעול לפי מדיניותם; אין הבטחה שאין להם לוגים פנימיים.
- הנתונים האישיים נמצאים בגיליון הפרטי ובמייל ההתראה. בקשות הן POST; כתובת העמוד נשמרת ללא query/hash.
- בדפדפן נשמרים ב־sessionStorage רק request_id, hash של התוכן וזמן יצירה, לא ערכי השדות עצמם.
  בעריכת הרשאות/מחיקת נתונים יש להתייחס גם למיילים, לא רק לגיליון.
- סוד התקשורת מיועד ל־Secrets/Script Properties בלבד; OAuth והרשאות Google נשארים בחשבון המפעיל.
  הגיליון עצמו, מייל ההתראה וכתובת Apps Script אינם נמצאים בקוד הדפדפן.
- לפי התיעוד שנבדק ב־15.10.2026, Apps Script בחשבון צרכני מוגבל ל־100 נמעני מייל ביום, וחלות גם מכסות ריצה ושירותים.
  המכסות משותפות לפעילות הסקריפטים של החשבון ועשויות להשתנות. המכסה נבדקת לפני ניסיון מייל; גם שגיאה בזמן השליחה נתפסת.
  [מכסות Apps Script](https://developers.google.com/apps-script/guides/services/quotas).
- שימוש ב־Advanced Sheets API כפוף גם למכסות הבקשות של Sheets API. כשקריאה/כתיבה נחסמת, לא מוחזרת הצלחה בלי אימות שמירה;
  ניסיון חוזר משתמש באותו מזהה. הגבלת הקצב ב־Worker אינה תחליף למכסות Google.
- Workers Free כולל 100,000 בקשות ביום לחשבון; זה אינו מבטל את מכסות Google או את גבולות זמן ה־CPU של Worker.
  השארת השירות במסלול Free אינה מפעילה שדרוג אוטומטי בקוד זה. [תמחור Workers](https://developers.cloudflare.com/workers/platform/pricing/).
- הטריגר מטפל בעד 10 התראות בריצה ועד דקה לפני עצירה. חיפוש המזהים וסריקת התור הם ליניאריים; המימוש מיועד לטופס בנפח נמוך.
  כשהגיליון גדל משמעותית, יש למדוד זמן ריצה ולתכנן ארכוב ששומר על מזהי הכפילות, לפני שמגיעים למכסות.

להעברה מסודרת לחשבון הלקוח:

1. צרי גיליון ופרויקט Apps Script חדשים בבעלות הלקוח והעתיקי את אותם `Code.gs`, `Core.gs` והמניפסט.
2. צרי סוד חדש, הגדרות Properties חדשות ומייל יעד מתאים. אשרי הרשאות בחשבון הלקוח.
3. הריצי setup וצרי deployment חדש. טריגרים והרשאות אינם עוברים רק מהעתקת הקוד; הם שייכים לחשבון שיצר אותם.
4. הקימי Worker נפרד בחשבון הלקוח או החליפי במכוון את הסודות ב־Worker המוסכם, לאחר אישור. השתמשי במזהי rate limit חדשים אם צריך.
5. החליפי את הכתובת הציבורית ב־`leads-config.js`, ובדקי עם נתוני בדיקה לפני הפעלה.
6. ודאי שכל פנייה חדשה מגיעה לחשבון הנכון, ואז כבי את סביבת הפיתוח הישנה והטריגר שלה לאחר טיפול בכל ההתראות הממתינות.
7. העברת נתונים קיימים, מחיקתם או חיבור ל־glattai.com אינם חלק מהעתקת הקוד ואינם מבוצעים אוטומטית.

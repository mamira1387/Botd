# Depth TON Bot

## نصب
```bash
npm install
```

## متغیرهای محیطی (Vercel → Settings → Environment Variables)
| نام | توضیح |
|---|---|
| `BOT_TOKEN` | توکن از BotFather |
| `BOT_USERNAME` | یوزرنیم ربات بدون @ |
| `SUPABASE_URL` | آدرس پروژه Supabase |
| `SUPABASE_SERVICE_KEY` | Service Role Key (نه anon) |
| `OWNER_ID` | آیدی عددی مالک اصلی |

## راه‌اندازی دیتابیس
محتوای `schema.sql` رو داخل SQL Editor پروژه Supabase اجرا کن.

## دیپلوی
1. پروژه رو در Vercel دیپلوی کن (فایل `index.js` باید داخل مسیر `api/` باشه، مثلاً `api/webhook.js`، یا `vercel.json` رو طوری تنظیم کن که روت `/` رو به این فایل بفرسته).
2. وبهوک تلگرام رو ست کن:
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-vercel-domain>/api/webhook
```

## دستورات
- `/wallet` — نمایش موجودی و آیدی ولت
- ریپلای + عدد (`10k`, `۱۰کا`, `5000`) — درخواست انتقال با تایید دکمه‌ای
- `انتقال 10k به 12345678` — انتقال با آیدی ولت
- `ساخت قبض ۱۰کا دپث ۵ بار مصرف` — ساخت قبض با لینک اختصاصی
- `add ton 10k` (ریپلای یا با آیدی) — شارژ توسط ادمین
- `کسر 10k` (ریپلای یا با آیدی) — کسر توسط ادمین
- `/addadmin`, `/deladmin` — فقط برای OWNER_ID

## نکات مهم پیاده‌سازی
- انتقال موجودی از تابع اتمیک `transfer_balance` در Postgres استفاده می‌کنه تا race condition پیش نیاد.
- تایید/لغو انتقال با callback_data و جدول `pending_transfers` مدیریت می‌شه (چون سرورلس، حافظه بین اجراها مشترک نیست).
- قبض‌ها با UUID شناسایی می‌شن و لینک دیپ‌لینک تلگرام (`?start=bill_<uuid>`) هم در گروه هم در پیوی کار می‌کنه.
- درخواست‌های GET برای جلوگیری از خطای ۵۰۰ هنگام تست مرورگری هندل شدن.
- 

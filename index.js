// ==========================================================================
// Depth TON Bot — index.js
// ربات کیف پول تلگرام | grammY + Supabase + Vercel Serverless
// ==========================================================================
// متغیرهای محیطی مورد نیاز (در تنظیمات Vercel ست کن):
//   BOT_TOKEN            توکن ربات از BotFather
//   BOT_USERNAME          یوزرنیم ربات بدون @ (برای ساخت لینک قبض)
//   SUPABASE_URL          آدرس پروژه Supabase
//   SUPABASE_SERVICE_KEY  Service Role Key (نه anon key، چون نیاز به دسترسی کامل داریم)
//   OWNER_ID              آیدی عددی مالک اصلی ربات
//
// اسکیمای دیتابیس داخل schema.sql هست — اول اونو روی Supabase اجرا کن.
// ==========================================================================

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const OWNER_ID = Number(process.env.OWNER_ID);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN تنظیم نشده است.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new Bot(BOT_TOKEN);

// ==========================================================================
// 1) توابع کمکی — پارس اعداد فارسی/انگلیسی + پسوند k / کا / هزار
// ==========================================================================

function normalizeDigits(str) {
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  return str.replace(/[۰-۹]/g, (d) => persian.indexOf(d))
            .replace(/[٠-٩]/g, (d) => arabic.indexOf(d));
}

// نگاشت پسوندها به ضریب عددی — ترتیب مهمه: پسوندهای بلندتر باید اول چک بشن
// تا "میلیون" با "م" اشتباه گرفته نشه.
const AMOUNT_SUFFIX_MULTIPLIERS = {
  "میلیارد": 1_000_000_000,
  "میلیون": 1_000_000,
  "هزار": 1_000,
  "کا": 1_000,
  "ک": 1_000,
  "k": 1_000,
  "m": 1_000_000,
  "b": 1_000_000_000,
  "م": 1_000_000,
  "ب": 1_000_000_000,
};

// این پترن به عنوان بخش پسوند داخل سایر Regexهای متنی (انتقال/قبض/...) هم استفاده می‌شه
const SUFFIX_PATTERN = "میلیارد|میلیون|هزار|کا|ک|k|m|b|م|ب";
// پترن کامل یک عدد با پسوند اختیاری، برای استفاده داخل جمله‌ها
const AMOUNT_TOKEN = `[\\d۰-۹.,]+\\s*(?:${SUFFIX_PATTERN})?`;

/**
 * یک تکه متن مثل "10k"، "۱۰کا"، "5,000"، "۵ هزار"، "2m"، "۳ میلیون"، "1.5b"، "۲ میلیارد"
 * رو به عدد صحیح تبدیل می‌کنه. در صورت شکست، null برمی‌گردونه.
 */
function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let text = normalizeDigits(String(raw)).trim().toLowerCase();
  text = text.replace(/[,\s]/g, ""); // حذف کاما و فاصله بین رقم و پسوند مثل "5 000"

  const match = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)(${SUFFIX_PATTERN})?$`, "i"));
  if (!match) return null;

  let value = parseFloat(match[1]);
  if (isNaN(value)) return null;

  const suffix = match[2];
  if (suffix) {
    const multiplier = AMOUNT_SUFFIX_MULTIPLIERS[suffix.toLowerCase()];
    if (!multiplier) return null;
    value *= multiplier;
  }

  value = Math.round(value);
  if (value <= 0) return null;
  return value;
}

// ==========================================================================
// 2) توابع دیتابیس
// ==========================================================================

async function ensureUser(user) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    // آپدیت یوزرنیم در صورت تغییر
    if (existing.username !== user.username || existing.first_name !== user.first_name) {
      await supabase
        .from("users")
        .update({ username: user.username || null, first_name: user.first_name || null })
        .eq("user_id", user.id);
    }
    return existing;
  }

  const { data: created, error } = await supabase
    .from("users")
    .insert({
      user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      balance: 0,
    })
    .select()
    .single();

  if (error) throw error;
  return created;
}

async function getUser(userId) {
  const { data } = await supabase.from("users").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

async function isOwner(userId) {
  return Number(userId) === OWNER_ID;
}

async function isAdmin(userId) {
  if (await isOwner(userId)) return true;
  const { data } = await supabase.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

// ==========================================================================
// 3) میان‌افزار: ثبت خودکار کاربر در هر پیام
// ==========================================================================

bot.use(async (ctx, next) => {
  if (ctx.from) {
    try {
      await ensureUser(ctx.from);
    } catch (e) {
      console.error("ensureUser error:", e);
    }
  }
  await next();
});

// ==========================================================================
// 4) دستور /start — شامل هندل کردن دیپ‌لینک قبض bill_xxx
// ==========================================================================

bot.command("start", async (ctx) => {
  const payload = ctx.match; // متن بعد از /start
  if (payload && payload.startsWith("bill_")) {
    const billId = payload.replace("bill_", "");
    await payBill(ctx, billId);
    return;
  }
  await ctx.reply(
    "👛 به Depth TON Bot خوش اومدی!\n\n" +
    "برای دیدن موجودی و آیدی ولتت دستور /wallet رو بزن."
  );
});

// ==========================================================================
// 5) دستور /wallet
// ==========================================================================

bot.command("wallet", async (ctx) => {
  const user = await getUser(ctx.from.id);
  await ctx.reply(
    `👛 <b>کیف پول شما</b>\n\n` +
    `🆔 آیدی ولت: <code>${ctx.from.id}</code>\n` +
    `💰 موجودی: <b>${fmt(user.balance)}</b>`,
    { parse_mode: "HTML" }
  );
});

// ==========================================================================
// 6) مدیریت ادمین‌ها: /addadmin و /deladmin
// ==========================================================================

bot.command("addadmin", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) {
    return ctx.reply("⛔️ فقط مالک ربات می‌تونه ادمین اضافه کنه.");
  }
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ روی پیام کاربر مورد نظر ریپلای کن یا آیدی عددی بده.");

  await ensureUser({ id: targetId });
  const { error } = await supabase
    .from("admins")
    .upsert({ user_id: targetId, added_by: ctx.from.id });

  if (error) return ctx.reply("❌ خطا در ثبت ادمین.");
  await ctx.reply(`✅ کاربر <code>${targetId}</code> به عنوان ادمین اضافه شد.`, { parse_mode: "HTML" });
});

bot.command("deladmin", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) {
    return ctx.reply("⛔️ فقط مالک ربات می‌تونه ادمین حذف کنه.");
  }
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ روی پیام کاربر مورد نظر ریپلای کن یا آیدی عددی بده.");

  await supabase.from("admins").delete().eq("user_id", targetId);
  await ctx.reply(`✅ دسترسی ادمین کاربر <code>${targetId}</code> حذف شد.`, { parse_mode: "HTML" });
});

// آیدی هدف رو از ریپلای یا از متن پیام (آخرین عدد) استخراج می‌کنه
async function resolveTargetId(ctx) {
  if (ctx.message?.reply_to_message?.from?.id) {
    return ctx.message.reply_to_message.from.id;
  }
  const parts = ctx.message.text.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const num = parseInt(normalizeDigits(last), 10);
  return isNaN(num) ? null : num;
}

// ==========================================================================
// 7) هندلر اصلی متن‌ها: انتقال / ساخت قبض / شارژ و کسر ادمین
// ==========================================================================

const RE_TRANSFER_TO_ID = new RegExp(`^انتقال\\s+(${AMOUNT_TOKEN})\\s+به\\s+(\\d+)$`, "i");
const RE_CREATE_BILL = new RegExp(`^ساخت\\s+قبض\\s+(${AMOUNT_TOKEN})\\s+دپث\\s+([\\d۰-۹]+)\\s*بار\\s*مصرف$`, "i");
const RE_ADMIN_ADD = new RegExp(`^add\\s*ton\\s+(${AMOUNT_TOKEN})(?:\\s+(?:به|for)\\s+(\\d+))?$`, "i");
const RE_ADMIN_SUB = new RegExp(`^کسر\\s+(${AMOUNT_TOKEN})(?:\\s+(?:از)\\s+(\\d+))?$`, "i");
const RE_JUST_NUMBER = new RegExp(`^${AMOUNT_TOKEN}$`, "i");

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  // ---- ۷.۱ انتقال با ریپلای روی پیام + عدد خالی (10k / ۱۰کا / 5000) ----
  if (ctx.message.reply_to_message && RE_JUST_NUMBER.test(text)) {
    const amount = parseAmount(text);
    if (amount) {
      await handleTransferRequest(ctx, ctx.message.reply_to_message.from, amount);
      return;
    }
  }

  // ---- ۷.۲ انتقال با آیدی ولت: "انتقال 10k به 12345678" ----
  const mTransfer = text.match(RE_TRANSFER_TO_ID);
  if (mTransfer) {
    const amount = parseAmount(mTransfer[1]);
    const toId = parseInt(mTransfer[2], 10);
    if (!amount) return ctx.reply("❗️ مبلغ نامعتبر است.");
    if (toId === ctx.from.id) return ctx.reply("❗️ نمی‌تونی به خودت انتقال بدی.");
    const toUser = await getUser(toId);
    if (!toUser) return ctx.reply("❗️ کاربر مقصد در ربات ثبت نشده (باید حداقل یک بار با ربات تعامل داشته باشه).");
    await handleTransferRequest(ctx, { id: toId, username: toUser.username, first_name: toUser.first_name }, amount);
    return;
  }

  // ---- ۷.۳ ساخت قبض: "ساخت قبض ۱۰کا دپث ۵ بار مصرف" ----
  const mBill = text.match(RE_CREATE_BILL);
  if (mBill) {
    const amount = parseAmount(mBill[1]);
    const maxUses = parseInt(normalizeDigits(mBill[2]), 10);
    if (!amount) return ctx.reply("❗️ مبلغ قبض نامعتبر است.");
    if (!maxUses || maxUses <= 0) return ctx.reply("❗️ تعداد دفعات مصرف نامعتبر است.");
    await createBill(ctx, amount, maxUses);
    return;
  }

  // ---- ۷.۴ شارژ توسط ادمین: "add ton 10k" (ریپلای یا با آیدی) ----
  const mAdd = text.match(RE_ADMIN_ADD);
  if (mAdd) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن شارژ کنن.");
    const amount = parseAmount(mAdd[1]);
    const targetId = mAdd[2] ? parseInt(mAdd[2], 10) : ctx.message.reply_to_message?.from?.id;
    if (!amount) return ctx.reply("❗️ مبلغ نامعتبر است.");
    if (!targetId) return ctx.reply("❗️ روی پیام کاربر ریپلای کن یا آیدی رو مشخص کن.");
    await ensureUser({ id: targetId });
    // شارژ ادمین از "بانک" است، نه از حساب کسی؛ مستقیم بالانس رو زیاد می‌کنیم
    const { data: cur } = await supabase.from("users").select("balance").eq("user_id", targetId).single();
    await supabase.from("users").update({ balance: cur.balance + amount }).eq("user_id", targetId);
    await ctx.reply(`✅ مبلغ <b>${fmt(amount)}</b> به کیف پول <code>${targetId}</code> شارژ شد.`, { parse_mode: "HTML" });
    return;
  }

  // ---- ۷.۵ کسر توسط ادمین: "کسر 10k" (ریپلای یا با آیدی) ----
  const mSub = text.match(RE_ADMIN_SUB);
  if (mSub) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن کسر کنن.");
    const amount = parseAmount(mSub[1]);
    const targetId = mSub[2] ? parseInt(mSub[2], 10) : ctx.message.reply_to_message?.from?.id;
    if (!amount) return ctx.reply("❗️ مبلغ نامعتبر است.");
    if (!targetId) return ctx.reply("❗️ روی پیام کاربر ریپلای کن یا آیدی رو مشخص کن.");
    const target = await getUser(targetId);
    if (!target || target.balance < amount) return ctx.reply("❗️ موجودی کاربر کافی نیست.");
    await supabase.from("users").update({ balance: target.balance - amount }).eq("user_id", targetId);
    await ctx.reply(`✅ مبلغ <b>${fmt(amount)}</b> از کیف پول <code>${targetId}</code> کسر شد.`, { parse_mode: "HTML" });
    return;
  }
});

// ==========================================================================
// 8) انتقال با تایید دکمه شیشه‌ای
// ==========================================================================

async function handleTransferRequest(ctx, toUser, amount) {
  if (toUser.id === ctx.from.id) {
    return ctx.reply("❗️ نمی‌تونی به خودت انتقال بدی.");
  }
  const fromUser = await getUser(ctx.from.id);
  if (fromUser.balance < amount) {
    return ctx.reply("❗️ موجودی شما برای این انتقال کافی نیست.");
  }

  const { data: pending, error } = await supabase
    .from("pending_transfers")
    .insert({
      from_user_id: ctx.from.id,
      to_user_id: toUser.id,
      amount,
      chat_id: ctx.chat.id,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    return ctx.reply("❌ خطا در ایجاد درخواست انتقال.");
  }

  const kb = new InlineKeyboard()
    .text("✅ تایید انتقال", `tr_confirm_${pending.id}`)
    .text("❌ لغو", `tr_cancel_${pending.id}`);

  const toLabel = toUser.username ? `@${toUser.username}` : (toUser.first_name || toUser.id);

  const sent = await ctx.reply(
    `🔁 <b>درخواست انتقال</b>\n\n` +
    `از: <code>${ctx.from.id}</code>\n` +
    `به: ${toLabel} (<code>${toUser.id}</code>)\n` +
    `مبلغ: <b>${fmt(amount)}</b>\n\n` +
    `برای نهایی شدن، فرستنده باید تایید کنه:`,
    { parse_mode: "HTML", reply_markup: kb }
  );

  await supabase
    .from("pending_transfers")
    .update({ message_id: sent.message_id })
    .eq("id", pending.id);
}

bot.callbackQuery(/^tr_confirm_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle();

  if (!pending || pending.status !== "pending") {
    return ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
  }
  if (pending.from_user_id !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: "فقط فرستنده می‌تونه تایید کنه.", show_alert: true });
  }

  const { data: ok } = await supabase.rpc("transfer_balance", {
    p_from: pending.from_user_id,
    p_to: pending.to_user_id,
    p_amount: pending.amount,
  });

  if (!ok) {
    await supabase.from("pending_transfers").update({ status: "expired" }).eq("id", id);
    await ctx.editMessageText("❌ موجودی کافی نبود. انتقال لغو شد.");
    return ctx.answerCallbackQuery();
  }

  await supabase.from("pending_transfers").update({ status: "confirmed" }).eq("id", id);

  await ctx.editMessageText(
    `✅ <b>انتقال با موفقیت انجام شد</b>\n\n` +
    `از: <code>${pending.from_user_id}</code>\n` +
    `به: <code>${pending.to_user_id}</code>\n` +
    `مبلغ: <b>${fmt(pending.amount)}</b>`,
    { parse_mode: "HTML" }
  );
  await ctx.answerCallbackQuery({ text: "انتقال انجام شد ✅" });
});

bot.callbackQuery(/^tr_cancel_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle();

  if (!pending || pending.status !== "pending") {
    return ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
  }
  if (pending.from_user_id !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: "فقط فرستنده می‌تونه لغو کنه.", show_alert: true });
  }

  await supabase.from("pending_transfers").update({ status: "cancelled" }).eq("id", id);
  await ctx.editMessageText("🚫 انتقال توسط فرستنده لغو شد.");
  await ctx.answerCallbackQuery({ text: "لغو شد" });
});

// ==========================================================================
// 9) سیستم قبض (Bill)
// ==========================================================================

async function createBill(ctx, amount, maxUses) {
  const { data: bill, error } = await supabase
    .from("bills")
    .insert({
      creator_id: ctx.from.id,
      amount,
      max_uses: maxUses,
      used_count: 0,
      chat_id: ctx.chat.id,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    return ctx.reply("❌ خطا در ساخت قبض.");
  }

  const link = `https://t.me/${BOT_USERNAME}?start=bill_${bill.id}`;
  const kb = new InlineKeyboard().url("💳 پرداخت قبض", link);

  const sent = await ctx.reply(billText(bill, []), { parse_mode: "HTML", reply_markup: kb });

  await supabase.from("bills").update({ message_id: sent.message_id }).eq("id", bill.id);
}

function billText(bill, payers) {
  const remaining = bill.max_uses - bill.used_count;
  const payersList = payers.length
    ? payers.map((p) => `• <code>${p.user_id}</code>`).join("\n")
    : "— هنوز کسی پرداخت نکرده —";

  return (
    `🧾 <b>قبض دپث</b>\n\n` +
    `💰 مبلغ هر پرداخت: <b>${fmt(bill.amount)}</b>\n` +
    `🔁 باقی‌مانده مصرف: <b>${remaining} از ${bill.max_uses}</b>\n\n` +
    `👥 <b>پرداخت‌کنندگان:</b>\n${payersList}` +
    (remaining <= 0 ? "\n\n🔒 این قبض غیرفعال شده است." : "")
  );
}

async function payBill(ctx, billId) {
  const { data: bill } = await supabase.from("bills").select("*").eq("id", billId).maybeSingle();
  if (!bill || !bill.is_active) {
    return ctx.reply("❗️ این قبض یافت نشد یا غیرفعال شده است.");
  }
  if (bill.used_count >= bill.max_uses) {
    return ctx.reply("❗️ ظرفیت این قبض تکمیل شده است.");
  }
  if (bill.creator_id === ctx.from.id) {
    return ctx.reply("❗️ سازنده قبض نمی‌تواند قبض خودش را پرداخت کند.");
  }

  const { data: already } = await supabase
    .from("bill_payments")
    .select("bill_id")
    .eq("bill_id", billId)
    .eq("user_id", ctx.from.id)
    .maybeSingle();
  if (already) {
    return ctx.reply("❗️ شما قبلاً این قبض را پرداخت کرده‌اید.");
  }

  const { data: ok } = await supabase.rpc("transfer_balance", {
    p_from: ctx.from.id,
    p_to: bill.creator_id,
    p_amount: bill.amount,
  });

  if (!ok) {
    return ctx.reply("❗️ موجودی شما برای پرداخت این قبض کافی نیست.");
  }

  await supabase.from("bill_payments").insert({ bill_id: billId, user_id: ctx.from.id });

  const newUsedCount = bill.used_count + 1;
  const isNowInactive = newUsedCount >= bill.max_uses;

  await supabase
    .from("bills")
    .update({ used_count: newUsedCount, is_active: !isNowInactive })
    .eq("id", billId);

  await ctx.reply(
    `✅ پرداخت با موفقیت انجام شد.\n💰 مبلغ <b>${fmt(bill.amount)}</b> به سازنده قبض واریز شد.`,
    { parse_mode: "HTML" }
  );

  // به‌روزرسانی لحظه‌ای متن پیام اصلی قبض (اگر در گروه بوده)
  if (bill.chat_id && bill.message_id) {
    const { data: payers } = await supabase
      .from("bill_payments")
      .select("user_id")
      .eq("bill_id", billId)
      .order("paid_at", { ascending: true });

    const updatedBill = { ...bill, used_count: newUsedCount };
    try {
      const kb = isNowInactive
        ? undefined
        : new InlineKeyboard().url("💳 پرداخت قبض", `https://t.me/${BOT_USERNAME}?start=bill_${billId}`);

      await bot.api.editMessageText(
        bill.chat_id,
        bill.message_id,
        billText(updatedBill, payers || []),
        { parse_mode: "HTML", reply_markup: kb }
      );
    } catch (e) {
      console.error("editMessageText error:", e.message);
    }
  }
}

// ==========================================================================
// 10) خروجی سازگار با Vercel Serverless Function
// ==========================================================================

const handleUpdate = webhookCallback(bot, "std/http");

module.exports = async (req, res) => {
  // جلوگیری از ارور ۵۰۰ هنگام تست دستی در مرورگر (GET)
  if (req.method === "GET") {
    res.status(200).json({ status: "ok", bot: "Depth TON Bot", message: "Webhook is alive." });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await handleUpdate(req, res);
  } catch (err) {
    console.error("Webhook error:", err);
    if (!res.headersSent) {
      res.status(200).json({ ok: true }); // به تلگرام همیشه 200 برگردون تا ریترای نکنه
    }
  }
};

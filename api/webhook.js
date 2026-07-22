// ==========================================================================
// Depth TON Bot — index.js (Final Stable Version for Vercel)
// - Merged: original features + interactive help + multiplayer games (emoji & dice)
// - Keep previous code behavior; added new functions without removing old parts
// ==========================================================================

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const OWNER_ID = Number(process.env.OWNER_ID);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing.");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new Bot(BOT_TOKEN);

// ==========================================================================
// 1) توابع کمکی
// ==========================================================================

function normalizeDigits(str) {
  if (!str && str !== 0) return "";
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  return String(str)
    .replace(/[۰-۹]/g, (d) => persian.indexOf(d).toString())
    .replace(/[٠-٩]/g, (d) => arabic.indexOf(d).toString());
}

const AMOUNT_SUFFIX_MULTIPLIERS = {
  "میلیارد": 1_000_000_000, "میلیون": 1_000_000, "هزار": 1_000,
  "کا": 1_000, "ک": 1_000, "k": 1_000,
  "m": 1_000_000, "b": 1_000_000_000, "م": 1_000_000, "ب": 1_000_000_000,
};

const SUFFIX_PATTERN = "میلیارد|میلیون|هزار|کا|ک|k|m|b|م|ب";
const AMOUNT_TOKEN = `[\\d۰-۹.,]+\\s*(?:${SUFFIX_PATTERN})?`;

function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let text = normalizeDigits(String(raw)).trim().toLowerCase();
  text = text.replace(/[,\s]/g, "");
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
  if (!user || !user.id) return null;
  const { data: existing } = await supabase.from("users").select("*").eq("user_id", user.id).maybeSingle();
  if (existing) {
    if ((existing.username || null) !== (user.username || null) || (existing.first_name || null) !== (user.first_name || null)) {
      await supabase.from("users").update({ username: user.username || null, first_name: user.first_name || null }).eq("user_id", user.id);
    }
    return existing;
  }
  try {
    const { data: created, error } = await supabase.from("users").insert({
      user_id: user.id, username: user.username || null, first_name: user.first_name || null, balance: 0,
    }).select().single();
    if (error) { console.error("Error creating user:", error); return null; }
    return created;
  } catch (e) { console.error("Exception in ensureUser:", e); return null; }
}

async function getUser(userId) {
  const { data } = await supabase.from("users").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

async function isOwner(userId) { return Number(userId) === OWNER_ID; }
async function isAdmin(userId) {
  if (await isOwner(userId)) return true;
  const { data } = await supabase.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}
function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }

// ==========================================================================
// 2.1) تشخیص پیام فوروارد شده + یافتن آیدی
// ==========================================================================

function getForwardedUserId(message) {
  if (!message) return null;
  if (message.forward_origin && message.forward_origin.type === "user" && message.forward_origin.sender_user) {
    return message.forward_origin.sender_user.id;
  }
  if (message.forward_from) return message.forward_from.id;
  return null;
}

function getReplyFromUser(replyMessage) {
  if (!replyMessage || !replyMessage.from) return null;
  if (replyMessage.from.is_bot) return null;
  return replyMessage.from;
}

async function resolveIdByUsername(usernameRaw) {
  const username = usernameRaw.replace(/^@/, "").trim();
  if (!username) return null;
  const { data } = await supabase.from("users").select("user_id").ilike("username", username).maybeSingle();
  if (data) return data.user_id;
  try {
    const chat = await bot.api.getChat(`@${username}`);
    if (chat && chat.id) {
      await ensureUser({ id: chat.id, username: chat.username, first_name: chat.first_name });
      return chat.id;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function resolveIdentifierToken(raw) {
  if (!raw) return null;
  const cleaned = normalizeDigits(raw.trim());
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  if (cleaned.startsWith("@")) return await resolveIdByUsername(cleaned);
  return null;
}

// ==========================================================================
// ADDITIONS: feature flags, games config (added, not removing previous code)
// ==========================================================================

const RANDOM_GIVEAWAY_AMOUNT = 100000; // 100k
const RANDOM_GIVEAWAY_PROBABILITY = 0.002; // 0.2% per message in group
const JACKPOT_PERCENT_OF_BET = 0.05; // 5% of each bet goes to jackpot
const JACKPOT_WIN_CHANCE = 0.001; // 0.1% chance to win jackpot on each bet

const EMOJI_GAMES = ['⚽️','🏀','🎯','🎲','🎳']; // emoji choices shown as buttons

async function isFeatureEnabled(chatId, name) {
  try {
    const { data } = await supabase.from("features").select("enabled").eq("chat_id", chatId).eq("name", name).maybeSingle();
    if (!data) return true; // default: enabled
    return data.enabled;
  } catch (e) {
    console.error("isFeatureEnabled error:", e);
    return true;
  }
}
async function setFeature(chatId, name, enabled) {
  try {
    await supabase.from("features").upsert({ chat_id: chatId, name, enabled });
    return true;
  } catch (e) {
    console.error("setFeature error:", e);
    return false;
  }
}

// ==========================================================================
// 3) میان‌افزار: ثبت خودکار کاربر + chats upsert + message counting + random giveaway
// ==========================================================================
bot.use(async (ctx, next) => {
  if (ctx.from) await ensureUser(ctx.from);
  await next();
});

bot.use(async (ctx, next) => {
  if (ctx.message && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    try {
      await supabase.from("chats").upsert({
        chat_id: ctx.chat.id,
        chat_type: ctx.chat.type,
        title: ctx.chat.title || null,
        last_seen: new Date().toISOString(),
      });
    } catch (e) {
      console.error("chats upsert error:", e);
    }

    if (ctx.from && !ctx.from.is_bot) {
      await incrementMessageCount(ctx.from.id, ctx.chat.id);
    }

    // Random giveaway trigger (only in groups and if feature enabled)
    try {
      if (ctx.from && !ctx.from.is_bot && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
        const enabled = await isFeatureEnabled(ctx.chat.id, "giveaways");
        if (enabled && Math.random() < RANDOM_GIVEAWAY_PROBABILITY) {
          await createGiveaway(ctx.api, ctx.chat.id, RANDOM_GIVEAWAY_AMOUNT, 0);
        }
      }
    } catch (e) {
      console.error("random giveaway trigger error:", e);
    }
  }
  await next();
});

// ==========================================================================
// 4) دستور /start
// ==========================================================================
bot.command("start", async (ctx) => {
  await ensureUser(ctx.from);
  const payload = ctx.match;
  if (payload && payload.startsWith("bill_")) {
    await payBill(ctx, payload.replace("bill_", ""));
    return;
  }
  await ctx.reply("👛 به Depth TON Bot خوش اومدی!\n\nبرای دیدن موجودی دستور /wallet یا /ولت رو بزن.\nFor help, send /help");
});

// ==========================================================================
// 5) دستور /wallet و /ولت
// ==========================================================================
bot.command("wallet", async (ctx) => await handleWalletCommand(ctx));
bot.command("ولت", async (ctx) => await handleWalletCommand(ctx));

async function handleWalletCommand(ctx) {
  await ensureUser(ctx.from);
  let targetId = ctx.from.id;

  const reply = ctx.message.reply_to_message;
  const argRaw = ctx.match?.trim();

  if (reply) {
    const forwardedId = getForwardedUserId(reply);
    const replyUser = getReplyFromUser(reply);

    if (forwardedId) {
      targetId = forwardedId;
      await ensureUser({ id: forwardedId });
    } else if (replyUser) {
      targetId = replyUser.id;
      await ensureUser(replyUser);
    }
  } else if (argRaw) {
    const resolved = await resolveIdentifierToken(argRaw);
    if (resolved) {
      targetId = resolved;
    } else {
      return ctx.reply("❗️ User not found. Enter a valid numeric ID or @username.");
    }
  }

  const user = await getUser(targetId);
  if (!user) {
    await ensureUser({ id: targetId });
    const retryUser = await getUser(targetId);
    if (!retryUser) return ctx.reply("❗️ This user is not registered.");
    return ctx.reply(`👛 <b>User Wallet</b>\n🆔 ID: <code>${targetId}</code>\n💰 Balance: <b>0</b>`, { parse_mode: "HTML" });
  }

  const isSelf = targetId === ctx.from.id;
  await ctx.reply(
    `👛 <b>${isSelf ? "Your Wallet | کیف پول شما" : "User Wallet | کیف پول کاربر"}</b>\n\n` +
    `🆔 ID: <code>${targetId}</code>\n` + (user.username ? `👤 Username: @${user.username}\n` : "") +
    `💰 Balance | موجودی: <b>${fmt(user.balance)}</b>`,
    { parse_mode: "HTML" }
  );
}

// ==========================================================================
// 5.1) Interactive Help menu (replaces previous long help)
// ==========================================================================

const HELP_SECTIONS = {
  main: {
    title: '📖 Depth TON Bot — منوی راهنما',
    text: `سلام! بخش موردنظر را انتخاب کن تا دستورها و مثال‌ها را ببینی.`,
  },
  wallet: {
    title: '👛 والِت (Wallet)',
    text:
`• /wallet یا /ولت → نمایش موجودی شما
مثال: <code>/wallet</code>

نمایش موجودی دیگران:
• ریپلای روی پیام کاربر + <code>/wallet</code>
• یا: <code>/wallet 123456789</code> یا <code>/wallet @username</code>`,
  },
  transfer: {
    title: '🔁 انتقال (Transfer)',
    text:
`• ریپلای + مبلغ → انتقال به کاربرِ ریپلای‌شده
مثال: ریپلای روی پیام کاربر و ارسال متن: <code>10k</code>

• انتقال مستقیم با آیدی/یوزرنیم:
مثال: <code>انتقال 5k به @username</code>

پس از ساخت درخواست، باید دکمهٔ "تایید" را بزنید تا انتقال انجام شود.`,
  },
  bill: {
    title: '🧾 قبض (Bill)',
    text:
`• ساخت قبض با محدودیت:
مثال: <code>create bill 10k for 5 uses</code>
(فارسی: <code>ساخت قبض 10k 5 بار مصرف</code>)

• قبض بدون محدودیت:
مثال: <code>make bill 10k unlimited</code>

• پرداخت: لینک یا /start=bill_{id} (در متن help از {} استفاده شده تا خطای HTML پیش نیاید).`,
  },
  stats: {
    title: '📊 آمار روزانه (Stats)',
    text:
`• نمایش لیدربورد پیام‌های امروز در گروه:
مثال: <code>آمار</code> یا <code>stats</code>

• نفر اول یک‌بار در روز جایزه می‌گیرد (پیش‌فرض: <b>500,000 دپث</b>).`,
  },
  giveaway: {
    title: '🎁 جایزهٔ شانسی (Giveaway)',
    text:
`• جایزهٔ رندوم توسط سیستم در گروه‌ها ارسال می‌شود (در هر پیام احتمال کمی دارد).
• ادمین می‌تواند دستی جایزه بسازد:
مثال: <code>ساخت جایزه 100k</code>

• اولین نفری که دکمه را بزند جایزه را می‌گیرد و پیام حذف می‌شود.`,
  },
  games: {
    title: '🕹 بازی‌ها (Games)',
    text:
`• بازی با ایموجی‌ها:
مثال: <code>/play فوتبال 10k</code> یا <code>/play ایموجی 5k</code>
- دکمه‌های شیشه‌ای با ایموجی نمایش داده می‌شود؛ روی ایموجیِ انتخابی کلیک کنید.

• مین (Mines):
مثال: <code>/play مین 5000</code>
- گرید دکمه‌ای نمایش داده می‌شود؛ هر خانه امن می‌تواند ضریب افزایش دهد.
- برداشت مقدار: <code>/cashout_{gameId}</code> (شناسه بازی در پیام ربات نمایش داده می‌شود).

• مولتی‌پلیر:
مثال ساخت بازی مولتی: <code>/play multiplayer 10k 3</code> (مبلغ 10k، حداکثر 3 بازیکن)
- سازنده auto-join می‌شود، بقیه با دکمه "ورود به بازی" وارد می‌شوند.
- پس از پر شدن بازی، نوبت‌ها آغاز می‌شود و هر بازیکن نوبتی ایموجی می‌فرستد. بالاترین ایموجی برنده است.

• بازی تاس (dice) — مولتی یا سینگل:
- هنگام ساخت مولتی از نوع dice (مثلاً: <code>/play multiplayer_dice 10k 3</code>) یا با دستور مخصوص،
  سازنده می‌تواند شرط را تنظیم کند: کمتر/بزرگتر/زوج/فرد/دقیق (با <code>/setdice {gameId} {mode} [value]</code>).
- هر بازیکن باید از قابلیت dice تلگرام استفاده کند (ارسال 🎲).`,
  },
  admin: {
    title: '🛡 دستورات ادمین',
    text:
`(فقط ادمین‌ها می‌توانند اجرا کنند)
• شارژ کاربر:
مثال: <code>شارژ 10k @username</code> یا ریپلای + <code>add 10k</code>

• کسر از کاربر:
مثال: <code>کسر 5k @username</code>

• ساخت جایزه:
مثال: <code>ساخت جایزه 100k</code>

• فعال/غیرفعال کردن قابلیت:
مثال فعال: <code>فعال کن giveaways</code> / <code>غیرفعال کن games</code>`,
  },
  owner: {
    title: '👑 دستورات مالک (Owner)',
    text:
`• ساخت کد ادمین (مالک):
مثال: <code>/makecode</code>

• افزودن ادمین:
مثال: <code>/addadmin {id|@username}</code>

• حذف ادمین:
مثال: <code>/deladmin {id|@username}</code>`,
  },
  tips: {
    title: '⚠️ نکات مهم',
    text:
`• واحد: «دپث» — والت مجازی و فاقد ارزش واقعی.
• برای شنیدن پیام‌های عادی در گروه، Privacy در BotFather باید غیرفعال شود.
• برای حذف/ویرایش پیام‌ها، ربات باید در گروه ادمین با حق حذف پیام باشد.`,
  }
};

function buildMainKeyboard(isAdmin = false, isOwner = false) {
  const kb = new InlineKeyboard();
  kb.text('👛 والِت', 'help_section_wallet')
    .text('🔁 انتقال', 'help_section_transfer')
    .row()
    .text('🧾 قبض', 'help_section_bill')
    .text('📊 آمار', 'help_section_stats')
    .row()
    .text('🎁 جایزه', 'help_section_giveaway')
    .text('🕹 بازی‌ها', 'help_section_games');

  if (isAdmin) {
    kb.row().text('🛡 ادمین', 'help_section_admin');
  }
  if (isOwner) {
    kb.row().text('👑 مالک', 'help_section_owner');
  }
  kb.row().text('⚠️ نکات مهم', 'help_section_tips');
  return kb;
}
function buildBackKeyboard() {
  return new InlineKeyboard().text('◀️ بازگشت', 'help_back');
}

bot.command('help', async (ctx) => {
  try {
    const adminStatus = await isAdmin(ctx.from.id).catch(() => false);
    const ownerStatus = await isOwner(ctx.from.id).catch(() => false);
    const main = HELP_SECTIONS.main;
    const kb = buildMainKeyboard(adminStatus, ownerStatus);
    await ctx.reply(`<b>${main.title}</b>\n\n${main.text}`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    console.error('help command error:', err);
    await ctx.reply('خطا در نمایش منوِ راهنما. بعداً تلاش کنید.');
  }
});

bot.callbackQuery(/^help_section_(.+)$/, async (ctx) => {
  try {
    const key = ctx.match[1];
    const section = HELP_SECTIONS[key];
    if (!section) return ctx.answerCallbackQuery({ text: 'بخش یافت نشد.', show_alert: true });
    const kb = buildBackKeyboard();
    await ctx.editMessageText(`<b>${section.title}</b>\n\n${section.text}`, { parse_mode: 'HTML', reply_markup: kb });
    return ctx.answerCallbackQuery();
  } catch (err) {
    console.error('help_section callback error:', err);
    return ctx.answerCallbackQuery({ text: 'خطا رخ داد.', show_alert: true });
  }
});

bot.callbackQuery('help_back', async (ctx) => {
  try {
    const adminStatus = await isAdmin(ctx.from.id).catch(() => false);
    const ownerStatus = await isOwner(ctx.from.id).catch(() => false);
    const main = HELP_SECTIONS.main;
    const kb = buildMainKeyboard(adminStatus, ownerStatus);
    await ctx.editMessageText(`<b>${main.title}</b>\n\n${main.text}`, { parse_mode: 'HTML', reply_markup: kb });
    return ctx.answerCallbackQuery();
  } catch (err) {
    console.error('help_back callback error:', err);
    return ctx.answerCallbackQuery({ text: 'خطا رخ داد.', show_alert: true });
  }
});

// ==========================================================================
// 6) مدیریت ادمین‌ها (kept same)
// ==========================================================================
bot.command("makecode", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔️ Only the bot owner can create admin codes.");
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ Reply to a user or provide an ID/Username.", { parse_mode: "HTML" });

  const code = Math.floor(1000000000 + Math.random() * 9000000000).toString();
  await supabase.from("admin_codes").delete().eq("user_id", targetId);
  const { error } = await supabase.from("admin_codes").insert({ code, user_id: targetId }); if (error) return ctx.reply("❌ Error creating code.");

  await ctx.reply(`🔑 <b>Admin Code Created</b>\n👤 User: <code>${targetId}</code>\n🔐 Code: <code>${code}</code>`, { parse_mode: "HTML" });
});

bot.command("addadmin", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔️ Only the bot owner can add admins.");
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ Reply to a user or provide an ID/Username.");
  await ensureUser({ id: targetId });
  const { error } = await supabase.from("admins").upsert({ user_id: targetId, added_by: ctx.from.id });
  if (error) return ctx.reply("❌ Error adding admin.");
  await ctx.reply(`✅ User <code>${targetId}</code> added as admin.`, { parse_mode: "HTML" });
});

bot.command("deladmin", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔️ Only the bot owner can remove admins.");
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ Reply to a user or provide an ID/Username.");
  await supabase.from("admins").delete().eq("user_id", targetId);
  await ctx.reply(`✅ Admin access for <code>${targetId}</code> removed.`, { parse_mode: "HTML" });
});

async function resolveTargetId(ctx) {
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const forwardedId = getForwardedUserId(reply);
    if (forwardedId) {
      await ensureUser({ id: forwardedId });
      return forwardedId;
    }
    const replyUser = getReplyFromUser(reply);
    if (replyUser) {
      await ensureUser(replyUser);
      return replyUser.id;
    }
  }
  const parts = ctx.message.text.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (last.startsWith("/")) return null;
  return await resolveIdentifierToken(last);
}

// ==========================================================================
// 6.1) آمار پیام‌های روزانه + جایزه‌ی نفر اول (kept)
// ==========================================================================
const RE_STATS_KEYWORD = /^(?:آمار|stats)$/i;
const DAILY_STATS_REWARD = 500000;

async function incrementMessageCount(userId, chatId) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await supabase.rpc("increment_message_count", { p_user_id: userId, p_chat_id: chatId, p_day: today });
  } catch (e) {
    console.error("incrementMessageCount error:", e);
  }
}

async function handleStats(ctx) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: rows } = await supabase
    .from("message_stats")
    .select("user_id, count, users(username, first_name)")
    .eq("chat_id", ctx.chat.id)
    .eq("day", today)
    .order("count", { ascending: false })
    .limit(15);

  if (!rows || rows.length === 0) {
    return ctx.reply("📊 امروز هنوز کسی توی این گروه پیام نداده.");
  }

  const lines = rows.map((r, i) => {
    const info = r.users || {};
    const label = info.username ? `@${info.username}` : (info.first_name || "کاربر");
    return `${i + 1}. ${label} — ${r.count} پیام`;
  });

  const topUserId = rows[0].user_id;

  const { data: existingReward } = await supabase
    .from("daily_stat_rewards")
    .select("*")
    .eq("chat_id", ctx.chat.id)
    .eq("day", today)
    .maybeSingle();

  let rewardLine;
  if (existingReward) {
    rewardLine = `🏆 جایزه‌ی امروز قبلاً به <code>${existingReward.user_id}</code> داده شده.`;
  } else {
    await ensureUser({ id: topUserId });
    const { data: cur } = await supabase.from("users").select("balance").eq("user_id", topUserId).single();
    await supabase.from("users").update({ balance: cur.balance + DAILY_STATS_REWARD }).eq("user_id", topUserId);
    await supabase.from("daily_stat_rewards").insert({ chat_id: ctx.chat.id, day: today, user_id: topUserId });
    rewardLine = `🏆 نفر اول (<code>${topUserId}</code>) جایزه‌ی <b>${fmt(DAILY_STATS_REWARD)}</b> دپث تون گرفت! 🎉`;
  }

  await ctx.reply(
    `📊 <b>آمار پیام‌های امروز</b>\n\n${lines.join("\n")}\n\n${rewardLine}`,
    { parse_mode: "HTML" }
  );
}

// ==========================================================================
// 6.2) جایزه‌ی شانسی (giveaway) (kept)
// ==========================================================================
const RE_CREATE_PRIZE = /^ساخت\s+جایزه\s+([\d۰-۹.,]+\s*(?:میلیارد|میلیون|هزار|کا|ک|k|m|b|م|ب)?)$/i;
const DAILY_GIVEAWAY_AMOUNT = 100000;

async function createGiveaway(api, chatId, amount, createdBy) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: giveaway, error } = await supabase
    .from("giveaways")
    .insert({ chat_id: chatId, amount, created_by: createdBy, day: today })
    .select()
    .single();
  if (error) {
    console.error("createGiveaway error:", error);
    return;
  }

  const kb = new InlineKeyboard().text("🎁 دریافت جایزه", `giveaway_claim_${giveaway.id}`);
  const sent = await api.sendMessage(
    chatId,
    `🎉 <b>جایزه‌ی شانسی!</b>\n\nاولین نفری که دکمه رو بزنه <b>${fmt(amount)}</b> دپث تون می‌بره!`,
    { parse_mode: "HTML", reply_markup: kb }
  );
  await supabase.from("giveaways").update({ message_id: sent.message_id }).eq("id", giveaway.id);
}

bot.callbackQuery(/^giveaway_claim_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const { data: giveaway } = await supabase.from("giveaways").select("*").eq("id", id).maybeSingle();
  if (!giveaway || giveaway.is_claimed) {
    return ctx.answerCallbackQuery({ text: "این جایزه قبلاً گرفته شده!", show_alert: true });
  }

  // conditional update to avoid race
  const { data: updated } = await supabase
    .from("giveaways")
    .update({ is_claimed: true, claimed_by: ctx.from.id })
    .eq("id", id)
    .eq("is_claimed", false)
    .select()
    .maybeSingle();

  if (!updated) {
    return ctx.answerCallbackQuery({ text: "همین الان توسط یه نفر دیگه گرفته شد!", show_alert: true });
  }

  await ensureUser(ctx.from);
  const { data: cur } = await supabase.from("users").select("balance").eq("user_id", ctx.from.id).single();
  await supabase.from("users").update({ balance: cur.balance + giveaway.amount }).eq("user_id", ctx.from.id);

  try {
    await ctx.api.deleteMessage(giveaway.chat_id, giveaway.message_id);
  } catch (e) {
    console.error("delete giveaway message error:", e.message);
  }

  await ctx.answerCallbackQuery({ text: `🎉 تبریک! ${fmt(giveaway.amount)} دپث تون گرفتی!`, show_alert: true });
});

// ==========================================================================
// 7) هندلر اصلی متن‌ها (merged + added multiplayer handling and call to tryHandleMultiplayerPlay)
// ==========================================================================
const KW = {
  transfer: ["انتقال", "transfer", "send"],
  to: ["به", "to"], createBill: ["ساخت\\s*قبض", "create\\s*bill", "make\\s*bill"],
  uses: ["بار\\s*مصرف", "uses", "times"],
  unlimited: ["بدون\\s*محدودیت", "unlimited", "no\\s*limit"],
  charge: ["شارژ", "add\\s*ton", "charge", "topup", "افزایش"],
  deduct: ["کسر", "ولس", "کم", "deduct", "sub", "remove", "minus"],
  from: ["از", "from"],
  wallet: ["ولت", "کیف\\s*پول", "wallet", "balance"],
};

function kw(key) { return KW[key].join("|"); }
const ID_TOKEN = `\\d+|@[A-Za-z0-9_]{3,32}`;

const RE_TRANSFER_TO_ID = new RegExp(`^(?:${kw("transfer")})\\s+(${AMOUNT_TOKEN})\\s+(?:(?:${kw("to")})\\s+)?(${ID_TOKEN})$`, "i");
const RE_TRANSFER_REPLY = new RegExp(`^(?:${kw("transfer")})?\\s*(${AMOUNT_TOKEN})$`, "i");
const RE_CREATE_BILL = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:دپث\\s+)?([\\d۰-۹]+)\\s*(?:${kw("uses")})$`, "i");
const RE_CREATE_BILL_UNLIMITED = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("unlimited")})$`, "i");
const RE_ADMIN_ADD = new RegExp(`^(?:${kw("charge")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("to")}|for)\\s+(${ID_TOKEN}))?$`, "i");
const RE_ADMIN_SUB = new RegExp(`^(?:${kw("deduct")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("from")})\\s+(${ID_TOKEN}))?$`, "i");
const RE_WALLET_KEYWORD = new RegExp(`^(?:${kw("wallet")})$`, "i");

// Multiplayer create regex:
const RE_PLAY_MULTI = /^(?:\/play|بازی)\s+(?:multiplayer|مولتی|مولتیپلیر)\s+([^\s]+)\s+(\d+)(?:\s+(dice))?$/i;
// RE_PLAY earlier exists in older code - we keep it
const RE_PLAY = /^(?:\/play|بازی)\s+([^\s]+)\s+(.+)$/i;

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  await ensureUser(ctx.from);

  // First: try to handle if this message is a multiplayer game play (n-turn moves)
  try {
    const handled = await tryHandleMultiplayerPlay(ctx);
    if (handled) return; // if it's an in-progress multiplayer move, stop further processing
  } catch (e) {
    console.error("tryHandleMultiplayerPlay error:", e);
  }

  // ---- Admin code 10-digit entry
  if (/^\d{10}$/.test(text)) {
    const { data: record } = await supabase.from("admin_codes").select("*").eq("code", text).maybeSingle();
    if (record) {
      if (record.user_id !== ctx.from.id) return ctx.reply("⛔️ This code was not issued for your Telegram ID!");
      await supabase.from("admins").upsert({ user_id: ctx.from.id, added_by: OWNER_ID });
      await supabase.from("admin_codes").delete().eq("code", text);
      return ctx.reply("🎉 <b>Success!</b> You have been promoted to bot admin.", { parse_mode: "HTML" });
    }
  }

  // Feature toggle (فعال/غیرفعال)
  const RE_FEATURE_ON = /^(?:فعال\s*(?:کن|کنید|سازی)?)\s+([a-zA-Z\u0600-\u06FF0-9_]+)$/i;
  const RE_FEATURE_OFF = /^(?:غیرفعال\s*(?:کن|کنید|سازی)?)\s+([a-zA-Z\u0600-\u06FF0-9_]+)$/i;

  const mOn = text.match(RE_FEATURE_ON);
  const mOff = text.match(RE_FEATURE_OFF);
  if (mOn || mOff) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن قابلیت‌ها رو تغییر بدن.");
    const featureName = (mOn ? mOn[1] : mOff[1]).toLowerCase();
    const enabled = !!mOn;
    await setFeature(ctx.chat.id, featureName, enabled);
    return ctx.reply(`${enabled ? "✅ فعال شد:" : "⛔️ غیرفعال شد:"} ${featureName}`);
  }

  // Play multi create (مولتی)
  const mMulti = text.match(RE_PLAY_MULTI);
  if (mMulti) {
    // groups only
    if (!(ctx.chat.type === "group" || ctx.chat.type === "supergroup")) return ctx.reply("این دستور فقط در گروه‌ها قابل اجرا است.");
    const amount = parseAmount(mMulti[1]);
    const maxPlayers = parseInt(mMulti[2], 10);
    const isDice = !!mMulti[3];
    if (!amount || !maxPlayers || maxPlayers < 2) return ctx.reply("❗️ مقدار یا تعداد بازیکنان نامعتبر است (حداقل 2).");
    const me = await getUser(ctx.from.id);
    if (!me) return ctx.reply("❗️ حساب شما ثبت نشده.");
    if (me.balance < amount) return ctx.reply("❗️ موجودی کافی نیست.");
    // deduct creator bet
    const { data: ok } = await supabase.rpc("transfer_balance", { p_from: ctx.from.id, p_to: 0, p_amount: amount });
    if (!ok) return ctx.reply("❗️ خطا در برداشت مبلغ. موجودی کافی نیست یا DB خطا داد.");
    // create game
    const { data: game } = await supabase.from("multiplayer_games").insert({
      chat_id: ctx.chat.id, creator_id: ctx.from.id, type: (isDice ? 'dice' : 'emoji'), bet: amount, max_players: maxPlayers, pot: amount
    }).select().single();
    if (!game) return ctx.reply("❌ خطا در ایجاد بازی.");
    // creator auto-joins
    await supabase.from("game_entries").insert({ game_id: game.id, user_id: ctx.from.id });
    const kb = new InlineKeyboard().text('▶️ ورود به بازی', `multiplayer_enter_${game.id}`).text('❌ لغو', `multiplayer_cancel_${game.id}`);
    const sent = await ctx.reply(`🕹 بازی مولتیپلیر ساخته شد!\n• سازنده: <code>${ctx.from.id}</code>\n• نوع: <b>${isDice ? 'تاس' : 'ایموجی'}</b>\n• مبلغ شرط: <b>${fmt(amount)}</b>\n• حداکثر بازیکن: <b>${maxPlayers}</b>\n\nبرای پیوستن روی دکمهٔ "ورود به بازی" بزنید.`, { parse_mode: 'HTML', reply_markup: kb });
    await supabase.from("multiplayer_games").update({ message_id: sent.message_id }).eq("id", game.id);
    return;
  }

  // Play single / legacy handlers (existing play command)
  const mPlay = text.match(RE_PLAY);
  if (mPlay) {
    const gameKey = mPlay[1].toLowerCase();
    const amount = parseAmount(mPlay[2]);
    if (!amount) return ctx.reply("❗️ مبلغ نامعتبر است.");
    if (!(await isFeatureEnabled(ctx.chat.id, "games"))) return ctx.reply("⚠️ بازی‌ها در این چت غیرفعال شده‌اند.");

    const allowed = {
      football: "football", فوتبال: "football",
      basketball: "basketball", بسکتبال: "basketball",
      darts: "darts", دارت: "darts",
      dice: "dice", تاس: "dice",
      bowling: "bowling", بولینگ: "bowling",
      emoji: "emoji", ایموجی: "emoji",
      mine: "mines", مین: "mines"
    };
    const gameName = allowed[gameKey] || null;
    if (!gameName) return ctx.reply("❗️ بازی نامشخص است. از فوتبال/بسکتبال/دارت/تاس/بولینگ/مین استفاده کنید.");

    const me = await getUser(ctx.from.id);
    if (!me) return ctx.reply("❗️ حساب شما ثبت نشده.");
    if (me.balance < amount) return ctx.reply("❗️ موجودی کافی نیست.");

    // deduct bet (transfer to system id 0)
    const { data: ok } = await supabase.rpc("transfer_balance", { p_from: ctx.from.id, p_to: 0, p_amount: amount });
    if (!ok) return ctx.reply("❗️ خطا در پردازش تراکنش. موجودی کافی نیست یا DB خطا داد.");

    if (gameName === "mines") {
      const gridSize = 3;
      const minesCount = 2;
      const total = gridSize * gridSize;
      const cells = new Array(total).fill(0);
      let placed = 0;
      while (placed < minesCount) {
        const idx = Math.floor(Math.random() * total);
        if (cells[idx] === 0) { cells[idx] = 1; placed++; }
      }
      const { data: mg } = await supabase.from("mines_games").insert({
        chat_id: ctx.chat.id, user_id: ctx.from.id, amount, grid_size: gridSize, mines_count: minesCount, cells: JSON.stringify(cells), opened: JSON.stringify([])
      }).select().single();

      const kbBuilder = new InlineKeyboard();
      for (let r=0; r<gridSize; r++) {
        for (let c=0; c<gridSize; c++) {
          const idx = r*gridSize + c;
          kbBuilder.text("⬜️", `mines_click_${mg.id}_${idx}`);
        }
        kbBuilder.row();
      }
      await ctx.reply(`💣 مین — شما شرط ${fmt(amount)} گذاشتید. خانه‌ها را باز کنید.`, { reply_markup: kbBuilder });
      return;
    }

    // emoji singleplayer
    const { data: created } = await supabase.from("games").insert({
      chat_id: ctx.chat.id, user_id: ctx.from.id, game: gameName, amount, chosen: -1, status: "pending"
    }).select().single();

    const kb = new InlineKeyboard();
    EMOJI_GAMES.forEach((em, idx) => kb.text(em, `game_bet_${created.id}_${idx}`));
    await ctx.reply(`🎲 بازی: ${gameName}\nلطفا روی ایموجی مورد نظرتون کلیک کنید. (مبلغ: ${fmt(amount)})`, { reply_markup: kb });
    return;
  }

  // Remaining legacy handlers: stats, create prize, wallet-reply, transfers, bills, admin add/sub, forwarded messages, etc.
  if (RE_STATS_KEYWORD.test(text) && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    await handleStats(ctx);
    return;
  }

  const mPrize = text.match(RE_CREATE_PRIZE);
  if (mPrize) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن جایزه بسازن.");
    const amount = parseAmount(mPrize[1]);
    if (!amount) return ctx.reply("❗️ مبلغ جایزه نامعتبر است.");
    await createGiveaway(ctx.api, ctx.chat.id, amount, ctx.from.id);
    return;
  }

  // wallet by reply
  if (ctx.message.reply_to_message && RE_WALLET_KEYWORD.test(text)) {
    const reply = ctx.message.reply_to_message;
    const forwardedId = getForwardedUserId(reply);
    let targetId = null;

    if (forwardedId) {
      targetId = forwardedId;
      await ensureUser({ id: forwardedId });
    } else {
      const replyUser = getReplyFromUser(reply);
      if (replyUser) {
        targetId = replyUser.id;
        await ensureUser(replyUser);
      }
    }
    if (!targetId) targetId = ctx.from.id;

    const user = await getUser(targetId);
    if (!user) return ctx.reply("❗️ User not registered.");

    return ctx.reply(
      `👛 <b>User Wallet</b>\n🆔 ID: <code>${targetId}</code>\n` +
      (user.username ? `👤 Username: @${user.username}\n` : "") +
      `💰 Balance: <b>${fmt(user.balance)}</b>`,
      { parse_mode: "HTML" }
    );
  }

  // Transfer by reply
  if (ctx.message.reply_to_message) {
    const mReply = text.match(RE_TRANSFER_REPLY);
    const amount = mReply ? parseAmount(mReply[1]) : null;
    if (amount) {
      const reply = ctx.message.reply_to_message;
      const forwardedId = getForwardedUserId(reply);
      let toUserId = null;

      if (forwardedId) {
        await ensureUser({ id: forwardedId });
        toUserId = forwardedId;
      } else {
        const replyUser = getReplyFromUser(reply);
        if (replyUser) {
          await ensureUser(replyUser);
          toUserId = replyUser.id;
        }
      }

      if (!toUserId) {
        return ctx.reply("❗️ Could not detect target user (اگه روی پیام خودِ ربات ریپلای کردی، این کار نمی‌کنه).");
      }
      if (toUserId === ctx.from.id) {
        return ctx.reply("❗️ You cannot transfer to yourself.");
      }

      const toUserRow = await getUser(toUserId);
      if (!toUserRow) return ctx.reply("❗️ Target user is not registered.");

      await handleTransferRequest(
        ctx,
        { id: toUserRow.user_id, username: toUserRow.username, first_name: toUserRow.first_name },
        amount
      );
      return;
    }
  }

  // Transfer by id/username
  const mTransfer = text.match(RE_TRANSFER_TO_ID);
  if (mTransfer) {
    const amount = parseAmount(mTransfer[1]);
    const toId = await resolveIdentifierToken(mTransfer[2]);
    if (!amount) return ctx.reply("❗️ Invalid amount.");
    if (!toId) return ctx.reply("❗️ Invalid target user.");
    if (toId === ctx.from.id) return ctx.reply("❗️ You cannot transfer to yourself.");

    await ensureUser({ id: toId });
    const toUser = await getUser(toId); if (!toUser) return ctx.reply("❗️ Target user is not registered.");

    await handleTransferRequest(ctx, { id: toId, username: toUser.username, first_name: toUser.first_name }, amount);
    return;
  }

  // Create bill limited
  const mBill = text.match(RE_CREATE_BILL);
  if (mBill) {
    const amount = parseAmount(mBill[1]);
    const maxUses = parseInt(normalizeDigits(mBill[2]), 10);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    if (!maxUses || maxUses <= 0) return ctx.reply("❗️ Invalid number of uses.");
    await createBill(ctx, amount, maxUses);
    return;
  }

  // Create bill unlimited
  const mBillUnlimited = text.match(RE_CREATE_BILL_UNLIMITED);
  if (mBillUnlimited) {
    const amount = parseAmount(mBillUnlimited[1]);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    await createBill(ctx, amount, null);
    return;
  }

  // Admin add
  const mAdd = text.match(RE_ADMIN_ADD);
  if (mAdd) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ Only admins can add balance.");
    const amount = parseAmount(mAdd[1]);
    let targetId = null;

    if (mAdd[2]) {
      targetId = await resolveIdentifierToken(mAdd[2]);
    } else {
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const fwdId = getForwardedUserId(reply);
        const repUser = getReplyFromUser(reply);
        targetId = fwdId || repUser?.id || null;
      }
    }

    if (!amount) return ctx.reply("❗️ Invalid amount.");
    if (!targetId) targetId = ctx.from.id;

    await ensureUser({ id: targetId });
    const { data: cur } = await supabase.from("users").select("balance").eq("user_id", targetId).single();
    if (!cur) return ctx.reply("❗️ User not found.");
    await supabase.from("users").update({ balance: cur.balance + amount }).eq("user_id", targetId);
    await ctx.reply(`✅ Added <b>${fmt(amount)}</b> to <code>${targetId}</code>.`, { parse_mode: "HTML" });
    return;
  }

  // Admin subtract using RPC
  const mSub = text.match(RE_ADMIN_SUB);
  if (mSub) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ Only admins can deduct balance.");

    const amount = parseAmount(mSub[1]);
    let targetId = null;

    if (mSub[2]) {
      targetId = await resolveIdentifierToken(mSub[2]);
    } else {
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const fwdId = getForwardedUserId(reply);
        const repUser = getReplyFromUser(reply);
        targetId = fwdId || repUser?.id || null;
      }
    }

    if (!amount) return ctx.reply("❗️ Invalid amount.");
    if (!targetId) targetId = ctx.from.id;

    const target = await getUser(targetId);
    if (!target) return ctx.reply("❗️ User not found.");
    if (target.balance < amount) return ctx.reply("❗️ Insufficient balance.");

    const { data: ok } = await supabase.rpc("transfer_balance", {
      p_from: targetId,
      p_to: 0,
      p_amount: amount
    });

    if (!ok) {
      return ctx.reply("❌ Error processing deduction. Database transaction failed.");
    }

    await ctx.reply(`✅ Deducted <b>${fmt(amount)}</b> from <code>${targetId}</code>.`, { parse_mode: "HTML" });
    return;
  }

  // Detect forwarded in private by admin
  if (ctx.chat.type === "private" && (await isAdmin(ctx.from.id))) {
    const fwdId = getForwardedUserId(ctx.message);
    if (fwdId) {
      await ensureUser({ id: fwdId });
      const fwdUser = await getUser(fwdId);
      return ctx.reply(
        `📎 <b>Forwarded Message Detected</b>\n🆔 ID: <code>${fwdId}</code>\n` +
        (fwdUser?.username ? `👤 Username: @${fwdUser.username}\n` : "") +
        `💰 Balance: <b>${fmt(fwdUser?.balance ?? 0)}</b>\n\n` +
        `Reply to this message with:\n<code>add 10k</code> or <code>deduct 10k</code>`,
        { parse_mode: "HTML" }
      );
    }
  }

  // Cashout for mines handled earlier in older code - kept (see below)
});

// ==========================================================================
// 8) انتقال با تایید دکمه شیشه‌ای (kept)
// ==========================================================================
async function handleTransferRequest(ctx, toUser, amount) {
  if (toUser.id === ctx.from.id) return ctx.reply("❗️ You cannot transfer to yourself.");
  const fromUser = await getUser(ctx.from.id);
  if (!fromUser) return ctx.reply("❗️ Your account is not registered.");
  if (fromUser.balance < amount) return ctx.reply("❗️ Insufficient balance.");

  const { data: pending, error } = await supabase.from("pending_transfers").insert({
    from_user_id: ctx.from.id, to_user_id: toUser.id, amount, chat_id: ctx.chat.id, status: "pending",
  }).select().single();

  if (error) return ctx.reply("❌ Error creating transfer request.");

  const kb = new InlineKeyboard()
    .text("✅ Confirm | تایید", `tr_confirm_${pending.id}`)
    .text("❌ Cancel | لغو", `tr_cancel_${pending.id}`);

  const toLabel = toUser.username ? `@${toUser.username}` : (toUser.first_name || toUser.id);
  const sent = await ctx.reply(
    `🔁 <b>Transfer Request | درخواست انتقال</b>\n\n` +
    `From | از: <code>${ctx.from.id}</code>\n` +
    `To | به: ${toLabel} (<code>${toUser.id}</code>)\n` +
    `Amount | مبلغ: <b>${fmt(amount)}</b>\n\n` +
    `Sender must confirm to proceed:`,
    { parse_mode: "HTML", reply_markup: kb }
  );

  await supabase.from("pending_transfers").update({ message_id: sent.message_id }).eq("id", pending.id);
}

bot.callbackQuery(/^tr_confirm_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle(); if (!pending || pending.status !== "pending") return ctx.answerCallbackQuery({ text: "Request expired.", show_alert: true });
  if (pending.from_user_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: "Only sender can confirm.", show_alert: true });

  const { data: ok } = await supabase.rpc("transfer_balance", { p_from: pending.from_user_id, p_to: pending.to_user_id, p_amount: pending.amount });
  if (!ok) {
    await supabase.from("pending_transfers").update({ status: "expired" }).eq("id", id);
    await ctx.editMessageText("❌ Insufficient balance. Transfer cancelled.");
    return ctx.answerCallbackQuery();
  }

  await supabase.from("pending_transfers").update({ status: "confirmed" }).eq("id", id);
  await ctx.editMessageText(`✅ <b>Transfer Successful</b>\nFrom: <code>${pending.from_user_id}</code>\nTo: <code>${pending.to_user_id}</code>\nAmount: <b>${fmt(pending.amount)}</b>`, { parse_mode: "HTML" });
  await ctx.answerCallbackQuery({ text: "Transferred ✅" });
});

bot.callbackQuery(/^tr_cancel_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle();
  if (!pending || pending.status !== "pending") return ctx.answerCallbackQuery({ text: "Request expired.", show_alert: true });
  if (pending.from_user_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: "Only sender can cancel.", show_alert: true });

  await supabase.from("pending_transfers").update({ status: "cancelled" }).eq("id", id);
  await ctx.editMessageText("🚫 Transfer cancelled by sender.");
  await ctx.answerCallbackQuery({ text: "Cancelled" });
});

// ==========================================================================
// 9) Bill system (kept)
// ==========================================================================
async function createBill(ctx, amount, maxUses) {
  const { data: bill, error } = await supabase.from("bills").insert({
    creator_id: ctx.from.id, amount, max_uses: maxUses, used_count: 0, chat_id: ctx.chat.id, is_active: true,
  }).select().single();

  if (error) return ctx.reply("❌ Error creating bill.");

  const link = `https://t.me/${BOT_USERNAME}?start=bill_${bill.id}`;
  const kb = new InlineKeyboard().url("💳 Pay Bill | پرداخت", link);
  const sent = await ctx.reply(billText(bill, []), { parse_mode: "HTML", reply_markup: kb });
  await supabase.from("bills").update({ message_id: sent.message_id }).eq("id", bill.id);
}

function billText(bill, payers) {
  const isUnlimited = bill.max_uses === null || bill.max_uses === undefined;
  const remaining = isUnlimited ? null : bill.max_uses - bill.used_count;

  const payersList = payers.length
    ? payers.map((p) => {
        const info = p.users || {};
        const label = info.username ? `@${info.username}` : (info.first_name || "User | کاربر");
        return `• ${label}`;
      }).join("\n")
    : "— No payments yet | هنوز کسی پرداخت نکرده —";

  return (
    `🧾 <b>Depth Bill | قبض دپث</b>\n\n` +
    `💰 Amount per pay | مبلغ: <b>${fmt(bill.amount)}</b>\n` +
    (isUnlimited
      ? `🔁 Status: <b>Unlimited total</b> (Each person can pay only once)\nوضعیت: بدون محدودیت تعداد کل (هر نفر فقط یک‌بار)\n\n`
      : `🔁 Remaining | باقی‌مانده: <b>${remaining} of ${bill.max_uses}</b>\n\n`) +
    `👥 <b>Payers | پرداخت‌کنندگان (${bill.used_count}):</b>\n${payersList}` +
    (!isUnlimited && remaining <= 0 ? "\n\n🔒 This bill is now inactive." : "")
  );
}

async function payBill(ctx, billId) {
  await ensureUser(ctx.from);
  const { data: bill } = await supabase.from("bills").select("*").eq("id", billId).maybeSingle();
  if (!bill || !bill.is_active) return ctx.reply("❗️ Bill not found or inactive.");
  if (bill.max_uses !== null && bill.used_count >= bill.max_uses) return ctx.reply("❗️ Bill capacity is full.");
  if (bill.creator_id === ctx.from.id) return ctx.reply("❗️ Creator cannot pay their own bill.");

  const { data: already } = await supabase.from("bill_payments").select("bill_id").eq("bill_id", billId).eq("user_id", ctx.from.id).maybeSingle();
  if (already) return ctx.reply("❗️ You have already paid this bill.");

  const { data: ok } = await supabase.rpc("transfer_balance", { p_from: ctx.from.id, p_to: bill.creator_id, p_amount: bill.amount });
  if (!ok) return ctx.reply("❗️ Insufficient balance.");

  await supabase.from("bill_payments").insert({ bill_id: billId, user_id: ctx.from.id });
  const newUsedCount = bill.used_count + 1;
  const isNowInactive = bill.max_uses !== null && newUsedCount >= bill.max_uses;

  await supabase.from("bills").update({ used_count: newUsedCount, is_active: !isNowInactive }).eq("id", billId);
  await ctx.reply(`✅ Payment successful.\n💰 <b>${fmt(bill.amount)}</b> sent to the bill creator.`, { parse_mode: "HTML" });

  if (bill.chat_id && bill.message_id) {
    const { data: payments } = await supabase.from("bill_payments").select("user_id").eq("bill_id", billId).order("paid_at", { ascending: true });
    let payersWithInfo = [];
    if (payments && payments.length > 0) {
      const userIds = payments.map(p => p.user_id);
      const { data: usersData } = await supabase.from("users").select("user_id, username, first_name").in("user_id", userIds);
      const userMap = new Map();
      if (usersData) usersData.forEach(u => userMap.set(u.user_id, u));
      payersWithInfo = payments.map(p => ({ user_id: p.user_id, users: userMap.get(p.user_id) || {} }));
    }

    const updatedBill = { ...bill, used_count: newUsedCount };
    try {
      const kb = isNowInactive ? undefined : new InlineKeyboard().url("💳 Pay Bill | پرداخت", `https://t.me/${BOT_USERNAME}?start=bill_${billId}`);
      await bot.api.editMessageText(bill.chat_id, bill.message_id, billText(updatedBill, payersWithInfo), { parse_mode: "HTML", reply_markup: kb });
    } catch (e) { console.error("editMessageText error:", e.message); }
  }
}

// ==========================================================================
// 10) Game callback handlers for singleplayer (kept)
// ==========================================================================

bot.callbackQuery(/^game_bet_(\d+)_(\d+)$/, async (ctx) => {
  const gameId = Number(ctx.match[1]);
  const chosenIdx = Number(ctx.match[2]);

  const { data: game } = await supabase.from("games").select("*").eq("id", gameId).maybeSingle();
  if (!game) return ctx.answerCallbackQuery({ text: "بازی پیدا نشد.", show_alert: true });
  if (game.status !== "pending") return ctx.answerCallbackQuery({ text: "این بازی قبلاً انجام شده.", show_alert: true });
  if (Number(game.user_id) !== Number(ctx.from.id)) return ctx.answerCallbackQuery({ text: "فقط کسی که شرط گذاشته می‌تونه انتخاب کنه.", show_alert: true });

  const winIdx = Math.floor(Math.random() * EMOJI_GAMES.length);
  let payout = 0;
  if (winIdx === chosenIdx) {
    payout = Math.floor(game.amount * 2); // 2x payout
    await supabase.rpc("transfer_balance", { p_from: 0, p_to: ctx.from.id, p_amount: payout });
  }

  // add to jackpot
  const jackpotAdd = Math.floor(game.amount * JACKPOT_PERCENT_OF_BET);
  try {
    const { data: jp } = await supabase.from("jackpots").select("amount").eq("chat_id", game.chat_id).maybeSingle();
    if (!jp) {
      await supabase.from("jackpots").insert({ chat_id: game.chat_id, amount: jackpotAdd });
    } else {
      await supabase.from("jackpots").update({ amount: jp.amount + jackpotAdd }).eq("chat_id", game.chat_id);
    }
  } catch (e) { console.error("jackpot add error:", e); }

  // chance to win jackpot
  try {
    if (Math.random() < JACKPOT_WIN_CHANCE) {
      const { data: jp2 } = await supabase.from("jackpots").select("amount").eq("chat_id", game.chat_id).maybeSingle();
      if (jp2 && jp2.amount > 0) {
        const won = jp2.amount;
        await supabase.rpc("transfer_balance", { p_from: 0, p_to: ctx.from.id, p_amount: won });
        await supabase.from("jackpots").update({ amount: 0 }).eq("chat_id", game.chat_id);
        await ctx.reply(`🎰 تبریک! شما جک‌پات ${fmt(won)} دپث را بردید!`);
      }
    }
  } catch(e){ console.error("jackpot win error:", e); }

  await supabase.from("games").update({ result: winIdx, payout, status: "finished" }).eq("id", gameId);

  const emWin = EMOJI_GAMES[winIdx];
  const emChosen = EMOJI_GAMES[chosenIdx];
  if (payout > 0) {
    await ctx.editMessageText(`🎉 بردید! شما ${emChosen} انتخاب کردید. نتیجه: ${emWin}\n🏆 برنده: ${fmt(payout)} دپث`, { parse_mode: "HTML" });
  } else {
    await ctx.editMessageText(`❌ باخت. شما ${emChosen} انتخاب کردید. نتیجه: ${emWin}\n💸 مبلغ شرط از دست رفت.`, { parse_mode: "HTML" });
  }
  return ctx.answerCallbackQuery();
});

bot.callbackQuery(/^mines_click_(\d+)_(\d+)$/, async (ctx) => {
  const gameId = Number(ctx.match[1]);
  const idx = Number(ctx.match[2]);
  const { data: mg } = await supabase.from("mines_games").select("*").eq("id", gameId).maybeSingle();
  if (!mg) return ctx.answerCallbackQuery({ text: "بازی مین پیدا نشد.", show_alert: true });
  if (Number(mg.user_id) !== Number(ctx.from.id)) return ctx.answerCallbackQuery({ text: "فقط سازندهٔ بازی می‌تونه خانه‌ها رو باز کنه.", show_alert: true });
  if (mg.status !== "playing") return ctx.answerCallbackQuery({ text: "این بازی تمام شده.", show_alert: true });

  const cells = JSON.parse(mg.cells);
  const opened = JSON.parse(mg.opened || "[]");

  if (opened.includes(idx)) return ctx.answerCallbackQuery({ text: "این خانه قبلاً باز شده.", show_alert: true });

  if (cells[idx] === 1) {
    // hit mine -> lose
    await supabase.from("mines_games").update({ status: "lost", opened: JSON.stringify([...opened, idx]) }).eq("id", gameId);
    await ctx.editMessageText(`💥 باختید! شما روی مین زدین. شرط ${fmt(mg.amount)} سوخت.`, { parse_mode: "HTML" });
    return ctx.answerCallbackQuery({ text: "مین! باختید.", show_alert: true });
  }

  // safe cell
  opened.push(idx);
  await supabase.from("mines_games").update({ opened: JSON.stringify(opened) }).eq("id", gameId);

  // potential reward calculation (example: multiplier grows)
  const multiplier = 1 + (opened.length * 0.2);
  const potential = Math.floor(mg.amount * multiplier);

  // Show updated prompt; user may issue cashout command to claim
  await ctx.editMessageText(
    `✅ خانه امن باز شد.\nباز شده‌ها: ${opened.length}\nدر صورت برداشت هم اکنون می‌گیرید: ${fmt(potential)}\nبرای ادامه خانه دیگری باز کنید یا /cashout_${gameId} را بزنید.`,
    { parse_mode: "HTML" }
  );
  return ctx.answerCallbackQuery({ text: "خانه باز شد." });
});

// ==========================================================================
// 11) Multiplayer tables operations + callbacks (new additions)
// ==========================================================================

async function getEntries(gameId) {
  const { data } = await supabase.from("game_entries").select("*").eq("game_id", gameId).order("id", { ascending: true });
  return data || [];
}

bot.callbackQuery(/^multiplayer_enter_(\d+)$/, async (ctx) => {
  const gameId = Number(ctx.match[1]);
  const { data: game } = await supabase.from("multiplayer_games").select("*").eq("id", gameId).maybeSingle();
  if (!game) return ctx.answerCallbackQuery({ text: 'بازی یافت نشد.', show_alert: true });
  if (game.status !== 'waiting') return ctx.answerCallbackQuery({ text: 'این بازی دیگر در حالت ورود نیست.', show_alert: true });

  // check if already joined
  const { data: exists } = await supabase.from("game_entries").select("*").eq("game_id", gameId).eq("user_id", ctx.from.id).maybeSingle();
  if (exists) return ctx.answerCallbackQuery({ text: 'شما قبلاً وارد بازی شده‌اید.', show_alert: true });

  // check user balance and deduct bet
  const me = await getUser(ctx.from.id);
  if (!me) return ctx.answerCallbackQuery({ text: 'حساب شما ثبت نیست.', show_alert: true });
  if (me.balance < game.bet) return ctx.answerCallbackQuery({ text: 'موجودی کافی نیست.', show_alert: true });

  const { data: ok } = await supabase.rpc('transfer_balance', { p_from: ctx.from.id, p_to: 0, p_amount: game.bet });
  if (!ok) return ctx.answerCallbackQuery({ text: 'خطا در برداشت مبلغ.', show_alert: true });

  // insert entry and update pot
  const { error: insErr } = await supabase.from('game_entries').insert({ game_id: gameId, user_id: ctx.from.id });
  if (insErr) {
    console.error('insert entry err', insErr);
    return ctx.answerCallbackQuery({ text: 'خطا در ورود به بازی.', show_alert: true });
  }
  await supabase.from('multiplayer_games').update({ pot: Number(game.pot) + Number(game.bet) }).eq('id', gameId);

  // count entries
  const entries = await getEntries(gameId);
  // edit game message to show status
  const kb = new InlineKeyboard().text('▶️ ورود به بازی', `multiplayer_enter_${game.id}`).text('❌ لغو', `multiplayer_cancel_${game.id}`);
  try {
    await ctx.api.editMessageText(game.chat_id, game.message_id,
      `🕹 بازی مولتیپلیر\n• سازنده: <code>${game.creator_id}</code>\n• مبلغ شرط: <b>${fmt(game.bet)}</b>\n• بازیکنان: <b>${entries.length}/${game.max_players}</b>\n• pot: <b>${fmt(Number(game.pot) + Number(game.bet))}</b>\n\nبرای پیوستن روی دکمهٔ "ورود به بازی" بزنید.`,
      { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) { /* ignore edit errors */ }

  // if reached max => start game
  if (entries.length >= game.max_players) {
    await supabase.from('multiplayer_games').update({ status: 'started', current_turn: 0 }).eq('id', gameId);
    const ordered = entries;
    const first = ordered[0];
    await ctx.reply(`✅ بازی آغاز شد! نوبت اولین بازیکن: <code>${first.user_id}</code>\nلطفا ایموجی خود را ارسال کنید (فقط یک ایموجی).`, { parse_mode: 'HTML' });
  }

  return ctx.answerCallbackQuery({ text: 'شما وارد شدید.' });
});

bot.callbackQuery(/^multiplayer_cancel_(\d+)$/, async (ctx) => {
  const gameId = Number(ctx.match[1]);
  const { data: game } = await supabase.from('multiplayer_games').select("*").eq("id", gameId).maybeSingle();
  if (!game) return ctx.answerCallbackQuery({ text: 'بازی یافت نشد.', show_alert: true });
  if (game.creator_id !== ctx.from.id && !(await isAdmin(ctx.from.id))) return ctx.answerCallbackQuery({ text: 'فقط سازنده یا ادمین می‌تواند بازی را لغو کند.', show_alert: true });
  // refund pot to entrants
  const entries = await getEntries(gameId);
  for (const e of entries) {
    try {
      await supabase.rpc('transfer_balance', { p_from: 0, p_to: e.user_id, p_amount: game.bet });
    } catch (err) { console.error('refund err', err); }
  }
  await supabase.from('multiplayer_games').update({ status: 'cancelled' }).eq('id', gameId);
  try { await ctx.api.deleteMessage(game.chat_id, game.message_id); } catch (e) { /* ignore */ }
  await ctx.reply('⛔️ بازی لغو و بازپرداخت انجام شد.');
  return ctx.answerCallbackQuery();
});

// ==========================================================================
// 12) Try-handle incoming multiplayer moves (called at top of message handler)
// ==========================================================================
async function tryHandleMultiplayerPlay(ctx) {
  if (!ctx.chat || !(ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) return false;
  const userId = ctx.from.id;
  // find active started game in this chat where this user is a participant and hasn't played yet
  const { data: games } = await supabase.from('multiplayer_games').select('*').eq('chat_id', ctx.chat.id).eq('status', 'started').order('created_at', { ascending: false }).limit(3);
  if (!games || games.length === 0) return false;
  for (const g of games) {
    const entries = await getEntries(g.id);
    if (!entries || entries.length === 0) continue;
    const idx = entries.findIndex(e => Number(e.user_id) === Number(userId));
    if (idx === -1) continue;
    if (entries[idx].played) continue;
    let nextIdx = g.current_turn || 0;
    while (nextIdx < entries.length && entries[nextIdx].played) nextIdx++;
    if (nextIdx >= entries.length) continue;
    if (idx !== nextIdx) {
      await ctx.reply(`⏳ هنوز نوبت شما نشده. نوبت فعلی: <code>${entries[nextIdx].user_id}</code>`, { parse_mode: 'HTML' });
      return true;
    }
    // It's user's turn
    if (g.type === 'emoji') {
      const token = (ctx.message.text || '').trim().split(/\s+/)[0];
      if (!token) return true;
      const play = token.slice(0, 8); // accept up to 8 chars
      await supabase.from('game_entries').update({ played: true, play_value: play }).eq('game_id', g.id).eq('user_id', userId);
      await supabase.from('multiplayer_games').update({ current_turn: nextIdx + 1 }).eq('id', g.id);
      const updatedEntries = await getEntries(g.id);
      const stillUnplayed = updatedEntries.some(e => !e.played);
      if (stillUnplayed) {
        const next = updatedEntries.find(e => !e.played);
        await ctx.reply(`✅ ثبت شد: ${play}\nنوبت بعدی: <code>${next.user_id}</code>`, { parse_mode: 'HTML' });
      } else {
        await concludeEmojiGame(g.id, ctx);
      }
      return true;
    } else if (g.type === 'dice') {
      if (!ctx.message.dice) {
        await ctx.reply('❗️ برای این بازی باید از قابلیت تاس تلگرام استفاده کنید (ارسال 🎲 یا رول تاس).', { parse_mode: 'HTML' });
        return true;
      }
      const val = ctx.message.dice.value;
      await supabase.from('game_entries').update({ played: true, play_value: String(val) }).eq('game_id', g.id).eq('user_id', userId);
      await supabase.from('multiplayer_games').update({ current_turn: nextIdx + 1 }).eq('id', g.id);
      const updatedEntries = await getEntries(g.id);
      const stillUnplayed = updatedEntries.some(e => !e.played);
      if (stillUnplayed) {
        const next = updatedEntries.find(e => !e.played);
        await ctx.reply(`✅ رول شما: <b>${val}</b>\nنوبت بعدی: <code>${next.user_id}</code>`, { parse_mode: 'HTML' });
      } else {
        await concludeDiceGame(g.id, ctx);
      }
      return true;
    }
  }
  return false;
}

// ==========================================================================
// 13) Conclude functions for multiplayer
// ==========================================================================
async function concludeEmojiGame(gameId, ctx) {
  const { data: game } = await supabase.from('multiplayer_games').select('*').eq('id', gameId).maybeSingle();
  if (!game) return;
  const entries = await getEntries(gameId);
  let best = null;
  let bestVal = -Infinity;
  for (const e of entries) {
    const s = e.play_value || '';
    const code = s.codePointAt(0) || 0;
    if (code > bestVal) { bestVal = code; best = e; }
  }
  if (!best) {
    await supabase.from('multiplayer_games').update({ status: 'finished' }).eq('id', gameId);
    await ctx.reply('بازی تمام شد ولی برنده‌ای یافت نشد.');
    return;
  }
  const { data: ok } = await supabase.rpc('transfer_balance', { p_from: 0, p_to: best.user_id, p_amount: game.pot });
  if (!ok) {
    await ctx.reply('خطا در پرداخت جایزه. لطفا لاگ‌ها را چک کن.');
    return;
  }
  await supabase.from('multiplayer_games').update({ status: 'finished' }).eq('id', gameId);
  await ctx.reply(`🏆 بازی تمام شد! برنده: <code>${best.user_id}</code>\nمقدار جایزه: <b>${fmt(game.pot)}</b>\nگزینهٔ برنده: ${best.play_value}`, { parse_mode: 'HTML' });
}

async function concludeDiceGame(gameId, ctx) {
  const { data: game } = await supabase.from('multiplayer_games').select('*').eq('id', gameId).maybeSingle();
  if (!game) return;
  const entries = await getEntries(gameId);
  const cond = game.condition || null; // {mode:'less'|'greater'|'even'|'odd'|'exact', value: int|null}
  let winner = null;
  if (!cond) {
    let bestVal = -Infinity;
    for (const e of entries) {
      const v = parseInt(e.play_value, 10) || 0;
      if (v > bestVal) { bestVal = v; winner = e; }
    }
  } else {
    const satisfiers = [];
    for (const e of entries) {
      const v = parseInt(e.play_value, 10) || 0;
      let ok = false;
      if (cond.mode === 'even') ok = (v % 2 === 0);
      else if (cond.mode === 'odd') ok = (v % 2 === 1);
      else if (cond.mode === 'less') ok = (v < (cond.value || 0));
      else if (cond.mode === 'greater') ok = (v > (cond.value || 0));
      else if (cond.mode === 'exact') ok = (v === (cond.value || 0));
      if (ok) satisfiers.push({ entry: e, v });
    }
    if (satisfiers.length > 0) {
      satisfiers.sort((a,b)=>b.v - a.v);
      winner = satisfiers[0].entry;
    } else {
      let bestVal=-Infinity;
      for (const e of entries) {
        const v = parseInt(e.play_value, 10)||0;
        if (v>bestVal){ bestVal=v; winner=e; }
      }
    }
  }

  if (!winner) {
    await supabase.from('multiplayer_games').update({ status: 'finished' }).eq('id', gameId);
    await ctx.reply('بازی تمام شد ولی برنده‌ای یافت نشد.');
    return;
  }
  const { data: ok } = await supabase.rpc('transfer_balance', { p_from: 0, p_to: winner.user_id, p_amount: game.pot });
  if (!ok) {
    await ctx.reply('خطا در پرداخت جایزه. لطفا لاگ‌ها را چک کن.');
    return;
  }
  await supabase.from('multiplayer_games').update({ status: 'finished' }).eq('id', gameId);
  await ctx.reply(`🏆 بازی تاس تمام شد! برنده: <code>${winner.user_id}</code>\nمقدار جایزه: <b>${fmt(game.pot)}</b>\nنتیجهٔ برنده: ${winner.play_value}`, { parse_mode: 'HTML' });
}

// ==========================================================================
// 14) Cashout for mines (kept)
// ==========================================================================
bot.on("message:text", async (ctx) => {
  // This second handler is safe because grammy composes handlers; but to avoid duplication we only handle explicit /cashout_ commands
  const text = ctx.message.text.trim();
  const RE_CASHOUT = /^\/cashout_(\d+)$/i;
  const mCashout = text.match(RE_CASHOUT);
  if (mCashout) {
    const gameId = Number(mCashout[1]);
    const { data: mg } = await supabase.from("mines_games").select("*").eq("id", gameId).maybeSingle();
    if (!mg) return ctx.reply("بازی پیدا نشد.");
    if (Number(mg.user_id) !== Number(ctx.from.id)) return ctx.reply("فقط سازنده می‌تونه برداشت کنه.");
    if (mg.status !== "playing") return ctx.reply("این بازی دیگر فعال نیست.");

    const opened = JSON.parse(mg.opened || "[]");
    const multiplier = 1 + (opened.length * 0.2);
    const payout = Math.floor(mg.amount * multiplier);
    const { data: ok } = await supabase.rpc("transfer_balance", { p_from: 0, p_to: ctx.from.id, p_amount: payout });
    if (!ok) return ctx.reply("خطا در پرداخت. لطفا بعداً تلاش کنید.");

    await supabase.from("mines_games").update({ status: "cashed_out" }).eq("id", gameId);
    await ctx.reply(`🏁 برداشت موفق: شما ${fmt(payout)} دپث گرفتید.`);
    return;
  }
});

// ==========================================================================
// 15) Remaining callbacks & webhook handler
// ==========================================================================

// kept previous callbacks (tr_confirm_, tr_cancel_, giveaway handlers, etc.) already declared above

// Webhook callback for Vercel
const handleUpdate = webhookCallback(bot, "next-js");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.status(200).json({ status: "ok", bot: "Depth TON Bot", message: "Webhook is alive." });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  try {
    await handleUpdate(req, res);
  } catch (err) {
    console.error("Webhook error:", err);
    if (!res.headersSent) res.status(200).json({ ok: true });
  }
};

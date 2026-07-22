// ==========================================================================
// Depth TON Bot — index.js (Final Stable Version for Vercel) — MERGED
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
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  return str.replace(/[۰-۹]/g, (d) => persian.indexOf(d))
            .replace(/[٠-٩]/g, (d) => arabic.indexOf(d));
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
    if (!multiplier) return null;    value *= multiplier;
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
    if (existing.username !== user.username || existing.first_name !== user.first_name) {
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
function fmt(n) { return Number(n).toLocaleString("en-US"); }

// ==========================================================================
// 2.1) تشخیص پیام فوروارد شده + یافتن آیدی
// ==========================================================================

function getForwardedUserId(message) {
  if (!message) return null;
  if (message.forward_origin && message.forward_origin.type === "user" && message.forward_origin.sender_user) {
    return message.forward_origin.sender_user.id;  }
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
// ADDITIONS: feature flags, games config (paste after const bot = new Bot(BOT_TOKEN);)
// ==========================================================================

const RANDOM_GIVEAWAY_AMOUNT = 100000; // 100k
const RANDOM_GIVEAWAY_PROBABILITY = 0.002; // 0.2% per message in group (adjust if needed)
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
// 3) میان‌افزار: ثبت خودکار کاربر
// ==========================================================================
bot.use(async (ctx, next) => {
  if (ctx.from) await ensureUser(ctx.from);
  await next();
});

// ثبت گروه‌های فعال (برای جایزه‌ی روزانه‌ی خودکار) + شمارش همه‌ی پیام‌ها (نه فقط متنی) برای آمار
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
          // created_by = 0 (system)
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
    await payBill(ctx, payload.replace("bill_", ""));    return;
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
    `🆔 ID: <code>${targetId}</code>\n` +    (user.username ? `👤 Username: @${user.username}\n` : "") +
    `💰 Balance | موجودی: <b>${fmt(user.balance)}</b>`,
    { parse_mode: "HTML" }
  );
}

// ==========================================================================
// 5.1) دستور /help
// ==========================================================================
// Replace existing /help handler with this chunked version
bot.command("help", async (ctx) => {
  try {
    const adminStatus = await isAdmin(ctx.from.id).catch(() => false);
    const ownerStatus = await isOwner(ctx.from.id).catch(() => false);

    const sections = [];

    sections.push(
`📖 <b>Depth TON Bot — راهنما و مثال‌ها</b>`
    );

    sections.push(
`<b>👛 والِت (Wallet)</b>
• /wallet یا /ولت → نمایش موجودی شما
  مثال: <code>/wallet</code>
• نمایش موجودیِ دیگران با ریپلای یا آیدی/یوزرنیم:
  مثال ریپلای: ریپلای روی پیام کاربر + <code>/wallet</code>
  مثال با آیدی/یوزرنیم: <code>/wallet 123456789</code> یا <code>/wallet @username</code>`
    );

    sections.push(
`<b>🔁 انتقال (Transfer)</b>
• ریپلای روی پیام کاربر و نوشتن مبلغ:
  مثال: ریپلای روی پیام کاربر + پیام: <code>10k</code>  (یا <code>انتقال 10k</code>)
• ارسال مستقیم با یوزرنیم/آیدی:
  مثال: <code>انتقال 5k به @username</code>
  یا: <code>transfer 5000 to 123456789</code>
• تایید انتقال توسط دکمهٔ شیشه‌ای: فرستنده باید دکمهٔ «تایید» را بزند تا انتقال انجام شود.`
    );

    sections.push(
`<b>🧾 قبض (Bill)</b>
• ایجاد قبض با محدودیت دفعات:
  مثال: <code>create bill 10k for 5 uses</code>
  (یا به فارسی: <code>ساخت قبض 10k 5 بار مصرف</code>)
• ایجاد قبض بدون محدودیت:
  مثال: <code>make bill 10k unlimited</code>
• پرداخت قبض:
  - وقتی قبض ساخته شود لینک پرداخت ظاهر می‌شود؛ روی آن کلیک کنید یا /start=bill_<id> را باز کنید.`
    );

    sections.push(
`<b>📊 آمار روزانه (Stats)</b>
• نمایش لیدربورد پیام‌های آن روز در گروه:
  مثال: <code>آمار</code> یا <code>stats</code>
• نفر اول (اولین بار در روز) به‌صورت خودکار جایزه می‌گیرد (پیش‌فرض: <b>500,000 دپث</b>).`
    );

    sections.push(
`<b>🎁 جایزهٔ شانسی / Giveaway</b>
• جایزهٔ رندوم توسط سیستم در گروه‌ها ارسال می‌شود (در هر پیام احتمال کمی دارد).
• ادمین می‌تواند جایزهٔ دستی بسازد:
  مثال: <code>ساخت جایزه 100k</code>
• اولین نفری که دکمه را بزند جایزه را می‌گیرد و پیام حذف می‌شود.`
    );

    sections.push(
`<b>🕹 بازی‌ها (Games)</b>
• بازی با ایموجی‌ها (انتخاب یک ایموجی):
  مثال: <code>/play فوتبال 10k</code> یا <code>/play ایموجی 5k</code>
  - دکمه‌های شیشه‌ای با ایموجی نمایش داده می‌شود؛ روی ایموجیِ انتخابی کلیک کنید.
• مین (Mines) — بازی با گرید دکمه‌ای:
  مثال: <code>/play مین 5000</code> یا <code>بازی مین 5000</code>
  - پس از قرار دادن شرط، گرید نشان داده می‌شود؛ خانه‌ها را باز کنید، در هر باخت شرط می‌سوزد.
  - برای برداشت: <code>/cashout_<gameId></code> (شناسهٔ بازی در پیام ربات نمایش داده می‌شود).`
    );

    sections.push(
`<b>🛡 دستورات ادمین</b>
(فقط ادمین‌ها می‌توانند اجرا کنند)
• شارژ کاربر:
  مثال: <code>شارژ 10k @username</code> یا ریپلای + <code>add 10k</code>
• کسر از کاربر:
  مثال: <code>کسر 5k @username</code> یا ریپلای + <code>deduct 5k</code>
• ساخت جایزه دستی:
  مثال: <code>ساخت جایزه 100k</code>
• فعال/غیرفعال کردن قابلیت‌ها:
  مثال فعال: <code>فعال کن giveaways</code>
  مثال غیرفعال: <code>غیرفعال کن games</code>`
    );

    if (ownerStatus) {
      sections.push(
`<b>👑 دستورات مالک (Owner)</b>
• ساخت کد ادمین برای کاربر:
  مثال (مالک اجرا می‌کند): <code>/makecode</code> (سپس کد ۱۰ رقمی تولید می‌شود)
• افزودن ادمین مستقیم:
  مثال: <code>/addadmin &lt;id|@username&gt;</code>
• حذف ادمین:
  مثال: <code>/deladmin &lt;id|@username&gt;</code>`
      );
    }

    sections.push(
`<b>🔎 روش‌های شناسایی هدف</b>
• برای آدرس‌دهی به کاربر می‌توانید:
  - ریپلای روی پیام کاربر
  - فوروارد پیامِ کاربر به پیوی ربات (برای گرفتن ID)
  - استفاده از آیدی عددی یا یوزرنیم: <code>@username</code> یا <code>123456789</code>`
    );

    sections.push(
`<b>⚠️ نکات مهم</b>
• تمام واحدها در «دپث» هستند و این والت کاملاً مجازی است — هیچ ارزش واقعی ندارد.
• برای حذف یا ویرایش پیام‌هایی که ربات ایجاد کرده، ربات باید در گروه ادمین با مجوز حذف پیام باشد.
• اگر پیام کار نمی‌کند: احتمال دارد متن خیلی طولانی باشد — این تابع متن را به بخش‌های کوچک تقسیم می‌کند.`
    );

    // send sections in chunks (combine adjacent sections until safe limit)
    const CHUNK_LIMIT = 3500; // safe margin under Telegram's ~4096
    let current = "";
    for (const sec of sections) {
      if ((current + "\n\n" + sec).length > CHUNK_LIMIT) {
        // send current
        if (current.trim()) await ctx.reply(current, { parse_mode: "HTML" }).catch(e => console.error("help send error:", e));
        current = sec;
      } else {
        current = current ? (current + "\n\n" + sec) : sec;
      }
    }
    if (current.trim()) await ctx.reply(current, { parse_mode: "HTML" }).catch(e => console.error("help send error:", e));
  } catch (err) {
    console.error("help handler error:", err);
    // fallback: short help
    await ctx.reply("📖 Help error — لطفا بعدا تلاش کنید یا لاگ‌ها را بررسی کنید.");
  }
});
// ==========================================================================
// 6) مدیریت ادمین‌ها
// ==========================================================================
bot.command("makecode", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔️ Only the bot owner can create admin codes.");
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ Reply to a user or provide an ID/Username.", { parse_mode: "HTML" });

  const code = Math.floor(1000000000 + Math.random() * 9000000000).toString();
  await supabase.from("admin_codes").delete().eq("user_id", targetId);
  const { error } = await supabase.from("admin_codes").insert({ code, user_id: targetId });  if (error) return ctx.reply("❌ Error creating code.");

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
// 6.1) آمار پیام‌های روزانه + جایزه‌ی نفر اول
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
// 6.2) جایزه‌ی شانسی (رندوم یا ساخته‌شده توسط ادمین)
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

  // آپدیت شرطی: فقط اگه هنوز claim نشده باشه (جلوگیری از برداشت هم‌زمان دو نفر)
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
// 7) هندلر اصلی متن‌ها
// ==========================================================================

const KW = {
  transfer: ["انتقال", "transfer", "send"],
  to: ["به", "to"],  createBill: ["ساخت\\s*قبض", "create\\s*bill", "make\\s*bill"],
  uses: ["بار\\s*مصرف", "uses", "times"],
  unlimited: ["بدون\\s*محدودیت", "unlimited", "no\\s*limit"],
  charge: ["شارژ", "add\\s*ton", "charge", "topup", "افزایش"],
  deduct: ["کسر", "ولس", "کم", "deduct", "sub", "remove", "minus"], 
  from: ["از", "from"],
  wallet: ["ولت", "کیف\\s*پول", "wallet", "balance"],
};

function kw(key) { return KW[key].join("|"); }
const ID_TOKEN = `\\d+|@[A-Za-z0-9_]{3,32}`;

// نکته: کلمه‌ی «به»/«to» رو داخل یه گروه واحد همراه فاصله‌ی بعدش گذاشتم تا وقتی حذف می‌شه
// (چون اختیاریه)، به یه فاصله‌ی اضافه‌ی غیرممکن نیاز نداشته باشه - قبلاً همین باعث می‌شد
// حالت بدون «به» اصلاً match نشه.
const RE_TRANSFER_TO_ID = new RegExp(`^(?:${kw("transfer")})\\s+(${AMOUNT_TOKEN})\\s+(?:(?:${kw("to")})\\s+)?(${ID_TOKEN})$`, "i");
const RE_TRANSFER_REPLY = new RegExp(`^(?:${kw("transfer")})?\\s*(${AMOUNT_TOKEN})$`, "i");
const RE_CREATE_BILL = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:دپث\\s+)?([\\d۰-۹]+)\\s*(?:${kw("uses")})$`, "i");
const RE_CREATE_BILL_UNLIMITED = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("unlimited")})$`, "i");
const RE_ADMIN_ADD = new RegExp(`^(?:${kw("charge")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("to")}|for)\\s+(${ID_TOKEN}))?$`, "i");
const RE_ADMIN_SUB = new RegExp(`^(?:${kw("deduct")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("from")})\\s+(${ID_TOKEN}))?$`, "i");
const RE_WALLET_KEYWORD = new RegExp(`^(?:${kw("wallet")})$`, "i");

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  await ensureUser(ctx.from);

  // ---- ۷.۰ بررسی ورود رمز ۱۰ رقمی ادمینی ----
  if (/^\d{10}$/.test(text)) {
    const { data: record } = await supabase.from("admin_codes").select("*").eq("code", text).maybeSingle();
    if (record) {
      if (record.user_id !== ctx.from.id) return ctx.reply("⛔️ This code was not issued for your Telegram ID!");
      await supabase.from("admins").upsert({ user_id: ctx.from.id, added_by: OWNER_ID });
      await supabase.from("admin_codes").delete().eq("code", text);
      return ctx.reply("🎉 <b>Success!</b> You have been promoted to bot admin.", { parse_mode: "HTML" });
    }
  }

  // ---------- Feature toggle handler (فعال/غیرفعال) ----------
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

  // ---------- Play command (emoji games + mines) ----------
  const RE_PLAY = /^(?:\/play|بازی)\s+([^\s]+)\s+(.+)$/i;
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

    // emoji game flow
    const { data: created } = await supabase.from("games").insert({
      chat_id: ctx.chat.id, user_id: ctx.from.id, game: gameName, amount, chosen: -1, status: "pending"
    }).select().single();

    const kb = new InlineKeyboard();
    EMOJI_GAMES.forEach((em, idx) => kb.text(em, `game_bet_${created.id}_${idx}`));
    await ctx.reply(`🎲 بازی: ${gameName}\nلطفا روی ایموجی مورد نظرتون کلیک کنید. (مبلغ: ${fmt(amount)})`, { reply_markup: kb });
    return;
  }

  // ---- ۷.۰.۰ آمار روزانه ----
  if (RE_STATS_KEYWORD.test(text) && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    await handleStats(ctx);
    return;
  }

  // ---- ۷.۰.۲ ساخت جایزه توسط ادمین: "ساخت جایزه 100k" ----
  const mPrize = text.match(RE_CREATE_PRIZE);
  if (mPrize) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن جایزه بسازن.");
    const amount = parseAmount(mPrize[1]);
    if (!amount) return ctx.reply("❗️ مبلغ جایزه نامعتبر است.");
    await createGiveaway(ctx.api, ctx.chat.id, amount, ctx.from.id);
    return;
  }

  // ---- ۷.۰.۱ نمایش ولت با ریپلای یا کلمه کلیدی ----
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
        await ensureUser(replyUser);      }
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

  // ---- ۷.۱ انتقال با ریپلای: هم عدد خالی (10k) هم با کلمه (انتقال 10k / transfer 10k) ----
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

      // نکته‌ی مهم: getUser ردیف جدول users رو برمی‌گردونه که فیلدش user_id هست، نه id.
      // handleTransferRequest انتظار فیلد id داره، پس اینجا صریحاً می‌سازیمش تا اون باگ قبلی پیش نیاد.
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

  // ---- ۷.۲ انتقال با آیدی یا یوزرنیم ----
  const mTransfer = text.match(RE_TRANSFER_TO_ID);
  if (mTransfer) {
    const amount = parseAmount(mTransfer[1]);
    const toId = await resolveIdentifierToken(mTransfer[2]);
    if (!amount) return ctx.reply("❗️ Invalid amount.");
    if (!toId) return ctx.reply("❗️ Invalid target user.");
    if (toId === ctx.from.id) return ctx.reply("❗️ You cannot transfer to yourself.");
    
    await ensureUser({ id: toId });
    const toUser = await getUser(toId);    if (!toUser) return ctx.reply("❗️ Target user is not registered.");
    
    await handleTransferRequest(ctx, { id: toId, username: toUser.username, first_name: toUser.first_name }, amount);
    return;
  }

  // ---- ۷.۳ ساخت قبض محدود ----
  const mBill = text.match(RE_CREATE_BILL);
  if (mBill) {
    const amount = parseAmount(mBill[1]);
    const maxUses = parseInt(normalizeDigits(mBill[2]), 10);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    if (!maxUses || maxUses <= 0) return ctx.reply("❗️ Invalid number of uses.");
    await createBill(ctx, amount, maxUses);
    return;
  }

  // ---- ۷.۳.۱ ساخت قبض بدون محدودیت ----
  const mBillUnlimited = text.match(RE_CREATE_BILL_UNLIMITED);
  if (mBillUnlimited) {
    const amount = parseAmount(mBillUnlimited[1]);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    await createBill(ctx, amount, null);
    return;
  }

  // ---- ۷.۴ شارژ توسط ادمین ----
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

  // ---- ۷.۵ کسر توسط ادمین (اصلاح شده با RPC) ----
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
    
    // استفاده از تابع RPC برای کسر مطمئن
    // ما پول را به آیدی 0 (سیستم) انتقال می‌دهیم تا از چرخه خارج شود
    const { data: ok } = await supabase.rpc("transfer_balance", { 
      p_from: targetId, 
      p_to: 0, // آیدی سیستم برای کسر
      p_amount: amount 
    });

    if (!ok) {
      return ctx.reply("❌ Error processing deduction. Database transaction failed.");
    }

    await ctx.reply(`✅ Deducted <b>${fmt(amount)}</b> from <code>${targetId}</code>.`, { parse_mode: "HTML" });
    return;
  }

  // ---- ۷.۶ تشخیص پیام فوروارد شده در پیوی توسط ادمین ----
  if (ctx.chat.type === "private" && (await isAdmin(ctx.from.id))) {    const fwdId = getForwardedUserId(ctx.message);
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

  // ---- Cashout (mina) command handler e.g. /cashout_123 ----
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
    // transfer payout from system (0) to user
    const { data: ok } = await supabase.rpc("transfer_balance", { p_from: 0, p_to: ctx.from.id, p_amount: payout });
    if (!ok) return ctx.reply("خطا در پرداخت. لطفا بعداً تلاش کنید.");

    await supabase.from("mines_games").update({ status: "cashed_out" }).eq("id", gameId);
    await ctx.reply(`🏁 برداشت موفق: شما ${fmt(payout)} دپث گرفتید.`);
    return;
  }

});

// ==========================================================================
// 8) انتقال با تایید دکمه شیشه‌ای
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
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle();  if (!pending || pending.status !== "pending") return ctx.answerCallbackQuery({ text: "Request expired.", show_alert: true });
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
// 9) سیستم قبض (Bill)
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
        const label = info.username ? `@${info.username}` : (info.first_name || "User | کاربر");        return `• ${label}`;
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
      await bot.api.editMessageText(bill.chat_id, bill.message_id, billText(updatedBill, payersWithInfo), { parse_mode: "HTML", reply_markup: kb });    } catch (e) { console.error("editMessageText error:", e.message); }
  }
}

// ==========================================================================
// 10) Game callback handlers (emoji games + mines) — add after existing callbacks
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
    payout = Math.floor(game.amount * 2); // 2x payout (you can change)
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
// 11) خروجی سازگار با Vercel Serverless Function
// ==========================================================================
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

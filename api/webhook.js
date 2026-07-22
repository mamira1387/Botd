// ==========================================================================
// Depth TON Bot — index.js (Final Stable Version for Vercel)
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
// 3) میان‌افزار: ثبت خودکار کاربر
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
    `🆔 ID: <code>${targetId}</code>\n` +
    (user.username ? `👤 Username: @${user.username}\n` : "") +
    `💰 Balance | موجودی: <b>${fmt(user.balance)}</b>`,
    { parse_mode: "HTML" }
  );
}

// ==========================================================================
// 5.1) دستور /help
// ==========================================================================
bot.command("help", async (ctx) => {
  const adminStatus = await isAdmin(ctx.from.id);
  const ownerStatus = await isOwner(ctx.from.id);

  let text =
    `📖 <b>Depth TON Bot Guide | راهنما</b>\n\n` +
    `<b>👛 Wallet | ولت</b>\n` +
    `• /wallet or /ولت → Shows YOUR wallet\n` +
    `• Reply to user + /wallet → Shows THEIR wallet\n\n` +
    `<b>🔁 Transfer | انتقال</b>\n` +
    `• Reply to user + <code>10k</code> or <code>transfer 10k</code>\n` +
    `• <code>transfer 10k to @username</code>\n\n` +
    `<b>🧾 Bill | قبض</b>\n` +
    `• <code>create bill 10k for 5 uses</code>\n` +
    `• <code>make bill 10k unlimited</code>\n\n` +
    `<b>📊 Stats | آمار</b>\n` +
    `• <code>آمار</code> or <code>stats</code> → Today's message leaderboard for this group\n\n` +
    `<b>🎁 Daily Giveaway | جایزه‌ی روزانه</b>\n` +
    `• هر روز خودکار یه پیام جایزه توی گروه گذاشته می‌شه؛ اولین کلیک می‌بره\n\n` +
    `<b>🎮 Games | بازی‌ها</b>\n` +
    `• <code>بازی</code> or <code>game</code> → منوی بازی‌های شانسی\n` +
    `• <code>مین</code> or <code>mine</code> → بازی مین‌روب\n\n` +
    `<i>Supported amount suffixes: k, m, b, هزار, میلیون, میلیارد</i>`;

  if (adminStatus) {
    text += `\n\n<b>🛡 Admin Commands | دستورات ادمین</b>\n` +
      `• <code>add 10k</code> or <code>شارژ 10k</code> → Adds to a wallet\n` +
      `• <code>deduct 10k</code> or <code>کسر 10k</code> → Deducts from a wallet\n` +
      `• <code>ساخت جایزه 100k</code> → Creates a one-time claim prize\n` +
      `• <code>بازی روشن</code> / <code>بازی خاموش</code> → فعال/غیرفعال کردن بازی‌ها`;
  }
  if (ownerStatus) {
    text += `\n\n<b>👑 Owner Commands | دستورات مالک</b>\n` +
      `• <code>/makecode</code>, <code>/addadmin</code>, <code>/deladmin</code>`;
  }

  await ctx.reply(text, { parse_mode: "HTML" });
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
  const { error } = await supabase.from("admin_codes").insert({ code, user_id: targetId });
  if (error) return ctx.reply("❌ Error creating code.");

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
    if (forwardedId) { await ensureUser({ id: forwardedId }); return forwardedId; }
    const replyUser = getReplyFromUser(reply);
    if (replyUser) { await ensureUser(replyUser); return replyUser.id; }
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
// 6.2) جایزه‌ی شانسی
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
  if (error) { console.error("createGiveaway error:", error); return; }

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

  try { await ctx.api.deleteMessage(giveaway.chat_id, giveaway.message_id); } catch (e) {}
  await ctx.answerCallbackQuery({ text: `🎉 تبریک! ${fmt(giveaway.amount)} دپث تون گرفتی!`, show_alert: true });
});

// ==========================================================================
// 6.3) سیستم بازی‌ها — فعال/غیرفعال توسط ادمین
// ==========================================================================

const RE_GAMES_ON  = /^(?:بازی|game)\s+(?:روشن|on)$/i;
const RE_GAMES_OFF = /^(?:بازی|game)\s+(?:خاموش|off)$/i;

async function isGamesEnabled(chatId) {
  const { data } = await supabase.from("chat_settings").select("games_enabled").eq("chat_id", chatId).maybeSingle();
  if (!data) return true; // پیش‌فرض: روشن
  return data.games_enabled !== false;
}

async function setGamesEnabled(chatId, enabled) {
  await supabase.from("chat_settings").upsert({ chat_id: chatId, games_enabled: enabled });
}

// ==========================================================================
// 6.4) بازی‌های شانسی با ایموجی
// ==========================================================================

const EMOJI_GAMES = [
  { key: "football",    emoji: "⚽",  label: "فوتبال",   multiplier: 2,   winValues: [5] },
  { key: "basketball",  emoji: "🏀",  label: "بسکتبال",  multiplier: 3,   winValues: [4] },
  { key: "dart",        emoji: "🎯",  label: "دارت",     multiplier: 5,   winValues: [6] },
  { key: "dice",        emoji: "🎲",  label: "تاس",      multiplier: 6,   winValues: [6] },
  { key: "bowling",     emoji: "🎳",  label: "بولینگ",   multiplier: 2.5, winValues: [6] },
];

const RE_GAME_KEYWORD = /^(?:بازی|game)$/i;

async function sendGameMenu(ctx) {
  if (!(await isGamesEnabled(ctx.chat.id))) {
    return ctx.reply("🚫 بازی‌ها در این گروه غیرفعال هستند.");
  }
  const kb = new InlineKeyboard();
  EMOJI_GAMES.forEach((g, i) => {
    kb.text(`${g.emoji} ${g.label}`, `game_select_${g.key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("💣 مین‌روب", "minesweeper_start");
  await ctx.reply(
    `🎮 <b>منوی بازی‌ها</b>\n\nیه بازی انتخاب کن و مبلغ شرط رو بنویس.\n<i>⚠️ پول مجازیه و ارزش واقعی نداره</i>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

// انتخاب بازی → درخواست مبلغ
bot.callbackQuery(/^game_select_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const game = EMOJI_GAMES.find(g => g.key === key);
  if (!game) return ctx.answerCallbackQuery();

  const user = await getUser(ctx.from.id);
  await ctx.editMessageText(
    `${game.emoji} <b>${game.label}</b>\n\n` +
    `💰 موجودی شما: <b>${fmt(user?.balance ?? 0)}</b>\n` +
    `✖️ ضریب برد: <b>${game.multiplier}x</b>\n\n` +
    `مبلغ شرط رو بنویس (مثلاً <code>10k</code>):`,
    { parse_mode: "HTML" }
  );
  // ذخیره state در دیتابیس
  await supabase.from("game_sessions").upsert({
    user_id: ctx.from.id,
    chat_id: ctx.chat.id,
    game_key: key,
    step: "awaiting_bet",
    created_at: new Date().toISOString(),
  });
  await ctx.answerCallbackQuery();
});

// پردازش شرط‌بندی بازی ایموجی
async function handleEmojiGameBet(ctx, session, amount) {
  const game = EMOJI_GAMES.find(g => g.key === session.game_key);
  if (!game) return;

  const user = await getUser(ctx.from.id);
  if (!user || user.balance < amount) {
    await supabase.from("game_sessions").delete().eq("user_id", ctx.from.id);
    return ctx.reply("❗️ موجودی کافی نیست.");
  }

  // کسر مبلغ
  await supabase.from("users").update({ balance: user.balance - amount }).eq("user_id", ctx.from.id);
  await supabase.from("game_sessions").delete().eq("user_id", ctx.from.id);

  // ارسال ایموجی بازی
  const emojiMap = {
    football: "⚽", basketball: "🏀", dart: "🎯", dice: "🎲", bowling: "🎳"
  };
  const diceEmoji = emojiMap[game.key];
  const diceMsg = await ctx.replyWithDice(diceEmoji);
  const value = diceMsg.dice.value;

  const won = game.winValues.includes(value);
  const prize = won ? Math.round(amount * game.multiplier) : 0;

  if (won) {
    const { data: cur } = await supabase.from("users").select("balance").eq("user_id", ctx.from.id).single();
    await supabase.from("users").update({ balance: cur.balance + prize }).eq("user_id", ctx.from.id);
  }

  // تأخیر کوتاه برای نمایش انیمیشن
  await new Promise(r => setTimeout(r, 3500));

  await ctx.reply(
    won
      ? `🎉 <b>بردی!</b>\n${game.emoji} عدد ${value} — برنده!\n💰 +${fmt(prize)} دپث تون`
      : `😔 <b>باختی!</b>\n${game.emoji} عدد ${value} — شانس نداشتی!\n💸 -${fmt(amount)} دپث تون`,
    { parse_mode: "HTML" }
  );
}

// ==========================================================================
// 6.5) بازی مین‌روب
// ==========================================================================

const MINE_ROWS = 4;
const MINE_COLS = 4;
const MINE_COUNT = 3;
const MINE_MULTIPLIER_PER_SAFE = 0.2; // هر خانه‌ی امن +20% به ضریب اضافه می‌کنه

```javascript
function generateMineBoard() {
  const cells = Array(MINE_ROWS * MINE_COLS).fill(false);
  let placed = 0;
  while (placed < MINE_COUNT) {
    const idx = Math.floor(Math.random() * cells.length);
    if (!cells[idx]) { cells[idx] = true; placed++; }
  }
  return cells; // true = mine
}

function buildMineKeyboard(gameId, revealed, mines, exploded) {
  const kb = new InlineKeyboard();
  for (let r = 0; r < MINE_ROWS; r++) {
    for (let c = 0; c < MINE_COLS; c++) {
      const idx = r * MINE_COLS + c;
      let label;
      if (revealed[idx]) {
        label = mines[idx] ? "💥" : "✅";
      } else if (exploded) {
        label = mines[idx] ? "💣" : "⬜";
      } else {
        label = "⬜";
      }
      const cb = revealed[idx] || exploded ? `mine_noop` : `mine_tap_${gameId}_${idx}`;
      kb.text(label, cb);
    }
    kb.row();
  }
  if (!exploded) {
    kb.text("💰 برداشت سود", `mine_cashout_${gameId}`);
  }
  return kb;
}

function mineStatusText(bet, safeCount, exploded, won, prize) {
  const multiplier = (1 + safeCount * MINE_MULTIPLIER_PER_SAFE).toFixed(2);
  if (exploded) return `💥 <b>مین خوردی!</b>\n💸 باختی: <b>${fmt(bet)}</b>`;
  if (won) return `💰 <b>برداشت کردی!</b>\n🏆 سود: <b>${fmt(prize)}</b> (${multiplier}x)`;
  return (
    `💣 <b>مین‌روب</b>\n\n` +
    `💰 شرط: <b>${fmt(bet)}</b>\n` +
    `✅ خانه‌های امن: <b>${safeCount}</b>\n` +
    `📈 ضریب فعلی: <b>${multiplier}x</b>\n` +
    `💵 سود فعلی: <b>${fmt(Math.round(bet * multiplier))}</b>\n\n` +
    `یه خانه بزن یا سودت رو برداشت کن!`
  );
}

// شروع مین‌روب از منو
bot.callbackQuery("minesweeper_start", async (ctx) => {
  if (!(await isGamesEnabled(ctx.chat.id))) {
    return ctx.answerCallbackQuery({ text: "بازی‌ها غیرفعالند.", show_alert: true });
  }
  const user = await getUser(ctx.from.id);
  await ctx.editMessageText(
    `💣 <b>مین‌روب</b>\n\n` +
    `💰 موجودی: <b>${fmt(user?.balance ?? 0)}</b>\n` +
    `🔢 تعداد مین: <b>${MINE_COUNT}</b> از <b>${MINE_ROWS * MINE_COLS}</b>\n\n` +
    `مبلغ شرط رو بنویس (مثلاً <code>10k</code>):`,
    { parse_mode: "HTML" }
  );
  await supabase.from("game_sessions").upsert({
    user_id: ctx.from.id,
    chat_id: ctx.chat.id,
    game_key: "minesweeper",
    step: "awaiting_bet",
    created_at: new Date().toISOString(),
  });
  await ctx.answerCallbackQuery();
});

// کلیک روی خانه
bot.callbackQuery(/^mine_tap_([^_]+)_(\d+)$/, async (ctx) => {
  const gameId = ctx.match[1];
  const idx = parseInt(ctx.match[2]);

  const { data: session } = await supabase
    .from("mine_games")
    .select("*")
    .eq("id", gameId)
    .eq("user_id", ctx.from.id)
    .maybeSingle();

  if (!session || se
esion?.is_ended) return ctx.answerCallbackQuery();

  const board = session.board;
  const revealed = session.revealed;

  if (board[idx]) {
    // بوم! انفجار
    revealed[idx] = true;
    await supabase.from("mine_games").update({ is_ended: true, exploded: true, revealed }).eq("id", gameId);
    await ctx.editMessageText(
      mineStatusText(session.bet_amount, 0, true, false, 0),
      { parse_mode: "HTML", reply_markup: buildMineKeyboard(gameId, revealed, board, true) }
    );
  } else {
    // امن
    revealed[idx] = true;
    const safeCount = revealed.filter((v, i) => v && !board[i]).length;

    // بررسی آیا همه‌ی خانه‌های غیرمین کشف شده‌اند
    const maxSafe = (MINE_ROWS * MINE_COLS) - MINE_COUNT;
    if (safeCount >= maxSafe) {
      const multiplier = 1 + safeCount * MINE_MULTIPLIER_PER_SAFE;
      const prize = Math.round(session.bet_amount * multiplier);
      await supabase.from("mine_games").update({ is_ended: true, won: true, prize_amount: prize, revealed }).eq("id", gameId);

      const { data: cur } = await supabase.from("users").select("balance").eq("user_id", ctx.from.id).single();
      await supabase.from("users").update({ balance: cur.balance + prize }).eq("user_id", ctx.from.id);

      await ctx.editMessageText(
        mineStatusText(session.bet_amount, safeCount, false, true, prize),
        { parse_mode: "HTML", reply_markup: buildMineKeyboard(gameId, revealed, board, true) }
      );
    } else {
      await supabase.from("mine_games").update({ revealed }).eq("id", gameId);
      await ctx.editMessageText(
        mineStatusText(session.bet_amount, safeCount, false, false, 0),
        { parse_mode: "HTML", reply_markup: buildMineKeyboard(gameId, revealed, board, false) }
      );
    }
  }
  await ctx.answerCallbackQuery();
});

// برداشت سود
bot.callbackQuery(/^mine_cashout_(.+)$/, async (ctx) => {
  const gameId = ctx.match[1];
  const { data: session } = await supabase
    .from("mine_games")
    .select("*")
    .eq("id", gameId)
    .eq("user_id", ctx.from.id)
    .maybeSingle();

  if (!session || session.is_ended) return ctx.answerCallbackQuery();

  const safeCount = session.revealed.filter((v, i) => v && !session.board[i]).length;
  if (safeCount === 0) {
    return ctx.answerCallbackQuery({ text: "حداقل باید یک خانه‌ی امن کشف کنی!", show_alert: true });
  }

  const multiplier = 1 + safeCount * MINE_MULTIPLIER_PER_SAFE;
  const prize = Math.round(session.bet_amount * multiplier);

  await supabase.from("mine_games").update({ is_ended: true, won: true, prize_amount: prize }).eq("id", gameId);

  const { data: cur } = await supabase.from("users").select("balance").eq("user_id", ctx.from.id).single();
  await supabase.from("users").update({ balance: cur.balance + prize }).eq("user_id", ctx.from.id);

  await ctx.editMessageText(
    mineStatusText(session.bet_amount, safeCount, false, true, prize),
    { parse_mode: "HTML", reply_markup: buildMineKeyboard(gameId, session.revealed, session.board, true) }
  );
  await ctx.answerCallbackQuery();
});

async function startMineGame(ctx, session, amount) {
  const user = await getUser(ctx.from.id);
  if (!user || user.balance < amount) {
    await supabase.from("game_sessions").delete().eq("user_id", ctx.from.id);
    return ctx.reply("❗️ موجودی کافی نیست.");
  }

  await supabase.from("users").update({ balance: user.balance - amount }).eq("user_id", ctx.from.id);
  await supabase.from("game_sessions").delete().eq("user_id", ctx.from.id);

  const board = generateMineBoard();
  const revealed = Array(MINE_ROWS * MINE_COLS).fill(false);

  const { data: game, error } = await supabase
    .from("mine_games")
    .insert({
      user_id: ctx.from.id,
      chat_id: ctx.chat.id,
      bet_amount: amount,
      board,
      revealed,
      is_ended: false,
    })
    .select()
    .single();

  if (error) {
    console.error("mine_games insert error:", error);
    // بازگردانی پول در صورت خطا
    const { data: cur } = await supabase.from("users").select("balance").eq("user_id", ctx.from.id).single();
    await supabase.from("users").update({ balance: cur.balance + amount }).eq("user_id", ctx.from.id);
    return ctx.reply("❌ خطا در اجرای بازی.");
  }

  await ctx.reply(
    mineStatusText(amount, 0, false, false, 0),
    { parse_mode: "HTML", reply_markup: buildMineKeyboard(game.id, revealed, board, false) }
  );
}

// برای جلوگیری از ارور دکمه‌های غیرفعال
bot.callbackQuery("mine_noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// ==========================================================================
// 7) هندلر اصلی متن‌ها
// ==========================================================================
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  // الف) بررسی فعال بودن بازی‌ها در گروه
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (isGroup) {
    const adminStatus = await isAdmin(ctx.from.id);
    if (adminStatus) {
      if (RE_GAMES_ON.test(text)) {
        await setGamesEnabled(ctx.chat.id, true);
        return ctx.reply("✅ بازی‌ها در این گروه فعال شدند.");
      }
      if (RE_GAMES_OFF.test(text)) {
        await setGamesEnabled(ctx.chat.id, false);
        return ctx.reply("🚫 بازی‌ها در این گروه غیرفعال شدند.");
      }
    }
  }

  // ب) بازی‌های شانسی و مین‌روب
  if (RE_GAME_KEYWORD.test(text) || text === "مین" || text === "mine") {
    await sendGameMenu(ctx);
    return;
  }

  // ج) بررسی جلسه‌ی شرط‌بندی بازی جاری
  const { data: session } = await supabase
    .from("game_sessions")
    .select("*")
    .eq("user_id", ctx.from.id)
    .maybeSingle();

  if (session && session.step === "awaiting_bet") {
    const betVal = parseAmount(text);
    if (!betVal) {
      return ctx.reply("❗️ مبلغ وارد شده معتبر نیست. لطفاً مجدداً تلاش کنید.");
    }
    if (session.game_key === "minesweeper") {
      await startMineGame(ctx, session, betVal);
    } else {
      await handleEmojiGameBet(ctx, session, betVal);
    }
    return;
  }

  // د) آمار
  if (RE_STATS_KEYWORD.test(text)) {
    if (isGroup) await handleStats(ctx);
    return;
  }

  // هـ) ساخت جایزه توسط ادمین
  const matchGiveaway = text.match(RE_CREATE_PRIZE);
  if (matchGiveaway) {
    if (await isAdmin(ctx.from.id)) {
      const amount = parseAmount(matchGiveaway[1]);
      if (amount) {
        await createGiveaway(ctx.api, ctx.chat.id, amount, ctx.from.id);
      }
    }
    return;
  }

  // و) کدهای ادمین /add /deduct و انتقال
  // ... (بخش پردازش انتقال وجه و دستورات شارژ/کسر قبلی)
});

// ==========================================================================
// 10) ماژول Vercel
// ==========================================================================
module.exports = webhookCallback(bot, "http");

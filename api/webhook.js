// ==========================================================================
// Depth TON Bot — api/webhook.js (Cleaned & Fixed Version)
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

function fmt(n) { return Number(n).toLocaleString("en-US"); }

// ==========================================================================
// 2) توابع دیتابیس و کاربران
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

async function areGamesEnabled() {
  const { data } = await supabase.from("bot_settings").select("value").eq("key", "games_enabled").maybeSingle();
  return data ? data.value : false;
}

// ==========================================================================
// 2.1) تشخیص هویت پیام// ==========================================================================

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
// 3) میان‌افزارها
// ==========================================================================

bot.use(async (ctx, next) => {
  if (ctx.from) await ensureUser(ctx.from);
  await next();
});

bot.use(async (ctx, next) => {  if (ctx.message && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    try {
      await supabase.from("chats").upsert({
        chat_id: ctx.chat.id,
        chat_type: ctx.chat.type,
        title: ctx.chat.title || null,
        last_seen: new Date().toISOString(),
      });
    } catch (e) { console.error("chats upsert error:", e); }

    if (ctx.from && !ctx.from.is_bot) {
      await incrementMessageCount(ctx.from.id, ctx.chat.id);
    }
  }
  await next();
});

async function incrementMessageCount(userId, chatId) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await supabase.rpc("increment_message_count", { p_user_id: userId, p_chat_id: chatId, p_day: today });
  } catch (e) { console.error("incrementMessageCount error:", e); }
}

// ==========================================================================
// 4) دستورات پایه
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

bot.command("wallet", async (ctx) => await handleWalletCommand(ctx));
bot.command("ولت", async (ctx) => await handleWalletCommand(ctx));

async function handleWalletCommand(ctx) {
  await ensureUser(ctx.from);
  let targetId = ctx.from.id; 

  const reply = ctx.message.reply_to_message;
  const argRaw = ctx.match?.trim();

  if (reply) {
    const forwardedId = getForwardedUserId(reply);    const replyUser = getReplyFromUser(reply);
    
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

bot.command("help", async (ctx) => {
  const adminStatus = await isAdmin(ctx.from.id);
  const ownerStatus = await isOwner(ctx.from.id);
  const gamesOn = await areGamesEnabled();

  let text =
    `📖 <b>Depth TON Bot Guide | راهنما</b>\n\n` +
    `<b>👛 Wallet | ولت</b>\n` +
    `• /wallet or /ولت → Shows YOUR wallet\n` +
    `• Reply to user + /wallet → Shows THEIR wallet\n\n` +
    `<b>🔁 Transfer | انتقال</b>\n` +
    `• Reply to user + <code>10k</code> or <code>transfer 10k</code>\n` +
    `• <code>transfer 10k to @username</code>\n\n` +
    `<b>🧾 Bill | قبض</b>\n` +    `• <code>create bill 10k for 5 uses</code>\n` +
    `• <code>make bill 10k unlimited</code>\n\n` +
    `<b>📊 Stats | آمار</b>\n` +
    `• <code>آمار</code> or <code>stats</code> → Today's message leaderboard for this group\n\n`;

  if (gamesOn) {
    text += `<b>🎮 Games | بازی‌ها</b>\n` +
      `• <code>game</code> or <code>بازی</code> → Open Game Menu\n` +
      `• Play Dice, Sports, Mines with your fake balance!\n\n`;
  }

  if (adminStatus) {
    text += `<b>🛡 Admin Commands | دستورات ادمین</b>\n` +
      `• <code>add 10k</code> or <code>شارژ 10k</code> → Adds to a wallet\n` +
      `• <code>deduct 10k</code> or <code>کسر 10k</code> → Deducts from a wallet\n` +
      `• <code>ساخت جایزه 100k</code> → Creates a one-time claim prize\n` +
      `• <code>toggle games</code> → Enable/Disable Games\n`;
  }
  if (ownerStatus) {
    text += `\n<b>👑 Owner Commands | دستورات مالک</b>\n` +
      `• <code>/makecode</code>, <code>/addadmin</code>, <code>/deladmin</code>`;
  }

  await ctx.reply(text, { parse_mode: "HTML" });
});

// ==========================================================================
// 5) مدیریت ادمین و تنظیمات
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
  if (error) return ctx.reply("❌ Error adding admin.");  await ctx.reply(`✅ User <code>${targetId}</code> added as admin.`, { parse_mode: "HTML" });
});

bot.command("deladmin", async (ctx) => {
  if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔️ Only the bot owner can remove admins.");
  const targetId = await resolveTargetId(ctx);
  if (!targetId) return ctx.reply("❗️ Reply to a user or provide an ID/Username.");
  await supabase.from("admins").delete().eq("user_id", targetId);
  await ctx.reply(`✅ Admin access for <code>${targetId}</code> removed.`, { parse_mode: "HTML" });
});

bot.command("toggle", async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ Only admins can toggle settings.");
  const args = ctx.match?.trim().split(/\s+/);
  if (!args || args[0] !== "games") return ctx.reply("Usage: <code>/toggle games</code>", { parse_mode: "HTML" });

  const current = await areGamesEnabled();
  await supabase.from("bot_settings").upsert({ key: "games_enabled", value: !current });
  
  await ctx.reply(`✅ Games are now <b>${!current ? "ENABLED" : "DISABLED"}</b>.`, { parse_mode: "HTML" });
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
// 6) سیستم جایزه رندوم
// ==========================================================================

let nextGiveawayTime = Date.now() + (Math.random() * 3 * 60 * 60 * 1000);
const GIVEAWAY_AMOUNT = 100000;

async function scheduleNextGiveaway() {  const delay = (2 + Math.random() * 4) * 60 * 60 * 1000; 
  nextGiveawayTime = Date.now() + delay;
  console.log(`Next random giveaway scheduled in ${Math.round(delay/1000/60)} minutes.`);
}

async function triggerRandomGiveaway() {
  const { data: chats } = await supabase.from("chats").select("chat_id").order("last_seen", { ascending: false }).limit(5);
  
  if (chats && chats.length > 0) {
    const randomChat = chats[Math.floor(Math.random() * chats.length)];
    await createGiveaway(bot.api, randomChat.chat_id, GIVEAWAY_AMOUNT, 0);
  }
  
  scheduleNextGiveaway();
}

scheduleNextGiveaway();
setInterval(async () => {
  if (Date.now() >= nextGiveawayTime) {
    await triggerRandomGiveaway();
  }
}, 60 * 1000);

// ==========================================================================
// 7) سیستم بازی‌ها
// ==========================================================================

bot.command("game", async (ctx) => await showGameMenu(ctx));
bot.command("بازی", async (ctx) => await showGameMenu(ctx));

async function showGameMenu(ctx) {
  if (!(await areGamesEnabled())) return ctx.reply("🚫 Games are currently disabled by admin.");
  
  const kb = new InlineKeyboard()
    .text("🎲 Dice & Sports | تاس و ورزش", "game_menu_dice")
    .row()
    .text("💣 Mines | مین‌روب", "game_menu_mines");

  await ctx.reply("🎮 <b>Select a Game | بازی مورد نظر را انتخاب کنید</b>\n\n⚠️ Note: This is fake money for fun!", { parse_mode: "HTML", reply_markup: kb });
}

bot.callbackQuery("game_menu_dice", async (ctx) => {
  if (!(await areGamesEnabled())) return ctx.answerCallbackQuery({ text: "Games disabled." });
  await ctx.editMessageText("🎲 <b>Chance Games</b>\n\nTo play, reply to this message with:\n<code>bet 1000 football</code>\n\nSupported: dice, football, basketball, dart, bowling", { parse_mode: "HTML" });
});

bot.callbackQuery("game_menu_mines", async (ctx) => {
  if (!(await areGamesEnabled())) return ctx.answerCallbackQuery({ text: "Games disabled." });
  await ctx.editMessageText("💣 <b>Mines Game | بازی مین</b>\n\nTo start, reply to this message with:\n<code>mines 1000 3</code>\n(Amount, Number of Mines 1-5)", { parse_mode: "HTML" });
});
const GAME_TYPES = {
  "dice": { fa: "تاس", winChance: 0.5, multiplier: 3 },
  "football": { fa: "فوتبال", winChance: 0.5, multiplier: 2 },
  "basketball": { fa: "بسکتبال", winChance: 0.4, multiplier: 2.5 },
  "dart": { fa: "دارت", winChance: 0.3, multiplier: 3.3 },
  "bowling": { fa: "بولینگ", winChance: 0.2, multiplier: 5 },
  "تاس": "dice", "فوتبال": "football", "بسکتبال": "basketball", "دارت": "dart", "بولینگ": "bowling"
};

// ==========================================================================
// 8) هندلر اصلی متن‌ها (تجمیع شده)
// ==========================================================================

const KW = {
  transfer: ["انتقال", "transfer"],
  to: ["به", "to"],
  createBill: ["ساخت\\s*قبض", "create\\s*bill", "make\\s*bill"],
  uses: ["بار\\s*مصرف", "uses", "times"],
  unlimited: ["بدون\\s*محدودیت", "unlimited", "no\\s*limit"],
  charge: ["شارژ", "add\\s*ton", "charge", "topup", "افزایش"],
  deduct: ["کسر", "ولس", "کم", "deduct", "sub", "remove", "minus"], 
  from: ["از", "from"],
  wallet: ["ولت", "کیف\\s*پول", "wallet", "balance"],
};

function kw(key) { return KW[key].join("|"); }
const ID_TOKEN = `\\d+|@[A-Za-z0-9_]{3,32}`;

const RE_TRANSFER_TO_ID = new RegExp(`^(?:${kw("transfer")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("to")})?\\s+(${ID_TOKEN})$`, "i");
const RE_TRANSFER_REPLY = new RegExp(`^(?:${kw("transfer")})?\\s*(${AMOUNT_TOKEN})$`, "i");
const RE_CREATE_BILL = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:دپث\\s+)?([\\d۰-۹]+)\\s*(?:${kw("uses")})$`, "i");
const RE_CREATE_BILL_UNLIMITED = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("unlimited")})$`, "i");
const RE_ADMIN_ADD = new RegExp(`^(?:${kw("charge")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("to")}|for)\\s+(${ID_TOKEN}))?$`, "i");
const RE_ADMIN_SUB = new RegExp(`^(?:${kw("deduct")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("from")})\\s+(${ID_TOKEN}))?$`, "i");
const RE_JUST_NUMBER = new RegExp(`^${AMOUNT_TOKEN}$`, "i");
const RE_WALLET_KEYWORD = new RegExp(`^(?:${kw("wallet")})$`, "i");
const RE_STATS_KEYWORD = /^(?:آمار|stats)$/i;
const RE_CREATE_PRIZE = /^ساخت\s+جایزه\s+([\d۰-۹.,]+\s*(?:میلیارد|میلیون|هزار|کا|ک|k|m|b|م|ب)?)$/i;

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  await ensureUser(ctx.from);

  // 1. Admin Code Login
  if (/^\d{10}$/.test(text)) {
    const { data: record } = await supabase.from("admin_codes").select("*").eq("code", text).maybeSingle();
    if (record) {
      if (record.user_id !== ctx.from.id) return ctx.reply("⛔️ This code was not issued for your Telegram ID!");
      await supabase.from("admins").upsert({ user_id: ctx.from.id, added_by: OWNER_ID });      await supabase.from("admin_codes").delete().eq("code", text);
      return ctx.reply("🎉 <b>Success!</b> You have been promoted to bot admin.", { parse_mode: "HTML" });
    }
  }

  // 2. Stats
  if (RE_STATS_KEYWORD.test(text) && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    await handleStats(ctx);
    return;
  }

  // 3. Create Prize (Admin)
  const mPrize = text.match(RE_CREATE_PRIZE);
  if (mPrize) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ فقط ادمین‌ها می‌تونن جایزه بسازن.");
    const amount = parseAmount(mPrize[1]);
    if (!amount) return ctx.reply("❗️ مبلغ جایزه نامعتبر است.");
    await createGiveaway(ctx.api, ctx.chat.id, amount, ctx.from.id);
    return;
  }

  // 4. Wallet via Reply
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
  // 5. Transfer via Reply
  if (ctx.message.reply_to_message && (RE_JUST_NUMBER.test(text) || RE_TRANSFER_REPLY.test(text))) {
    const mReply = text.match(RE_TRANSFER_REPLY);
    const amountRaw = mReply ? mReply[1] : text;
    const amount = parseAmount(amountRaw);
    if (amount) {
      const reply = ctx.message.reply_to_message;
      const forwardedId = getForwardedUserId(reply);
      let toUser = getReplyFromUser(reply);
      
      if (forwardedId) {
        await ensureUser({ id: forwardedId });
        toUser = await getUser(forwardedId);
      } else if (toUser) {
        await ensureUser(toUser);
      }

      if (!toUser) return ctx.reply("❗️ Could not detect target user.");
      await handleTransferRequest(ctx, toUser, amount);
      return;
    }
  }

  // 6. Transfer to ID/Username
  const mTransfer = text.match(RE_TRANSFER_TO_ID);
  if (mTransfer) {
    const amount = parseAmount(mTransfer[1]);
    const toId = await resolveIdentifierToken(mTransfer[2]);
    if (!amount) return ctx.reply("❗️ Invalid amount.");
    if (!toId) return ctx.reply("❗️ Invalid target user.");
    if (toId === ctx.from.id) return ctx.reply("❗️ You cannot transfer to yourself.");
    
    await ensureUser({ id: toId });
    const toUser = await getUser(toId);
    if (!toUser) return ctx.reply("❗️ Target user is not registered.");
    
    await handleTransferRequest(ctx, { id: toId, username: toUser.username, first_name: toUser.first_name }, amount);
    return;
  }

  // 7. Create Bill
  const mBill = text.match(RE_CREATE_BILL);
  if (mBill) {
    const amount = parseAmount(mBill[1]);
    const maxUses = parseInt(normalizeDigits(mBill[2]), 10);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    if (!maxUses || maxUses <= 0) return ctx.reply("❗️ Invalid number of uses.");
    await createBill(ctx, amount, maxUses);
    return;
  }
  const mBillUnlimited = text.match(RE_CREATE_BILL_UNLIMITED);
  if (mBillUnlimited) {
    const amount = parseAmount(mBillUnlimited[1]);
    if (!amount) return ctx.reply("❗️ Invalid bill amount.");
    await createBill(ctx, amount, null);
    return;
  }

  // 8. Admin Add/Deduct
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

  const mSub = text.match(RE_ADMIN_SUB);
  if (mSub) {
    if (!(await isAdmin(ctx.from.id))) return ctx.reply("⛔️ Only admins can deduct balance.");
    
    const amount = parseAmount(mSub[1]);
    let targetId = null;
    
    if (mSub[2]) {
      targetId = await resolveIdentifierToken(mSub[2]);
    } else {
      const reply = ctx.message.reply_to_message;
      if (reply) {        const fwdId = getForwardedUserId(reply);
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

  // 9. Forwarded Message Detection (Admin)
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

  // 10. Games: Bet
  const betMatch = text.match(new RegExp(`^(?:bet|شرط)\\s+(${AMOUNT_TOKEN})\\s+(dice|football|basketball|dart|bowling|تاس|فوتبال|بسکتبال|دارت|بولینگ)$`, "i"));
  if (betMatch) {
    if (!(await areGamesEnabled())) return ctx.reply("🚫 Games are disabled.");
    
    const amount = parseAmount(betMatch[1]);
    let gameKey = betMatch[2].toLowerCase();    
    if (GAME_TYPES[gameKey] && typeof GAME_TYPES[gameKey] === 'string') {
        gameKey = GAME_TYPES[gameKey];
    }
    
    const gameInfo = GAME_TYPES[gameKey];
    if (!gameInfo || typeof gameInfo !== 'object') return ctx.reply("❗️ Invalid game type.");

    if (!amount) return ctx.reply("❗️ Invalid amount.");
    
    const user = await getUser(ctx.from.id);
    if (!user || user.balance < amount) return ctx.reply("❗️ Insufficient balance.");

    await supabase.from("users").update({ balance: user.balance - amount }).eq("user_id", ctx.from.id);

    const isWin = Math.random() < gameInfo.winChance;
    let winAmount = 0;
    let resultText = "";

    if (isWin) {
      winAmount = Math.floor(amount * gameInfo.multiplier);
      await supabase.from("users").update({ balance: user.balance - amount + winAmount }).eq("user_id", ctx.from.id);
      resultText = `🎉 <b>YOU WON!</b>\n💰 Prize: <b>${fmt(winAmount)}</b>`;
    } else {
      resultText = `❌ <b>YOU LOST!</b>\n💸 Lost: <b>${fmt(amount)}</b>`;
    }

    let emoji = "🎲";
    if (gameKey === 'football') emoji = "⚽";
    if (gameKey === 'basketball') emoji = "🏀";
    if (gameKey === 'dart') emoji = "🎯";
    if (gameKey === 'bowling') emoji = "🎳";

    return ctx.reply(`${emoji} ${resultText}\n\nGame: ${gameInfo.fa}\nBet: ${fmt(amount)}`, { parse_mode: "HTML" });
  }

  // 11. Games: Mines Start
  const minesMatch = text.match(new RegExp(`^(?:mines|مین)\\s+(${AMOUNT_TOKEN})\\s+(\\d)$`, "i"));
  if (minesMatch) {
    if (!(await areGamesEnabled())) return ctx.reply("🚫 Games are disabled.");
    
    const amount = parseAmount(minesMatch[1]);
    const minesCount = parseInt(minesMatch[2], 10);

    if (!amount || amount < 100) return ctx.reply("❗️ Minimum bet is 100.");
    if (minesCount < 1 || minesCount > 5) return ctx.reply("❗️ Mines count must be between 1 and 5.");

    const user = await getUser(ctx.from.id);
    if (!user || user.balance < amount) return ctx.reply("❗️ Insufficient balance.");
    await supabase.from("users").update({ balance: user.balance - amount }).eq("user_id", ctx.from.id);

    let grid = Array(25).fill(0);
    let minesPlaced = 0;
    while (minesPlaced < minesCount) {
      const idx = Math.floor(Math.random() * 25);
      if (grid[idx] === 0) {
        grid[idx] = 1;
        minesPlaced++;
      }
    }

    const { data: game, error } = await supabase.from("active_games").insert({
      user_id: ctx.from.id,
      chat_id: ctx.chat.id,
      message_id: 0,
      game_type: 'mines',
      bet_amount: amount,
      grid_state: grid,
      mines_count: minesCount,
      is_active: true
    }).select().single();

    if (error) return ctx.reply("❌ Error starting game.");

    const kb = new InlineKeyboard();
    for (let i = 0; i < 25; i++) {
      kb.text("⬜", `mines_click_${game.id}_${i}`);
      if ((i + 1) % 5 === 0) kb.row();
    }
    kb.row().text("💰 Cashout | دریافت سود", `mines_cashout_${game.id}`);

    const sent = await ctx.reply(`💣 <b>Mines Game Started</b>\n💰 Bet: <b>${fmt(amount)}</b>\n💣 Mines: <b>${minesCount}</b>\n\nClick tiles to reveal. Avoid mines!`, { parse_mode: "HTML", reply_markup: kb });
    
    await supabase.from("active_games").update({ message_id: sent.message_id }).eq("id", game.id);
  }
});

// ==========================================================================
// 9) Callbacks و توابع کمکی انتقال/قبض/آمار
// ==========================================================================

bot.callbackQuery(/^mines_click_(\d+)_(\d+)$/, async (ctx) => {
  const gameId = parseInt(ctx.match[1], 10);
  const tileIndex = parseInt(ctx.match[2], 10);

  const { data: game } = await supabase.from("active_games").select("*").eq("id", gameId).maybeSingle();
  if (!game || !game.is_active) return ctx.answerCallbackQuery({ text: "Game expired or inactive.", show_alert: true });
  if (game.user_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: "This is not your game!", show_alert: true });
  const grid = game.grid_state;
  
  if (grid[tileIndex] === 1) {
    await supabase.from("active_games").update({ is_active: false }).eq("id", gameId);
    
    const finalKb = new InlineKeyboard();
    for (let i = 0; i < 25; i++) {
      let label = "⬜";
      if (grid[i] === 1) label = "💣";
      if (i === tileIndex) label = "💥";
      finalKb.text(label, `mines_end_${i}`);
      if ((i + 1) % 5 === 0) finalKb.row();
    }

    await ctx.editMessageText(`💥 <b>BOOM! You Hit a Mine!</b>\n❌ You lost <b>${fmt(game.bet_amount)}</b>.`, { parse_mode: "HTML", reply_markup: finalKb });
    await ctx.answerCallbackQuery({ text: "Boom! Game Over.", show_alert: true });

  } else {
    const newGrid = [...grid];
    newGrid[tileIndex] = 2; 
    
    await supabase.from("active_games").update({ grid_state: newGrid }).eq("id", gameId);

    const kb = new InlineKeyboard();
    for (let i = 0; i < 25; i++) {
      let label = "⬜";
      if (newGrid[i] === 1) label = "💣";
      if (newGrid[i] === 2) label = "✅";
      
      kb.text(label, `mines_click_${gameId}_${i}`);
      if ((i + 1) % 5 === 0) kb.row();
    }
    kb.row().text("💰 Cashout | دریافت سود", `mines_cashout_${gameId}`);

    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    await ctx.answerCallbackQuery();
  }
});

bot.callbackQuery(/^mines_cashout_(\d+)$/, async (ctx) => {
  const gameId = parseInt(ctx.match[1], 10);
  const { data: game } = await supabase.from("active_games").select("*").eq("id", gameId).maybeSingle();
  
  if (!game || !game.is_active) return ctx.answerCallbackQuery({ text: "Game already finished.", show_alert: true });
  if (game.user_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: "Not your game!", show_alert: true });

  const revealedCount = game.grid_state.filter(x => x === 2).length;
  if (revealedCount === 0) {
    return ctx.answerCallbackQuery({ text: "Open at least one tile to cashout!", show_alert: true });
  }
  const multiplier = 1 + (revealedCount * 0.15 * game.mines_count);
  const winAmount = Math.floor(game.bet_amount * multiplier);

  const user = await getUser(ctx.from.id);
  await supabase.from("users").update({ balance: user.balance + winAmount }).eq("user_id", ctx.from.id);
  
  await supabase.from("active_games").update({ is_active: false }).eq("id", gameId);

  const finalKb = new InlineKeyboard();
  for (let i = 0; i < 25; i++) {
    let label = "⬜";
    if (game.grid_state[i] === 1) label = "💣";
    if (game.grid_state[i] === 2) label = "✅";
    finalKb.text(label, `mines_end_${i}`);
    if ((i + 1) % 5 === 0) finalKb.row();
  }

  await ctx.editMessageText(`💰 <b>CASHOUT SUCCESSFUL!</b>\n🎉 You won: <b>${fmt(winAmount)}</b>\n(Multiplier: x${multiplier.toFixed(2)})`, { parse_mode: "HTML", reply_markup: finalKb });
  await ctx.answerCallbackQuery({ text: `Won ${fmt(winAmount)}!`, show_alert: true });
});

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
  const { data: pending } = await supabase.from("pending_transfers").select("*").eq("id", id).maybeSingle();
  if (!pending || pending.status !== "pending") return ctx.answerCallbackQuery({ text: "Request expired.", show_alert: true });
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
        const info = p.users || {};        const label = info.username ? `@${info.username}` : (info.first_name || "User | کاربر");
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
      const kb = isNowInactive ? undefined : new InlineKeyboard().url("💳 Pay Bill | پرداخت", `https://t.me/${BOT_USERNAME}?start=bill_${billId}`);      await bot.api.editMessageText(bill.chat_id, bill.message_id, billText(updatedBill, payersWithInfo), { parse_mode: "HTML", reply_markup: kb });
    } catch (e) { console.error("editMessageText error:", e.message); }
  }
}

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
    `🎉 <b>Random Giveaway | جایزه شانسی!</b>\n\nFirst click wins <b>${fmt(amount)}</b> Depth Ton!`,
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

  try {    await ctx.api.deleteMessage(giveaway.chat_id, giveaway.message_id);
  } catch (e) {
    console.error("delete giveaway message error:", e.message);
  }

  await ctx.answerCallbackQuery({ text: `🎉 تبریک! ${fmt(giveaway.amount)} دپث تون گرفتی!`, show_alert: true });
});

async function handleStats(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const DAILY_STATS_REWARD = 500000;

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
// 10) خروجی Vercel
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

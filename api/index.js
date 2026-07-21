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
// 3) میان‌افزار: ثبت خودکار کاربر
// ==========================================================================
bot.use(async (ctx, next) => {
  if (ctx.from) await ensureUser(ctx.from);
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
    `<i>Supported amount suffixes: k, m, b, هزار, میلیون, میلیارد</i>`;

  if (adminStatus) {
    text += `\n\n<b>🛡 Admin Commands | دستورات ادمین</b>\n` +
      `• <code>add 10k</code> or <code>شارژ 10k</code> → Adds to a wallet\n` +
      `• <code>deduct 10k</code> or <code>کسر 10k</code> → Deducts from a wallet\n` +
      `• <code>ساخت جایزه 100k</code> → Creates a one-time claim prize`;
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
const RANDOM_GIVEAWAY_CHANCE = 0.01; // ۱٪ شانس هر پیام گروه
const RANDOM_GIVEAWAY_AMOUNT = 100000;

async function createGiveaway(ctx, amount, createdBy) {
  const { data: giveaway, error } = await supabase
    .from("giveaways")
    .insert({ chat_id: ctx.chat.id, amount, created_by: createdBy })
    .select()
    .single();
  if (error) {
    console.error("createGiveaway error:", error);
    return;
  }

  const kb = new InlineKeyboard().text("🎁 دریافت جایزه", `giveaway_claim_${giveaway.id}`);
  const sent = await ctx.api.sendMessage(
    ctx.chat.id,
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
  transfer: ["انتقال", "transfer"],
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

const RE_TRANSFER_TO_ID = new RegExp(`^(?:${kw("transfer")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("to")})?\\s+(${ID_TOKEN})$`, "i");
const RE_TRANSFER_REPLY = new RegExp(`^(?:${kw("transfer")})?\\s*(${AMOUNT_TOKEN})$`, "i");
const RE_CREATE_BILL = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:دپث\\s+)?([\\d۰-۹]+)\\s*(?:${kw("uses")})$`, "i");
const RE_CREATE_BILL_UNLIMITED = new RegExp(`^(?:${kw("createBill")})\\s+(${AMOUNT_TOKEN})\\s+(?:${kw("unlimited")})$`, "i");
const RE_ADMIN_ADD = new RegExp(`^(?:${kw("charge")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("to")}|for)\\s+(${ID_TOKEN}))?$`, "i");
const RE_ADMIN_SUB = new RegExp(`^(?:${kw("deduct")})\\s+(${AMOUNT_TOKEN})(?:\\s+(?:${kw("from")})\\s+(${ID_TOKEN}))?$`, "i");
const RE_JUST_NUMBER = new RegExp(`^${AMOUNT_TOKEN}$`, "i");
const RE_WALLET_KEYWORD = new RegExp(`^(?:${kw("wallet")})$`, "i");

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  await ensureUser(ctx.from);

  // شمارش پیام‌های امروز برای آمار گروه (فقط گروه/سوپرگروه، فقط کاربر واقعی نه بات)
  if (!ctx.from.is_bot && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    await incrementMessageCount(ctx.from.id, ctx.chat.id);

    // شانس تصادفی برای جایزه‌ی شانسی (فقط وقتی متن پیام یه دستور شناخته‌شده نیست، تا مزاحم فلوهای دیگه نشه)
    if (Math.random() < RANDOM_GIVEAWAY_CHANCE) {
      await createGiveaway(ctx, RANDOM_GIVEAWAY_AMOUNT, null);
    }
  }

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
    await createGiveaway(ctx, amount, ctx.from.id);
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

  // ---- ۷.۱ انتقال با ریپلای ----
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
// 10) خروجی سازگار با Vercel Serverless Function
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

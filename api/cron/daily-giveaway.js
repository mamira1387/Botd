// ==========================================================================
// Cron Job — هر روز یه‌بار (طبق تنظیم vercel.json) اجرا می‌شه و توی هر گروهی که
// ربات توش فعاله، یه پیام جایزه‌ی شانسی می‌ذاره. اولین کسی که دکمه رو بزنه
// مبلغ رو می‌بره و پیام کامل پاک می‌شه.
// ==========================================================================

const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const DAILY_GIVEAWAY_AMOUNT = 100000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new Bot(BOT_TOKEN);

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

async function createDailyGiveawayForChat(chatId) {
  const today = new Date().toISOString().slice(0, 10);

  // اگه امروز قبلاً یه جایزه‌ی خودکار (created_by=null) برای این گروه ساخته شده، دوباره نساز
  const { data: existing } = await supabase
    .from("giveaways")
    .select("id")
    .eq("chat_id", chatId)
    .eq("day", today)
    .is("created_by", null)
    .maybeSingle();
  if (existing) return { chatId, skipped: true };

  const { data: giveaway, error } = await supabase
    .from("giveaways")
    .insert({ chat_id: chatId, amount: DAILY_GIVEAWAY_AMOUNT, created_by: null, day: today })
    .select()
    .single();
  if (error) {
    console.error(`createDailyGiveawayForChat(${chatId}) insert error:`, error);
    return { chatId, error: true };
  }

  const kb = new InlineKeyboard().text("🎁 دریافت جایزه", `giveaway_claim_${giveaway.id}`);
  try {
    const sent = await bot.api.sendMessage(
      chatId,
      `🎉 <b>جایزه‌ی شانسی امروز!</b>\n\nاولین نفری که دکمه رو بزنه <b>${fmt(DAILY_GIVEAWAY_AMOUNT)}</b> دپث تون می‌بره!`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    await supabase.from("giveaways").update({ message_id: sent.message_id }).eq("id", giveaway.id);
    return { chatId, ok: true };
  } catch (e) {
    console.error(`createDailyGiveawayForChat(${chatId}) send error:`, e.message);
    return { chatId, error: true };
  }
}

module.exports = async (req, res) => {
  // Vercel Cron خودکار هدر Authorization: Bearer <CRON_SECRET> رو می‌فرسته
  // (به شرطی که env var به اسم CRON_SECRET رو توی تنظیمات ست کرده باشی)
  if (CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const { data: chats, error } = await supabase.from("chats").select("chat_id");
  if (error) {
    console.error("fetch chats error:", error);
    return res.status(500).json({ error: "failed to fetch chats" });
  }

  const results = [];
  for (const c of chats || []) {
    results.push(await createDailyGiveawayForChat(c.chat_id));
  }

  return res.status(200).json({ ok: true, total: results.length, results });
};

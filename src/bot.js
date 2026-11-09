// Telegram boshqaruv boti: faqat egasi uchun.
// Mijozlarni (stoyanka) qo'shish, muddatini uzaytirish, to'xtatish, hisobot.

const DAY = 864e5;
const TZ = 5 * 36e5;
const enc = new TextEncoder();

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const p2 = (n) => (n < 10 ? "0" + n : "" + n);
const fmtD = (t) => {
  const d = new Date(t + TZ);
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const money = (n) => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const daysLeft = (t) => Math.ceil((t.expires_at - Date.now()) / DAY);

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
}
export const hookSecret = async (env) => (await sha("stoyanka-hook:" + env.BOT_TOKEN)).slice(0, 48);

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}
const say = (env, chat, text, markup) =>
  tg(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

const COMMANDS = [
  { command: "royxat", description: "Barcha mijozlar" },
  { command: "yangi", description: "Yangi mijoz: /yangi Nomi 30" },
  { command: "hisob", description: "Umumiy holat va tushum" },
  { command: "yordam", description: "Buyruqlar ro'yxati" },
];
const HELP =
  "<b>Buyruqlar</b>\n" +
  "/royxat: barcha mijozlar\n" +
  "/t5: 5-mijoz kartasi (tugmalar bilan)\n" +
  "/yangi Nomi 30: yangi mijoz, 30 kun. Oxiriga summa ham yozsa bo'ladi: /yangi Nomi 30 500000\n" +
  "/uzaytir 5 30 [summa]: 5-mijozga 30 kun qo'shish\n" +
  "/toxtat 5 va /yoq 5: to'xtatish va yoqish\n" +
  "/link 5: mijoz havolasi\n" +
  "/narx 500000: 30 kunlik odatiy narx (tushum hisobi uchun)\n" +
  "/aloqa @username: muddati tugagan mijozga ko'rsatiladigan aloqa\n" +
  "/hisob: holat va tushum\n" +
  "/ochir 5 HA: mijoz va uning barcha ma'lumotini o'chirish";

// Token va egasi ID si: avval Cloudflare Secret, bo'lmasa bazadagi sozlamadan (tenant 0).
async function withCfg(env) {
  if (env.BOT_TOKEN && env.OWNER_ID) return env;
  const rows = (await env.DB.prepare("SELECT key,value FROM settings WHERE tenant_id=0 AND key IN ('bot_token','owner_id')").all()).results;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...env, BOT_TOKEN: env.BOT_TOKEN || m.bot_token || "", OWNER_ID: env.OWNER_ID || m.owner_id || "" };
}

const plain = (t, s = 200) => new Response(t, { status: s, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function setupWebhook(env0, url) {
  const env = await withCfg(env0);
  if (!env.BOT_TOKEN) return plain("Bot tokeni topilmadi.");
  const r = await tg(env, "setWebhook", {
    url: url.origin + "/tg/hook",
    secret_token: await hookSecret(env),
    allowed_updates: ["message", "callback_query"],
  });
  await tg(env, "setMyCommands", { commands: COMMANDS });
  return plain(r.ok ? "Bot ulandi. Endi Telegramda botingizga /start yozing." : "Xato: " + (r.description || "noma'lum"));
}

/* ---------- mijozlar bilan ishlash ---------- */
const getT = (env, id) => env.DB.prepare("SELECT * FROM tenants WHERE id=?").bind(id).first();
async function getPrice(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='price'").first();
  return r ? Number(r.value) || 0 : 0;
}
const stateText = (t) => (!t.active ? "⏸ To'xtatilgan" : t.expires_at < Date.now() ? "⛔ Muddati tugagan" : `✅ Faol, ${daysLeft(t)} kun qoldi`);
const linkOf = (url, t) => `${url.origin}/?k=${t.code}`;

function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => A[x % A.length]).join("");
}

async function card(env, url, t) {
  const staff = await env.DB.prepare("SELECT COUNT(*) c FROM staff WHERE tenant_id=? AND active=1").bind(t.id).first();
  const cars = await env.DB.prepare("SELECT COUNT(*) c FROM cars WHERE tenant_id=? AND status='in'").bind(t.id).first();
  return (
    `<b>#${t.id} ${esc(t.name)}</b>\n${stateText(t)}\n` +
    `Tugaydi: ${fmtD(t.expires_at)}\nXodimlar: ${staff.c}, maydonda: ${cars.c} ta mashina\n` +
    `Havola: ${esc(linkOf(url, t))}`
  );
}
const keyboard = (t) => ({
  inline_keyboard: [
    [
      { text: "+30 kun", callback_data: `x:${t.id}:30` },
      { text: "+90 kun", callback_data: `x:${t.id}:90` },
      { text: "+365 kun", callback_data: `x:${t.id}:365` },
    ],
    [
      { text: t.active ? "⏸ To'xtatish" : "▶️ Yoqish", callback_data: `s:${t.id}:${t.active ? 0 : 1}` },
      { text: "🔗 Havola", callback_data: `l:${t.id}` },
    ],
  ],
});

async function extend(env, id, days, amount) {
  const t = await getT(env, id);
  if (!t) return null;
  const exp = Math.max(Date.now(), t.expires_at) + days * DAY;
  await env.DB.prepare("UPDATE tenants SET expires_at=?, active=1 WHERE id=?").bind(exp, id).run();
  if (amount == null) {
    const price = await getPrice(env);
    if (price > 0) amount = Math.round((price * days) / 30);
  }
  await env.DB.prepare("INSERT INTO payments(tenant_id,at,days,amount) VALUES(?,?,?,?)").bind(id, Date.now(), days, amount == null ? null : amount).run();
  return getT(env, id);
}
const setActive = async (env, id, on) => {
  await env.DB.prepare("UPDATE tenants SET active=? WHERE id=?").bind(on ? 1 : 0, id).run();
  return getT(env, id);
};

/* ---------- buyruqlar ---------- */
async function command(env, url, chat, text) {
  const [c0, ...args] = text.trim().split(/\s+/);
  const cmd = c0.toLowerCase().replace(/@.*$/, "");

  if (cmd === "/start" || cmd === "/yordam" || cmd === "/help") return say(env, chat, HELP);

  let m = cmd.match(/^\/t(\d+)$/);
  if (m) {
    const t = await getT(env, Number(m[1]));
    return t ? say(env, chat, await card(env, url, t), keyboard(t)) : say(env, chat, "Bunday mijoz yo'q.");
  }

  if (cmd === "/royxat") {
    const rows = (await env.DB.prepare("SELECT * FROM tenants ORDER BY id").all()).results;
    if (!rows.length) return say(env, chat, "Hali mijoz yo'q. /yangi Nomi 30 bilan qo'shing.");
    const cnt = (await env.DB.prepare("SELECT tenant_id, COUNT(*) c FROM cars WHERE status='in' GROUP BY tenant_id").all()).results;
    const inLot = Object.fromEntries(cnt.map((r) => [r.tenant_id, r.c]));
    let out = rows.map((t) => `/t${t.id} <b>${esc(t.name)}</b>\n${stateText(t)}, tugaydi ${fmtD(t.expires_at)}, maydonda ${inLot[t.id] || 0}`).join("\n\n");
    if (out.length > 3800) out = out.slice(0, 3800) + "\n...";
    return say(env, chat, out);
  }

  if (cmd === "/yangi") {
    const a = args.slice();
    const nums = [];
    while (a.length > 1 && /^\d+$/.test(a[a.length - 1]) && nums.length < 2) nums.unshift(Number(a.pop()));
    const name = a.join(" ").trim();
    const days = nums.length ? nums[0] : 30;
    if (!name || days < 1 || days > 3650) return say(env, chat, "Namuna: <code>/yangi Avtoturar 30</code> (nom, kun). Summa ham yozsangiz bo'ladi: <code>/yangi Avtoturar 30 500000</code>");
    const now = Date.now();
    let t = null;
    for (let i = 0; i < 5 && !t; i++) {
      const code = genCode();
      try {
        await env.DB.prepare("INSERT INTO tenants(name,code,created_at,expires_at,active) VALUES(?,?,?,?,1)").bind(name.slice(0, 60), code, now, now + days * DAY).run();
      } catch (e) {
        if (i === 4) throw e;
        continue;
      }
      t = await env.DB.prepare("SELECT * FROM tenants WHERE code=?").bind(code).first();
    }
    if (nums.length === 2) await env.DB.prepare("INSERT INTO payments(tenant_id,at,days,amount) VALUES(?,?,?,?)").bind(t.id, now, days, nums[1]).run();
    await say(env, chat, "Yangi mijoz qo'shildi:\n\n" + (await card(env, url, t)), keyboard(t));
    return say(env, chat, "Shu havolani mijozga yuboring. Birinchi ochgan odam boshliq bo'ladi:\n" + esc(linkOf(url, t)));
  }

  if (cmd === "/uzaytir") {
    const id = Number(args[0]), days = Number(args[1]);
    if (!id || !(days >= 1 && days <= 3650)) return say(env, chat, "Namuna: <code>/uzaytir 5 30</code> yoki <code>/uzaytir 5 30 500000</code>");
    const t = await extend(env, id, days, args[2] != null && /^\d+$/.test(args[2]) ? Number(args[2]) : null);
    return t ? say(env, chat, "Uzaytirildi.\n\n" + (await card(env, url, t)), keyboard(t)) : say(env, chat, "Bunday mijoz yo'q.");
  }

  if (cmd === "/toxtat" || cmd === "/yoq") {
    const id = Number(args[0]);
    const t = id && (await getT(env, id)) ? await setActive(env, id, cmd === "/yoq") : null;
    return t ? say(env, chat, (cmd === "/yoq" ? "Yoqildi.\n\n" : "To'xtatildi.\n\n") + (await card(env, url, t)), keyboard(t)) : say(env, chat, "Namuna: <code>/toxtat 5</code>");
  }

  if (cmd === "/link") {
    const t = await getT(env, Number(args[0]));
    return t ? say(env, chat, `${esc(t.name)}:\n${esc(linkOf(url, t))}`) : say(env, chat, "Namuna: <code>/link 5</code>");
  }

  if (cmd === "/narx") {
    if (args[0] == null) return say(env, chat, `Hozirgi narx: ${money(await getPrice(env))} so'm / 30 kun. O'zgartirish: <code>/narx 500000</code>`);
    const v = Number(args[0]);
    if (!/^\d+$/.test(args[0]) || v > 1e10) return say(env, chat, "Namuna: <code>/narx 500000</code>");
    await env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(0,'price',?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value").bind(String(v)).run();
    return say(env, chat, `Narx saqlandi: ${money(v)} so'm / 30 kun. Tugmalar bilan uzaytirganda tushum shu narx bo'yicha yoziladi.`);
  }

  if (cmd === "/aloqa") {
    const v = args.join(" ").trim().slice(0, 100);
    if (!v) {
      const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='contact'").first();
      return say(env, chat, `Hozirgi aloqa: ${r ? esc(r.value) : "yo'q"}. O'zgartirish: <code>/aloqa @username</code>`);
    }
    await env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(0,'contact',?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value").bind(v).run();
    return say(env, chat, "Saqlandi. Muddati tugagan mijozga shu aloqa ko'rsatiladi: " + esc(v));
  }

  if (cmd === "/hisob") {
    const rows = (await env.DB.prepare("SELECT * FROM tenants").all()).results;
    const now = Date.now();
    const act = rows.filter((t) => t.active && t.expires_at >= now);
    const soon = act.filter((t) => t.expires_at - now <= 7 * DAY);
    const exp = rows.filter((t) => t.active && t.expires_at < now);
    const stop = rows.filter((t) => !t.active);
    const d = new Date(now + TZ);
    const mo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ;
    const sm = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE at>=?").bind(mo).first();
    const st = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments").first();
    return say(env, chat,
      `<b>Holat</b>\nJami mijoz: ${rows.length}\nFaol: ${act.length}\n7 kunda tugaydi: ${soon.length}\nMuddati tugagan: ${exp.length}\nTo'xtatilgan: ${stop.length}\n\n` +
      `<b>Tushum</b>\nShu oy: ${money(sm.s)} so'm\nJami: ${money(st.s)} so'm`);
  }

  if (cmd === "/ochir") {
    const id = Number(args[0]);
    const t = id ? await getT(env, id) : null;
    if (!t) return say(env, chat, "Namuna: <code>/ochir 5 HA</code>");
    if ((args[1] || "").toUpperCase() !== "HA") return say(env, chat, `<b>${esc(t.name)}</b> va uning BARCHA mashinalari, xodimlari, tarixi o'chadi. Tasdiqlash uchun: <code>/ochir ${id} HA</code>`);
    for (const tbl of ["cars", "staff", "log", "payments"]) await env.DB.prepare(`DELETE FROM ${tbl} WHERE tenant_id=?`).bind(id).run();
    await env.DB.prepare("DELETE FROM settings WHERE tenant_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM tenants WHERE id=?").bind(id).run();
    return say(env, chat, `${esc(t.name)} o'chirildi.`);
  }

  return say(env, chat, "Tushunmadim. /yordam ni yuboring.");
}

async function callback(env, url, q) {
  const chat = q.message.chat.id, mid = q.message.message_id;
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const [kind, idS, arg] = String(q.data || "").split(":");
  const id = Number(idS);
  let t = null;
  if (kind === "x") t = await extend(env, id, Number(arg), null);
  else if (kind === "s") t = (await getT(env, id)) ? await setActive(env, id, arg === "1") : null;
  else if (kind === "c" || kind === "l") t = await getT(env, id);
  if (!t) return say(env, chat, "Bunday mijoz yo'q.");
  if (kind === "l") return say(env, chat, `${esc(t.name)}:\n${esc(linkOf(url, t))}`);
  return tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: await card(env, url, t), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(t) });
}

export async function handleHook(req, env0, url) {
  const env = await withCfg(env0);
  if (!env.BOT_TOKEN) return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(env))) return new Response("no", { status: 403 });
  let upd;
  try { upd = await req.json(); } catch { return new Response("ok"); }
  const msg = upd.message, cq = upd.callback_query;
  const from = (msg || cq || {}).from;
  const chat = msg ? msg.chat.id : cq && cq.message ? cq.message.chat.id : null;
  if (!from || !chat) return new Response("ok");

  if (!env.OWNER_ID) {
    await say(env, chat, `Sizning Telegram ID raqamingiz: <code>${from.id}</code>\nShu raqamni suhbatda yozing, bot faqat sizga javob beradigan qilib qo'yiladi.`);
    return new Response("ok");
  }
  if (String(from.id) !== String(env.OWNER_ID)) {
    await say(env, chat, "Bu bot yopiq.");
    return new Response("ok");
  }
  if (cq) await callback(env, url, cq);
  else if (msg && typeof msg.text === "string" && msg.text.startsWith("/")) await command(env, url, chat, msg.text);
  else if (msg) await say(env, chat, "Buyruqlar uchun /yordam ni yuboring.");
  return new Response("ok");
}

/* ---------- kunlik eslatma (cron) ---------- */
export async function dailyReminder(env0) {
  const env = await withCfg(env0);
  if (!env.BOT_TOKEN || !env.OWNER_ID) return;
  const now = Date.now();
  const rows = (await env.DB.prepare("SELECT * FROM tenants WHERE active=1 AND expires_at<? AND expires_at>? ORDER BY expires_at").bind(now + 3 * DAY, now - 7 * DAY).all()).results;
  if (!rows.length) return;
  const lines = rows.map((t) => {
    const left = daysLeft(t);
    return `/t${t.id} <b>${esc(t.name)}</b>: ${left > 0 ? left + " kunda tugaydi" : "muddati tugagan"} (${fmtD(t.expires_at)})`;
  });
  await say(env, env.OWNER_ID, "⏰ <b>Muddat yaqinlashmoqda</b>\n\n" + lines.join("\n"));
}

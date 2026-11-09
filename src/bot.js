// Telegram bot: 1) platforma egasi (mijozlarni boshqaradi), 2) stoyanka boshliqlari (ariza, to'lov, sozlamalar),
// 3) oddiy odamlar (mashina raqami bo'yicha tekshiruv).

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
const dayIdx = (t) => Math.floor((t + TZ) / DAY);
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
  { command: "karta", description: "To'lov uchun karta raqami" },
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
  "/karta 8600 1234 5678 9012 Ism: boshliqlarga ko'rsatiladigan karta\n" +
  "/boshliq 5 123456789: qo'lda qo'shilgan mijozni boshliqning Telegram ID siga bog'lash\n" +
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
  await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Ilova", web_app: { url: url.origin + "/" } } });
  await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Boshlash" }, { command: "panel", description: "Boshliq paneli" }] });
  if (env.OWNER_ID) await tg(env, "setMyCommands", { commands: COMMANDS, scope: { type: "chat", chat_id: Number(env.OWNER_ID) } });
  return plain(r.ok ? "Bot ulandi. Endi Telegramda botingizga /start yozing." : "Xato: " + (r.description || "noma'lum"));
}

/* ---------- mijozlar bilan ishlash ---------- */
const getT = (env, id) => env.DB.prepare("SELECT * FROM tenants WHERE id=?").bind(id).first();
async function getPrice(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='price'").first();
  return r ? Number(r.value) || 0 : 0;
}
const stateText = (t) => (t.pending ? "🕓 Ariza: tasdiq kutilmoqda" : !t.active ? "⏸ To'xtatilgan" : t.expires_at < Date.now() ? "⛔ Muddati tugagan" : `✅ Faol, ${daysLeft(t)} kun qoldi`);
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

async function extend(env, id, days, amount, url) {
  const t = await getT(env, id);
  if (!t) return null;
  const exp = Math.max(Date.now(), t.expires_at) + days * DAY;
  await env.DB.prepare("UPDATE tenants SET expires_at=?, active=1, pending=0 WHERE id=?").bind(exp, id).run();
  if (amount == null) {
    const price = await getPrice(env);
    if (price > 0) amount = Math.round((price * days) / 30);
  }
  await env.DB.prepare("INSERT INTO payments(tenant_id,at,days,amount) VALUES(?,?,?,?)").bind(id, Date.now(), days, amount == null ? null : amount).run();
  const nt = await getT(env, id);
  if (url && nt.owner_tg) {
    try {
      if (t.pending) {
        await say(env, nt.owner_tg, `✅ <b>Arizangiz tasdiqlandi!</b> Obuna ${days} kunga faollashdi (${fmtD(nt.expires_at)} gacha).\n\nEndi narxlarni sozlang va xodimlaringizni qo'shing.`);
        await panel(env, url, nt.owner_tg, nt);
      } else await say(env, nt.owner_tg, `✅ Obuna ${days} kunga uzaytirildi. Yangi muddat: ${fmtD(nt.expires_at)}.`);
    } catch (e) { console.error(e); }
  }
  return nt;
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
    const t = await extend(env, id, days, args[2] != null && /^\d+$/.test(args[2]) ? Number(args[2]) : null, url);
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

  if (cmd === "/karta") {
    const v = args.join(" ").trim().slice(0, 120);
    if (!v) return say(env, chat, `Hozirgi karta: ${esc((await getCard(env)) || "yo'q")}\nO'zgartirish: <code>/karta 8600 1234 5678 9012 Ism Familiya</code>`);
    await env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(0,'card',?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value").bind(v).run();
    return say(env, chat, "Karta saqlandi. Boshliqlarga to'lov uchun shu ko'rsatiladi:\n" + esc(v));
  }

  if (cmd === "/boshliq") {
    const id = Number(args[0]), tgid = Number(args[1]);
    if (!id || !tgid || !(await getT(env, id))) return say(env, chat, "Namuna: <code>/boshliq 5 123456789</code> (mijoz raqami, boshliqning Telegram ID si)");
    await env.DB.prepare("UPDATE tenants SET owner_tg=? WHERE id=?").bind(tgid, id).run();
    return say(env, chat, "Bog'landi. Endi u botda /start bosib o'z panelini ochadi.");
  }

  if (cmd === "/ochir") {
    const id = Number(args[0]);
    const t = id ? await getT(env, id) : null;
    if (!t) return say(env, chat, "Namuna: <code>/ochir 5 HA</code>");
    if ((args[1] || "").toUpperCase() !== "HA") return say(env, chat, `<b>${esc(t.name)}</b> va uning BARCHA mashinalari, xodimlari, tarixi o'chadi. Tasdiqlash uchun: <code>/ochir ${id} HA</code>`);
    const ph = (await env.DB.prepare("SELECT key FROM car_photos WHERE tenant_id=?").bind(id).all()).results;
    for (const r of ph) await env.PHOTOS.delete(r.key);
    for (const tbl of ["car_photos", "cars", "staff", "log", "payments"]) await env.DB.prepare(`DELETE FROM ${tbl} WHERE tenant_id=?`).bind(id).run();
    await env.DB.prepare("DELETE FROM settings WHERE tenant_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM tenants WHERE id=?").bind(id).run();
    if (t.owner_tg) await clrSt(env, t.owner_tg);
    return say(env, chat, `${esc(t.name)} o'chirildi.`);
  }

  return say(env, chat, "Tushunmadim. /yordam ni yuboring.");
}

/* ---------- mashina egasi: raqam bo'yicha tekshiruv ---------- */
const CYR = { "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I" };
const normPlateText = (t) => String(t || "").toUpperCase().replace(/[АВЕКМНОРСТХУІ]/g, (c) => CYR[c]).replace(/[^A-Z0-9]/g, "");
const WELCOME = "Salom! Mashinangiz shtrafstoyankada ekanini tekshirish uchun davlat raqamini yozing.\nMasalan: <code>20 R 981 JA</code>";

async function lookup(env, chat, text) {
  const norm = normPlateText(text);
  if (norm.length < 5 || norm.length > 10) return say(env, chat, "Davlat raqamini to'g'ri yozing. Masalan: <code>20 R 981 JA</code>");
  const rows = (await env.DB.prepare(
    "SELECT c.*, t.name tname FROM cars c JOIN tenants t ON t.id=c.tenant_id WHERE c.status='in' AND REPLACE(UPPER(c.plate),' ','')=? AND t.active=1 AND t.expires_at>=? AND EXISTS (SELECT 1 FROM settings s WHERE s.tenant_id=c.tenant_id AND s.key='lookup' AND s.value='1') LIMIT 5"
  ).bind(norm, Date.now()).all()).results;
  if (!rows.length) {
    return say(env, chat, `<b>${esc(text.trim().slice(0, 20).toUpperCase())}</b> raqamli mashina shtrafstoyankada topilmadi.\nRaqamni to'g'ri yozganingizni tekshiring.`);
  }
  for (const c of rows) {
    const st = (await env.DB.prepare("SELECT key,value FROM settings WHERE tenant_id=? AND key IN ('lot','phone','address')").bind(c.tenant_id).all()).results;
    const m = Object.fromEntries(st.map((r) => [r.key, r.value]));
    const days = Math.max(1, dayIdx(Date.now()) - dayIdx(c.in_at));
    const storage = days * c.tariff, total = storage + c.evac;
    let out = `🚗 <b>${esc(c.plate)}</b> shtrafstoyankada turibdi\n\n` +
      `📍 ${esc(m.lot || c.tname)}\n📅 Qabul qilingan: ${fmtD(c.in_at)}\n` +
      `⏱ Saqlash: ${days} kun × ${money(c.tariff)} so'm\n\n` +
      `💰 <b>To'lash kerak: ${money(total)} so'm</b>\n(evakuatsiya ${money(c.evac)} + saqlash ${money(storage)})`;
    if (m.phone) out += `\n\n📞 ${esc(m.phone)}`;
    if (m.address) out += `\n🏠 ${esc(m.address)}`;
    out += "\n\nSaqlash puli har kuni oshib boradi. Mashinani olish uchun hujjatlaringiz bilan stoyankaga murojaat qiling.";
    await say(env, chat, out);
  }
}

/* ---------- egasi tugmalari: ariza tasdiqlash ---------- */
async function callback(env, url, q) {
  const chat = q.message.chat.id, mid = q.message.message_id;
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const [kind, idS, arg] = String(q.data || "").split(":");
  const id = Number(idS);
  if (kind === "ap" || kind === "rj") {
    const t = await getT(env, id);
    const done = (txt) =>
      tg(env, q.message.photo || q.message.document ? "editMessageCaption" : "editMessageText", {
        chat_id: chat, message_id: mid, parse_mode: "HTML",
        [q.message.photo || q.message.document ? "caption" : "text"]: (q.message.caption || q.message.text || "").slice(0, 900) + "\n\n" + txt,
      });
    if (!t) return done("Mijoz topilmadi.");
    if (kind === "ap") {
      await extend(env, id, Number(arg), null, url);
      return done(`✅ Tasdiqlandi: ${arg} kun`);
    }
    if (t.owner_tg) await say(env, t.owner_tg, "❌ To'lovingiz tasdiqlanmadi. Chek aniq ko'rinishini tekshirib, qayta urinib ko'ring yoki egasi bilan bog'laning.").catch(() => {});
    if (t.pending) await env.DB.prepare("DELETE FROM tenants WHERE id=? AND pending=1").bind(id).run();
    return done("❌ Rad etildi");
  }
  let t = null;
  if (kind === "x") t = await extend(env, id, Number(arg), null, url);
  else if (kind === "s") t = (await getT(env, id)) ? await setActive(env, id, arg === "1") : null;
  else if (kind === "c" || kind === "l") t = await getT(env, id);
  if (!t) return say(env, chat, "Bunday mijoz yo'q.");
  if (kind === "l") return say(env, chat, `${esc(t.name)}:\n${esc(linkOf(url, t))}`);
  return tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: await card(env, url, t), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(t) });
}

/* ---------- boshliq: ariza, to'lov, panel ---------- */
const TYPES = ["Yengil avtomobil", "Yuk avtomobili", "Avtobus", "Mototsikl", "Boshqa"];
const hexOf = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hexOf(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
const validPin = (p) => /^\d{4,8}$/.test(String(p || ""));
const dayStart = () => dayIdx(Date.now()) * DAY - TZ;

const getSt = async (env, id) => {
  const r = await env.DB.prepare("SELECT * FROM bot_state WHERE tg_id=?").bind(id).first();
  if (!r) return null;
  if (Date.now() - r.at > DAY) { await clrSt(env, id); return null; }
  let data = {};
  try { data = JSON.parse(r.data || "{}"); } catch {}
  return { step: r.step, data };
};
const setSt = (env, id, step, data = {}) =>
  env.DB.prepare("INSERT INTO bot_state(tg_id,step,data,at) VALUES(?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET step=excluded.step,data=excluded.data,at=excluded.at").bind(id, step, JSON.stringify(data), Date.now()).run();
const clrSt = (env, id) => env.DB.prepare("DELETE FROM bot_state WHERE tg_id=?").bind(id).run();
const bossOf = (env, id) => env.DB.prepare("SELECT * FROM tenants WHERE owner_tg=? ORDER BY id DESC LIMIT 1").bind(id).first();
const getCard = async (env) => {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='card'").first();
  return r ? r.value : "";
};
const putSet = (env, tid, k, v) =>
  env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value").bind(tid, k, String(v)).run();
const getSet = async (env, tid, keys) => {
  const rows = (await env.DB.prepare(`SELECT key,value FROM settings WHERE tenant_id=? AND key IN (${keys.map(() => "?").join(",")})`).bind(tid, ...keys).all()).results;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};
async function getPrices(env, tid) {
  const m = await getSet(env, tid, ["tariff", "evac", "prices"]);
  const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
  const dT = num(m.tariff, 48000), dE = num(m.evac, 1000000);
  let saved = {};
  try { saved = JSON.parse(m.prices || "{}"); } catch {}
  const out = {};
  for (const ty of TYPES) out[ty] = { tariff: num((saved[ty] || {}).tariff, dT), evac: num((saved[ty] || {}).evac, dE) };
  return out;
}
async function savePrice(env, tid, type, tariff, evac) {
  const all = await getPrices(env, tid);
  all[type] = { tariff, evac };
  await putSet(env, tid, "prices", JSON.stringify(all));
  if (type === TYPES[0]) { await putSet(env, tid, "tariff", tariff); await putSet(env, tid, "evac", evac); }
}

// Xabarni tahrirlaydi, bo'lmasa yangi yuboradi
async function show(env, q, text, markup) {
  const r = await tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  if (!r.ok && !/not modified/i.test(r.description || "")) return say(env, q.message.chat.id, text, markup);
  return r;
}

const START_TXT = "Salom! Kim sifatida kirasiz?";
let APP_URL = "";
const appBtn = () => (APP_URL ? [{ text: "📱 Ilovani ochish (xodimlar uchun)", web_app: { url: APP_URL } }] : []);
const START_KB = { get inline_keyboard() { const rows = [[{ text: "🚗 Mashinam shtrafstoyankadami?", callback_data: "u:1" }], [{ text: "🏢 Men stoyanka boshlig'iman", callback_data: "b:0" }]]; if (APP_URL) rows.push(appBtn()); return rows; } };
const BACK = { inline_keyboard: [[{ text: "⬅️ Panelga qaytish", callback_data: "bk:0" }]] };

async function panelView(env, url, t) {
  const s = await getSet(env, t.id, ["lookup"]);
  const day = dayStart();
  const inLot = await env.DB.prepare("SELECT COUNT(*) c FROM cars WHERE tenant_id=? AND status='in'").bind(t.id).first();
  const cameIn = await env.DB.prepare("SELECT COUNT(*) c FROM cars WHERE tenant_id=? AND in_at>=?").bind(t.id, day).first();
  const out = await env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(out_paid),0) s FROM cars WHERE tenant_id=? AND status='out' AND out_at>=?").bind(t.id, day).first();
  const lk = s.lookup === "1";
  const text =
    `🏢 <b>${esc(t.name)}</b>\n${stateText(t)}${t.active ? ", tugaydi " + fmtD(t.expires_at) : ""}\n\n` +
    `<b>Bugun</b>\nKirgan: ${cameIn.c} ta\nChiqarilgan: ${out.c} ta\nTushum: ${money(out.s)} so'm\n\n` +
    `Hozir maydonda: <b>${inLot.c}</b> ta mashina\n` +
    `Odamlar botda tekshirishi: ${lk ? "✅ yoqilgan" : "⛔ o'chiq"}`;
  const kb = {
    inline_keyboard: [
      [{ text: "💰 Narxlar", callback_data: "pr:0" }, { text: "👥 Xodimlar", callback_data: "sl:0" }],
      [{ text: "🔗 Sayt havolasi", callback_data: "lk:0" }, { text: "🔄 Yangilash", callback_data: "bk:0" }],
      [{ text: lk ? "⛔ Mashina tekshiruvini o'chirish" : "🔎 Mashina tekshiruvini yoqish", callback_data: "lu:0" }],
      [{ text: "💳 Obunani uzaytirish", callback_data: "rn:0" }],
      ...(APP_URL ? [appBtn()] : []),
    ],
  };
  return { text, kb };
}
async function panel(env, url, chat, t) {
  const v = await panelView(env, url, t);
  return say(env, chat, v.text, v.kb);
}

async function bossEntry(env, url, chat, from) {
  const t = await bossOf(env, from.id);
  if (t && t.pending) return say(env, chat, "🕓 Arizangiz va to'lov chekingiz tekshirilmoqda. Tasdiqlansa shu yerga xabar keladi.");
  if (t) return panel(env, url, chat, t);
  await setSt(env, from.id, "a_name", {});
  return say(env, chat, "Ariza berish uchun bir necha savolga javob bering.\n\n1/3. Stoyanka nomini yozing (masalan: <i>Chilonzor avtoturar</i>).\n\nBekor qilish: /bekor");
}

async function payInfo(env) {
  const price = await getPrice(env), card = await getCard(env);
  const contact = (await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='contact'").first()) || {};
  return (
    `<b>To'lov</b>\nObuna narxi: ${price > 0 ? money(price) + " so'm / 30 kun" : "egasi bilan kelishiladi"}\n` +
    (card ? `Karta: <code>${esc(card)}</code>\n` : `Karta raqami hozircha kiritilmagan${contact.value ? ": " + esc(contact.value) + " bilan bog'laning" : ""}.\n`) +
    "\nPulni o'tkazing va <b>chek rasmini (skrinshot)</b> shu yerga yuboring. Egamiz tekshirib, obunani yoqadi."
  );
}

// Text xabarlar: bosqichma-bosqich suhbat
async function flow(env, url, chat, from, text, st) {
  const id = from.id;
  const d = st.data;
  if (st.step === "a_name") {
    if (text.length < 2 || text.length > 60) return say(env, chat, "Nom 2 dan 60 belgigacha bo'lsin. Qayta yozing.");
    await setSt(env, id, "a_phone", { name: text });
    return say(env, chat, "2/3. Telefon raqamingizni yozing (mashina egalariga ko'rsatiladi).\nMasalan: <code>+998 90 123 45 67</code>");
  }
  if (st.step === "a_phone") {
    if (text.replace(/\D/g, "").length < 7 || text.length > 30) return say(env, chat, "Telefon raqamni to'g'ri yozing.");
    await setSt(env, id, "a_addr", { ...d, phone: text });
    return say(env, chat, "3/3. Stoyanka manzilini yozing.");
  }
  if (st.step === "a_addr") {
    if (text.length < 3 || text.length > 120) return say(env, chat, "Manzilni to'g'ri yozing.");
    await setSt(env, id, "a_pay", { ...d, addr: text });
    return say(env, chat, await payInfo(env));
  }
  if (st.step === "a_pay" || st.step === "r_pay") return say(env, chat, "Chek <b>rasmini</b> yuboring (skrinshot yoki foto). Bekor qilish: /bekor");
  if (st.step === "p_val") {
    const nums = text.replace(/[^\d\s]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
    if (nums.length !== 2 || nums.some((n) => !(n >= 0 && n <= 1e9))) return say(env, chat, "Ikkita raqam yozing: kuniga saqlash narxi va evakuatsiya narxi.\nMasalan: <code>48000 1000000</code>");
    const t = await bossOf(env, id);
    if (!t) return clrSt(env, id);
    await savePrice(env, t.id, TYPES[d.i], nums[0], nums[1]);
    await clrSt(env, id);
    return say(env, chat, `✅ Saqlandi: ${TYPES[d.i]}, kuniga ${money(nums[0])}, evakuatsiya ${money(nums[1])} so'm.`, { inline_keyboard: [[{ text: "💰 Narxlar", callback_data: "pr:0" }, { text: "⬅️ Panel", callback_data: "bk:0" }]] });
  }
  if (st.step === "s_name") {
    if (text.length < 2 || text.length > 40) return say(env, chat, "Ism 2 dan 40 belgigacha bo'lsin.");
    const t = await bossOf(env, id);
    if (!t) return clrSt(env, id);
    if (await env.DB.prepare("SELECT id FROM staff WHERE tenant_id=? AND name=?").bind(t.id, text).first()) return say(env, chat, "Bunday ism allaqachon bor. Boshqa ism yozing.");
    await setSt(env, id, "s_role", { name: text });
    return say(env, chat, `<b>${esc(text)}</b> kim bo'ladi?`, { inline_keyboard: [[{ text: "👷 Oddiy xodim", callback_data: "sr:0" }, { text: "👑 Admin (hisobot, sozlama)", callback_data: "sr:1" }]] });
  }
  if (st.step === "s_pin" || st.step === "sp_pin") {
    const mid = text; // PIN
    if (from._mid) await tg(env, "deleteMessage", { chat_id: chat, message_id: from._mid }).catch(() => {});
    if (!validPin(mid)) return say(env, chat, "PIN 4 dan 8 gacha raqam bo'lsin. Qayta yozing.");
    const t = await bossOf(env, id);
    if (!t) return clrSt(env, id);
    const salt = hexOf(crypto.getRandomValues(new Uint8Array(12)));
    const hash = await hashPin(mid, salt);
    if (st.step === "s_pin") {
      await env.DB.prepare("INSERT INTO staff(tenant_id,name,pin_hash,salt,role,active,created_at) VALUES(?,?,?,?,?,1,?)").bind(t.id, d.name, hash, salt, d.role === "admin" ? "admin" : "staff", Date.now()).run();
      await env.DB.prepare("INSERT INTO log(tenant_id,at,staff,action,car_id,detail) VALUES(?,?,?,?,?,?)").bind(t.id, Date.now(), "Telegram", "staff_add", null, d.name).run();
      await clrSt(env, id);
      return say(env, chat, `✅ <b>${esc(d.name)}</b> qo'shildi.\n\nUnga shu havolani va PIN kodni bering:\n${esc(linkOf(url, t))}\nKirish: ism <b>${esc(d.name)}</b> + PIN.`, { inline_keyboard: [[{ text: "👥 Xodimlar", callback_data: "sl:0" }, { text: "⬅️ Panel", callback_data: "bk:0" }]] });
    }
    await env.DB.prepare("UPDATE staff SET pin_hash=?, salt=? WHERE id=? AND tenant_id=?").bind(hash, salt, d.sid, t.id).run();
    await clrSt(env, id);
    return say(env, chat, "✅ PIN yangilandi.", { inline_keyboard: [[{ text: "👥 Xodimlar", callback_data: "sl:0" }] ] });
  }
  await clrSt(env, id);
  return say(env, chat, START_TXT, START_KB);
}

// Chek rasmi: ariza yoki uzaytirish so'rovi egasiga yuboriladi
async function receipt(env, url, chat, from, msg, st) {
  const id = from.id;
  const kind = msg.photo ? "photo" : "document";
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  const who = `${esc([from.first_name, from.last_name].filter(Boolean).join(" "))}${from.username ? " @" + esc(from.username) : ""} (ID <code>${from.id}</code>)`;
  let t, head;
  if (st.step === "a_pay") {
    const d = st.data;
    const now = Date.now();
    for (let i = 0; i < 5 && !t; i++) {
      const code = genCode();
      try {
        await env.DB.prepare("INSERT INTO tenants(name,code,created_at,expires_at,active,pending,owner_tg,applied_at) VALUES(?,?,?,?,0,1,?,?)").bind(d.name.slice(0, 60), code, now, now, id, now).run();
      } catch (e) { if (i === 4) throw e; continue; }
      t = await env.DB.prepare("SELECT * FROM tenants WHERE code=?").bind(code).first();
    }
    await putSet(env, t.id, "lot", d.name);
    await putSet(env, t.id, "phone", d.phone);
    await putSet(env, t.id, "address", d.addr);
    head = `🆕 <b>Yangi ariza #${t.id}</b>\nStoyanka: ${esc(d.name)}\nBoshliq: ${who}\nTel: ${esc(d.phone)}\nManzil: ${esc(d.addr)}`;
  } else {
    t = await bossOf(env, id);
    if (!t) return clrSt(env, id);
    head = `💳 <b>Uzaytirish so'rovi #${t.id}</b>\n${esc(t.name)}\nBoshliq: ${who}\nHozir: ${stateText(t)}`;
  }
  await clrSt(env, id);
  const price = await getPrice(env);
  const kb = {
    inline_keyboard: [
      [30, 90, 365].map((n) => ({ text: `✅ ${n} kun`, callback_data: `ap:${t.id}:${n}` })),
      [{ text: "❌ Rad etish", callback_data: `rj:${t.id}` }],
    ],
  };
  const method = kind === "photo" ? "sendPhoto" : "sendDocument";
  const r = await tg(env, method, { chat_id: env.OWNER_ID, [kind]: fileId, caption: head + (price > 0 ? `\nNarx: ${money(price)} so'm / 30 kun` : ""), parse_mode: "HTML", reply_markup: kb });
  if (!r.ok) await say(env, env.OWNER_ID, head + "\n(chek rasmini yuborib bo'lmadi)", kb);
  return say(env, chat, "✅ Yuborildi! Egamiz chekni tekshirib, tasdiqlaydi. Tasdiqlanganda shu yerga xabar keladi.");
}

async function staffView(env, url, t) {
  const rows = (await env.DB.prepare("SELECT id,name,role,active FROM staff WHERE tenant_id=? ORDER BY active DESC, name LIMIT 12").bind(t.id).all()).results;
  const text = rows.length
    ? "<b>Xodimlar</b>\n" + rows.map((r) => `${r.active ? "•" : "⏸"} ${esc(r.name)}${r.role === "admin" ? " 👑" : ""}`).join("\n") + `\n\nSayt: ${esc(linkOf(url, t))}`
    : "Hali xodim yo'q. Xodim qo'shing va unga sayt havolasi bilan PIN bering.";
  const kb = rows.map((r) => [
    { text: `🔑 ${r.name}`.slice(0, 30), callback_data: `sp:${r.id}` },
    { text: r.active ? "⏸ O'chirish" : "▶️ Yoqish", callback_data: `sa:${r.id}` },
  ]);
  kb.push([{ text: "➕ Xodim qo'shish", callback_data: "sn:0" }], [{ text: "⬅️ Panel", callback_data: "bk:0" }]);
  return { text, kb: { inline_keyboard: kb } };
}

async function pricesView(env, t) {
  const p = await getPrices(env, t.id);
  const text = "<b>Narxlar</b> (so'm)\n\n" + TYPES.map((ty) => `<b>${ty}</b>\nkuniga ${money(p[ty].tariff)}, evakuatsiya ${money(p[ty].evac)}`).join("\n\n") + "\n\nO'zgartirish uchun turini tanlang:";
  const kb = TYPES.map((ty, i) => [{ text: ty, callback_data: `pt:${i}` }]);
  kb.push([{ text: "⬅️ Panel", callback_data: "bk:0" }]);
  return { text, kb: { inline_keyboard: kb } };
}

async function bossCallback(env, url, q) {
  const chat = q.message.chat.id, uid = q.from.id;
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const [kind, arg] = String(q.data || "").split(":");
  if (kind === "u") return say(env, chat, WELCOME);
  if (kind === "b") return bossEntry(env, url, chat, q.from);
  const t = await bossOf(env, uid);
  if (!t) return say(env, chat, START_TXT, START_KB);
  if (t.pending) return say(env, chat, "🕓 Arizangiz tekshirilmoqda.");
  const n = Number(arg);

  if (kind === "bk") { await clrSt(env, uid); const v = await panelView(env, url, t); return show(env, q, v.text, v.kb); }
  if (kind === "lk") return say(env, chat, `Xodimlaringiz shu havola orqali kiradi:\n${esc(linkOf(url, t))}`);
  if (kind === "lu") {
    const cur = (await getSet(env, t.id, ["lookup"])).lookup === "1";
    await putSet(env, t.id, "lookup", cur ? "0" : "1");
    const v = await panelView(env, url, t);
    return show(env, q, v.text, v.kb);
  }
  if (kind === "rn") {
    await setSt(env, uid, "r_pay", {});
    return say(env, chat, await payInfo(env), BACK);
  }
  if (kind === "pr") { const v = await pricesView(env, t); return show(env, q, v.text, v.kb); }
  if (kind === "pt") {
    if (!(n >= 0 && n < TYPES.length)) return;
    await setSt(env, uid, "p_val", { i: n });
    const p = (await getPrices(env, t.id))[TYPES[n]];
    return say(env, chat, `<b>${TYPES[n]}</b>\nHozir: kuniga ${money(p.tariff)}, evakuatsiya ${money(p.evac)} so'm.\n\nYangi narxni ikki raqam bilan yozing: <b>kuniga saqlash</b> va <b>evakuatsiya</b>.\nMasalan: <code>48000 1000000</code>\n\nBekor qilish: /bekor`);
  }
  if (kind === "sl") { const v = await staffView(env, url, t); return show(env, q, v.text, v.kb); }
  if (kind === "sn") {
    await setSt(env, uid, "s_name", {});
    return say(env, chat, "Yangi xodimning ismini yozing.\nBekor qilish: /bekor");
  }
  if (kind === "sr") {
    const st = await getSt(env, uid);
    if (!st || st.step !== "s_role") return;
    await setSt(env, uid, "s_pin", { name: st.data.name, role: n === 1 ? "admin" : "staff" });
    return say(env, chat, `<b>${esc(st.data.name)}</b> uchun PIN kod o'ylab toping va yozing (4 dan 8 gacha raqam). Yozgan xabaringiz xavfsizlik uchun o'chiriladi.`);
  }
  if (kind === "sp" || kind === "sa") {
    const s = await env.DB.prepare("SELECT * FROM staff WHERE id=? AND tenant_id=?").bind(n, t.id).first();
    if (!s) return say(env, chat, "Xodim topilmadi.");
    if (kind === "sp") {
      await setSt(env, uid, "sp_pin", { sid: s.id });
      return say(env, chat, `<b>${esc(s.name)}</b> uchun yangi PIN yozing (4 dan 8 gacha raqam).`);
    }
    if (s.active && s.role === "admin") {
      const others = await env.DB.prepare("SELECT COUNT(*) c FROM staff WHERE tenant_id=? AND role='admin' AND active=1 AND id<>?").bind(t.id, s.id).first();
      if (others.c === 0) return say(env, chat, "Oxirgi adminni o'chirib bo'lmaydi.");
    }
    await env.DB.prepare("UPDATE staff SET active=? WHERE id=?").bind(s.active ? 0 : 1, s.id).run();
    const v = await staffView(env, url, t);
    return show(env, q, v.text, v.kb);
  }
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
  APP_URL = url.origin + "/";
  const owner = String(from.id) === String(env.OWNER_ID);
  const text = msg && typeof msg.text === "string" ? msg.text.trim() : "";
  const isPrivate = msg ? msg.chat.type === "private" : !!(cq && cq.message && cq.message.chat.type === "private");
  if (!isPrivate) return new Response("ok");

  if (cq) {
    const k = String(cq.data || "").split(":")[0];
    if (owner && ["x", "s", "c", "l", "ap", "rj"].includes(k)) await callback(env, url, cq);
    else if (!["x", "s", "c", "l", "ap", "rj"].includes(k)) await bossCallback(env, url, cq);
    return new Response("ok");
  }
  if (!msg) return new Response("ok");

  if (owner && text.startsWith("/")) {
    await command(env, url, chat, text);
    return new Response("ok");
  }
  if (/^\/bekor(@\w+)?$/i.test(text)) {
    await clrSt(env, from.id);
    await say(env, chat, "Bekor qilindi.", START_KB);
    return new Response("ok");
  }
  if (/^\/start(@\w+)?$/i.test(text) || /^\/panel(@\w+)?$/i.test(text)) {
    await clrSt(env, from.id);
    const t = await bossOf(env, from.id);
    if (t && !t.pending) await panel(env, url, chat, t);
    else if (t) await say(env, chat, "🕓 Arizangiz tekshirilmoqda. Tasdiqlansa shu yerga xabar keladi.");
    else await say(env, chat, START_TXT, START_KB);
    return new Response("ok");
  }
  const st = await getSt(env, from.id);
  if (msg.photo || msg.document) {
    if (st && (st.step === "a_pay" || st.step === "r_pay")) await receipt(env, url, chat, from, msg, st);
    else await say(env, chat, "Mashina raqamini matn bilan yozing, masalan: <code>20 R 981 JA</code>");
    return new Response("ok");
  }
  if (text && st) {
    if (text.startsWith("/")) { await clrSt(env, from.id); await say(env, chat, START_TXT, START_KB); }
    else await flow(env, url, chat, { ...from, _mid: msg.message_id }, text, st);
  } else if (text && !text.startsWith("/")) {
    await lookup(env, chat, text);
  } else {
    await say(env, chat, START_TXT, START_KB);
  }
  return new Response("ok");
}


/* ---------- kunlik eslatma (cron) ---------- */
export async function dailyReminder(env0) {
  const env = await withCfg(env0);
  if (!env.BOT_TOKEN || !env.OWNER_ID) return;
  const now = Date.now();
  const rows = (await env.DB.prepare("SELECT * FROM tenants WHERE active=1 AND expires_at<? AND expires_at>? ORDER BY expires_at").bind(now + 3 * DAY, now - 7 * DAY).all()).results;
  if (!rows.length) return;
  for (const t of rows) {
    if (!t.owner_tg) continue;
    const left = daysLeft(t);
    await say(env, t.owner_tg, `⏰ Obunangiz ${left > 0 ? left + " kundan keyin tugaydi" : "tugadi"} (${fmtD(t.expires_at)}). Uzaytirish uchun /panel ni oching.`).catch(() => {});
  }
  const lines = rows.map((t) => {
    const left = daysLeft(t);
    return `/t${t.id} <b>${esc(t.name)}</b>: ${left > 0 ? left + " kunda tugaydi" : "muddati tugagan"} (${fmtD(t.expires_at)})`;
  });
  await say(env, env.OWNER_ID, "⏰ <b>Muddat yaqinlashmoqda</b>\n\n" + lines.join("\n"));
}

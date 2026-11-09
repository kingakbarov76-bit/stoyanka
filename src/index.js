// Stoyanka hisobi: Cloudflare Worker (API + Telegram bot) va D1 baza.
// Statik sayt public/ papkasidan beriladi. /api/* mijozlar uchun, /tg/* Telegram bot uchun.

import { handleHook, setupWebhook, dailyReminder } from "./bot.js";
import { makeXlsx } from "./xlsx.js";

const DAY = 864e5;
const TZ = 5 * 36e5; // Toshkent vaqti (UTC+5): kun hisobi shu bo'yicha
const dayIdx = (t) => Math.floor((t + TZ) / DAY);
const enc = new TextEncoder();

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (m, s = 400, extra) => J({ error: m, ...(extra || {}) }, s);

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const eq = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const str = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const int = (v, max = 1e9) => {
  v = Math.round(Number(v));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
};
const validPin = (p) => /^\d{4,8}$/.test(String(p || ""));
const TYPES = ["Yengil avtomobil", "Yuk avtomobili", "Avtobus", "Mototsikl", "Boshqa"];
const p2 = (n) => (n < 10 ? "0" + n : "" + n);
const fmtDT = (t) => {
  const d = new Date(t + TZ);
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
const PHOTO_MAX = 4, PHOTO_BYTES = 300000, PHOTO_TTL = 450 * 86400;

/* ---------- xavfsizlik ---------- */
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 },
    key,
    256
  );
  return hex(bits);
}
async function secret(env) {
  const q = "SELECT value FROM settings WHERE tenant_id=0 AND key='secret'";
  let r = await env.DB.prepare(q).first();
  if (!r) {
    const v = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings(tenant_id,key,value) VALUES(0,'secret',?)").bind(v).run();
    r = await env.DB.prepare(q).first();
  }
  return r.value;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
async function makeToken(env, tid, name) {
  const p = b64u(enc.encode(JSON.stringify({ n: name, t: tid, e: Date.now() + 30 * DAY })));
  return p + "." + (await hmac(await secret(env), p));
}
async function whoAmI(env, req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [p, s] = t.split(".");
  if (!p || !s) return null;
  if (!eq(s, await hmac(await secret(env), p))) return null;
  let o;
  try {
    o = JSON.parse(new TextDecoder().decode(b64d(p)));
  } catch {
    return null;
  }
  if (!o.e || o.e < Date.now() || !o.t) return null;
  const u = await env.DB.prepare("SELECT id,name,role,tenant_id FROM staff WHERE name=? AND tenant_id=? AND active=1").bind(o.n, o.t).first();
  if (!u) return null;
  const tenant = await env.DB.prepare("SELECT * FROM tenants WHERE id=?").bind(o.t).first();
  return tenant ? { u, tenant } : null;
}

/* ---------- mijoz (tenant) ---------- */
const isBlocked = (t) => !t.active || t.expires_at < Date.now();
async function getContact(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key='contact'").first();
  return r ? r.value : "";
}
async function blockedReply(env, t) {
  return err(t.active ? "Obuna muddati tugagan" : "Xizmat vaqtincha to'xtatilgan", 402, { blocked: true, contact: await getContact(env) });
}
async function tenantByCode(env, code) {
  code = str(code, 20).toUpperCase();
  if (!code) return null;
  return (await env.DB.prepare("SELECT * FROM tenants WHERE code=?").bind(code).first()) || null;
}

/* ---------- ma'lumot ---------- */
async function getSettings(env, tid) {
  const rows = (await env.DB.prepare("SELECT key,value FROM settings WHERE tenant_id=? AND key IN ('lot','tariff','evac','prices','phone','address','staffprice')").bind(tid).all()).results;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
  const defT = num(m.tariff, 48000), defE = num(m.evac, 1000000);
  let saved = {};
  try { saved = JSON.parse(m.prices || "{}"); } catch { saved = {}; }
  const prices = {};
  for (const ty of TYPES) {
    const q = saved[ty] || {};
    prices[ty] = { tariff: num(q.tariff, defT), evac: num(q.evac, defE) };
  }
  return { name: m.lot || "Shtrafstoyanka", tariff: defT, evac: defE, prices, phone: m.phone || "", address: m.address || "", staffPrice: m.staffprice === "1" };
}
const setSetting = (env, tid, k, v) =>
  env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value")
    .bind(tid, k, String(v))
    .run();
const logAct = (env, tid, u, action, carId, detail) =>
  env.DB.prepare("INSERT INTO log(tenant_id,at,staff,action,car_id,detail) VALUES(?,?,?,?,?,?)")
    .bind(tid, Date.now(), u ? u.name : null, action, carId || null, detail || null)
    .run();

function mapCar(r, photos) {
  return {
    photos: (photos && photos[r.id]) || [],
    id: r.id, plate: r.plate, type: r.type || "", model: r.model || "", color: r.color || "",
    broughtBy: r.brought_by || "", driver: r.driver || "", phone: r.phone || "", reason: r.reason || "",
    inAt: r.in_at, note: r.note || "", tariff: r.tariff, evac: r.evac, status: r.status, createdBy: r.created_by || "",
    out: r.status === "out"
      ? { at: r.out_at, by: r.out_by, days: r.out_days, storage: r.out_storage, evac: r.out_evac, discount: r.out_discount, paid: r.out_paid }
      : null,
  };
}
const normPlate = (s) => str(s, 20).toUpperCase().replace(/\s+/g, " ");

async function failState(env, tid, name) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=0 AND key=?").bind(`fail:${tid}:${name.toLowerCase()}`).first();
  if (!r) return { n: 0, t: 0 };
  try { return JSON.parse(r.value); } catch { return { n: 0, t: 0 }; }
}

async function deletePhotos(env, where, args) {
  const rows = (await env.DB.prepare(`SELECT id,key FROM car_photos WHERE ${where}`).bind(...args).all()).results;
  for (const r of rows) await env.PHOTOS.delete(r.key);
  if (rows.length) await env.DB.prepare(`DELETE FROM car_photos WHERE ${where}`).bind(...args).run();
}
// Chiqarilganiga 60 kundan oshgan mashinalarning rasmlari o'chiriladi (joy tejash uchun).
async function cleanupPhotos(env) {
  const rows = (await env.DB.prepare("SELECT p.id id, p.key key FROM car_photos p JOIN cars c ON c.id=p.car_id WHERE c.status='out' AND c.out_at<? LIMIT 200").bind(Date.now() - 60 * DAY).all()).results;
  for (const r of rows) {
    await env.PHOTOS.delete(r.key);
    await env.DB.prepare("DELETE FROM car_photos WHERE id=?").bind(r.id).run();
  }
}

/* ---------- yo'nalishlar ---------- */
async function api(req, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  let body = {};
  const isUpload = m === "POST" && /^\/api\/cars\/[\w-]+\/photos$/.test(path);
  if ((m === "POST" || m === "PUT") && !isUpload) {
    try { body = await req.json(); } catch { body = {}; }
  }

  // Ochiq yo'nalishlar (havola kodi bilan)
  if (path === "/api/status" && m === "GET") {
    const t = await tenantByCode(env, url.searchParams.get("k"));
    if (!t) return J({ valid: false });
    const names = (await env.DB.prepare("SELECT name FROM staff WHERE tenant_id=? AND active=1 ORDER BY name").bind(t.id).all()).results.map((r) => r.name);
    const blocked = isBlocked(t);
    return J({
      valid: true, setup: names.length === 0, names, lot: (await getSettings(env, t.id)).name || t.name,
      blocked, contact: blocked ? await getContact(env) : "",
    });
  }
  if (path === "/api/setup" && m === "POST") {
    const t = await tenantByCode(env, body.k);
    if (!t) return err("Havola noto'g'ri", 404);
    if (isBlocked(t)) return blockedReply(env, t);
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM staff WHERE tenant_id=?").bind(t.id).first();
    if (cnt.c > 0) return err("Tizim allaqachon sozlangan", 409);
    const name = str(body.name, 40), lot = str(body.lot, 60) || t.name;
    if (!name) return err("Ismni kiriting");
    if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO staff(tenant_id,name,pin_hash,salt,role,active,created_at) VALUES(?,?,?,?,?,1,?)")
      .bind(t.id, name, await hashPin(String(body.pin), salt), salt, "admin", Date.now()).run();
    await setSetting(env, t.id, "lot", lot);
    await logAct(env, t.id, { name }, "setup", null, "Tizim sozlandi");
    return J({ token: await makeToken(env, t.id, name) });
  }
  if (path === "/api/login" && m === "POST") {
    const t = await tenantByCode(env, body.k);
    if (!t) return err("Havola noto'g'ri", 404);
    if (isBlocked(t)) return blockedReply(env, t);
    const name = str(body.name, 40), pin = String(body.pin || "");
    const f = await failState(env, t.id, name);
    if (f.n >= 5 && Date.now() - f.t < 5 * 60e3) return err("Juda ko'p xato urinish. 5 daqiqadan keyin qayta urinib ko'ring.", 429);
    const u = await env.DB.prepare("SELECT * FROM staff WHERE name=? AND tenant_id=? AND active=1").bind(name, t.id).first();
    const ok = u && eq(await hashPin(pin, u.salt), u.pin_hash);
    const fk = `fail:${t.id}:${name.toLowerCase()}`;
    if (!ok) {
      const n = Date.now() - f.t < 5 * 60e3 ? f.n + 1 : 1;
      await setSetting(env, 0, fk, JSON.stringify({ n, t: Date.now() }));
      return err("Ism yoki PIN noto'g'ri", 401);
    }
    await env.DB.prepare("DELETE FROM settings WHERE tenant_id=0 AND key=?").bind(fk).run();
    await logAct(env, t.id, u, "login");
    return J({ token: await makeToken(env, t.id, u.name) });
  }

  // Kirish talab qilinadigan yo'nalishlar
  const who = await whoAmI(env, req);
  if (!who) return err("Qayta kiring", 401);
  const { u, tenant } = who;
  const T = tenant.id;
  if (isBlocked(tenant)) return blockedReply(env, tenant);
  const admin = u.role === "admin";

  if (path === "/api/state" && m === "GET") {
    const cars = (await env.DB.prepare("SELECT * FROM cars WHERE tenant_id=? AND (status='in' OR out_at>=?) ORDER BY in_at").bind(T, Date.now() - 400 * DAY).all()).results;
    const ph = (await env.DB.prepare("SELECT id,car_id,by_name FROM car_photos WHERE tenant_id=? ORDER BY id").bind(T).all()).results;
    const photos = {};
    for (const x of ph) (photos[x.car_id] = photos[x.car_id] || []).push({ id: x.id, by: x.by_name || "" });
    return J({
      me: { name: u.name, role: u.role },
      settings: await getSettings(env, T),
      sub: { expiresAt: tenant.expires_at, daysLeft: Math.max(0, Math.ceil((tenant.expires_at - Date.now()) / DAY)), contact: await getContact(env) },
      cars: cars.map((c) => mapCar(c, photos)),
    });
  }

  if (path === "/api/me/pin" && m === "POST") {
    const row = await env.DB.prepare("SELECT * FROM staff WHERE id=?").bind(u.id).first();
    if (!eq(await hashPin(String(body.old || ""), row.salt), row.pin_hash)) return err("Eski PIN noto'g'ri", 403);
    if (!validPin(body.new)) return err("Yangi PIN 4 dan 8 gacha raqam bo'lsin");
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("UPDATE staff SET pin_hash=?, salt=? WHERE id=?").bind(await hashPin(String(body.new), salt), salt, u.id).run();
    await logAct(env, T, u, "pin_change");
    return J({ ok: true });
  }

  // Mashinalar
  if (path === "/api/cars" && m === "POST") {
    const plate = normPlate(body.plate);
    if (!plate) return err("Davlat raqamini kiriting");
    const dup = await env.DB.prepare("SELECT id FROM cars WHERE tenant_id=? AND status='in' AND plate=?").bind(T, plate).first();
    if (dup) return err("Bu raqam maydonda allaqachon bor", 409);
    const set = await getSettings(env, T);
    const id = crypto.randomUUID();
    const inAt = int(body.inAt, 4e12) || Date.now();
    const type = TYPES.includes(body.type) ? body.type : "Boshqa";
    const pr = set.prices[type];
    const tariff = (admin || set.staffPrice) && body.tariff != null ? int(body.tariff) : pr.tariff;
    const evac = body.evac != null ? int(body.evac) : pr.evac;
    await env.DB.prepare(
      "INSERT INTO cars(id,tenant_id,plate,type,model,color,brought_by,driver,phone,reason,in_at,note,tariff,evac,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in',?)"
    ).bind(id, T, plate, type, str(body.model), str(body.color, 40), str(body.broughtBy), str(body.driver), str(body.phone, 30),
      str(body.reason, 80), inAt, str(body.note, 500), tariff, evac, u.name).run();
    await logAct(env, T, u, "car_add", id, plate);
    return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()), 201);
  }

  let mm = path.match(/^\/api\/cars\/([\w-]+)(\/pay)?$/);
  if (mm) {
    const id = mm[1];
    const c = await env.DB.prepare("SELECT * FROM cars WHERE id=? AND tenant_id=?").bind(id, T).first();
    if (!c) return err("Topilmadi", 404);

    if (mm[2] && m === "POST") {
      if (c.status !== "in") return err("Bu mashina allaqachon chiqarilgan", 409);
      const now = Date.now();
      const d = Math.max(1, dayIdx(now) - dayIdx(c.in_at));
      const storage = d * c.tariff, total = storage + c.evac;
      const disc = Math.min(int(body.discount), total), paid = total - disc;
      const r = await env.DB.prepare(
        "UPDATE cars SET status='out', out_at=?, out_by=?, out_days=?, out_storage=?, out_evac=?, out_discount=?, out_paid=? WHERE id=? AND tenant_id=? AND status='in'"
      ).bind(now, u.name, d, storage, c.evac, disc, paid, id, T).run();
      if (!r.meta || r.meta.changes !== 1) return err("Bu mashina allaqachon chiqarilgan", 409);
      await logAct(env, T, u, "car_pay", id, `${c.plate}: ${paid} so'm, chegirma ${disc}`);
      return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()));
    }

    if (!mm[2] && m === "PUT") {
      if (c.status !== "in") return err("Chiqarilgan mashinani tahrirlab bo'lmaydi", 409);
      const plate = normPlate(body.plate);
      if (!plate) return err("Davlat raqamini kiriting");
      const dup = await env.DB.prepare("SELECT id FROM cars WHERE tenant_id=? AND status='in' AND plate=? AND id<>?").bind(T, plate, id).first();
      if (dup) return err("Bu raqam maydonda allaqachon bor", 409);
      const canPrice = admin || (await getSettings(env, T)).staffPrice;
      const tariff = canPrice && body.tariff != null ? int(body.tariff) : c.tariff;
      const evac = canPrice && body.evac != null ? int(body.evac) : c.evac;
      const type = TYPES.includes(body.type) ? body.type : c.type;
      await env.DB.prepare(
        "UPDATE cars SET plate=?,type=?,model=?,color=?,brought_by=?,driver=?,phone=?,reason=?,in_at=?,note=?,tariff=?,evac=? WHERE id=? AND tenant_id=?"
      ).bind(plate, type, str(body.model), str(body.color, 40), str(body.broughtBy), str(body.driver), str(body.phone, 30),
        str(body.reason, 80), int(body.inAt, 4e12) || c.in_at, str(body.note, 500), tariff, evac, id, T).run();
      await logAct(env, T, u, "car_edit", id, plate);
      return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()));
    }

    if (!mm[2] && m === "DELETE") {
      if (!admin) return err("Faqat boshliq o'chira oladi", 403);
      await deletePhotos(env, "car_id=? AND tenant_id=?", [id, T]);
      await env.DB.prepare("DELETE FROM cars WHERE id=? AND tenant_id=?").bind(id, T).run();
      await logAct(env, T, u, "car_delete", id, `${c.plate} (${c.status}${c.out_paid != null ? ", " + c.out_paid + " so'm" : ""})`);
      return J({ ok: true });
    }
  }

  // Rasmlar
  mm = path.match(/^\/api\/cars\/([\w-]+)\/photos$/);
  if (mm && m === "POST") {
    const c = await env.DB.prepare("SELECT id,plate,status FROM cars WHERE id=? AND tenant_id=?").bind(mm[1], T).first();
    if (!c) return err("Topilmadi", 404);
    if (c.status !== "in") return err("Chiqarilgan mashinaga rasm qo'shib bo'lmaydi", 409);
    const cnt = await env.DB.prepare("SELECT COUNT(*) n FROM car_photos WHERE car_id=?").bind(c.id).first();
    if (cnt.n >= PHOTO_MAX) return err(`Bitta mashinaga ko'pi bilan ${PHOTO_MAX} ta rasm`, 409);
    if (Number(req.headers.get("content-length") || 0) > PHOTO_BYTES + 2048) return err("Rasm juda katta", 413);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > PHOTO_BYTES) return err("Rasm juda katta", 413);
    const b = new Uint8Array(buf);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return err("Faqat JPEG rasm qabul qilinadi");
    const key = `t${T}/${crypto.randomUUID()}`;
    await env.PHOTOS.put(key, buf, { expirationTtl: PHOTO_TTL });
    await env.DB.prepare("INSERT INTO car_photos(tenant_id,car_id,key,at,by_name) VALUES(?,?,?,?,?)").bind(T, c.id, key, Date.now(), u.name).run();
    const row = await env.DB.prepare("SELECT id FROM car_photos WHERE key=?").bind(key).first();
    await logAct(env, T, u, "photo_add", c.id, c.plate);
    return J({ id: row.id, by: u.name }, 201);
  }
  mm = path.match(/^\/api\/photos\/(\d+)$/);
  if (mm) {
    const row = await env.DB.prepare("SELECT * FROM car_photos WHERE id=? AND tenant_id=?").bind(Number(mm[1]), T).first();
    if (!row) return err("Topilmadi", 404);
    if (m === "GET") {
      const data = await env.PHOTOS.get(row.key, { type: "arrayBuffer" });
      if (!data) return err("Rasm topilmadi", 404);
      return new Response(data, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
    }
    if (m === "DELETE") {
      if (!admin && row.by_name !== u.name) return err("Faqat boshliq yoki rasmni qo'shgan xodim o'chira oladi", 403);
      await deletePhotos(env, "id=?", [row.id]);
      await logAct(env, T, u, "photo_delete", row.car_id, null);
      return J({ ok: true });
    }
  }

  // Faqat boshliq
  if (!admin && (path.startsWith("/api/staff") || path === "/api/settings" || path === "/api/log" || path === "/api/export")) return err("Ruxsat yo'q", 403);

  if (path === "/api/export" && m === "GET") {
    const dp = (v, def) => {
      const mt = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return mt ? Date.UTC(+mt[1], +mt[2] - 1, +mt[3]) - TZ : def;
    };
    const nowDay = dayIdx(Date.now()) * DAY - TZ;
    const from = dp(url.searchParams.get("from"), nowDay - 30 * DAY);
    const to = dp(url.searchParams.get("to"), nowDay) + DAY;
    if (to <= from || to - from > 800 * DAY) return err("Sanalar noto'g'ri");
    const rows = (await env.DB.prepare("SELECT * FROM cars WHERE tenant_id=? AND status='out' AND out_at>=? AND out_at<? ORDER BY out_at LIMIT 5000").bind(T, from, to).all()).results;
    const head = ["№", "Chiqarilgan vaqt", "Davlat raqami", "Toifa", "Marka / model", "Qabul vaqti", "Kun", "Evakuatsiya", "Saqlash", "Chegirma", "To'langan", "Qabul qilgan xodim"].map((v) => ({ v, bold: true }));
    const body2 = rows.map((r, i) => [i + 1, fmtDT(r.out_at), r.plate, r.type || "", r.model || "", fmtDT(r.in_at), r.out_days, r.out_evac, r.out_storage, r.out_discount, r.out_paid, r.out_by || ""]);
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const total = [{ v: "Jami", bold: true }, "", "", "", "", "", { v: sum("out_days"), bold: true }, { v: sum("out_evac"), bold: true }, { v: sum("out_storage"), bold: true }, { v: sum("out_discount"), bold: true }, { v: sum("out_paid"), bold: true }, ""];
    const file = makeXlsx("Tushum", [head, ...body2, total], [5, 18, 16, 18, 22, 18, 7, 14, 14, 12, 14, 20]);
    const fn = `tushum_${new Date(from + TZ).toISOString().slice(0, 10)}_${new Date(to - DAY + TZ).toISOString().slice(0, 10)}.xlsx`;
    await logAct(env, T, u, "export", null, `${rows.length} ta yozuv`);
    return new Response(file, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${fn}"`, "cache-control": "no-store" } });
  }

  if (path === "/api/settings" && m === "PUT") {
    const prices = {};
    const inP = body.prices && typeof body.prices === "object" ? body.prices : {};
    for (const ty of TYPES) {
      const q = inP[ty] || {};
      prices[ty] = { tariff: int(q.tariff), evac: int(q.evac) };
    }
    await setSetting(env, T, "lot", str(body.name, 60) || "Shtrafstoyanka");
    await setSetting(env, T, "phone", str(body.phone, 60));
    await setSetting(env, T, "address", str(body.address, 150));
    await setSetting(env, T, "staffprice", body.staffPrice ? "1" : "0");
    await setSetting(env, T, "prices", JSON.stringify(prices));
    await setSetting(env, T, "tariff", prices["Yengil avtomobil"].tariff);
    await setSetting(env, T, "evac", prices["Yengil avtomobil"].evac);
    await logAct(env, T, u, "settings", null, "Narxlar va ma'lumotlar o'zgardi");
    return J(await getSettings(env, T));
  }
  if (path === "/api/log" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT at,staff,action,detail FROM log WHERE tenant_id=? ORDER BY id DESC LIMIT 100").bind(T).all()).results;
    return J({ log: rows });
  }
  if (path === "/api/staff" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT id,name,role,active FROM staff WHERE tenant_id=? ORDER BY active DESC, name").bind(T).all()).results;
    return J({ staff: rows });
  }
  if (path === "/api/staff" && m === "POST") {
    const name = str(body.name, 40), role = body.role === "admin" ? "admin" : "staff";
    if (!name) return err("Ismni kiriting");
    if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
    const ex = await env.DB.prepare("SELECT id FROM staff WHERE tenant_id=? AND name=?").bind(T, name).first();
    if (ex) return err("Bunday ism allaqachon bor", 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO staff(tenant_id,name,pin_hash,salt,role,active,created_at) VALUES(?,?,?,?,?,1,?)")
      .bind(T, name, await hashPin(String(body.pin), salt), salt, role, Date.now()).run();
    await logAct(env, T, u, "staff_add", null, `${name} (${role})`);
    return J({ ok: true }, 201);
  }
  mm = path.match(/^\/api\/staff\/(\d+)$/);
  if (mm && m === "PUT") {
    const id = Number(mm[1]);
    const t = await env.DB.prepare("SELECT * FROM staff WHERE id=? AND tenant_id=?").bind(id, T).first();
    if (!t) return err("Topilmadi", 404);
    if (body.pin != null) {
      if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
      const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
      await env.DB.prepare("UPDATE staff SET pin_hash=?, salt=? WHERE id=?").bind(await hashPin(String(body.pin), salt), salt, id).run();
      await logAct(env, T, u, "staff_pin_reset", null, t.name);
    }
    if (body.active != null) {
      if (id === u.id) return err("O'zingizni o'chira olmaysiz", 400);
      await env.DB.prepare("UPDATE staff SET active=? WHERE id=?").bind(body.active ? 1 : 0, id).run();
      await logAct(env, T, u, body.active ? "staff_enable" : "staff_disable", null, t.name);
    }
    return J({ ok: true });
  }

  return err("Topilmadi", 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/tg/hook" && req.method === "POST") return await handleHook(req, env, url);
      if (url.pathname === "/tg/setup") return await setupWebhook(env, url);
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return url.pathname.startsWith("/tg/") ? new Response("ok") : err("Server xatosi", 500);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReminder(env).catch((e) => console.error(e)));
    ctx.waitUntil(cleanupPhotos(env).catch((e) => console.error(e)));
  },
};

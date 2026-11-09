// Stoyanka hisobi: Cloudflare Worker (API) + D1 baza.
// Statik sayt public/ papkasidan beriladi, /api/* so'rovlari shu fayldan o'tadi.

const DAY = 864e5;
const TZ = 5 * 36e5; // Toshkent vaqti (UTC+5): kun hisobi shu bo'yicha
const dayIdx = (t) => Math.floor((t + TZ) / DAY);
const enc = new TextEncoder();

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (m, s = 400) => J({ error: m }, s);

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
  const q = "SELECT value FROM settings WHERE key='secret'";
  let r = await env.DB.prepare(q).first();
  if (!r) {
    const v = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('secret',?)").bind(v).run();
    r = await env.DB.prepare(q).first();
  }
  return r.value;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
async function makeToken(env, name) {
  const p = b64u(enc.encode(JSON.stringify({ n: name, e: Date.now() + 30 * DAY })));
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
  if (!o.e || o.e < Date.now()) return null;
  return (await env.DB.prepare("SELECT id,name,role FROM staff WHERE name=? AND active=1").bind(o.n).first()) || null;
}

/* ---------- ma'lumot ---------- */
async function getSettings(env) {
  const rows = (await env.DB.prepare("SELECT key,value FROM settings WHERE key IN ('lot','tariff','evac')").all()).results;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
  return { name: m.lot || "Shtrafstoyanka", tariff: num(m.tariff, 48000), evac: num(m.evac, 1000000) };
}
const setSetting = (env, k, v) =>
  env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(k, String(v))
    .run();
const logAct = (env, u, action, carId, detail) =>
  env.DB.prepare("INSERT INTO log(at,staff,action,car_id,detail) VALUES(?,?,?,?,?)")
    .bind(Date.now(), u ? u.name : null, action, carId || null, detail || null)
    .run();

function mapCar(r) {
  return {
    id: r.id, plate: r.plate, type: r.type || "", model: r.model || "", color: r.color || "",
    broughtBy: r.brought_by || "", driver: r.driver || "", phone: r.phone || "", reason: r.reason || "",
    inAt: r.in_at, note: r.note || "", tariff: r.tariff, evac: r.evac, status: r.status, createdBy: r.created_by || "",
    out: r.status === "out"
      ? { at: r.out_at, by: r.out_by, days: r.out_days, storage: r.out_storage, evac: r.out_evac, discount: r.out_discount, paid: r.out_paid }
      : null,
  };
}
const normPlate = (s) => str(s, 20).toUpperCase().replace(/\s+/g, " ");

async function failState(env, name) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind("fail:" + name.toLowerCase()).first();
  if (!r) return { n: 0, t: 0 };
  try { return JSON.parse(r.value); } catch { return { n: 0, t: 0 }; }
}

/* ---------- yo'nalishlar ---------- */
async function api(req, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  let body = {};
  if (m === "POST" || m === "PUT") {
    try { body = await req.json(); } catch { body = {}; }
  }

  // Ochiq yo'nalishlar
  if (path === "/api/status" && m === "GET") {
    const names = (await env.DB.prepare("SELECT name FROM staff WHERE active=1 ORDER BY name").all()).results.map((r) => r.name);
    return J({ setup: names.length === 0, names, lot: (await getSettings(env)).name });
  }
  if (path === "/api/setup" && m === "POST") {
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM staff").first();
    if (cnt.c > 0) return err("Tizim allaqachon sozlangan", 409);
    const name = str(body.name, 40), lot = str(body.lot, 60) || "Shtrafstoyanka";
    if (!name) return err("Ismni kiriting");
    if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO staff(name,pin_hash,salt,role,active,created_at) VALUES(?,?,?,?,1,?)")
      .bind(name, await hashPin(String(body.pin), salt), salt, "admin", Date.now()).run();
    await setSetting(env, "lot", lot);
    await logAct(env, { name }, "setup", null, "Tizim sozlandi");
    return J({ token: await makeToken(env, name) });
  }
  if (path === "/api/login" && m === "POST") {
    const name = str(body.name, 40), pin = String(body.pin || "");
    const f = await failState(env, name);
    if (f.n >= 5 && Date.now() - f.t < 5 * 60e3) return err("Juda ko'p xato urinish. 5 daqiqadan keyin qayta urinib ko'ring.", 429);
    const u = await env.DB.prepare("SELECT * FROM staff WHERE name=? AND active=1").bind(name).first();
    const ok = u && eq(await hashPin(pin, u.salt), u.pin_hash);
    if (!ok) {
      const n = Date.now() - f.t < 5 * 60e3 ? f.n + 1 : 1;
      await setSetting(env, "fail:" + name.toLowerCase(), JSON.stringify({ n, t: Date.now() }));
      return err("Ism yoki PIN noto'g'ri", 401);
    }
    await env.DB.prepare("DELETE FROM settings WHERE key=?").bind("fail:" + name.toLowerCase()).run();
    await logAct(env, u, "login");
    return J({ token: await makeToken(env, u.name) });
  }

  // Kirish talab qilinadigan yo'nalishlar
  const u = await whoAmI(env, req);
  if (!u) return err("Qayta kiring", 401);
  const admin = u.role === "admin";

  if (path === "/api/state" && m === "GET") {
    const cars = (await env.DB.prepare("SELECT * FROM cars WHERE status='in' OR out_at>=? ORDER BY in_at").bind(Date.now() - 400 * DAY).all()).results;
    return J({ me: { name: u.name, role: u.role }, settings: await getSettings(env), cars: cars.map(mapCar) });
  }

  if (path === "/api/me/pin" && m === "POST") {
    const row = await env.DB.prepare("SELECT * FROM staff WHERE id=?").bind(u.id).first();
    if (!eq(await hashPin(String(body.old || ""), row.salt), row.pin_hash)) return err("Eski PIN noto'g'ri", 403);
    if (!validPin(body.new)) return err("Yangi PIN 4 dan 8 gacha raqam bo'lsin");
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("UPDATE staff SET pin_hash=?, salt=? WHERE id=?").bind(await hashPin(String(body.new), salt), salt, u.id).run();
    await logAct(env, u, "pin_change");
    return J({ ok: true });
  }

  // Mashinalar
  if (path === "/api/cars" && m === "POST") {
    const plate = normPlate(body.plate);
    if (!plate) return err("Davlat raqamini kiriting");
    const dup = await env.DB.prepare("SELECT id FROM cars WHERE status='in' AND plate=?").bind(plate).first();
    if (dup) return err("Bu raqam maydonda allaqachon bor", 409);
    const set = await getSettings(env);
    const id = crypto.randomUUID();
    const inAt = int(body.inAt, 4e12) || Date.now();
    const tariff = admin && body.tariff != null ? int(body.tariff) : set.tariff;
    const evac = body.evac != null ? int(body.evac) : set.evac;
    await env.DB.prepare(
      "INSERT INTO cars(id,plate,type,model,color,brought_by,driver,phone,reason,in_at,note,tariff,evac,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'in',?)"
    ).bind(id, plate, str(body.type, 40), str(body.model), str(body.color, 40), str(body.broughtBy), str(body.driver), str(body.phone, 30),
      str(body.reason, 80), inAt, str(body.note, 500), tariff, evac, u.name).run();
    await logAct(env, u, "car_add", id, plate);
    return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()), 201);
  }

  let mm = path.match(/^\/api\/cars\/([\w-]+)(\/pay)?$/);
  if (mm) {
    const id = mm[1];
    const c = await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first();
    if (!c) return err("Topilmadi", 404);

    if (mm[2] && m === "POST") {
      if (c.status !== "in") return err("Bu mashina allaqachon chiqarilgan", 409);
      const now = Date.now();
      const d = Math.max(1, dayIdx(now) - dayIdx(c.in_at));
      const storage = d * c.tariff, total = storage + c.evac;
      const disc = Math.min(int(body.discount), total), paid = total - disc;
      const r = await env.DB.prepare(
        "UPDATE cars SET status='out', out_at=?, out_by=?, out_days=?, out_storage=?, out_evac=?, out_discount=?, out_paid=? WHERE id=? AND status='in'"
      ).bind(now, u.name, d, storage, c.evac, disc, paid, id).run();
      if (!r.meta || r.meta.changes !== 1) return err("Bu mashina allaqachon chiqarilgan", 409);
      await logAct(env, u, "car_pay", id, `${c.plate}: ${paid} so'm, chegirma ${disc}`);
      return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()));
    }

    if (!mm[2] && m === "PUT") {
      if (c.status !== "in") return err("Chiqarilgan mashinani tahrirlab bo'lmaydi", 409);
      const plate = normPlate(body.plate);
      if (!plate) return err("Davlat raqamini kiriting");
      const dup = await env.DB.prepare("SELECT id FROM cars WHERE status='in' AND plate=? AND id<>?").bind(plate, id).first();
      if (dup) return err("Bu raqam maydonda allaqachon bor", 409);
      const tariff = admin && body.tariff != null ? int(body.tariff) : c.tariff;
      const evac = admin && body.evac != null ? int(body.evac) : c.evac;
      await env.DB.prepare(
        "UPDATE cars SET plate=?,type=?,model=?,color=?,brought_by=?,driver=?,phone=?,reason=?,in_at=?,note=?,tariff=?,evac=? WHERE id=?"
      ).bind(plate, str(body.type, 40), str(body.model), str(body.color, 40), str(body.broughtBy), str(body.driver), str(body.phone, 30),
        str(body.reason, 80), int(body.inAt, 4e12) || c.in_at, str(body.note, 500), tariff, evac, id).run();
      await logAct(env, u, "car_edit", id, plate);
      return J(mapCar(await env.DB.prepare("SELECT * FROM cars WHERE id=?").bind(id).first()));
    }

    if (!mm[2] && m === "DELETE") {
      if (!admin) return err("Faqat boshliq o'chira oladi", 403);
      await env.DB.prepare("DELETE FROM cars WHERE id=?").bind(id).run();
      await logAct(env, u, "car_delete", id, `${c.plate} (${c.status}${c.out_paid != null ? ", " + c.out_paid + " so'm" : ""})`);
      return J({ ok: true });
    }
  }

  // Faqat boshliq
  if (!admin && (path.startsWith("/api/staff") || path === "/api/settings" || path === "/api/log")) return err("Ruxsat yo'q", 403);

  if (path === "/api/settings" && m === "PUT") {
    await setSetting(env, "lot", str(body.name, 60) || "Shtrafstoyanka");
    await setSetting(env, "tariff", int(body.tariff));
    await setSetting(env, "evac", int(body.evac));
    await logAct(env, u, "settings", null, `tarif ${int(body.tariff)}, evakuatsiya ${int(body.evac)}`);
    return J(await getSettings(env));
  }
  if (path === "/api/log" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT at,staff,action,detail FROM log ORDER BY id DESC LIMIT 100").all()).results;
    return J({ log: rows });
  }
  if (path === "/api/staff" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT id,name,role,active FROM staff ORDER BY active DESC, name").all()).results;
    return J({ staff: rows });
  }
  if (path === "/api/staff" && m === "POST") {
    const name = str(body.name, 40), role = body.role === "admin" ? "admin" : "staff";
    if (!name) return err("Ismni kiriting");
    if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
    const ex = await env.DB.prepare("SELECT id FROM staff WHERE name=?").bind(name).first();
    if (ex) return err("Bunday ism allaqachon bor", 409);
    const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO staff(name,pin_hash,salt,role,active,created_at) VALUES(?,?,?,?,1,?)")
      .bind(name, await hashPin(String(body.pin), salt), salt, role, Date.now()).run();
    await logAct(env, u, "staff_add", null, `${name} (${role})`);
    return J({ ok: true }, 201);
  }
  mm = path.match(/^\/api\/staff\/(\d+)$/);
  if (mm && m === "PUT") {
    const id = Number(mm[1]);
    const t = await env.DB.prepare("SELECT * FROM staff WHERE id=?").bind(id).first();
    if (!t) return err("Topilmadi", 404);
    if (body.pin != null) {
      if (!validPin(body.pin)) return err("PIN 4 dan 8 gacha raqam bo'lsin");
      const salt = hex(crypto.getRandomValues(new Uint8Array(12)));
      await env.DB.prepare("UPDATE staff SET pin_hash=?, salt=? WHERE id=?").bind(await hashPin(String(body.pin), salt), salt, id).run();
      await logAct(env, u, "staff_pin_reset", null, t.name);
    }
    if (body.active != null) {
      if (id === u.id) return err("O'zingizni o'chira olmaysiz", 400);
      await env.DB.prepare("UPDATE staff SET active=? WHERE id=?").bind(body.active ? 1 : 0, id).run();
      await logAct(env, u, body.active ? "staff_enable" : "staff_disable", null, t.name);
    }
    return J({ ok: true });
  }

  return err("Topilmadi", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return err("Server xatosi", 500);
    }
  },
};

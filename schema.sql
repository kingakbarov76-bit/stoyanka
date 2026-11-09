-- Ko'p mijozli sxema: har bir stoyanka (tenant) o'z ma'lumotiga ega.
-- tenant_id = 0 faqat umumiy sozlamalar uchun (maxfiy kalit, narx, aloqa).
CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, at INTEGER NOT NULL, days INTEGER NOT NULL, amount INTEGER);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, pin_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE(tenant_id, name));
CREATE TABLE IF NOT EXISTS cars (id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, plate TEXT NOT NULL, type TEXT, model TEXT, color TEXT, brought_by TEXT, driver TEXT, phone TEXT, reason TEXT, in_at INTEGER NOT NULL, note TEXT, tariff INTEGER NOT NULL, evac INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'in', created_by TEXT, out_at INTEGER, out_by TEXT, out_days INTEGER, out_storage INTEGER, out_evac INTEGER, out_discount INTEGER, out_paid INTEGER);
CREATE TABLE IF NOT EXISTS settings (tenant_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant_id, key));
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, at INTEGER NOT NULL, staff TEXT, action TEXT NOT NULL, car_id TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS idx_cars_tenant ON cars(tenant_id, status, plate);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_log_tenant ON log(tenant_id, id);

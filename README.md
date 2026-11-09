# Stoyanka hisobi

Shtrafstoyanka uchun hisob tizimi: mashinalarni qabul qilish, saqlash puli hisobi, to'lov va chiqarish, xodimlar, hisobot.

- `public/index.html`: telefon uchun sayt
- `src/index.js`: Cloudflare Worker (API)
- `schema.sql`: Cloudflare D1 baza jadvallari (baza allaqachon yaratilgan)
- `wrangler.jsonc`: sozlama (D1 bazaga ulanish shu yerda)

## Joylash (Cloudflare)

1. Cloudflare Dashboard, **Workers & Pages**, **Create**, **Import a repository**.
2. Shu repoyni tanlang. Build command bo'sh, deploy command: `npx wrangler deploy`.
3. Tayyor bo'lgach `https://stoyanka.<hisob>.workers.dev` manzili beriladi.
4. Saytni birinchi marta ochganda boshliq ismi va PIN so'raladi.

## Qoidalar

- Kun hisobi Toshkent vaqti (UTC+5) bo'yicha: qabul kunidan bugungacha, kamida 1 kun.
- Yakuniy summani server hisoblaydi.
- Xodim tarifni o'zgartira olmaydi, mashinani o'chira olmaydi, hisobotni ko'rmaydi.
- Barcha harakatlar tarixga yoziladi.

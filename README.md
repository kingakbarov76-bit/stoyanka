# Stoyanka hisobi

Shtrafstoyanka uchun hisob tizimi. Bir joyda ko'p mijoz (stoyanka) ishlaydi, har birining ma'lumoti alohida. Egasi mijozlarni va ularning obuna muddatini Telegram bot orqali boshqaradi.

- `public/index.html`: telefon uchun sayt
- `src/index.js`: Cloudflare Worker (API)
- `src/bot.js`: Telegram boshqaruv boti (faqat egasi uchun)
- `schema.sql`: Cloudflare D1 baza jadvallari
- `wrangler.jsonc`: sozlama (D1 ulanishi, kunlik eslatma)

## Joylash

Repo Cloudflare Workers'ga ulangan. `main` ga push qilinsa o'zi qayta joylanadi.

## Telegram botni ulash (bir marta)

1. Telegramda @BotFather orqali yangi bot oching va tokenni oling.
2. Cloudflare, Workers, `stoyanka`, Settings, **Variables and Secrets** bo'limida **Secret** sifatida qo'shing: `BOT_TOKEN` (token). Deploy qiling.
3. Brauzerda `https://<sayt manzili>/tg/setup` ni oching. "Bot ulandi" yozuvi chiqadi.
4. Botga `/start` yozing. U sizning Telegram ID raqamingizni ko'rsatadi.
5. Shu raqamni **Secret** sifatida `OWNER_ID` nomi bilan qo'shing va yana deploy qiling. Shundan keyin bot faqat sizga javob beradi.

## Bot buyruqlari

- `/yangi Nomi 30 [summa]`: yangi mijoz, 30 kun. Havola beriladi.
- `/royxat`, `/t5`: mijozlar ro'yxati va kartasi (tugmalar: +30, +90, +365 kun, to'xtatish, havola)
- `/uzaytir 5 30 [summa]`, `/toxtat 5`, `/yoq 5`, `/link 5`
- `/narx 500000`: 30 kunlik odatiy narx (tushum hisobi uchun)
- `/aloqa @username`: muddati tugagan mijozga ko'rsatiladigan aloqa
- `/hisob`: holat va tushum
- `/ochir 5 HA`: mijoz va uning barcha ma'lumotini o'chirish

Har kuni 09:00 (Toshkent) 3 kun ichida tugaydigan mijozlar haqida eslatma keladi.

## Qoidalar

- Mijoz saytga faqat o'zining havolasi (`/?k=KOD`) orqali kiradi. Birinchi ochgan odam boshliq bo'ladi.
- Muddat tugasa yoki to'xtatilsa, mijoz kira olmaydi, lekin ma'lumoti saqlanadi. Uzaytirilgach hammasi avvalgidek ochiladi.
- Kun hisobi Toshkent vaqti (UTC+5) bo'yicha: qabul kunidan bugungacha, kamida 1 kun.
- Yakuniy summani server hisoblaydi. Xodim tarifni o'zgartira olmaydi, mashinani o'chira olmaydi, hisobotni ko'rmaydi.
- Barcha harakatlar tarixga yoziladi.

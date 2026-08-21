# WhatsApp Sales Bot

Bot WhatsApp untuk jualan produk digital (akun, lisensi, top-up) lengkap dengan dashboard admin
berbasis web. Satu proses Node.js: bot WhatsApp, REST API, WebSocket realtime, dan penjadwal cron
jalan bersamaan.

> **Untuk AI agent (Claude, Codex, Cursor, Gemini, Copilot):** baca [AGENTS.md](AGENTS.md) dulu —
> di situ ada peta arsitektur, urutan router, konvensi, dan aturan wajib project ini.
> Aturan operasional dari Owner ada di [DEVELOPMENT_RULES.md](DEVELOPMENT_RULES.md).

---

## Fitur

**Toko & transaksi**
Katalog produk, keranjang, checkout, pembayaran QRIS otomatis (Casaku) dengan fallback Midtrans dan
QRIS manual, pengiriman kredensial otomatis, garansi, riwayat pesanan, kupon diskon, deposit saldo,
program referral, dan lapak reseller antar-member.

**Moderasi grup**
Anti-link, anti-spam dengan sistem warning + auto-kick, welcome/goodbye card, tagall, ban/mute,
mode grup (`all` / `sales` / `off`), dan toggle fitur per-grup.

**Hiburan & ekonomi**
Kuis, tebak gambar/emoji/kata/lagu, susun kata, sambung kata, werewolf, slot, suit, rampok, daily
reward, sistem poin + XP + level dengan kartu level-up.

**Media**
Downloader TikTok / Instagram / YouTube / Facebook / Twitter, pembuat stiker (statis & animasi),
quote sticker, brat, konversi gambar/video, TTS, dan efek audio.

**Premium & AI**
Tiga tier (Silver / Gold / Diamond), asisten AI Gemini, OCR gambar & PDF, dan tools PDF
(merge, split, img2pdf, pdf2txt).

**Dashboard admin**
Kelola produk & stok, pesanan, pelanggan, kupon, FAQ, broadcast, live chat dua arah dengan
takeover, statistik penjualan, backup database, dan 2FA (TOTP).

---

## Kebutuhan sistem

- **Node.js 18+**
- **Python** + `yt-dlp` (dipakai downloader; `pip install -U yt-dlp` dijalankan otomatis saat start)
- ffmpeg **tidak perlu diinstal** — sudah dibundel lewat `@ffmpeg-installer/ffmpeg`

## Instalasi

```bash
npm install
cp .env.example .env
```

Lalu isi `.env`. **Tiga variabel ini wajib** — tanpa salah satunya bot langsung berhenti saat start:

```env
JWT_SECRET=<string acak minimal 32 karakter>
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=<hash bcrypt dari password login dashboard>
```

Bikin hash password-nya:

```bash
node -e "console.log(require('bcryptjs').hashSync('passwordkamu', 10))"
```

> ⚠️ `.env.example` belum lengkap — `ADMIN_PASSWORD_HASH` tidak ada di situ, dan `OWNER_NUMBER`
> yang tercantum sebenarnya tidak dibaca oleh kode. Daftar env var yang benar dan lengkap ada di
> [AGENTS.md §14](AGENTS.md#14-environment-variables).

**Opsional:** `PORT` (default 3000), `CORS_ORIGIN`, `NODE_ENV`, `PAIRING_NUMBER`,
`BACKUP_RETENTION_DAYS`, `GEMINI_API_KEY`, `APP_URL`, dan blok `CASAKU_*` untuk QRIS otomatis.

## Menjalankan

```bash
npm start
```

Windows bisa juga klik dua kali `start-bot.bat`.

Saat pertama jalan, **QR code muncul di terminal** (bukan di dashboard) — scan pakai WhatsApp >
Perangkat Tertaut. Kalau jalan headless, set `PAIRING_NUMBER` di `.env` untuk dapat kode pairing
8 digit sebagai ganti QR.

Dashboard: **http://localhost:3000** → login di `/login.html`.

## Menghentikan

`CTRL+C` dua kali. Nothing menangani SIGINT, jadi sebelum restart pastikan proses lama benar-benar
mati:

```bash
taskkill /F /IM node.exe      # Windows
```

Kalau tidak, port 3000 masih dipegang proses lama dan start berikutnya gagal `EADDRINUSE` — tapi
bot WhatsApp-nya tetap nyala, jadi gejalanya terlihat seperti "dashboard-nya hilang".

---

## Struktur

| File | Isi |
|---|---|
| `index.js` | Entry point. Urutan boot: server → bot → scheduler (urutannya penting) |
| `bot.js` | Socket Baileys, pipeline pesan masuk, router perintah, antrean kirim + anti-ban |
| `database.js` | Semua akses SQLite (~213 fungsi, 56 tabel) |
| `server.js` | Express API dashboard + webhook pembayaran + `botState` |
| `scheduler.js` | Cron: reminder, expiry order, rekonsiliasi, backup, laporan harian, jadwal sholat |
| `src/handlers/` | Handler pelanggan, admin grup, dan PDF |
| `src/payment/` | Gateway Casaku, webhook, worker pengiriman produk |
| `funHandler.js` · `entertainmentHandler.js` · `werewolfGame.js` | Game & hiburan |
| `mediaHandler.js` · `cardGenerator.js` | Downloader, stiker, konversi, kartu gambar |
| `commandRegistry.js` | Isi `.menu` — perintah baru wajib didaftarkan di sini agar terlihat user |
| `plugins/` | Plugin modular, dimuat saat start ([kontrak plugin](AGENTS.md#13-plugins)) |
| `public/` | Frontend dashboard (HTML tunggal) + aset game |

## Catatan pengembangan

- **Tidak ada test, linter, atau build step.** Validasi = `node --check` + restart + tes manual di
  DM dan grup.
- **Tidak ada hot-reload.** Setiap ubah `.js` harus restart.
- **State runtime tidak masuk Git** (`session/`, `*.db`, `backups/`, `tmp/`, `public/uploads/`,
  `.env`). Clone baru = WhatsApp belum tertaut dan database kosong; skema tabel dibuat otomatis,
  datanya tidak.
- **Jangan pernah commit `session/` atau `.env`** — `session/` berisi kredensial yang memberi
  kendali penuh atas akun WhatsApp, `.env` berisi `JWT_SECRET` dan kunci pembayaran.

Repositori resmi: https://github.com/Bar1965/Bot.git

# DEVELOPMENT RULES & GUIDELINES
**Whatsapp Sales Bot Project**

Dokumen ini berisi standar prosedur, panduan pengembangan (development), dan langkah-langkah mitigasi bug untuk memastikan stabilitas bot. Harap patuhi aturan ini sebelum melakukan deploy atau menyelesaikan perbaikan.

---

## 1. Standar Pengujian (Testing)
Setiap kali ada penambahan fitur atau perbaikan bug, langkah-langkah pengujian berikut **wajib** dilakukan:
- **Restart Wajib:** Perubahan pada file `.js` tidak akan otomatis teraplikasi. Pastikan untuk selalu me-restart bot setiap selesai merubah kode logika.
- **Tes Jalur Pribadi (DM) vs Grup:** Fitur bot harus selalu dites di dua lingkungan yang berbeda:
  - Private Chat (DM)
  - Group Chat
- **Cek Routing:** Pastikan perintah yang dikhususkan untuk DM (seperti *checkout*, histori, keranjang) tidak terekspos datanya di grup (harus redirect / DM only).
- **Cek Admin / Owner:** Pastikan fitur eksklusif (seperti `.join`, `.ban`, reset poin) ditolak apabila yang mengeksekusi bukan Owner atau Admin.

## 2. Mitigasi Bug Umum
Dari pengalaman pengembangan sebelumnya, perhatikan hal-hal rawan berikut:
- **NaN / Null di Poin & Ekonomi:**
  - Jika melakukan operasi penambahan atau pengurangan pada database, **selalu periksa validitas angka**. Gunakan mitigasi seperti `isNaN(amount)` dan pastikan angka diubah ke integer (`parseInt()`, `Math.floor()`).
  - Set default value (contoh: `points || 0`) pada kalkulasi variabel.
- **Auto-Leave & Asynchronous Task (Cron):**
  - Untuk setiap job menggunakan `setInterval`, pastikan di-wrap dengan `try...catch` agar bot tidak *crash* ketika salah satu antrean gagal (misal: gagal keluar karena sudah di-kick manual).
- **Restart Gantung / Port Bentrok:**
  - Pastikan proses lama (`node.exe`) benar-benar sudah mati sepenuhnya (di-*kill*) sebelum me-restart, karena Dashboard Web (misal: port 3000) tidak dapat menyala dua kali (EADDRINUSE).
- **Spam Log:**
  - Jangan biarkan console dipenuhi spam dari *library* (seperti `libsignal`). Nonaktifkan *logging* debug untuk fungsi yang dipanggil sangat intens agar server tidak cepat kehabisan memori.

## 3. Workflow Implementasi Fitur Baru
1. **Analisis Konteks & Dampak:** Pahami di mana fungsi akan diletakkan (apakah di `bot.js`, `database.js`, atau handler lain). Jangan sampai pengecekan kondisi global (misalnya `!isGroup`) malah memblokir fungsi dasar lainnya.
2. **Implementasi Bertahap:**
   - Tulis query database terlebih dahulu (DAO).
   - Hubungkan handler logikanya (logic).
   - Terapkan di router utama (`bot.js`).
3. **Double-Check Syntax:** Pastikan tidak ada karakter nyasar atau braket yang hilang sebelum di-*save*.
4. **Kill Node Lama -> Start Ulang -> Tes Langsung.**

> **Pesan Untuk AI / Developer:** Jika Anda diminta memperbaiki bug atau menambahkan fitur di masa mendatang, **BACA DOKUMEN INI TERLEBIH DAHULU** sebagai *checklist* standar operasional Anda!


### 🚨 MUST DO: PROTOKOL WAJIB PASCA-UPDATE (ANTI-SILENT CRASH)
Berdasarkan instruksi langsung dari Owner, **setiap kali ada update, perbaikan, atau injeksi kode baru (terutama di file Handler)**, wajib hukumnya melakukan langkah ini:
1. **Lakukan `node -c` (Syntax Check)** pada setiap file yang dimodifikasi.
2. **Restart Daemon/Proses Bot**. Jangan pernah asumsikan bot berjalan di background dengan sendirinya setelah diubah kodenya.
3. **Cek Log Terminal / Background Task:** Perhatikan baik-baik apakah ada `ReferenceError` atau `TypeError` yang muncul di log saat bot merespons pesan (terutama jika ada indikator "Spam Warning"). 
4. **Verifikasi Jalur Routing:** Tanyakan dan pastikan kepada Owner bahwa bot dapat menerima *command* secara normal baik di **Chat Pribadi** maupun di **Grup**. Jangan anggap tugas selesai sebelum mendapat konfirmasi bahwa bot benar-benar merespons tanpa *error*.
5. **Kebijakan Toggle Per-Grup:** Jika ada fitur yang bisa di-ON atau OFF-kan (Switch Toggle), pengaturannya **wajib** berlaku pada tingkat grup (Per-Grup), BUKAN global (kecuali fitur tersebut adalah fitur owner). Gunakan tabel `group_settings` untuk menyimpan konfigurasinya.

6. **Git / Repository Push:** Jika perbaikan atau fitur baru telah dikonfirmasi selesai dan **TIDAK ADA BUG** oleh Owner, agen AI diwajibkan untuk langsung melakukan push/update perubahan kode tersebut ke repository resmi: https://github.com/Bar1965/Bot.git.

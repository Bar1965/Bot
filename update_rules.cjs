const fs = require('fs');
let rules = fs.readFileSync('DEVELOPMENT_RULES.md', 'utf8');

const additionalRules = \

### 🚨 MUST DO: PROTOKOL WAJIB PASCA-UPDATE (ANTI-SILENT CRASH)
Berdasarkan instruksi langsung dari Owner, **setiap kali ada update, perbaikan, atau injeksi kode baru (terutama di file Handler)**, wajib hukumnya melakukan langkah ini:
1. **Lakukan \
ode -c\ (Syntax Check)** pada setiap file yang dimodifikasi.
2. **Restart Daemon/Proses Bot**. Jangan pernah asumsikan bot berjalan di background dengan sendirinya setelah diubah kodenya.
3. **Cek Log Terminal / Background Task:** Perhatikan baik-baik apakah ada \ReferenceError\ atau \TypeError\ yang muncul di log saat bot merespons pesan (terutama jika ada indikator "Spam Warning"). 
4. **Verifikasi Jalur Routing:** Tanyakan dan pastikan kepada Owner bahwa bot dapat menerima *command* secara normal baik di **Chat Pribadi** maupun di **Grup**. Jangan anggap tugas selesai sebelum mendapat konfirmasi bahwa bot benar-benar merespons tanpa *error*.
\;

if (!rules.includes('PROTOKOL WAJIB PASCA-UPDATE')) {
    rules += additionalRules;
    fs.writeFileSync('DEVELOPMENT_RULES.md', rules);
    console.log('DEVELOPMENT_RULES.md updated with strict post-update protocol.');
}

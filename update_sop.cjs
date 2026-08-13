const fs = require('fs');
let rules = fs.readFileSync('DEVELOPMENT_RULES.md', 'utf8');

const newRule = \
5. **Kebijakan Toggle Per-Grup:** Jika ada fitur yang bisa di-ON atau OFF-kan (Switch Toggle), pengaturannya **wajib** berlaku pada tingkat grup (Per-Grup), BUKAN global (kecuali fitur tersebut adalah fitur owner). Gunakan tabel \group_settings\ untuk menyimpan konfigurasinya.\;

rules = rules.replace('4. **Verifikasi Jalur Routing:** Tanyakan dan pastikan kepada Owner bahwa bot dapat menerima *command* secara normal baik di **Chat Pribadi** maupun di **Grup**. Jangan anggap tugas selesai sebelum mendapat konfirmasi bahwa bot benar-benar merespons tanpa *error*.', 
'4. **Verifikasi Jalur Routing:** Tanyakan dan pastikan kepada Owner bahwa bot dapat menerima *command* secara normal baik di **Chat Pribadi** maupun di **Grup**. Jangan anggap tugas selesai sebelum mendapat konfirmasi bahwa bot benar-benar merespons tanpa *error*.' + newRule);

fs.writeFileSync('DEVELOPMENT_RULES.md', rules);
console.log('SOP Updated.');

/**
 * CATATAN PEMBARUAN SISTEM BOT
 *
 * Dulu file ini cuma satu string raksasa. Sekarang datanya terstruktur per
 * versi karena dipakai tiga tempat sekaligus:
 *   1. `.update` / `.changelog` — menampilkan rincian penuh versi terbaru.
 *   2. Pengumuman otomatis saat bot online (src/utils/startupAnnounce.js) —
 *      memakai `sorotan`, bukan rincian penuh, supaya tidak jadi tembok teks.
 *   3. Perbandingan versi — pengumuman ke grup hanya dikirim sekali per versi,
 *      bukan tiap kali koneksi WhatsApp tersambung ulang.
 *
 * Menambah versi baru: taruh entri paling baru di indeks 0 dan naikkan
 * BOT_VERSION. Jangan lupa `sorotan` — itu yang dibaca member di grup.
 */

export const BOT_VERSION = 'v3.0.1';

export const RIWAYAT_VERSI = [
  {
    versi: 'v3.0.1',
    nama: 'Bot Tidak Bisa Menendang Dirinya Sendiri',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '🛡️ *Perbaikan penting:* `.kick @bot` dulu benar-benar membuat bot KELUAR dari grup. Sekarang ditolak.',
      '🔁 Balasan ke pesan bot dan `.del` di grup juga ikut diperbaiki — dua-duanya diam-diam rusak oleh sebab yang sama.'
    ],
    rincian: [
      {
        judul: '🛡️ *BOT BISA MENENDANG DIRINYA SENDIRI*',
        poin: [
          'Dilaporkan owner: kalau admin menjalankan perintah kick ke bot, botnya keluar sendiri dari grup.',
          'Penjaganya sebenarnya sudah ada — tapi cuma membandingkan *nomor HP* bot.',
          '🆔 Satu akun WhatsApp sekarang punya *dua identitas dengan angka yang sama sekali berbeda*: nomor HP (`@s.whatsapp.net`) dan LID (`@lid`).',
          'Di grup modern, men-tag bot menghasilkan *@lid*. Angka LID tidak memuat nomor HP sama sekali, jadi penjaganya lewat dan perintah keluar-grup benar-benar dijalankan atas bot sendiri. Bot punya hak admin, jadi permintaannya berhasil.',
          '✅ Sekarang bot membandingkan *kedua* identitasnya, dan mencocokkannya *persis* — bukan sekadar "mengandung".',
          '🔓 Efek samping baik: dulu anggota yang nomornya kebetulan memuat digit nomor bot ikut kebal di-kick. Sekarang tidak lagi.',
          '🚫 Bot juga tidak akan pernah lagi memoderasi dirinya sendiri lewat anti-link maupun anti-spam.'
        ]
      },
      {
        judul: '🔁 *DUA HAL LAIN YANG DIAM-DIAM RUSAK*',
        poin: [
          'Sebab yang sama membuat *balasan ke pesan bot* tidak pernah terdeteksi di grup — fitur yang bergantung padanya seperti tidak ada.',
          '`.del` untuk menghapus pesan bot sendiri salah mengambil jalur "hapus pesan orang lain", jadi sering gagal.',
          '🎮 `.suit @bot` juga sekarang ditolak dengan benar di grup ber-LID.'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji regresi baru `npm run test:identity` — 31 pemeriksaan, semuanya lewat.',
          'Termasuk memastikan arah sebaliknya tetap aman: anggota sungguhan *tetap bisa* di-kick admin.',
          'Ujinya juga menghitung jumlah jalur yang bisa mengeluarkan peserta dari grup, dan gagal kalau ada jalur baru yang lupa dipasangi penjaga.'
        ]
      }
    ]
  },
  {
    versi: 'v3.0',
    nama: 'Arena Punya Besok',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '🔥 *`.tcg daily` sekarang punya BERUNTUN.* Makin panjang tanpa bolong, makin besar hadiahnya — plus hadiah tonggak di hari ke-3, 7, 14, dan 30.',
      '⚔️ *Duel sekarang meninggalkan jejak.* Ada poin peringkat, tier Perunggu→Legenda, dan musim 30 hari dengan hadiah akhir musim.',
      '🌌 *Menara Abadi:* sesudah lantai 30 tamat, sekarang ada lantai yang tidak pernah habis. Elemen penjaganya berputar tiap lantai.',
      '🏷️ *17 gelar permanen* yang tampil di menu, hasil duel, dan papan peringkat — plus tonggak hadiah tiap kelipatan jenis kartu.',
      '🤝 *Barter kartu antar pemain.* Duplikat yang selama ini cuma bisa dijual sekarang bisa ditukar dengan teman di grup.',
      '🎯 *Misi harian diundi tiap hari*, tidak lagi tiga misi yang sama selamanya — dan ada misi mingguan yang reset tiap Senin.'
    ],
    rincian: [
      {
        judul: '🔥 *BERUNTUN HARIAN — ALASAN BUKA BOT BESOK*',
        poin: [
          'Dulu `.tcg daily` memberi 50 Keping yang sama persis, entah kamu main hari pertama atau hari ke-200. Tidak ada apa pun yang hilang kalau bolong sehari.',
          '📈 Sekarang tiap hari beruntun menambah *+10 Keping* bonus, sampai maksimal +100. Hari ke-11 dan seterusnya: 150 Keping per hari.',
          '🎁 *Tonggak beruntun:* hari ke-3 (ransum), ke-7 (150 Keping + 3 Serpihan Rare), ke-14 (300 Keping + Bekal Agung), ke-30 (*800 Keping* + 3 Serpihan Legendary).',
          '♾️ Tonggak hari ke-30 berulang tiap kelipatan 30 — hari ke-60, ke-90, dan seterusnya tetap ada yang ditunggu.',
          '⚠️ Bolong satu hari saja, beruntun kembali ke 1. Rekor terpanjangmu tetap disimpan.',
          '📊 Papan peringkat baru: `.lb tcgstreak`.'
        ]
      },
      {
        judul: '⚔️ *PERINGKAT & MUSIM — DUEL YANG BERARTI*',
        poin: [
          'Sebelum ini, menang duel cuma memindahkan Keping taruhan. Besoknya tidak ada bedanya antara yang menang 20 kali dan yang tidak pernah main.',
          '🏆 Sekarang tiap duel menggeser *poin peringkat* (Elo). Menang lawan yang lebih kuat memberi lebih banyak; menang lawan yang jauh lebih lemah tetap memberi minimal +1.',
          '🥉 Tier: Perunggu · Perak · Emas · Platina · Diamond · Master · Legenda.',
          '🗓️ *Musim 30 hari.* Di akhir musim, hadiah dibayar sesuai tier — Legenda dapat 2.500 Keping + 3 Serpihan Mythic. Diamond ke atas dapat *gelar musiman permanen*.',
          '↩️ Poin direset lunak tiap musim (separuh jarak dari 1000, minimal 800), jadi pemain baru punya peluang tanpa membuat pemain lama mulai dari nol.',
          '🛡️ Anti akun kembar: maksimal *3 duel berperingkat* melawan orang yang sama per hari, dan sparring cuma berbobot separuh dengan jatah 5 laga/hari.',
          '📊 `.tcg rank`, `.tcg rank top`, dan `.lb peringkat`.'
        ]
      },
      {
        judul: '🌌 *MENARA ABADI — SESUDAH LANTAI 30 BUKAN LAGI UJUNG*',
        poin: [
          'Menara Penjaga berakhir di lantai 30, dan itu memang seharusnya. Masalahnya, sesudah itu tidak ada apa pun lagi — pemain paling rajin yang paling cepat kehabisan.',
          '🕳️ Menara Abadi terbuka begitu 30 lantai tamat. Lantainya dibangkitkan dari nomornya, jadi tidak pernah habis.',
          '🔄 *Elemen penjaga berputar tiap lantai* — satu dek tidak akan cukup selamanya. Dua kartu bertema, satu penyimpang.',
          '⚖️ Kurva kesulitannya diukur, bukan dikira: dek terbaik menang ~96% di lantai 20, ~86% di lantai 25, ~59% di lantai 30, ~23% di lantai 40, ~2% di lantai 50.',
          '💰 Hadiah Keping *dibatasi atas* supaya lantai tanpa ujung tidak jadi keran Keping tanpa ujung. Yang tumbuh tanpa batas adalah angka lantainya.',
          '📊 Papan terdalam: `.lb abadi`.',
          '_Bonus: kemenangan Menara Abadi juga menghitung misi harian MENARA — dulu misi itu jadi mustahil begitu lantai 30 tamat._'
        ]
      },
      {
        judul: '🏷️ *GELAR & TONGGAK KOLEKSI*',
        poin: [
          '17 gelar permanen dengan syarat yang terpampang jelas: Kolektor, Kurator Nusantara, Sang Pelengkap, Penakluk Menara, Penembus Kabut, Penjelajah Void, Rajin Absen, Tak Pernah Absen, Seratus Hari, Pemburu Mitos, Raja Mitos, Pandai Besi, Duelis Ulung, Legenda Arena, Pedagang Ulung, dan lainnya.',
          '🎛️ Pasang satu gelar untuk dipajang: `.tcg gelar <id>`. Muncul di menu, hasil duel, dan papan peringkat.',
          '🏛️ *Tonggak koleksi:* hadiah sekali seumur hidup di 10, 20, 30, 40, 50, dan 60 jenis kartu. Yang terakhir: *2.500 Keping + 3 Serpihan Mythic*.',
          '📍 Gelar dinilai ulang tiap kali `.tcg gelar` dibuka — tidak ada yang bisa terlewat.'
        ]
      },
      {
        judul: '🤝 *BARTER KARTU — DUPLIKAT AKHIRNYA PUNYA GUNA SOSIAL*',
        poin: [
          '`.tcg barter @member <kartumu> <kartunya>` — tawaran dua arah, disetujui dengan `.tcg deal` atau ditolak dengan `.tcg batal`.',
          '🔒 *Hanya duplikat yang bisa berpindah.* Salinan terakhir dari satu jenis tidak akan pernah bisa hilang dari koleksimu — aturan yang sama dengan `.tcg jual` dan `.tcg serpih`.',
          '📊 Level kartu tidak ikut pindah: level adalah hasil grinding serpihan milik pemiliknya.',
          '⏱️ Kuota *3 barter per hari* per orang, dan hanya bisa di dalam grup supaya semua orang melihat pertukarannya.',
          'Setiap barter dicatat — bisa diaudit lewat `.tcg cek`.'
        ]
      },
      {
        judul: '🎯 *MISI DIUNDI, DAN ADA MISI MINGGUAN*',
        poin: [
          'Dulu misi harian selalu tiga yang sama: tarik 1 kartu, menang 1 Menara, menang 1 duel. Selamanya.',
          'Lebih buruk lagi, "menang 1 pertarungan Menara" jadi *mustahil* begitu pemain menamatkan lantai 30 — tidak ada lantai tersisa untuk dimenangkan.',
          '🎲 Sekarang tiga misi diundi tiap hari dari 13 misi berbeda, satu dari tiap keranjang: solo, tempur/sosial, dan koleksi. Satu misi *selalu* bisa dikerjakan sendirian.',
          '📆 *Misi mingguan* (`.tcg mingguan`) reset tiap Senin: 12 kemenangan, 15 tarikan, 3 kenaikan level. Bonus tuntas: 500 Keping + 2 Bekal Agung + 2 Serpihan Legendary.',
          '✅ Progres mingguan terisi otomatis dari aktivitas harian — tidak ada yang perlu diklaim dua kali.'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji asap Arena naik dari 88 jadi 121 perintah dan dari 110 jadi 211 pemeriksaan — semuanya lewat.',
          'Termasuk: beruntun putus & lanjut, pergantian musim beserta hadiahnya, batas duel per pasangan, penolakan barter kartu terakhir, dan 200 lantai Menara Abadi diperiksa satu per satu.',
          'Kurva kesulitan Menara Abadi dikalibrasi dengan mencari dek terbaik dari *31.390 kombinasi legal* untuk tiap lantai.'
        ]
      }
    ]
  },
  {
    versi: 'v2.9',
    nama: 'Kartu Punya Watak',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '🎴 *Tiap kartu sekarang punya PERAN sendiri.* Dulu semua Common 100/500, semua Rare 117/585 — 44 kartu cuma punya 5 profil stat. Sekarang ada Penyergap, Penyerang, Seimbang, Petahan, dan Penjaga.',
      '⚖️ *Keseimbangan tidak berubah:* rarity tetap menentukan besar kekuatan, peran cuma menentukan cara membelanjakannya. Diuji 46 kartu saling lawan — selisih antar-peran cuma 5,5 poin.',
      '🌊 *AIR dan ANGIN akhirnya punya Mythic:* 🐉 Naga Baruna dan 🌪️ Sang Hyang Bayu. Dua elemen ini dulu tidak punya kartu puncak sama sekali.',
      '✨ *Tiap Legendary & Mythic punya skill sendiri.* Dulu tiga dari lima Legendary memakai skill yang sama persis.',
      '🔗 *"Menang ele" dikurangi:* keunggulan elemen turun dari 1,35x/0,75x jadi 1,20x/0,85x. Kartu Rare tidak lagi bisa mengalahkan Mythic cuma karena hoki elemen.',
      '⏳ *Downloader sekarang ada jatahnya:* 15x/hari untuk member gratis, sampai 150x/hari untuk Diamond.'
    ],
    rincian: [
      {
        judul: '🎴 *PERAN — JAWABAN UNTUK "APA CUMA RARITYNYA AJA?"*',
        poin: [
          'Pertanyaan itu muncul di grup, dan jawabannya waktu itu: iya. `statKartu()` cuma membaca rarity, jadi keenam belas Common identik, kedua belas Rare identik, dan seterusnya.',
          'Delapan kartu bahkan *kembar sempurna* — rarity, elemen, dan skill sama persis, nol beda saat bertarung. Gagak Kelam = Bayang Kecil, Beruang Salju = Kura Karang, Elang Badai = Rajawali Puncak, Kuda Petir = Landak Setrum.',
          '⚔️ *Penyergap* ATK 1,5x / HP 0,67x — ledakan besar, rapuh.',
          '🗡️ *Penyerang* ATK 1,3x / HP 0,77x — agresif.',
          '⚖️ *Seimbang* 1,0x / 1,0x — serba bisa.',
          '🛡️ *Petahan* ATK 0,88x / HP 1,14x — menang di ronde panjang.',
          '🏰 *Penjaga* ATK 0,75x / HP 1,34x — tembok.',
          '_Hasil kali ATK x HP tiap peran dijaga sama, jadi tidak ada peran yang lebih kuat — yang berubah cuma CARA menang._',
          '👀 Peran tercetak di gambar kartu, di `.tcg kartu`, dan di daftar dekmu.'
        ]
      },
      {
        judul: '🔗 *KENAPA "MENANG ELE" DIKURANGI*',
        poin: [
          'Ayunan elemen lama 1,35x lawan 0,75x = selisih *1,8x*. Sementara seluruh rentang koleksi, dari Common Lv.1 sampai Mythic Lv.5, cuma *2,58x*.',
          'Artinya: Rare unggul elemen (117 x 1,35 = *158*) mengalahkan Mythic lemah elemen (190 x 0,75 = *143*). Hasil gacha kalah sama undian matchup.',
          'Sekarang 1,20x lawan 0,85x = selisih *1,41x*. Elemen tetap jadi keputusan penting saat menyusun dek, tapi tidak lagi membatalkan kerja keras mengumpulkan kartu.'
        ]
      },
      {
        judul: '💎 *KARTU BARU & SKILL BARU*',
        poin: [
          '🐉 *Naga Baruna* (Mythic AIR, Penjaga) — Pusaran Abadi: abaikan kerugian elemen, pulih 5% HP tiap ronde.',
          '🌪️ *Sang Hyang Bayu* (Mythic ANGIN, Seimbang) — Sangkakala: ronde pertama +30% damage, 18% menghindar.',
          'Delapan skill puncak baru supaya tiap Legendary & Mythic terasa berbeda: Tarian Badai, Kutukan Rangda, Api Suci, Murka Petir, Pusaran Abadi, Sangkakala, Tapak Gunung, Racun Rimba.',
          '_Gambar kartu lama otomatis dibuat ulang — angka ATK/HP di cache sudah tidak berlaku._'
        ]
      },
      {
        judul: '⏳ *DOWNLOADER SEKARANG ADA REMNYA*',
        poin: [
          'Sebelum ini tidak ada rem sama sekali: tanpa jeda, tanpa kuota, tanpa batas berapa unduhan berjalan bersamaan, dan tanpa batas ukuran berkas.',
          '📊 *Kuota harian:* Free *15x* · Silver *30x* · Gold *60x* · Diamond *150x*. Berganti tengah malam WIB.',
          '⏱️ *Jeda antar unduhan:* Free 20 dtk · Silver 15 · Gold 10 · Diamond 5.',
          '🚦 Maksimal *2 unduhan berat* berjalan bersamaan; sisanya mengantre, bukan ditolak.',
          '📎 Stiker, quote, meme, khodam, cuaca, dan terjemahan *tidak* kena jatah — obrolan grup tetap lancar.',
          '⚡ *Auto-download* (link TikTok/IG tanpa perintah) sekarang ikut aturan yang sama, wajib sudah terdaftar, dan ada jeda 30 detik per grup.'
        ]
      }
    ]
  },
  {
    versi: 'v2.8',
    nama: 'Janji Ditepati',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '👑 *Diskon belanja Premium akhirnya BENAR-BENAR dipotong.* Silver 5% · Gold 10% · Diamond 15% — selama ini cuma tertulis di menu, tidak pernah ikut menghitung harga. Sekarang muncul di layar checkout.',
      '🔁 *Perpanjang Premium sekarang bisa.* Dulu `.upgradepremium gold` selalu ditolak kalau kamu sudah Gold — padahal `.cekpremium` sendiri yang menyuruh mengetiknya.',
      '🎁 *Kupon referral turun tiap 3 teman, sesuai janjinya.* Karena salah hitung, dulu kupon kedua baru datang di teman ke-12.',
      '⏳ *Peringatan moderasi punya masa berlaku 7 hari.* Dulu seumur hidup dan tidak bisa dihapus — sekali kena 3x, kamu di ambang kick selamanya.',
      '🔗 *Anti-link diperbaiki dua arah:* link tanpa `http://` sekarang tertangkap, dan kalimat biasa tidak lagi salah dituduh link.',
      '🤖 *Kuota AI reset tengah malam WIB*, bukan jam 7 pagi.'
    ],
    rincian: [
      {
        judul: '👑 *BENEFIT PREMIUM YANG SELAMA INI CUMA TULISAN*',
        poin: [
          '🏷️ *Diskon belanja tidak pernah dipakai menghitung harga.* Angka 5%/10%/15% muncul di sembilan tempat berbeda (`.premium`, `.cekpremium`, layar konfirmasi, `.premiumbenefit`) tapi tidak pernah menyentuh total pesanan sekali pun.',
          '   └ _Sekarang dipotong otomatis saat `checkout`, dengan pesan terpisah supaya kamu bisa melihat sendiri berapa yang hemat._',
          '🔁 *Perpanjangan diblokir oleh salah tanda banding.* Syaratnya "tier setara ATAU lebih tinggi ditolak", padahal yang benar hanya "lebih tinggi".',
          '⬆️ *Naik tier sekarang adil dua arah:* sisa hari tier lamamu dihitung nilainya lalu dikonversi jadi hari di tier baru — tidak hangus, tapi juga tidak bisa dipakai menimbun hari murah untuk ditukar jadi Diamond.'
        ]
      },
      {
        judul: '⏳ *PERINGATAN MODERASI TIDAK LAGI SEUMUR HIDUP*',
        poin: [
          'Hitungannya dulu tanpa batas waktu sama sekali. Peringatan dari dua bulan lalu tetap dihitung penuh, dan tidak ada satu pun perintah untuk menghapusnya.',
          'Itu berbahaya di sini: `checkout` mewajibkan kamu ada di grup pembeli, jadi ter-kick berarti kehilangan hak belanja.',
          '⏳ Sekarang hanya peringatan *7 hari terakhir* yang dihitung — berperilaku baik seminggu memulihkan sendiri.',
          '🧹 Admin punya `.unwarn @user` (bersihkan semua) dan `.unwarn @user 1` (cabut satu terakhir).',
          '📋 `.cekwarn` menampilkan siapa saja yang mendekati ambang kick, `.cekwarn @user` untuk satu orang.'
        ]
      },
      {
        judul: '🔗 *ANTI-LINK: BOCOR DAN SALAH TUDUH SEKALIGUS*',
        poin: [
          '🕳️ *Bocor:* polanya mewajibkan `http://`, jadi cukup mengetik `bit.ly/promo` tanpa skema untuk lolos sepenuhnya — padahal WhatsApp tetap membuatnya bisa diklik.',
          '🎯 *Salah tuduh:* pencocokannya memakai potongan teks mentah, jadi entri blokir `t.me` ikut cocok pada kata biasa seperti "chat.mereka".',
          '✅ Sekarang dicocokkan per-nama-domain, dan diuji terhadap 19 kasus batas.'
        ]
      },
      {
        judul: '🛡️ *KEAMANAN TOKO (sisi Owner)*',
        poin: [
          '🔑 *`.addmod` diam-diam memberi wewenang Admin Toko penuh* — termasuk `.paid`, `.broadcast`, dan `.eval` — padahal pesannya hanya menjanjikan `.ban`/`.unban`. Sekarang moderator benar-benar hanya bisa perintah moderasi.',
          '🚫 *`.ban 628xxx` dan `.setpremium 628xxx` selalu balas "berhasil" padahal tidak mengenai siapa pun*, karena 191 dari 194 akun tersimpan sebagai @lid. Sekarang bot menolak terus terang kalau nomornya tidak ditemukan.',
          '🏠 *`.setmemberstatus` bisa dipakai admin grup mana pun* untuk mem-BANNED pelanggan toko. Sekarang khusus Admin Toko / Owner.',
          '🗑️ *Tombol hapus riwayat di dashboard* dulu bisa dipakai peran Admin dan jatuh ke "hapus SEMUA" kalau permintaannya tidak lengkap. Sekarang Owner saja, dan wajib mengetik kalimat konfirmasi.',
          '🔓 *Logout dashboard cuma kosmetik* — token 24 jamnya tetap sah. Sekarang logout, ganti password, dan hapus akun benar-benar mencabut sesi, termasuk koneksi live-chat.',
          '🌐 *Dashboard sekarang hanya mendengar dari komputer bot.* Butuh akses dari HP? Isi `DASHBOARD_HOST=0.0.0.0` di `.env`.'
        ]
      },
      {
        judul: '🧾 *ANGKA & CADANGAN*',
        poin: [
          '📊 *`.laporan` memakai tanggal WIB.* Antara jam 00:00-07:00, judulnya menulis hari ini tapi angkanya omzet kemarin.',
          '💾 *Retensi cadangan 14 hari yang dijanjikan sebenarnya cuma ~1,7 hari.* Backup dibuat ulang setiap bot dinyalakan, dan batas 15 file memangkas sisanya. Sekarang benar-benar sekali sehari.',
          '🏘️ *Sewa grup yang habis dihapus walaupun bot gagal keluar* — grupnya lalu dilayani gratis tanpa jejak. Sekarang catatannya dipertahankan dan dicoba lagi tiap jam.',
          '💳 *`.deposit` yang gagal membocorkan nama variabel konfigurasi ke chat pelanggan.* Sekarang pesannya sopan, detailnya masuk log, dan Owner ikut diberi tahu.'
        ]
      }
    ]
  },
  {
    versi: 'v2.7',
    nama: 'Reformasi Bank Poin',
    tanggal: '26 Agustus 2026',
    sorotan: [
      '🏦 *Pajak tarik 2% DIHAPUS.* Menarik uangmu sendiri dari bank sekarang gratis — setor 100, tarik 100, dapat 100.',
      '📉 *Bunga bank jadi bertingkat:* 2%/hari hanya untuk 5.000 poin pertama, maksimal 50 poin/hari per akun.',
      '⏳ *Dana endap 10 menit:* setoran baru belum kebal `.steal`. Kabur ke bank di detik terakhir tidak lagi menyelamatkanmu.',
      '💡 Tujuannya satu: poin kembali beredar, bukan menumpuk mati di brankas segelintir orang.'
    ],
    rincian: [
      {
        judul: '🏦 *KENAPA BANK DIROMBAK*',
        poin: [
          'Bank lama adalah *katup satu arah*: setor gratis, tarik kena pajak 2%, sementara bunga menyimpan 2%/hari jauh lebih besar dari ongkos keluar.',
          'Akibatnya *95% seluruh kekayaan bot parkir di bank* dan cuma sekitar 5.800 poin benar-benar beredar di 134 dompet.',
          'Bunga harian mencetak ~2.400 poin/hari, dan *93%-nya mengalir ke 3 akun saja* — yang kaya makin jauh secara otomatis, tanpa main.'
        ]
      },
      {
        judul: '✅ *YANG BERUBAH*',
        poin: [
          '💸 *Tarik gratis.* Pajak 2% dihapus total. Nilai bank sekarang dibayar pakai risiko, bukan pajak.',
          '📉 *Bunga bertingkat:* 2%/hari untuk 5.000 poin pertama saja, dengan batas keras 50 poin/hari per akun.',
          '   └ _Pemain kecil tidak terpengaruh sama sekali — bunga justru jadi terasa berarti buat mereka. Yang berubah cuma penabung besar._',
          '⏳ *Dana endap 10 menit.* Setoran baru masih bisa dijangkau `.steal` selama 10 menit. Ini pengganti pajak tarik sebagai rem, dan bikin `.steal` hidup lagi.',
          '🔒 Saldo yang sudah mengendap tetap *100% aman* seperti sebelumnya.'
        ]
      },
      {
        judul: '🥷 *EFEK KE `.steal`*',
        poin: [
          'Pencuri sekarang menjangkau *dompet + setoran yang belum mengendap*, bukan cuma dompet.',
          'Kalau hasil curian menyentuh dana yang belum mengendap, pesannya menyebutkan jumlahnya secara terpisah.',
          '_Menyetor semua poin tepat sebelum dicopet tidak lagi jadi jurus sakti._'
        ]
      }
    ]
  },
  {
    versi: 'v2.6',
    nama: 'Energi Arena & Bansos',
    tanggal: '26 Agustus 2026',
    sorotan: [
      '⚡ *Energi Arena Kartu dipisah!* Stamina Menara dan Energi Gerbang punya kantong sendiri — main menara tidak lagi memakan jatah farming gerbang.',
      '⏳ Tidak ada lagi reset jam 00:00 — energi mengisi sendiri bertahap sepanjang hari.',
      '🎒 *Ransum* — item pemulih energi baru dari `.tcg daily` dan kemenangan Raid Boss. Ketik `.tcg ransum`.',
      '🏅 *Papan peringkat terpadu* `.lb` — 10 kategori sekaligus, lengkap dengan posisimu sendiri.',
      '🎁 Owner sekarang bisa membagikan *bansos* ke seluruh member lewat `.bansos`.'
    ],
    rincian: [
      {
        judul: '⚡ *ENERGI ARENA DIPISAH & REGEN BERTAHAP*',
        poin: [
          '🏰 *Stamina Menara* — 3 slot, terisi +1 tiap *6 jam*, khusus `.tcg menara`.',
          '🌀 *Energi Gerbang* — 5 slot, terisi +1 tiap *4 jam*, khusus `.tcg gerbang`.',
          '_Sebelumnya keduanya berbagi satu kantong 5/hari, jadi menyiapkan dek untuk menara berarti mengorbankan farming gerbang. Ini permintaan langsung dari grup dan memang masuk akal._',
          '⏳ *Reset jam 00:00 dihapus.* Energi mengisi sendiri sepanjang hari, dan sisa waktu regen tidak hangus saat kamu mengecek status.',
          '🤺 Sparring tetap *gratis tanpa energi* seperti sebelumnya.'
        ]
      },
      {
        judul: '🎒 *RANSUM — ITEM PEMULIH ENERGI*',
        poin: [
          '🍖 *Ransum Pendaki* (+1 Stamina Menara) · 🧃 *Tonik Penjelajah* (+1 Energi Gerbang) · 🍱 *Bekal Agung* (+1 Menara & +2 Gerbang).',
          '📥 Didapat dari `.tcg daily` (dijamin 1 tiap hari) dan dari kemenangan *Raid World Boss* — bos makin besar, peluang makin bagus, MVP dijamin dapat.',
          '🎒 Lihat & pakai lewat `.tcg ransum`.',
          '🚫 *Energi tidak dijual dengan poin.* Kalau energi bisa dibeli, papan peringkat berubah jadi papan orang terkaya — jadi energi hanya datang dari bermain.'
        ]
      },
      {
        judul: '🏅 *PAPAN PERINGKAT TERPADU (`.lb`)*',
        poin: [
          '📋 `.lb` menampilkan daftar kategori, `.lb <kategori>` membuka isinya.',
          '💰 Ekonomi: `.lb poin`, `.lb kaya` (dompet + bank), `.lb streak`.',
          '⭐ Progres: `.lb lvl`, `.lb menang`.',
          '🎮 Per game: `.lb raid`, `.lb lelang`, `.lb undercover`, `.lb tcg`.',
          '💬 `.lb chat` — member paling aktif di grup tempat kamu mengetiknya.',
          '📍 Setiap papan selalu menampilkan *posisimu sendiri*, bukan cuma 10 besar.'
        ]
      },
      {
        judul: '🎁 *BANSOS OWNER*',
        poin: [
          '📮 `.bansos` — Owner membagikan poin, Keping, energi, ransum, atau kartu ke *seluruh member sekaligus*, lengkap dengan surat pengumuman ke grup.',
          '📦 `.bansos paket` — paket campuran sekali klik · `.bansos drop` — jatuhkan kartu gratis di semua grup.',
          '🧾 `.bansos riwayat` — semua pembagian tercatat.'
        ]
      },
      {
        judul: '🐛 *PERBAIKAN*',
        poin: [
          'Klaim `.tcg daily` dulu mengaku "stamina di-refill" padahal tidak pernah menyentuh stamina sama sekali. Sekarang benar-benar memberi ransum.'
        ]
      }
    ]
  },
  {
    versi: 'v2.5',
    nama: 'Raid & Lelang Overhaul',
    tanggal: '26 Agustus 2026',
    sorotan: [
      '🐉 *Raid World Boss* dirombak: HP bos menyesuaikan jumlah regu, boss ke-5 *Nightmare*, sihir elemental, dan mode *MURKA*.',
      '📦 *Lelang Kotak Misteri* jadi mencekam: 3 petunjuk bocor bertahap, palu tiga hitungan, dan poin ditahan saat menawar.',
      '🤫 Tiga mode lelang baru: *buta* (tawaran tersegel via DM), *terkutuk* (lelang terbalik), dan *gudang* (3 lot beruntun).',
      '🗡️ Sabotase lelang: `.endus`, `.gertak`, `.sikut`.',
      '🏅 Papan peringkat baru: `.raidtop` & `.lelangtop`.'
    ],
    rincian: [
      {
        judul: '🐉 *RAID WORLD BOSS — PEROMBAKAN TOTAL*',
        poin: [
          '⚖️ *HP & serangan bos menyesuaikan jumlah regu.* Duo tidak lagi menghadapi tembok, grup ramai tidak lagi membunuh bos di ronde pertama.',
          '🕳️ *Boss ke-5: Erebus Sang Kehampaan (Nightmare Mode)* — terbuka setelah grup menumbangkan Leviathan. Kelemahan elemennya berganti tiap ronde.',
          '🧬 *Sihir elemental Mage:* `.sihir air/petir/tanah/cahaya/api`. Elemen yang tepat = damage *1,6x*, elemen yang ditahan cuma 0,45x.',
          '🎯 *Mekanik khas tiap bos:* luka bakar Ignis, serapan jiwa Malakor, chain lightning Raijin, dan tentakel cengkeram Leviathan.',
          '😡 *Mode MURKA* di bawah 30% HP dan *AMUKAN* mulai ronde 8 — pertempuran kini punya batas ronde 15.',
          '✨ *Bonus Formasi Lengkap:* regu dengan 3 role berbeda dapat +15% damage & -10% damage diterima.',
          '🃏 *Loot kartu TCG* untuk seluruh regu, MVP dijamin dapat kartu tingkat lebih tinggi.',
          '📊 *Statistik & papan peringkat:* `.raidstats` dan `.raidtop`, lengkap dengan gelar seperti "Pembantai Leviathan".',
          '🛠️ Perbaikan keseimbangan: skill terkunci per kelas, batas komposisi role, perisai punya plafon, dan hadiah dihitung per pemain.',
          '🔄 Pertempuran yang sedang berjalan kini selamat dari restart bot.'
        ]
      },
      {
        judul: '📦 *LELANG KOTAK MISTERI — LEBIH MENCEKAM*',
        poin: [
          '🕯️ *Tiga petunjuk bocor bertahap* di detik 30/20/10 — isi kotak sekarang ditentukan di awal, jadi harga bergerak mengikuti informasi. Satu petunjuk bisa saja menyesatkan.',
          '🔨 *Palu tiga hitungan:* SEKALI → DUA KALI → TERJUAL. Tawaran baru menarik palu kembali ke awal.',
          '💸 *Poin ditahan begitu kamu menawar*, dikembalikan penuh saat disalip. Tidak ada lagi sanksi penjara gara-gara saldo berubah di akhir.',
          '🧾 *Biaya papan lelang:* yang ikut menawar tapi kalah membayar 5% dari tawaran tertingginya (maks 50 Poin).',
          '🔏 *Harga rahasia:* tidak tertembus, kotak ditarik dan tidak ada yang membawanya pulang.',
          '🤫 *Mode `.lelang buta`* — tawaran dikirim ke DM bot, pemenang membayar *harga penawar kedua* (lelang Vickrey).',
          '🕯️ *Mode `.lelang kutuk`* — lelang terbalik: siapa paling nekat menanggung kutukan demi pot poin. Ada 15% kemungkinan kutukannya mandul.',
          '🏚️ *Mode `.lelang gudang`* — 3 lot berurutan dengan satu dompet.',
          '🗡️ *Sabotase:* `.endus` (beli petunjuk jujur via DM), `.gertak` (gertakan tidak mengikat), `.sikut @orang` (kunci lawan 15 detik).',
          '📊 *Statistik & papan peringkat:* `.lelangstats` dan `.lelangtop` berdasarkan untung bersih.'
        ]
      },
      {
        judul: '🛠️ *PERBAIKAN SISTEM*',
        poin: [
          '🏷️ Pesan bertombol kini benar-benar menandai (mention) pemain yang disebut — sebelumnya mention diam-diam hilang di semua fitur bertombol.',
          '📢 Bot mengumumkan sendiri apa saja yang berubah setiap kali versi baru dinyalakan.',
          '🗂️ Menu game dirapikan: Raid dan Lelang kini punya bagiannya masing-masing.'
        ]
      }
    ]
  },
  {
    versi: 'v2.4',
    nama: 'Ultra Update',
    tanggal: '24 Agustus 2026',
    sorotan: [
      '🕵️ Undercover Ultra 2.0 dengan peran Jester, Mr. White, dan Detektif.',
      '🏦 Bank Heist bertingkat 4 sasaran & misi bobol penjara 3 tahap.',
      '🏆 Turnamen Cerdas Cermat sistem gugur.'
    ],
    rincian: [
      {
        judul: '🕵️ *Undercover Ultra 2.0 (Social Deduction)*',
        poin: [
          '🎭 *Peran Baru:* Jester (Si Badut), Mr. White (Blank), Detektif Intel, & Duo Impostor!',
          '🔍 *Skill Detektif via DM:* Ketik `.intip @member` untuk melacak status pemain lain secara rahasia.',
          '🃏 *Toko Kartu Aksi:* Rompi Shield, Golden Vote (x2), Kartu Lakban, & Radar Sensor via `.undercover card`.',
          '🗂️ *100+ Pasangan Kata Pop-Culture* dan panduan peran lewat `.undercover role`.'
        ]
      },
      {
        judul: '🏦 *Multi-Tier Bank Heist (Rampok Bank Bertingkat)*',
        poin: [
          '🎯 *4 Pilihan Sasaran:* ATM Minimarket, Bank Cabang, Bank Sentral, & Royal Vault (`.heist 1`–`4`).',
          '⚖️ Hadiah & risiko denda/penjara diseimbangkan ulang.',
          '⏱️ Cooldown terpisah tiap bank.'
        ]
      },
      {
        judul: '🏃‍♂️ *Misi Bobol Penjara 3 Tahap (.jailbreak)*',
        poin: [
          '🔒 Hack PIN keypad, 🐕 lolos patroli anjing pelacak, ⚡ potong kabel alarm gerbang.',
          '⚖️ Teman bisa menebus napi dengan `.tebus @napi` (1.000 Poin).'
        ]
      },
      {
        judul: '🏆 *Turnamen Kuis & Penyempurnaan Lain*',
        poin: [
          '`.cerdascermat` — battle royale sistem gugur dengan 2 nyawa dan prizepool jackpot.',
          '🏳️ `.nyerah` tersedia di semua game tebakan.',
          '📥 `.ig` / `.tt` / `.fb` kini mengunduh seluruh slide album tanpa terpotong.'
        ]
      }
    ]
  }
];

export const VERSI_TERBARU = RIWAYAT_VERSI[0];

/** Rincian penuh versi terbaru — dipakai `.update` / `.changelog`. */
export function getSystemChangelog() {
  const v = VERSI_TERBARU;
  const blok = v.rincian.map((bagian, i) =>
    `${i + 1}. ${bagian.judul}\n${bagian.poin.map(p => `   • ${p}`).join('\n')}`
  ).join('\n\n');

  const versiLama = RIWAYAT_VERSI.slice(1, 4)
    .map(x => `   • *${x.versi}* — ${x.nama} _(${x.tanggal})_`)
    .join('\n');

  return `📢 *CATATAN PEMBARUAN SISTEM (CHANGELOG)* 🚀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *Versi Bot:* ${v.versi} (${v.nama})
📅 *Rilis:* ${v.tanggal}

🔥 *RINGKASAN FITUR BARU & PENYEMPURNAAN:*

${blok}
${versiLama ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 *Versi Sebelumnya:*\n${versiLama}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 _Ketik \`.menu\` untuk melihat seluruh daftar perintah bot!_`;
}

/** Versi ringkas untuk pengumuman "bot online" — jangan sampai jadi tembok teks. */
export function getSorotanUpdate(versi = VERSI_TERBARU) {
  return (versi.sorotan || []).map(s => `• ${s}`).join('\n');
}

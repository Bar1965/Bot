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

export const BOT_VERSION = 'v3.8';

export const RIWAYAT_VERSI = [
  {
    versi: 'v3.8',
    nama: 'Stiker Bersuara, Downloader & Media Pro',
    tanggal: '25 November 2026',
    sorotan: [
      '🔊 *Stiker Bersuara Upgrade.* Kini mendukung foto + suara custom 2-langkah (VN, MP3, link MyInstants/MP3, koleksi `@nama`, atau TTS). Video stiker kini pas sinkron dengan audionya.',
      '🎵 *Koleksi Sound Pribadi.* Simpan efek suara lewat `.addsound <nama>`, cek dengan `.listsound`, hapus lewat `.delsound`.',
      '📥 *Downloader Slide Foto + Audio Terpisah.* Slide foto TikTok (`/photo/`) dan Instagram kini otomatis mengirim seluruh foto sekaligus audio latarnya terpisah (pakai `.tt foto`/`.ig foto` bila mau fotonya saja, `.ttmp3`/`.igmp3` untuk audio saja).',
      '🎨 *Stiker & Media Baru.* `.aistiker`, `.removebg`, `.efek <filter>`, `.qr` / `.qrstiker`, `.cut`, `.percepat` / `.perlambat` / `.nightcore`, serta `.brat` & `.qc` dengan font rapi.',
      '🤖 *Utilitas AI & Grup.* `.ringkas` (ringkas chat/PDF), `.lens` (identifikasi foto + katalog), `.tourl`, `.calc`, `.statsgrup` & `.antikasar on/off`.'
    ],
    ditambah: [
      'Stiker & media baru: `.aistiker`, `.removebg`, `.efek <filter>`, `.qr`/`.qrstiker`, `.tourl`, `.cut`, `.percepat`/`.perlambat`/`.nightcore`, dan `.calc`.',
      'Utilitas AI baru: `.ringkas` (ringkas chat/PDF) & `.lens` (identifikasi foto + cek katalog produk).',
      'Koleksi sound pribadi untuk stiker bersuara: `.addsound <nama>`, `.listsound`, `.delsound`.',
      'Fitur grup baru: `.antikasar on/off` (per grup, default OFF) & `.statsgrup` / `.totalchat` (ringkasan + top member aktif).'
    ],
    diperbaiki: [
      '`.stikersuara` mendukung foto/video + suara custom 2-langkah (VN, MP3, URL/MyInstants, `@sound`, TTS) dengan durasi audio-video sinkron presisi.',
      'Downloader TikTok/IG/YT/FB/X/Pin memakai mesin offline/lokal dulu + fallback online, serta slide foto TikTok/IG memisahkan semua foto + audio latar (`.igmp3`/`.igaudio`).',
      '`.cekresi` kini memakai API BINDERBYTE (jika diisi) atau tautan pelacakan resmi kurir (bukan mock lagi).',
      'Stabilitas sesi WA: cache retry pesan keluar disimpan ke disk saat shutdown & pembersihan berkala sesi kembung tiap 8 jam.',
      'Notifikasi BOT ONLINE ke Owner kini selalu menampilkan rincian Ditambah/Diperbaiki/Dikurang + status commit Git agar tidak lupa saat restart.',
      'Stiker video (`.s`/`.stiker`/`.sgif` & `.stikersuara`) memakai background blur 512x512 otomatis agar video landscape/kecil tidak berongga kosong (tersedia `.s full` / `.s crop`).'
    ],
    dikurang: [
      'Menghapus pesan placeholder `(MOCK)` di `.cekresi`, `.removebg`, `.tourl`, `.lens`, serta blok kode mati `.brat` yang duplikat.',
      'Membersihkan label `🆕` versi lama (v3.7) di `.menu` agar sorotan menu hanya menandai fitur v3.8.'
    ],
    rincian: [
      {
        judul: '🔊 *STIKER BERSUARA & SOUND LIBRARY*',
        poin: [
          '✅ `.stikersuara` sekarang mendukung kombinasi foto/video + audio dari VN, MP3, link URL/MyInstants, `@sound` tersimpan, atau TTS.',
          '✅ Durasi audio dan animasi video stiker disinkronkan presisi per milidetik agar tidak lebih panjang sebelah.',
          '✅ `.addsound <nama>`, `.listsound`, dan `.delsound` tersedia untuk menyimpan klip suara favorit.'
        ]
      },
      {
        judul: '📥 *DOWNLOADER OFFLINE + ONLINE & SLIDE AUDIO*',
        poin: [
          '✅ Seluruh downloader memakai mesin offline/lokal terlebih dahulu dengan fallback otomatis ke backup online.',
          '✅ Slide foto TikTok & IG otomatis memisahkan foto dan audio latar. Tersedia juga `.igmp3` / `.igaudio`.'
        ]
      },
      {
        judul: '🎨 *ALAT KREATIF, AI & GRUP*',
        poin: [
          '✅ Fitur baru aktif: `.aistiker`, `.removebg`, `.efek`, `.qr` / `.qrstiker`, `.tourl`, `.cut`, `.percepat` / `.perlambat` / `.nightcore`, `.calc`, `.ringkas`, dan `.lens`.',
          '✅ Fitur grup baru: `.statsgrup` (ringkasan + top member aktif) dan `.antikasar on/off` (per grup).'
        ]
      }
    ]
  },
  {
    versi: 'v3.7',
    nama: 'Yang Mati Pun Ikut Bicara',
    tanggal: '29 Agustus 2026',
    sorotan: [
      '⚖️ *Sidang Terakhir.* Yang kena suara terbanyak sekarang dapat waktu membela diri. Juri lalu mengetik `.bersalah` atau `.bebas` — seri atau mayoritas bebas, eksekusi BATAL. Tidak ada lagi mati konyol karena vote asal ronde 1.',
      '👻 *Bisikan Arwah.* Mati ronde 1 tidak lagi berarti nganggur. Tiap ronde, pemain yang gugur boleh menitip *1 bisikan anonim* ke grup lewat DM `.bisik <pesan>`. Maksimal 6 kata, dilarang menyebut nama, angka, atau kata rahasia.',
      '👤 *Ronde Anonim.* Sesekali satu ronde tidak ada giliran bicara: semua menyetor petunjuk lewat DM `.anon <teks>`, lalu papan tayang *teracak tanpa satu pun nama*. Kalian vote sambil menebak siapa menulis apa.',
      '🎯 *Misi Rahasia Personal.* Semua pemain dapat 1 misi pribadi via DM di awal game. Berhasil = bonus poin, dibayar *di luar pot taruhan* — jadi tidak memotong hadiah pemenang. Lupa? Ketik `.misirahasia`.',
      '🍺 *Si Mabuk.* Di game 7+ pemain, satu "warga" bisa diam-diam memegang *kata yang salah*. Dia sendiri tidak tahu — DM-nya persis seperti Warga Sipil biasa. Baru kebongkar di rekap akhir.',
      '🎭 *Split Word.* Sesekali kedua penyamar dapat kata BERBEDA. Mereka tetap saling kenal, tapi tidak bisa saling menyandarkan petunjuk.',
      '🔠 *Bocoran Zona Merah.* Mulai Ronde 4 satu huruf kata warga dibuka tiap ronde, biar game tidak mentok sampai batas ronde.',
      '💸 *Pasar Gelap Mr. White.* Boleh menebus huruf kata warga pakai poin sendiri lewat `.belihuruf` (maks 2x). `.tebakwarga` tidak lagi tebak buta.',
      '🎲 *Empat tantangan ronde baru:* Sumpah Bisu (1 kata), Petunjuk Estafet, Urutan Terbalik, dan Ronde Anonim.',
      '📊 *Trust Score & Petunjuk Paling Mematikan.* Papan penilaian iseng di akhir game. Tidak mempengaruhi hadiah sama sekali — murni bahan bully.',
      '_Semua fitur lama tetap jalan seperti biasa. Tidak ada peran atau kartu yang dihapus._'
    ],
    rincian: [
      {
        judul: '⚖️ *SIDANG TERAKHIR — PALU BELUM DIKETUK*',
        poin: [
          'Dulu suara terbanyak langsung berarti mati. Satu tuduhan panas di ronde 1 sudah cukup mengubur orang yang belum sempat bicara apa-apa.',
          '✅ Sekarang tersangka dapat *30 detik membela diri* di grup, lalu juri menjatuhkan vonis: `.bersalah` atau `.bebas`.',
          '🔨 Eksekusi hanya jalan kalau suara *BERSALAH lebih banyak*. Seri atau mayoritas bebas ➔ terdakwa lolos, tidak ada yang mati ronde itu.',
          '🚫 Terdakwa tidak ikut memilih. Yang tidak memilih dianggap abstain.',
          '💀 *Sidang dilewati mulai Ronde 4 (Zona Merah)* — di sana vote skip memang sudah dikunci, jadi vonis bebas cuma akan jadi skip terselubung. Dilewati juga kalau pemain tinggal 3.',
          '_Paling seru kalau terdakwanya ternyata Si Mabuk: dia membela diri dengan panik dan 100% tulus, karena dia memang tidak tahu katanya salah._'
        ]
      },
      {
        judul: '👻 *BISIKAN ARWAH — YANG MATI IKUT MENGADUK*',
        poin: [
          'Keluhan paling sering di Undercover: tereliminasi ronde 1, lalu cuma jadi penonton 15 menit.',
          '✅ Sekarang tiap ronde, pemain yang sudah gugur boleh menitip *1 bisikan anonim* ke grup lewat DM: `.bisik jangan percaya yang pertama`.',
          '🎭 Bot menayangkannya sebagai *"👻 BISIKAN DARI ALAM BAKA"* — tanpa nama. Percaya atau tidak, terserah yang masih hidup.',
          '📏 *Batas ketat, dan itu disengaja:* maksimal 6 kata, maksimal 2 bisikan per ronde untuk seluruh arwah, dan 1 per orang per ronde.',
          '🚫 Bisikan otomatis DITOLAK kalau memuat angka, tanda @, nama pemain, atau kata rahasia mana pun. Arwah sudah tahu semua peran dari dead chat — saluran ini bukan tempat membocorkannya mentah-mentah.'
        ]
      },
      {
        judul: '👤 *RONDE ANONIM — PAPAN TANPA NAMA*',
        poin: [
          'Salah satu tantangan ronde baru. Kalau keluar, ronde itu *tidak ada giliran bicara di grup sama sekali*.',
          '📨 Semua pemain hidup menyetor petunjuk *serentak* lewat DM: `.anon <teks petunjukmu>` (60 detik).',
          '🎲 Setelah waktu habis, semua petunjuk tayang *TERACAK dan TANPA NAMA*, cuma berlabel A, B, C…',
          '🧠 Diskusi dan voting berjalan di atas papan buta itu: kalian harus menebak siapa penulis tiap baris dulu.',
          '🎬 Di rekap akhir game, semua kedok dibuka — barulah ketahuan baris paling mencurigakan itu tulisan siapa.',
          '_Tidak pernah keluar di Ronde 1 (ronde itu punya 2 putaran petunjuk) dan tidak keluar kalau pemain hidup tinggal 3._'
        ]
      },
      {
        judul: '🎯 *MISI RAHASIA PERSONAL*',
        poin: [
          'Di awal game, setiap pemain menerima 1 misi pribadi lewat DM. Tidak ada yang tahu isi misi orang lain.',
          '🫀 *Napas Panjang* — masih hidup saat permainan berakhir.',
          '🎯 *Pemburu Jitu* — minimal 2x mem-vote pemain yang ternyata bukan Warga Sipil.',
          '😇 *Wajah Tak Berdosa* — tidak pernah menerima lebih dari 1 suara dalam satu ronde.',
          '🛟 *Penjaga Rahasia* — pastikan seorang pemain tertentu masih hidup di akhir game.',
          '🗣️ *Mulut Tak Pernah Diam* — beri petunjuk di setiap giliran, tidak pernah skip atau kehabisan waktu.',
          '⚖️ *Tangan Algojo* — ikut mem-vote pemain (bukan skip) di minimal 2 ronde yang berakhir dengan eksekusi.',
          '💰 Bonusnya dibayar *di luar pot taruhan*, jadi tidak memotong sepeser pun hadiah pemenang.',
          '⚖️ Misi *tidak mengubah kemenangan kubu* — kubu tetap prioritas utama. Sengaja tidak ada misi yang menyuruh menjatuhkan kubu sendiri.'
        ]
      },
      {
        judul: '🍺 *SI MABUK & 🎭 SPLIT WORD*',
        poin: [
          '🍺 *Si Mabuk* muncul di game 7+ pemain, dan tidak selalu ada. Satu kursi Warga Sipil diam-diam menerima *kata dari pasangan lain* di tema yang sama.',
          '🤫 DM-nya *persis sama* dengan Warga Sipil biasa — dia tidak punya satu pun petunjuk bahwa katanya salah. Sepanjang game dia bersumpah dia warga, dan dia memang benar.',
          '🎬 Identitasnya dirahasiakan dari SEMUA tampilan di tengah permainan, termasuk dead chat. Baru dibuka di rekap akhir.',
          '🤠 *Aturan khusus Sheriff:* menembak Si Mabuk dihitung *sah* — target tewas, Sheriff selamat. Kalau dihitung salah tembak, satu peran lucu berubah jadi bom yang menghabisi dua warga sekaligus.',
          '🎭 *Split Word:* di game 6+ pemain, ada peluang kedua penyamar dikasih *kata berbeda*. Mereka tetap tahu siapa rekannya, tapi tidak bisa lagi ikut-ikutan arah petunjuk rekan.'
        ]
      },
      {
        judul: '🔠 *ANTI-STALL & PASAR GELAP*',
        poin: [
          '🔠 Mulai *Ronde 4*, bot membuka *1 huruf kata warga* ke seluruh grup, dan menambah 1 huruf tiap ronde berikutnya.',
          '⏳ Tujuannya memaksa permainan konvergen sebelum mentok di batas 7 ronde — sekaligus memberi Mr. White peluang nyata untuk menebak.',
          '💸 *Pasar Gelap:* Mr. White boleh menebus 1 huruf kata warga dengan *poin miliknya sendiri* lewat `.belihuruf`, maksimal 2x per game.',
          '🕶️ Huruf yang dia beli *tidak ikut bocor ke grup* — itu pembelian pribadi, bukan pengumuman.',
          '🎲 *Tantangan ronde baru:* 🤫 *Sumpah Bisu* (petunjuk hanya 1 kata), 🔗 *Petunjuk Estafet* (wajib memuat satu kata dari petunjuk pemain sebelumnya), dan 🔄 *Urutan Terbalik*.'
        ]
      },
      {
        judul: '📊 *TRUST SCORE & PETUNJUK PALING MEMATIKAN*',
        poin: [
          'Dua papan iseng yang muncul di akhir game, sesudah rekap peran.',
          '📊 *Trust Score* menilai tiap pemain 0–100 dari rekam jejaknya: menuduh orang yang ternyata bukan warga menaikkan skor, salah tuduh menurunkan, sering dicurigai menurunkan, rajin memberi petunjuk menaikkan.',
          '🥇 Yang teratas dapat gelar *Paling Dipercaya*, yang terbawah dapat *Paling Mencurigakan 🤡*.',
          '☠️ *Petunjuk Paling Mematikan* menayangkan ulang petunjuk yang paling banyak menarik suara ke kepala penulisnya sendiri.',
          '_Keduanya murni hiburan — tidak menyentuh hadiah, statistik, maupun papan peringkat._'
        ]
      }
    ]
  },
  {
    versi: 'v3.6',
    nama: 'Ada Yang Bisa Dituju',
    tanggal: '28 Agustus 2026',
    sorotan: [
      '🔒 *Perbaikan keamanan:* member biasa ternyata bisa memanggil seluruh grup lewat `.freegames tag` — sekarang khusus Admin.',
      '🆕 *Tiga kartu Mythic baru:* ⚡ *Gatotkaca*, 🍃 *Dewi Sri*, dan 🌑 *Antaboga*. Katalog jadi *63 kartu*, Mythic jadi *8*.',
      '🎴 *Banner gacha — akhirnya ada yang bisa dituju.* Tiap *14 hari* ada 1 Mythic dan 2 Legendary unggulan yang peluangnya dinaikkan. Ketik `.tcg banner` untuk melihat siapa yang sedang *rate ON*.',
      '🎯 *Sistem jaminan 50/50.* Kalau Mythic-mu meleset dari kartu unggulan, Mythic *berikutnya dijamin* kartu itu. Paling buruk kamu butuh dua Mythic — tidak pernah lebih.',
      '🔧 *Duplikat akhirnya berguna.* `.tcg refine <kartu>` menyisipkan kartu kembar untuk menaikkan *R1 ➜ R5*. Yang naik adalah *angka skillnya* — di R5 efeknya jadi *2x lipat*. Gerhana milik Kala Rau naik dari +60% jadi *+120%*.',
      '🪙 *Picis — mata uang baru khusus naik level.* Menaikkan level tidak lagi memakan Keping, jadi menguatkan kartu tidak lagi berebut dompet dengan gacha.',
      '📊 *Kartu memang tidak sama kuat, dan itu disengaja.* Sekarang bisa diperbesar sendiri lewat R. Bot sengaja TIDAK menempelkan label "META" atau "lewati" — kalian yang menilai.',
      '_Stat kartu tidak ada yang berubah. R hanya menyentuh skill._'
    ],
    rincian: [
      {
        judul: '🆕 *TIGA KARTU MYTHIC BARU*',
        poin: [
          'Katalog naik dari *60 jadi 63 kartu*, dan Mythic dari *5 jadi 8*.',
          '⚡ *Gatotkaca* — _Sinews of Wire, Bones of Iron_. Otot kawat balung wesi: damage yang diterima berkurang, dan sebagian dipantulkan balik ke penyerangnya.',
          '🍃 *Dewi Sri* — _Mother of the Golden Harvest_. Dewi padi: memulihkan HP tiap ronde sekaligus makin keras memukul tiap ronde.',
          '🌑 *Antaboga* — _The Serpent That Holds the World_. Naga penyangga bumi: lilitannya melemahkan ATK lawan dan memeras HP-nya tiap ronde.',
          '⚖️ Ketiganya *tidak lebih kuat secara mentah* dari Mythic yang sudah ada — semuanya patuh anggaran daya yang sama, meleset kurang dari 0,2%. Yang membedakan cuma bentuk stat dan skillnya.',
          '🎯 Skillnya sengaja dipilih dari mekanik yang *belum dipegang satu pun Mythic*: sebelum ini tidak ada Mythic yang memantulkan damage, dan tidak ada yang melemahkan ATK lawan.',
          '_Efeknya ke banner: satu putaran penuh sekarang *8 banner / 16 pekan*, bukan 5 banner / 10 pekan — dengan tiga wajah yang belum pernah dilihat siapa pun._'
        ]
      },
      {
        judul: '🎴 *BANNER — RATE ON DAN RATE OFF*',
        poin: [
          'Dulu `.tcg gacha` mengundi rata: kalau kamu dapat Mythic, peluangnya sama besar untuk kelima-limanya. Artinya tidak ada satu tarikan pun yang bisa DITUJU — kamu cuma bisa berharap.',
          '✅ Sekarang tiap 14 hari ada banner: *1 Mythic* dan *2 Legendary* yang peluangnya dinaikkan.',
          '⬆️ *RATE ON* = kartu unggulan banner ini. *50%* dari setiap Mythic yang keluar adalah kartu unggulannya.',
          '⬇️ *RATE OFF* = kartu lain di rarity yang sama. *Tetap bisa keluar*, cuma tidak dinaikkan — tidak ada satu kartu pun yang jadi mustahil didapat.',
          '🎯 *Jaminan 50/50:* kalau Mythic-mu meleset, jaminan menyala dan Mythic berikutnya *pasti* kartu unggulan. Jadi paling buruk butuh dua Mythic, tidak pernah lebih.',
          '📊 `.tcg banner` menampilkan semuanya terang-terangan: siapa yang rate on, berapa peluangnya, berapa kartu yang rate off, dan apakah jaminanmu sedang menyala.',
          '🏷️ Hasil tarikan menandai kartu unggulan dengan ⬆️, jadi kelihatan sekilas di tengah 10 baris.',
          '',
          '⚠️ *Yang perlu diketahui:* jaminan *tidak terbawa* ke banner berikutnya — kalau tidak, tidak ada bedanya menarik sekarang atau bulan depan. Tapi *pity Mythic-mu tetap utuh*: kemajuan yang sudah kamu kumpulkan selama ini tidak direset sama sekali.',
          '_Lima banner bergilir menampilkan kelima Mythic, jadi kartu yang kamu incar pasti akan tayang._'
        ]
      },
      {
        judul: '🔧 *REFINE — R1 SAMPAI R5*',
        poin: [
          '`.tcg refine <id atau nama>` menyisipkan *1 duplikat* untuk naik satu tingkat. R1 ➜ R5 butuh *4 duplikat* di luar kartu aslinya.',
          '⚡ Yang naik *hanya angka skill*, tidak pernah ATK atau HP. Itu bukan pilihan malas: seluruh katalog berdiri di atas janji bahwa tiap rarity punya anggaran daya yang sama, dan menaikkan stat lewat R akan meruntuhkannya.',
          '📈 Justru di situ letak kartu "wajib kejar": skill yang menskala keras jadi menakutkan di R5, sementara skill datar seperti `HP maks +10%` tetap datar. Tidak ada daftar tier yang ditulis tangan — bedanya muncul sendiri dari desain skillnya.',
          '🔒 Duplikat yang sedang bertugas di dek atau sedang pergi ekspedisi *tidak akan ikut dimakan*. Satu keping selalu tersisa.',
          'Ketik `.tcg refine` tanpa apa-apa untuk melihat kartu mana yang duplikatnya sudah cukup.',
          '_Alias: `.tcg sisip`, `.tcg evolusi`._'
        ]
      },
      {
        judul: '🪙 *PICIS — KENAPA ADA MATA UANG KEDUA*',
        poin: [
          'Selama ini naik level dibayar Keping — mata uang yang sama dengan gacha. Datanya menunjukkan siapa yang menang: *212 dari 218 kartu di server masih Lv.1.* Sistem levelnya praktis mati karena setiap Keping lebih menggoda dipakai menarik kartu baru.',
          '✅ Sekarang empat sumber daya, empat tujuan, tidak ada yang saling memakan:',
          '   💠 *Keping* ➜ gacha, dan hanya gacha',
          '   🪙 *Picis* ➜ naik level (stat)',
          '   ✦ *Serpihan* ➜ naik level (bahan)',
          '   🎴 *Duplikat* ➜ refine R (skill)',
          '💰 Picis datang dari `.tcg gerbang` dan `.tcg ekspedisi` — bukan dari gacha, dan tidak bisa ditukar dengan Keping.',
          '🎁 Semua pemain lama dapat *3.000 Picis* sekali seumur hidup supaya tidak mulai dari nol. Pemain baru dapat *2.500 Picis* di paket pemula.'
        ]
      },
      {
        judul: '📊 *KAMI TIDAK AKAN BILANG KARTU MANA YANG BAGUS*',
        poin: [
          'Kartu satu rarity punya anggaran daya yang persis sama, tapi *skillnya tidak sama kuat* — dan itu sudah begitu sejak lama, cuma tidak kelihatan.',
          'Diukur lewat adu penuh sesama rarity: Mythic terentang *41% sampai 60%*, Legendary 45%-57%, Epic 42%-54%. Paparan elemennya terbukti rata (1,008-1,010), jadi selisih itu murni dari skill.',
          '🙅 Bot *tidak* akan menempelkan label META atau LEWATI di kartu mana pun. Kalian yang menilai, kalian yang berdebat di grup — itu memang bagian paling seru dari game kartu.',
          '👀 Yang kami lakukan cuma *mengawasi*. Ada alat ukur yang dijalankan tiap kali angka skill disentuh, dan ia menolak rilis kalau ada kartu R5 yang mulai mengalahkan rarity di atasnya — karena kalau itu terjadi, gacha kehilangan alasannya.',
          '_Dua cacat sudah ketahuan lewat alat itu sebelum sampai ke kalian: satu kartu Legendary R5 sempat menang 67% melawan Mythic, dan satu Rare R5 menang 63% melawan Epic. Keduanya sudah diperbaiki._'
        ]
      },
      {
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji asap arena naik jadi *228 perintah* dan *424 pemeriksaan*, semuanya lulus.',
          'Batas gacha harian dikunci ujinya: pemain biasa tidak bisa mengubah, angka di atas batas atas ditolak, jatah pemain benar-benar ikut naik (bukan cuma tampil di layar), dan — yang terpenting — *baris bertanggal kemarin tidak berlaku hari ini*, karena kalau ia berlaku, batas yang dinaikkan sekali akan menetap selamanya tanpa ada yang menyadarinya.',
          'Layar keputusan dikunci pemeriksaannya sendiri: layar banner WAJIB memuat ATK, HP, KRIT, CP, biaya bintang, nama skill, angka efek, status kepemilikan, pity, biaya tarikan, dan saldo. Layar refine WAJIB memuat efek sebelum dan sesudah. Ikut diperiksa bahwa *setiap* kartu berskill punya ringkasan angka, dan bahwa R selalu mengubah angka untuk setiap kartu — kalau ada yang tidak, duplikatnya tidak layak disimpan dan itu cacat desain.',
          'Tiap pintasan angka menu diuji dengan MEMBANDINGKAN ke perintah aslinya, bukan sekadar memastikan bot membalas: pintasan yang salah sasaran tetap membalas sesuatu, jadi uji yang cuma memeriksa "ada balasan" akan lulus sementara menunya berbohong. Ikut diperiksa bahwa pintasan angka tidak pernah memakan Keping, Picis, maupun serpihan.',
          'Yang dikunci pemeriksaan baru: R1 berperilaku *persis* seperti sebelum fitur ini ada (kalau ini bergeser, seluruh keseimbangan Menara, Gauntlet, dan Bos ikut bergeser diam-diam), R5 benar-benar melipatduakan, tidak ada koefisien yang melewati batasnya, anggaran daya tidak tersentuh, duplikat yang bertugas tidak bisa dimakan, dan naik level memakan Picis *tanpa* menyentuh Keping.',
          'Banner ikut dikunci: jaminan yang menyala *selalu* memberi kartu unggulan (diuji 200x), kalah 50/50 *selalu* menyalakan jaminan (diuji 4.000x), peluang unggulan terukur ~50%, tidak pernah butuh lebih dari 2 Mythic, dan jaminan tidak bocor antar banner.',
          'Jadwal banner juga dikunci: *tidak ada Legendary yang tayang dua banner berturut-turut*, tidak ada dua banner berurutan yang Mythic-nya seelemen, dan semua Legendary kebagian tayang (diperiksa atas 40 banner).',
          '📐 Alat pengawas keseimbangan `scripts/tcgTierMeter.mjs`: 10 pemeriksaan, semuanya lulus dengan 8 Mythic — termasuk bahwa tidak ada kartu R5 yang mengalahkan rarity di atasnya.'
        ]
      }
    ]
  },
  {
    versi: 'v3.5',
    nama: 'Gelar',
    tanggal: '28 Agustus 2026',
    sorotan: [
      '🏅 *Kartu Legendary dan Mythic sekarang punya gelar.* Di bawah namanya ada satu baris julukan berbahasa Inggris — `Batara Kala` kini bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Sang Hyang Petir` _"Fury of the Splitting Sky"_.',
      '🌑 *Voidreaper berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya akhirnya nyambung.',
      '_Gelar sengaja hanya ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka._',
      '_Stat, biaya bintang, dan skill tidak ada yang berubah sama sekali._'
    ],
    rincian: [
      {
        judul: '🏅 *KENAPA GELARNYA INGGRIS TAPI NAMANYA TIDAK*',
        poin: [
          'Rangka Arena ini memang sudah berbahasa Inggris sejak awal: Common, Rare, Epic, Legendary, Mythic, Gauntlet, Void. Yang lokal cuma nama makhluknya.',
          'Itu bukan kebetulan — itu formula yang sama dipakai gacha besar: tulisan antarmuka Inggris, nama diri lokal. Tidak ada yang menerjemahkan nama tokohnya.',
          'Menerjemahkan nama kartunya justru akan MEMBALIK tangga rarity. `Ember Rat` terdengar internasional, tapi `Batara Kala` tetap `Batara Kala` karena ia nama diri yang tidak punya terjemahan — jadi kartu Common malah terdengar lebih megah daripada dewa di ujung koleksi.',
          '✅ Jalan tengahnya: nama tetap Nusantara, gelarnya Inggris. Yang megah tetap terasa megah tanpa kehilangan satu-satunya hal yang membuat arena ini tidak sama dengan game mana pun.',
          '📍 Gelarnya muncul di tiga tempat: gambar kartunya, layar `.tcg kartu`, dan hasil `.tcg tarik` — jadi kalau kamu menarik Legendary atau Mythic, gelarnya ikut keluar saat itu juga.'
        ]
      },
      {
        judul: '🌑 *KALA RAU*',
        poin: [
          'Dari 60 kartu, cuma satu yang namanya Inggris murni: `Voidreaper` — dan dia berdiri di tier yang seluruh isinya dewa Nusantara (Barong Agni, Naga Baruna, Sang Hyang Bayu, Sang Hyang Petir).',
          'Kala Rau adalah raksasa Bali dan Jawa yang menelan matahari dan bulan — itulah gerhana. Skill kartu ini sudah bernama *Gerhana* sejak dirilis.',
          '🎴 Gambar kartunya pun kebetulan sudah pas: elemen Dark digambar sebagai bulan gelap.',
          '⚠️ ID-nya tetap `MYT03`. Kartu yang kamu punya tidak ke mana-mana, levelnya tidak turun, dan dek yang sudah terpasang tidak perlu disusun ulang.',
          '_Yang berubah cuma cara memanggilnya lewat nama:_ `.tcg kartu voidreaper` _sekarang jadi_ `.tcg kartu kala rau`. _`.tcg kartu MYT03` tetap seperti biasa._'
        ]
      },
      {
        judul: '📜 *DAFTAR LENGKAP GELAR*',
        poin: [
          '⭐⭐⭐⭐⭐ *Mythic*',
          '🔥 Barong Agni — _Sacred Flame of the Guardian_',
          '💧 Naga Baruna — _Tide of the Endless Deep_',
          '🍃 Sang Hyang Bayu — _Breath of the First Storm_',
          '⚡ Sang Hyang Petir — _Fury of the Splitting Sky_',
          '🌑 Kala Rau — _The Eclipse Devourer_',
          '',
          '⭐⭐⭐⭐ *Legendary*',
          '🔥 Naga Krakatau — _The Island That Burned_',
          '🔥 Naga Merapi — _The Mountain That Never Sleeps_',
          '💧 Ratu Laut Selatan — _Empress of the Southern Tide_',
          '💧 Nyi Blorong — _Coils of the Golden Serpent_',
          '🍃 Garuda Nusantara — _Wings Over the Archipelago_',
          '🍃 Jatayu Perkasa — _The Wing That Would Not Fall_',
          '⚡ Petir Semeru — _Twin Bolts of the Highest Peak_',
          '⚡ Kala Gledek — _The Thunder That Splits Stone_',
          '🌑 Rangda Kelam — _Mother of All Curses_',
          '🌑 Batara Kala — _Devourer of Time_',
          '',
          '_Tiap gelar ditambatkan ke kartunya, bukan dikarang lepas: Jatayu bertahan dan tidak jatuh (HP tertinggi kedua di tier-nya), Sang Hyang Petir membelah langit (ATK 292, tertinggi di seluruh katalog), Kala Gledek membelah batu (skillnya memang Gledek Selo — selo itu batu)._'
        ]
      },
      {
        judul: '🖼️ *SEMUA GAMBAR KARTU DIGAMBAR ULANG*',
        poin: [
          'Gambar kartu disimpan di cache supaya tidak digambar berulang-ulang. Tanpa penanda versi di nama berkasnya, gambar lama akan disajikan selamanya dan pemain melihat kartu yang sudah tidak ada.',
          '✅ Penanda versi dinaikkan 3 ➜ 4, jadi seluruh 60 kartu digambar ulang saat pertama kali dibuka.',
          'Kartu bergelar menggeser namanya sedikit ke atas supaya gelarnya muat. Kartu tanpa gelar tata letaknya tidak disentuh sama sekali.'
        ]
      }
    ]
  },
  {
    versi: 'v3.4',
    nama: 'Berhenti Menghafal',
    tanggal: '28 Agustus 2026',
    sorotan: [
      '🗣️ *Arena sekarang mengerti caramu bicara.* 44 kata sehari-hari yang selama ini ditolak kini diterima: `.tcg tim`, `.tcg auto`, `.tcg absen`, `.tcg taruh`, `.tcg pindah`, `.tcg naikin`, `.tcg pecah`, `.tcg liga`, `.tcg portal`, dan banyak lagi.',
      '🧹 *`.tcg lepas semua`* — kosongkan seluruh dek dalam satu ketikan, bukan tiga pesan.',
      '👹 *`.tcg raid`* sekarang membuka Bos Arena. Sebelumnya bot justru menyarankan `.tcg rate` atau `.tcg naik` — menunjuk ke arah yang salah.',
      '_Semua kata lama tetap jalan. Tidak ada yang perlu kamu pelajari ulang._'
    ],
    rincian: [
      {
        judul: '🗣️ *KATA YANG BENAR-BENAR DIKETIK ORANG*',
        poin: [
          'Daftar ini tidak dikarang. Ia disusun dari log pemain sungguhan: ada yang mengetik `.tcg copot 1` lalu harus menebak lagi sampai ketemu `lepas`, dan ada yang mengetik `.tcg raid` untuk mencari Bos Arena.',
          '🃏 Dek & kartu: `tim` · `formasi` · `dekku` · `kartuku` · `koleksiku` · `taruh` · `pasangin` · `masukin` · `copotin` · `lepasin` · `pindah` · `pindahin`',
          '🤖 Auto: `auto` · `susun` · `bestdeck` — dua yang pertama memang sudah dipakai bot di `.tcg gauntlet dek`, jadi ini menyeragamkan yang sudah ada.',
          '⚙️ Naik level & serpihan: `naikin` · `leburin` · `pecah` · `pecahin` · `pecahan` · `serpihanku` · `jualin`',
          '⚔️ Bertarung: `pvp` · `gaspol` · `nolak` · `latih` · `liga` · `tier` · `menaraabadi` · `bosgrup` · `raid` · `gaunlet`',
          '🌾 Harian: `absen` · `beruntun` · `streak` · `stamina` · `portal` · `berangkat` · `tangkap` · `misiku` · `tugasku` · `minggu` · `julukan` · `tukarkartu`'
        ]
      },
      {
        judul: '🧹 *`.TCG LEPAS SEMUA`*',
        poin: [
          'Dari log: pemain mengetik `.tcg lepas semua`, ditolak, lalu terpaksa mengirim tiga pesan berturut-turut — `lepas 1`, `lepas 2`, `lepas 3`.',
          'Kata "semua" itu bukan tebakan liar: bot sendiri yang mengajarkannya lewat `.tcg serpihsemua` dan `.tcg jualsemua`. Pemain cuma menggeneralisasi pola yang kita perkenalkan.',
          '✅ Aman tanpa konfirmasi — melepas tidak pernah menghapus kartu dari koleksi, dan `.tcg autodek` memulihkan dek dalam satu ketikan.',
          '💡 Pesan format `.tcg lepas` yang salah sekarang ikut menawarkannya, supaya tidak perlu ditemukan secara kebetulan.'
        ]
      },
      {
        judul: '🛡️ *YANG SENGAJA TIDAK DILAKUKAN*',
        poin: [
          'Koreksi salah ketik bot (`Maksudmu ...?`) memilih kata terdekat. Menambah 44 kata baru berisiko MEREBUT koreksi yang selama ini sudah benar — mis. salah ketik `raik` yang hari ini benar diarahkan ke `naik`.',
          '✅ Karena itu hanya 24 dari 44 alias yang ikut jadi sasaran tebakan, dan semuanya ditaruh di urutan paling akhir. Sisanya bisa diketik, tapi tidak ikut menebak.',
          '🧪 Diuji dengan membangkitkan *6.434 salah ketik* dari seluruh perintah lama, lalu membandingkan saran sebelum dan sesudah: *nol* koreksi berubah.',
          '⚠️ Satu jebakan lain ikut ditutup: alias dek baru wajib menerima argumen. Tanpa itu `.tcg tim 1 CMN07` akan menampilkan dek tanpa memasang apa pun — gagal senyap.'
        ]
      },
      {
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji asap arena naik jadi *162 perintah* dan *305 pemeriksaan*, semuanya lulus.',
          'Termasuk pemeriksaan bahwa alias dek dengan argumen benar-benar MEMASANG kartu, bukan sekadar menampilkan dek.'
        ]
      }
    ]
  },
  {
    versi: 'v3.3',
    nama: 'Yang Ditemukan Audit',
    tanggal: '28 Agustus 2026',
    sorotan: [
      '🧭 *Saran elemen di Menara sempat menyesatkan.* Diukur atas 200 lantai, 73,5% di antaranya menyarankan minimal satu elemen yang justru RUGI melawan penjaganya, dan 27% menyembunyikan jawaban terbaiknya sendiri. Rumusnya ditulis ulang dan sekarang selalu cocok dengan hitungan sebenarnya.',
      '🤖 *Sinergi tidak pernah benar-benar dipakai `.tcg autodek`.* Pengalinya diam-diam selalu 1,00 sejak awal, jadi dek disusun murni dari daya mentah. Sekarang sinergi formasi benar-benar ikut dihitung — dan laporannya menampilkan sinergi yang aktif, bukan selalu "tidak ada".',
      '🏟️ *Lawan Gauntlet sempat main di luar aturan.* Deknya bernilai 12-14 bintang sementara kamu dikunci 10. Di pekan tertentu, dek terbaik yang mungkin ada cuma menang 10% di tahap 3. Sekarang lawan memakai anggaran yang sama denganmu.',
      '👹 *Bos Arena bisa jadi mustahil tumbang, dan semua orang dapat nol.* HP yang dibawa penantang baru sekarang ditakar sisa pekan, dan hadiah tetap dibayar sebanding kerusakan walau bosnya tidak tumbang.',
      '🎯 *Gauntlet dan Bos akhirnya menyumbang progres misi* — dua mode terberat sebelumnya tidak dibaca satu pun misi.'
    ],
    rincian: [
      {
        judul: '🧭 *SARAN ELEMEN YANG MENYESATKAN*',
        poin: [
          'Baris "💡 Unggul melawan mereka" di `.tcg menara`, `.tcg abadi`, dan `.tcg gauntlet` dihitung dengan cara yang salah sejak dirilis kemarin.',
          'Cacat pertama: daftar sarannya dikumpulkan dari elemen UNIK dek penjaga, tanpa menimbang berapa kartu yang memakainya. Dek Abadi selalu 2 kartu setema + 1 penyimpang — jadi elemen yang cuma mengalahkan si penyimpang tetap disarankan meski rugi melawan dua kartu inti.',
          'Cacat kedua: kandidat yang kebetulan berelemen sama dengan salah satu kartu penjaga justru DIBUANG. Padahal di situlah counter terbaik sering berada.',
          '📊 Diukur atas lantai 1-200: *147 lantai (73,5%)* menyarankan minimal satu elemen merugikan, dan *27%* menyembunyikan elemen terbaiknya.',
          '✅ Sekarang tiap elemen dinilai atas KETIGA kartu penjaga, memakai rasio "seberapa keras aku memukul" dibanding "seberapa keras aku dipukul". Hanya yang benar-benar di atas netral yang disarankan — kalau tidak ada, bot memilih diam daripada menyesatkan.',
          '🔁 Layar kekalahan Menara dulu punya salinan rumusnya sendiri yang ikut cacat. Salinan itu dihapus; sekarang semuanya memakai satu fungsi.'
        ]
      },
      {
        judul: '🤖 *SINERGI YANG TIDAK PERNAH AKTIF*',
        poin: [
          '`.tcg autodek` seharusnya menimbang sinergi formasi, bukan cuma daya mentah — itu yang tertulis waktu dirilis.',
          'Kenyataannya kode membaca field yang tidak pernah ada, jadi pengali sinergi *selalu* bernilai 1,00 dan sinergi tidak pernah ikut dihitung sama sekali.',
          'Efek keduanya: laporan autodek selalu mencetak "_Tidak ada sinergi elemen khusus._" apa pun deknya.',
          '✅ Sekarang dek dengan sinergi benar-benar dinilai lebih tinggi (mis. tiga kartu satu elemen atau tiga elemen berbeda), dan sinergi yang aktif ditampilkan lengkap dengan syaratnya.'
        ]
      },
      {
        judul: '🏟️ *GAUNTLET: LAWAN MAIN DI LUAR ATURAN*',
        poin: [
          'Kamu dibatasi 10 bintang. Lawan Gauntlet tidak dibatasi sama sekali, lalu masih dikalikan kekuatan sampai ×1,10.',
          '📊 Hasil pengukuran: dek lawan tahap 3 bernilai *12-14 bintang* tergantung undian pekan. Pada pekan 24 Agustus, dek terbaik yang mungkin ada — koleksi 60 kartu penuh Lv.5 — cuma menang *10%*. Hadiah tahap 3 praktis tidak akan pernah dibayar ke siapa pun.',
          '✅ Sekarang lawan memakai *anggaran yang sama denganmu*: 10 bintang, tiga kartu penuh. Kesulitannya naik lewat level kartu (Lv.3 ➜ Lv.4 ➜ Lv.5), bukan lewat kartu yang tidak boleh kamu punya.',
          '✅ Lawannya juga menyusun dek dengan baik, bukan asal undi — kalau tidak, tahap 3 malah jadi 100% menang dan Gauntlet kehilangan gigi.',
          '📊 Sesudah diukur ulang dengan aturan kartu-tak-boleh-diulang ditegakkan: pemain berkoleksi penuh Lv.5 menang 100% / 93-100% / *40-83%* di tiga tahap. Tetap berat di ujung, tapi mungkin.',
          '🔒 Dek yang tidak penuh sekarang ditolak. Dulu dek 2 kartu tetap bisa menang 2-1, jadi Gauntlet bisa dituntaskan dengan enam kartu — padahal seluruh alasan mode ini ada adalah menuntut sembilan.'
        ]
      },
      {
        judul: '👹 *BOS ARENA: DUA CARA HADIAH BISA HANGUS*',
        poin: [
          'Cacat pertama — HP yang dibawa penantang baru. Tiap orang yang pertama kali memukul menambah 30.000 HP, berapa pun sisa hari. Yang bergabung hari Minggu cuma punya 3 serangan tersisa: ia harus menyetor 10.000 damage per serangan sekadar membayar HP yang ia bawa, padahal dek terkuat pun cuma ~6.900.',
          'Akibatnya anggota yang iseng memukul dua kali lalu berhenti menyumbang *−26.000* untuk grupnya, dan bos makin jauh dari tumbang tiap ada peserta baru.',
          '✅ HP yang dibawa sekarang ditakar sisa pekan. Titik impas seorang penantang tetap ~1.429 damage per serangan kapan pun ia bergabung — di bawah dek Common sekalipun.',
          'Cacat kedua — hadiah hanya dibayar oleh pukulan pematian. Bos yang tidak tumbang sampai Minggu berarti *semua orang dapat nol*, dan kalau bot mati tepat di antara "bos tumbang" dan "hadiah dibagi", hadiahnya hilang permanen tanpa jalan pemulihan.',
          '✅ Sekarang `.tcg bos` membereskan hadiah yang menggantung: yang sudah tumbang tapi belum terbayar dibayar penuh, dan bos yang pekannya lewat tanpa tumbang tetap membayar *sebanding kerusakan* yang berhasil ditimbun grup.',
          '_Serpihan Legendary tetap hanya jatuh kalau bosnya benar-benar tumbang — itu hadiah untuk menuntaskan, bukan untuk mencoba._'
        ]
      },
      {
        judul: '🎯 *DUA MODE TERBERAT AKHIRNYA DIHITUNG MISI*',
        poin: [
          'Gauntlet dan Bos Arena mencatat progres ke sistem misi sejak dirilis — tapi tidak ada satu pun misi yang membaca aksinya, jadi catatannya dibuang diam-diam.',
          '✅ Menang Gauntlet sekarang dihitung misi mingguan *Menangkan 12 pertarungan*.',
          '✅ Ada misi mingguan baru: 👹 *Pukul Bos Arena grup 8 kali* — 300 Keping + 2 Serpihan Epic.',
          '_Gauntlet sengaja tidak dijadikan misi harian: modenya cuma 3 tahap per pekan, jadi pemain yang tuntas hari Senin akan menatap misi mustahil sampai Minggu._'
        ]
      },
      {
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji asap arena diperluas jadi *144 perintah* dan *286 pemeriksaan*, semuanya lulus.',
          'Yang dikunci pemeriksaan baru: saran counter tidak pernah menyarankan elemen merugikan dan tidak pernah menyembunyikan yang terbaik (diperiksa di 120 lantai), dek lawan Gauntlet tidak pernah melampaui anggaran pemain, dek tidak penuh ditolak tanpa memakan percobaan, autodek gagal jujur saat syarat mustahil, hadiah bos tertunda bisa dibereskan sekali dan hanya sekali, serta misi mingguan benar-benar membaca aksi GAUNTLET dan BOS.',
          'Satu bug ikut tertangkap uji ini saat perbaikan ditulis: sebuah `ReferenceError` di layar kekalahan Menara yang — sesuai sifat bot ini — akan muncul sebagai *diam*, bukan sebagai error.'
        ]
      }
    ]
  },
  {
    versi: 'v3.2',
    nama: 'Arena Punya Lawan Lagi',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '🔍 *Dek penjaga sekarang terlihat SEBELUM bertarung.* Menara Penjaga dulu merahasiakan lawannya, jadi kamu baru tahu harus bawa apa sesudah stamina habis. Sekarang kartunya, levelnya, dan elemen yang unggul melawannya semua tertulis.',
      '🌌 *Menara Abadi punya modifier lantai mulai lantai 10.* Tiap lantai memasang aturan sendiri: elemen disegel, anggaran dipangkas jadi 8★, kabut beracun, perisai penjaga. Satu dek tidak lagi bisa menjawab semua lantai.',
      '🏟️ *GAUNTLET PEKANAN — `.tcg gauntlet`.* Tiga pertarungan berurutan, dan kartu yang sudah bertarung TIDAK boleh dipakai lagi di tahap berikutnya. Sekali tamat butuh sembilan kartu terawat, bukan tiga.',
      '👹 *BOS ARENA GRUP — `.tcg bos`.* Satu kantong HP milik grup yang cuma tumbang kalau cukup banyak orang ikut memukul. Hadiahnya dibagi menurut sumbangan damage.',
      '🤖 *`.tcg autodek` sekarang bisa diberi sasaran:* `.tcg autodek api` menyusun dek yang UNGGUL melawan Api, dan `.tcg autodek abadi` menyusun dek yang lolos syarat lantai Abadi berikutnya.'
    ],
    rincian: [
      {
        judul: '🔍 *LAWANNYA TIDAK LAGI RAHASIA*',
        poin: [
          'Menara Penjaga dulu cuma menyebut nama lantai dan hadiahnya. Dek penjaganya rahasia — jadi counter elemen mustahil, dan kamu baru tahu lawannya SESUDAH stamina terpakai.',
          'Itu bukan kesulitan, itu ketidaktahuan: yang diuji cuma "sudah pernah kalah di sini atau belum".',
          '🆕 `.tcg menara` sekarang menampilkan ketiga kartu penjaga lengkap dengan level dan biaya bintangnya.',
          '💡 Ditambah satu baris saran: *elemen apa* yang unggul melawan mereka. Sengaja menyebut elemen, bukan kartu — arahnya diberi, pilihannya tetap milikmu.',
          'Menara tidak jadi lebih mudah: mesin tempurnya tidak diubah sama sekali. Yang berubah, kekalahan sekarang bisa dipelajari.'
        ]
      },
      {
        judul: '🌌 *MODIFIER LANTAI MENARA ABADI*',
        poin: [
          'Sejak `.tcg autodek` ada, menyusun dek bukan lagi keputusan: bot menghitung kombinasi terkuat dari koleksimu, memasangnya, selesai — dan jawaban itu sama untuk setiap lantai.',
          '🆕 Mulai *lantai 10*, tiap lantai Abadi memasang satu aturan tambahan. Ada 8 macam: ☠️ Kabut Beracun · 🛡️ Perisai Penjaga · 🚫 Segel Elemen · 💰 Anggaran Ketat (8★) · 📯 Panggilan Elemen · 🪨 Gravitasi Berat · ❄️ Tangan Dingin · 🏯 Benteng Penjaga.',
          '🚫 *Segel Elemen* tidak menyegel elemen sembarangan — yang disegel justru salah satu elemen yang UNGGUL melawan penjaga lantai itu. Kamu dipaksa menang tanpa counter andalanmu.',
          '👁️ Semua modifier *terlihat di `.tcg abadi` sebelum bertarung*, lengkap dengan akibatnya. Modifier tersembunyi cuma akan terasa seperti bot curang.',
          '🎲 Deterministik: lantai 43 memasang aturan yang sama untuk semua orang, selamanya. Tidak ada yang bisa mengulang sampai dapat aturan mudah.',
          '⚡ Dek yang melanggar syarat ditolak *sebelum* stamina terpotong — melanggar aturan pendaftaran bukan kekalahan.',
          '🧊 Sembilan lantai pertama tetap bersih, persis seperti kurva kesulitan yang sudah diukur sebelumnya.'
        ]
      },
      {
        judul: '🏟️ *GAUNTLET PEKANAN — AKHIRNYA KOLEKSI BERGUNA*',
        poin: [
          'Cacat paling lama arena ini: kamu cuma pernah butuh TIGA kartu bagus. Katalognya 60 kartu, tapi tidak ada satu pun konten yang menuntut kartu keempat — dan sejak `.tcg jualsemua` ada, menyempitkan koleksi malah menguntungkan.',
          '🆕 `.tcg gauntlet` — tiga pertarungan berurutan dalam satu pekan. *Kartu yang sudah menang TIDAK boleh dipakai lagi di tahap berikutnya.*',
          '🎯 Lawannya menguat tiap tahap: Penantang (Lv.3) ➜ Panglima (Lv.4) ➜ Juara Pekan (Lv.5). Jadi sembilan kartunya juga tidak boleh asal ada.',
          '🎟️ Jatah *5 percobaan per pekan*. Kalah TIDAK mengunci kartu — yang terpakai cuma satu percobaan, jadi satu kekalahan di tahap 1 tidak menutup sisa pekanmu.',
          '🤖 `.tcg gauntlet dek` menyusun dek otomatis dari kartu yang belum terkunci, sekaligus disesuaikan dengan elemen lawan tahap itu.',
          '🎁 Hadiah tiap tahap: 150 · 300 · 700 Keping plus serpihan Rare/Epic/Legendary. Tuntas tiga tahap: bonus +500 Keping.',
          '📅 Reset tiap Senin dengan tiga lawan yang berbeda — dan seluruh kartumu terbuka lagi.'
        ]
      },
      {
        judul: '👹 *BOS ARENA GRUP — LAWAN YANG TIDAK BISA DIHABISI SENDIRIAN*',
        poin: [
          'Semua konten arena sampai sekarang bisa dimainkan sendirian: menara, gerbang, ekspedisi, bahkan duel pun cuma dua orang. Grup ramai dan grup sepi memainkan permainan yang persis sama.',
          '🆕 `.tcg bos` — satu bos per grup per pekan, dengan satu kantong HP milik bersama. `.tcg bos serang` memukulnya dengan dek aktifmu, *3 kali per hari*.',
          '⚔️ *Elemen jauh lebih menentukan di sini:* kartu yang unggul memukul ×1,5, yang lemah cuma ×0,7 (di duel biasa cuma ×1,13 dan ×0,89). Bos tidak balas memukul, jadi satu-satunya keputusan yang tersisa adalah kartu apa yang kamu bawa — dan keputusan itu harus terasa.',
          '📈 HP bos *bertambah tiap ada penantang baru*, jadi bos di grup ramai memang lebih besar. Angka mati akan mustahil ditumbangkan di grup sepi dan tumbang di hari pertama di grup ramai.',
          '🎁 Saat tumbang, hadiah dibagi menurut *sumbangan damage* — ikut memukul selalu berarti sesuatu meski bukan yang terkuat. Pemukul terbesar dapat bonus Keping + serpihan Legendary.',
          '📊 `.tcg bos` menampilkan papan sumbangan, sisa HP, jatah seranganmu, dan elemen apa yang sebaiknya kamu bawa.'
        ]
      },
      {
        judul: '🤖 *AUTODEK SEKARANG PUNYA SASARAN*',
        poin: [
          'Autodek versi kemarin cuma punya satu jawaban untuk seluruh permainan: kombinasi terkuat secara mentah.',
          '🆕 `.tcg autodek api` (juga `air`, `angin`, `petir`, `gelap`) menyusun dek yang *unggul melawan elemen itu*, bukan yang paling kuat. Keputusan "mau meng-counter apa" kembali ke tanganmu.',
          '🆕 `.tcg autodek abadi` menyusun dek untuk lantai Abadi berikutnya — sekaligus mematuhi syarat modifier lantainya: batas bintang, elemen yang disegel, dan elemen yang diwajibkan.',
          '🔤 Nama elemen dimaklumi longgar: `gelap`/`dark`, `listrik`/`petir`, `water`/`air` semuanya diterima.'
        ]
      },
      {
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji asap arena diperluas: sekarang *143 perintah* dan *265 pemeriksaan*, semuanya lulus.',
          'Yang ikut diperiksa antara lain: modifier tidak pernah sama di dua lantai berturut-turut, modifier deterministik, syarat lantai benar-benar menolak dek yang melanggar, kartu Gauntlet yang terkunci benar-benar ditolak dan penolakannya tidak memakan percobaan, jatah serangan bos menutup serangan keempat, serta hadiah bos tidak bisa dibagi dua kali.'
        ]
      }
    ]
  },
  {
    versi: 'v3.1',
    nama: 'Tiga Perintah yang Menghapus Pekerjaan Rumah',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '💳 *`.dompet`* — satu kartu berisi SELURUH asetmu: saldo rupiah, Akbar Poin, tabungan bank, Keping Arena, koleksi kartu, serpihan, sampai sisa kuota AI dan downloader hari ini. Bisa juga `.dompet @member`.',
      '🤖 *`.tcg autodek`* — bot menghitung sendiri kombinasi 3 kartu terkuat dari koleksimu, lengkap dengan sinergi elemen, lalu memasangnya. Tidak perlu lagi coba-coba `.tcg pasang` satu per satu.',
      '🧹 *`.tcg serpihsemua`* dan *`.tcg jualsemua`* — bersihkan SEMUA kartu duplikat sekaligus, bisa disaring per rarity. Kartu di dek dan yang sedang ekspedisi tetap aman, koleksi tidak pernah habis.'
    ],
    rincian: [
      {
        judul: '💳 *DOMPET & ASET TERPADU*',
        poin: [
          'Dulu untuk tahu posisi asetmu kamu harus mengetik lima perintah berbeda: `.saldo`, `.poin`, `.bank`, `.tcg keping`, `.tcg serpihan` — dan tetap tidak tahu sisa kuota AI hari ini.',
          '🆕 `.dompet` (alias `.wallet`, `.aset`) menampilkan semuanya dalam satu kartu: saldo rupiah, role, tier premium, gelar Arena, Akbar Poin, tabungan bank, dana endap, total kekayaan.',
          '🎴 Sisi Arena ikut masuk: Keping, jumlah jenis kartu, total kartu, dan rincian serpihan per rarity.',
          '⚡ Ditambah kuota harian yang selama ini tidak pernah bisa dilihat: pemakaian Smart AI dan Media Downloader hari ini beserta batasnya (batas AI mengikuti tier premiummu).',
          '👥 `.dompet @member` untuk melihat aset member lain — berguna sebelum barter, duel taruhan, atau lelang.'
        ]
      },
      {
        judul: '🤖 *AUTO-DEK CERDAS*',
        poin: [
          'Menyusun dek 3v3 yang benar butuh membandingkan ATK, HP, kritis, biaya bintang, dan sinergi elemen sekaligus. Di layar HP, kebanyakan pemain menyerah lalu memasang tiga kartu rarity tertinggi — yang sering justru kalah.',
          '🆕 `.tcg autodek` (alias `.tcg bestdek`) menguji SEMUA kombinasi 3 kartu yang muat di batas bintang, memberi nilai tiap kombinasi, lalu memasang yang terbaik.',
          '✨ Sinergi ikut dihitung, bukan cuma kekuatan mentah: tiga kartu yang sedikit lebih lemah tapi membentuk sinergi bisa menang dari tiga kartu terkuat tanpa sinergi.',
          '🧭 Kartu yang sedang pergi ekspedisi otomatis dilewati, jadi dek tidak pernah dipasangi kartu yang tidak ada di rumah.',
          '📊 Hasilnya langsung menampilkan total bintang, estimasi power, dan sinergi yang aktif — jadi tetap bisa dipelajari, bukan kotak hitam.'
        ]
      },
      {
        judul: '🧹 *PEMBERSIHAN KARTU MASSAL*',
        poin: [
          'Pemain lama bisa punya 40+ jenis kartu duplikat. Membersihkannya berarti mengetik `.tcg serpih <id>` puluhan kali sambil membuka `.tcg koleksi` bolak-balik.',
          '🆕 `.tcg serpihsemua` memecah semua duplikat jadi serpihan sekaligus; `.tcg jualsemua` menjual semuanya jadi Keping.',
          '🎯 Bisa disaring: `.tcg serpihsemua common` hanya menyentuh Common, `.tcg jualsemua rare` hanya Rare. Tanpa saringan berarti semua rarity.',
          '🛡️ Pengaman yang sama seperti versi satuan: kartu terakhir dari tiap jenis TIDAK PERNAH ikut, kartu yang terpasang di dek aman, kartu yang sedang ekspedisi aman.',
          '⚠️ Rarity yang salah ketik ditolak, bukan dianggap "semua" — perintah ini menghancurkan kartu, jadi salah ketik tidak boleh berarti kehilangan seluruh koleksi duplikat.',
          '📖 Semua perintah baru sudah masuk `.menu` dan `.tcg bantuan`.'
        ]
      }
    ]
  },
  {
    versi: 'v3.0.2',
    nama: 'Bot Tidak Bisa Menendang Dirinya Sendiri (dan Owner Tidak Bisa Ditendang Siapa Pun)',
    tanggal: '27 Agustus 2026',
    sorotan: [
      '🛡️ *Perbaikan penting:* `.kick @bot` dulu benar-benar membuat bot KELUAR dari grup. Sekarang ditolak.',
      '👑 *Owner & Admin Toko sekarang kebal:* admin grup mana pun dulu bisa mengeluarkan Owner bot dari grupnya sendiri dengan satu perintah.',
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
        judul: '👑 *SIAPA BOLEH MENENDANG SIAPA*',
        poin: [
          '`.kick` dan `.demote` terbuka untuk *siapa pun yang jadi admin di grup WhatsApp* — bukan cuma Admin Toko.',
          'Artinya admin grup mana pun bisa mengeluarkan Owner bot dari grupnya sendiri dengan satu perintah, dan bot yang punya hak admin akan menurutinya.',
          '🪜 Sekarang ada tata tingkat: *Owner* boleh menyentuh siapa pun · *Admin Toko* boleh siapa pun kecuali Owner · *admin grup* boleh siapa pun kecuali Owner & Admin Toko.',
          '🎯 Hanya `.kick` dan `.demote` yang dijaga. `.promote` pada Owner tidak merugikan, dan `.add` sasarannya justru belum ada di grup.',
          '✅ Anggota biasa *tetap* bisa di-kick admin grup seperti sebelumnya — perisainya cuma menolak saat ada kecocokan pasti, tidak menebak.'
        ]
      },
      {
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
        ]
      },
      {
        judul: '🧪 *DIUJI*',
        poin: [
          'Uji regresi baru `npm run test:identity` — 59 pemeriksaan, semuanya lewat.',
          'Termasuk memastikan arah sebaliknya tetap aman: anggota sungguhan *tetap bisa* di-kick admin, dan Owner tetap bisa menindak Admin Toko.',
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
        judul: '🏅 *KARTU LEGENDARY & MYTHIC PUNYA GELAR*',
        poin: [
          'Di bawah nama kartu ⭐4 dan ⭐5 sekarang ada satu baris julukan berbahasa Inggris. `Batara Kala` bertuliskan _"Devourer of Time"_, `Nyi Blorong` _"Coils of the Golden Serpent"_, `Gatotkaca` _"Sinews of Wire, Bones of Iron"_.',
          'Gelar sengaja *hanya* ada di dua tier teratas. Kalau kartumu punya gelar, kamu sedang memegang sesuatu yang langka — ketiadaannya di tier bawah adalah penandanya.',
          '🌑 *`Voidreaper` berganti nama jadi `Kala Rau`* — raksasa penelan matahari dan bulan. Skillnya memang sudah bernama *Gerhana* sejak awal; sekarang namanya nyambung.',
          '⚠️ ID-nya tetap `MYT03`, jadi koleksi, level, dan dek kalian tidak tersentuh. Yang berubah cuma pencarian lewat nama: `.tcg kartu voidreaper` sekarang jadi `.tcg kartu kala rau`.',
          '_Nama kartu tetap Nusantara dan tidak akan diterjemahkan. Kalau nama Common jadi Inggris sementara nama dewa tetap lokal, tangga rarity-nya justru terbalik — kartu murah terdengar lebih megah daripada endgame._'
        ]
      },
      {
        judul: '🗂️ *MENU DITATA ULANG MENGIKUTI ALUR*',
        poin: [
          'Nomor menu dulu urutannya acak — spar di 3, gerbang di 5, gauntlet di 11. Terbaca sebagai daftar, bukan sebagai urutan yang mengajari pemain baru harus mulai dari mana.',
          '✅ Sekarang dikelompokkan mengikuti yang benar-benar kamu lakukan:',
          '   🎴 *DAPAT KARTU* — banner, koleksi',
          '   🃏 *SIAPKAN DEK* — dek, naik level, refine',
          '   ⚔️ *BERTARUNG* — spar, menara, rank, gauntlet, bos',
          '   🌾 *HARIAN* — gerbang, ekspedisi, misi',
          '   🏛️ *JANGKA PANJANG* — gelar, barter',
          '⚠️ *Nomornya bergeser.* Yang sudah hafal `.tcg 3` = spar sekarang dapat layar dek. Maaf — tapi nomor menu selalu dibaca dari menu yang sedang terbuka, sementara urutan yang acak jadi beban selamanya.',
          '🪙 Kepala menu sekarang menampilkan *Keping dan Picis* sekaligus.',
          '_`.tcg banner` dan `.tcg refine` sebelumnya cuma ada di `.menu` besar dan tidak terlihat sama sekali dari dalam menu Arena — sekarang keduanya ada di nomor 1 dan 5._'
        ]
      },
      {
        judul: '🔢 *SEMUA LAYAR KEPUTUSAN SEKARANG BERANGKA*',
        poin: [
          '`.tcg banner` sempat cuma menyebut NAMA kartu unggulannya. Itu layar tempat kamu memutuskan membakar 1.800 Keping — tanpa angka, keputusannya jadi tebakan.',
          '✅ Sekarang tiap kartu unggulan menampilkan *ATK · HP · KRIT · CP*, biaya bintang, *nama skill beserta angka efeknya*, dan apakah *kamu sudah punya* (lengkap dengan Lv dan R-mu).',
          '✅ Ditambah tiga angka yang sebelumnya harus dicari di layar lain: *kemajuan pity* menuju jaminan Mythic, *biaya tarikan*, dan *saldo Keping-mu sendiri*.',
          '',
          '🔧 `.tcg refine` juga sempat cuma menyebut R dan jumlah duplikat. Membakar duplikat itu *permanen*, jadi angkanya wajib terlihat sebelum diputuskan.',
          '✅ Sekarang tiap baris menampilkan efek *sebelum ➜ sesudah*, mis. `pukulan pertama +60%` ➜ *`+75%`*. Sesudah berhasil, bot langsung menunjukkan apa yang akan diberikan tingkat berikutnya.',
          '',
          '🃏 `.tcg kartu` sekarang punya *TANGGA R* di bawah *TANGGA LEVEL*, dengan penanda posisimu di keduanya. Dua sumbu berbeda — level membeli *stat*, refine membeli *skill* — dan sekarang keduanya bisa dibandingkan di layar yang sama.',
          '_Angkanya dihitung dari koefisien yang benar-benar dipakai mesin tempur, bukan ditulis ulang tangan, jadi mustahil melenceng dari yang sesungguhnya terjadi di duel._'
        ]
      },
      {
        judul: '✦ *NAIK LEVEL JAUH LEBIH MURAH SEKARANG*',
        poin: [
          'Biaya *serpihan* untuk naik level dipangkas besar-besaran. Menaikkan satu kartu Common ke Lv.5 dulu menuntut *30 duplikat* — sekitar 15 hari farming gerbang untuk SATU kartu. Sekarang *11 duplikat*, sekitar 5,5 hari.',
          '   ⭐ Common  30 ➜ *11*  ·  Rare 23 ➜ *10*  ·  Epic 15 ➜ *8*',
          '   _Legendary dan Mythic tidak disentuh — serpihannya memang sudah mahal luar biasa lewat rantai lebur._',
          '',
          'Kenapa: sistem level memang sudah mati (*212 dari 218 kartu di server masih Lv.1*), dan kedatangan refine membuatnya makin mati. Refine cuma menuntut *4 duplikat* di semua rarity, sementara naik level menuntut 30 di Common — memperebutkan duplikat yang sama persis.',
          '⚖️ Sekarang naik level berharga *1,75x sampai 2,75x* refine di semua rarity. Cukup mahal supaya memilih terasa berarti, tidak cukup mahal untuk jadi jebakan.',
          '_Perbandingan ini dikunci uji asap: kalau suatu saat salah satu ongkos digeser sampai timpang lagi, rilisnya ditolak._'
        ]
      },
      {
        judul: '🎚️ *OWNER BISA MENAIKKAN BATAS GACHA — SEHARI SAJA*',
        poin: [
          '`.tcg batas <angka>` menaikkan jatah tarikan harian semua pemain untuk *hari itu saja*. Cocok buat perayaan, banner terakhir, atau grup yang sedang ramai.',
          '⏳ *Hangus sendiri saat tanggal berganti.* Aturannya dikunci ke tanggal, bukan ke saklar menyala/mati — jadi tidak ada yang perlu dimatikan besok, dan tidak mungkin lupa dimatikan.',
          '   _Saklar biasa akan tetap menyala kalau bot kebetulan mati di tengah malam. Ini tidak bisa._',
          `🔒 Maksimal *200* tarikan/hari. Batas atas itu ada supaya satu salah ketik — 2000 alih-alih 200 — tidak menguras Keping seluruh grup dalam satu sore, dan itu tidak bisa dibatalkan sesudah kartunya keluar.`,
          '👀 Kalau batasnya sedang naik, *menu utama `.tcg` mengumumkannya* dan `.tcg rate` menampilkan angka barunya. Event yang tidak terlihat sama saja dengan event yang tidak pernah ada.',
          '',
          '➜ `.tcg batas` — siapa saja boleh melihat batas hari ini',
          '➜ `.tcg batas 50` — Owner/Admin Toko menaikkan',
          '➜ `.tcg batas normal` — batalkan lebih awal'
        ]
      },
      {
        judul: '🔒 *KEBOCORAN IZIN: MEMBER BIASA BISA MEMANGGIL SELURUH GRUP*',
        poin: [
          '`.tagall` dan `.hidetag` memang sudah lama dijaga admin. Tapi `.freegames tag` melakukan hal yang *persis sama* — mention seluruh anggota grup — *tanpa satu pun pemeriksaan izin*. Dan `.freegames` adalah perintah publik.',
          '⚠️ Lebih parah: pesan `.freegames` menempelkan tombol *📢 TagAll Group*, jadi siapa pun yang melihatnya bisa membunyikan notifikasi seluruh grup dengan *satu ketukan*.',
          '✅ Sekarang ketiga jalurnya (`.freegames tag`, `.freegames tagall`, `.freegamestag`) khusus Admin Grup / Admin Toko / Owner, dan tombolnya hanya muncul untuk yang berhak.',
          '✅ Penolakannya diberi alasan yang jelas, bukan didiamkan — orang yang menekan tombol berhak tahu kenapa tidak terjadi apa-apa.',
          '',
          '🛡️ Penjaga kedua ditambahkan langsung di blok mention massal `groupAdminHandler`. Gerbang utamanya ada ~1.300 baris di atas dan melindungi blok itu hanya selama nama perintahnya tetap terdaftar; untuk alat spam, jarak sejauh itu antara aturan dan yang diaturnya terlalu berisiko.',
          '',
          '🔧 Ikut ketahuan saat menulis ujinya: `.all` dan `.semua` disebut di kode sebagai alias hidetag tapi tidak pernah didaftarkan, jadi keduanya *mati untuk semua orang termasuk admin*. Sekarang hidup dan dijaga sama ketatnya.',
          '_Uji tetapnya ada di `scripts/tagallGuardTest.mjs` — 8 jalur, diperiksa dua arah: member harus ditolak DAN admin harus tetap bisa._'
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

/** Format terstruktur (Ditambah / Diperbaiki / Dikurang) untuk laporan Owner saat bot online & `.update`. */
export function formatRingkasanPerubahan(versi = VERSI_TERBARU) {
  const bagian = [];
  if (Array.isArray(versi.ditambah) && versi.ditambah.length > 0) {
    bagian.push(`➕ *DITAMBAH:*\n${versi.ditambah.map(p => `• ${p}`).join('\n')}`);
  }
  if (Array.isArray(versi.diperbaiki) && versi.diperbaiki.length > 0) {
    bagian.push(`🔧 *DIPERBAIKI / UPGRADE:*\n${versi.diperbaiki.map(p => `• ${p}`).join('\n')}`);
  }
  if (Array.isArray(versi.dikurang) && versi.dikurang.length > 0) {
    bagian.push(`➖ *DIKURANG / DIHAPUS:*\n${versi.dikurang.map(p => `• ${p}`).join('\n')}`);
  }
  if (bagian.length === 0) {
    return getSorotanUpdate(versi);
  }
  return bagian.join('\n\n');
}

/** Rincian penuh versi terbaru — dipakai `.update` / `.changelog`. */
export function getSystemChangelog() {
  const v = VERSI_TERBARU;
  const ringkasPerubahan = formatRingkasanPerubahan(v);
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

${ringkasPerubahan ? `🧭 *PERUBAHAN SINGKAT (DITAMBAH / DIPERBAIKI / DIKURANG):*\n\n${ringkasPerubahan}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` : ''}🔥 *RINCIAN LENGKAP PER BAGIAN:*

${blok}
${versiLama ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 *Versi Sebelumnya:*\n${versiLama}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 _Ketik \`.menu\` untuk melihat seluruh daftar perintah bot!_`;
}

/** Versi ringkas untuk pengumuman "bot online" — jangan sampai jadi tembok teks. */
export function getSorotanUpdate(versi = VERSI_TERBARU) {
  return (versi.sorotan || []).map(s => `• ${s}`).join('\n');
}

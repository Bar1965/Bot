/**
 * REGISTRY MENU BOT
 *
 * Satu sumber kebenaran untuk seluruh daftar perintah yang tampil di `.menu`.
 *
 * Bentuk data: setiap kategori punya `groups`, dan setiap grup punya `items`
 * ([perintah, deskripsi]) plus `inGame` opsional untuk perintah lanjutan yang
 * hanya dipakai saat sebuah sesi game/fitur sedang berjalan. Perintah lanjutan
 * sengaja tidak dijadikan bullet sendiri supaya daftar utama tetap pendek dan
 * gampang dipindai di layar HP.
 *
 * Aturan menulis deskripsi: maksimal sekitar 45 karakter. WhatsApp memakai font
 * proporsional dan layar HP sempit — deskripsi panjang akan wrap dan membuat
 * daftar terlihat berantakan.
 */

const categories = {
  jualan: {
    id: 'jualan',
    number: '1',
    title: '🛍️ PRODUK & JUALAN',
    tagline: 'Katalog produk, detail, paket hemat & lapak',
    aliases: ['1', 'jualan', 'produk', 'katalog', 'list', 'shop', 'store'],
    groups: [
      {
        title: '🔎 LIHAT & CARI',
        items: [
          ['.list / .produk', 'Katalog produk & status stok'],
          ['.p / .detail <kode>', 'Detail & spesifikasi produk'],
          ['.cari <kata kunci>', 'Cari produk per nama/kategori'],
          ['.bundle', 'Paket hemat bundling diskon']
        ]
      },
      {
        title: '🛒 BELI & LAPAK',
        items: [
          ['.beli <kode> <qty>', 'Masukkan produk ke keranjang'],
          ['.lapak', 'Lihat lapak komunitas penjual'],
          ['.lapak add <nama> <harga> <stok> <isi>', 'Buka lapak sendiri (Premium)']
        ]
      }
    ]
  },

  transaksi: {
    id: 'transaksi',
    number: '2',
    title: '🛒 TRANSAKSI & PEMBAYARAN',
    tagline: 'Keranjang, QRIS otomatis, saldo & garansi',
    aliases: ['2', 'transaksi', 'bayar', 'order', 'checkout', 'payment'],
    groups: [
      {
        title: '💳 BELANJA & BAYAR',
        items: [
          ['.keranjang', 'Isi keranjang belanja saat ini'],
          ['.checkout', 'Buat invoice & tagihan pembayaran'],
          ['.pay / .qris', 'Tampilkan QRIS pembayaran']
        ]
      },
      {
        title: '💰 SALDO & DOMPET',
        items: [
          ['.dompet / .wallet / .aset', 'Semua aset: IDR, poin, TCG terpadu 🆕'],
          ['.saldo', 'Cek sisa saldo deposit rupiah'],
          ['.deposit <nominal>', 'Top up saldo via QRIS otomatis']
        ]
      },
      {
        title: '📦 PESANAN SAYA',
        items: [
          ['.status', 'Status pesanan terakhir'],
          ['.riwayat', '5 transaksi terakhir'],
          ['.garansi [orderId]', 'Cek & klaim garansi akun'],
          ['.batal', 'Batalkan pesanan belum dibayar']
        ]
      }
    ]
  },

  game: {
    id: 'game',
    number: '3',
    title: '🎮 ARENA GAME',
    tagline: 'Undercover, Werewolf, Raid, Kasino, Kuis & RPG',
    aliases: ['3', 'game', 'games', 'gaming', 'arcade', 'play', 'mabar', 'permainan'],
    groups: [
      {
        title: '🕵️ SOSIAL & DEDUKSI',
        items: [
          ['.undercover / .sus [taruhan]', 'Deduksi kata rahasia via DM'],
          ['.undercover role / card', 'Panduan peran & toko kartu aksi'],
          ['.undercover stats / top', 'Statistik & papan peringkat'],
          ['.ww / .werewolf', 'Werewolf klasik siang & malam']
        ],
        inGame: [
          '.vote', '.lanjut', '.tukargiliran', '.bersalah / .bebas',
          '.anon <petunjuk>', '.bisik <pesan>', '.misirahasia', '.belihuruf'
        ]
      },
      {
        title: '🐉 RAID WORLD BOSS',
        items: [
          ['.raid / .worldboss [boss]', 'Raid co-op 5 boss, 4 kelas pemain'],
          ['.raid list', 'Daftar boss, kelemahan & cooldown grup'],
          ['.joinraid <dps/tank/heal/mage>', 'Gabung regu & pilih kelas'],
          ['.statusraid', 'HP boss, kondisi regu & cooldown skill'],
          ['.raidstats / .raidtop', 'Statistik & papan peringkat raid']
        ],
        inGame: ['.serang', '.tameng', '.taunt', '.heal', '.sihir <elemen>', '.freeze']
      },
      {
        title: '📦 LELANG KOTAK MISTERI',
        items: [
          ['.lelang / .auction [kotak]', 'Lelang kotak, 3 petunjuk bocor'],
          ['.lelang buta [kotak]', 'Tawaran tersegel via DM'],
          ['.lelang kutuk', 'Lelang terbalik: paling nekat menang'],
          ['.lelang gudang', '3 lot berurutan satu dompet'],
          ['.lelang list', 'Isi gudang, stok & semua mode lelang'],
          ['.bid <poin> / .bidup', 'Pasang tawaran (poin langsung ditahan)'],
          ['.lelangstats / .lelangtop', 'Untung rugi & papan peringkat']
        ],
        inGame: ['.bidup', '.infolelang', '.endus', '.gertak <poin>', '.sikut @orang', '.cancellelang']
      },
      {
        title: '🧠 KUIS & TEBAK-TEBAKAN',
        items: [
          ['.quiz / .trivia', 'Kuis trivia pilihan ganda'],
          ['.cerdascermat [taruhan]', 'Turnamen kuis sistem gugur'],
          ['.family100 / .f100', 'Kuis survei tebak banyak kata'],
          ['.caklontong', 'Teka-teki logika plesetan'],
          ['.tebakgambar', 'Tebak gambar dari potongan visual'],
          ['.tebaklagu', 'Tebak judul & artis dari audio'],
          ['.tebakbendera', 'Tebak negara dari benderanya'],
          ['.tebakkata / .susunkata', 'Tebak kata & susun anagram'],
          ['.tebakemoji', 'Tebak arti rangkaian emoji'],
          ['.sambungkata', 'Sambung huruf terakhir kata'],
          ['.tebakangka', 'Tebak angka 1-100, pot progresif']
        ]
      },
      {
        title: '🎰 KASINO & POKER',
        items: [
          ['.poker / .texaspoker [taruhan]', 'Texas Hold\'em Poker 2-8 pemain 🆕'],
          ['.bom [taruhan]', 'Cut The Wire potong kabel bom 2-6p 🆕'],
          ['.battleship @lawan [taruhan]', 'Perang armada kapal laut 1v1 🆕'],
          ['.buckshot @lawan [taruhan]', 'Shotgun roulette taktis 1v1 + item 🆕'],
          ['.uno [taruhan]', 'UNO 2-6 pemain, kartu via DM + bot AI 🆕'],
          ['.capsa / .capsasusun [taruhan]', 'Capsa Susun 13 kartu adu tingkat 🆕'],
          ['.fastpoker / .poker3 [taruhan]', 'Fast 3-Card Poker kilat 🆕'],
          ['.bj / .blackjack [taruhan]', 'Kartu 21 lawan Dealer (10-5.000)'],
          ['.mines <taruhan> [1-24 bom]', 'Ranjau poin 5x5 cari multiplier'],
          ['.slot / .spin [taruhan]', 'Mesin slot & Lucky Spin Wheel'],
          ['.duel @member [taruhan]', 'Russian Roulette 1v1'],
          ['.suit @member [taruhan]', 'Suit gunting-batu-kertas'],
          ['.balapkuda', 'Pacuan kuda multi-betting grup']
        ],
        inGame: ['.hit', '.stand', '.double', '.buka', '.cashout', '.infomines', '.pasangkuda', '.check', '.call', '.raise', '.allin', '.fold', '.kartu', '.capsa ready', '.potong <warna>', '.tembak <koordinat>', '.pakai <item>']
      },
      {
        title: '🎴 ARENA KARTU MONSTER — DASAR',
        items: [
          ['.tcg', 'Menu utama Arena Kartu Monster'],
          ['.tcg mulai', 'Ambil paket pemula (satu kali seumur hidup)'],
          ['.tcg banner', 'Kartu unggulan & rate on/off saat ini'],
          ['.tcg batas', 'Lihat batas tarikan harian hari ini'],
          ['.tcg gacha', 'Tarikan kartu: 1 kartu acak'],
          ['.tcg gacha10', 'Tarikan ×10: bonus rate rarity tinggi'],
          ['.tcg koleksi [rarity/elemen]', 'Semua kartu milikmu'],
          ['.tcg kartu <id>', 'Detail stat & tangga level kartu'],
          ['.tcg dek', 'Lihat susunan dek aktif 3v3'],
          ['.tcg pasang <1-3> <id>', 'Pasang kartu ke slot dek'],
          ['.tcg lepas <1-3>', 'Kosongkan slot dek'],
          ['.tcg tukar <slot> <slot>', 'Tukar posisi dua kartu di dek'],
          ['.tcg autodek / .tcg bestdek', 'Pasang 3 kartu terkuat otomatis'],
          ['.tcg autodek <elemen>', 'Dek yang unggul melawan elemen itu 🆕'],
          ['.tcg autodek abadi', 'Dek yang lolos syarat lantai Abadi 🆕']
        ]
      },
      {
        title: '⚔️ TCG — PERTARUNGAN',
        items: [
          ['.tcg spar <@member>', 'Sparring latihan (tanpa energi)'],
          ['.tcg duel @member [taruhan]', 'Duel PvP di grup'],
          ['.tcg gas / .tcg tolak', 'Terima atau tolak tantangan duel'],
          ['.tcg menara / .tcg menara lawan', 'Menara PvE 30 lantai'],
          ['.tcg gerbang [elemen]', 'Gerbang elemen harian: serpihan + Picis'],
          ['.tcg abadi', 'Menara Abadi tanpa ujung (post-lantai 30)'],
          ['.tcg rank / .tcg rank top', 'Peringkat & papan 10 besar musim ini'],
          ['.tcg gauntlet', '3 lawan pekanan, kartu tak boleh diulang 🆕'],
          ['.tcg gauntlet dek / lawan', 'Susun dek bebas kunci & bertarung 🆕'],
          ['.tcg bos', 'Bos Arena grup: HP bersama, hadiah dibagi 🆕'],
          ['.tcg bos serang', 'Pukul bos, 3x sehari (bawa counter!) 🆕']
        ]
      },
      {
        title: '⚙️ TCG — NAIK LEVEL & SERPIH',
        items: [
          ['.tcg naik', 'Daftar kartu yang siap naik level'],
          ['.tcg refine <id>', 'Sisipkan duplikat: naikkan R kartu'],
          ['.tcg naik <id>', 'Naik level: serpihan + Picis (maks Lv.5)'],
          ['.tcg serpih <id> [n]', 'Pecah duplikat kartu jadi serpihan'],
          ['.tcg serpihsemua [rarity]', 'Pecah SEMUA duplikat sekaligus 🆕'],
          ['.tcg lebur <rarity>', 'Lebur serpihan ke tingkat lebih tinggi'],
          ['.tcg jual <id> [n]', 'Jual kartu duplikat dapat Keping'],
          ['.tcg jualsemua [rarity]', 'Jual SEMUA duplikat sekaligus 🆕'],
          ['.tcg serpihan', 'Cek stok serpihan per rarity'],
          ['.tcg keping', 'Dompet: Keping + Picis']
        ]
      },
      {
        title: '🌾 TCG — FARMING & HARIAN',
        items: [
          ['.tcg daily', 'Hadiah harian + beruntun & tonggak'],
          ['.tcg misi', 'Misi harian Arena & klaim hadiah'],
          ['.tcg mingguan', 'Misi mingguan, reset tiap Senin'],
          ['.tcg ekspedisi <id> <jam>', 'Kirim kartu cari Keping, Picis & serpihan'],
          ['.tcg ekspedisi klaim', 'Ambil hasil ekspedisi yang sudah pulang'],
          ['.tcg ransum', 'Gunakan ransum pemulih energi'],
          ['.tcg ambil <1-3>', 'Sambar kartu dari drop acak grup']
        ]
      },
      {
        title: '🏅 TCG — JANGKA PANJANG',
        items: [
          ['.tcg barter @member <idku> <idmu>', 'Tukar kartu duplikat antar pemain'],
          ['.tcg gelar / .tcg gelar <id>', 'Koleksi & pasang gelar Arena'],
          ['.tcg tonggak / .tcg tonggak klaim', 'Hadiah tonggak koleksi kartu'],
          ['.tcg rate', 'Peluang gacha & rate per rarity'],
          ['.tcg sinergi', 'Tabel bonus sinergi elemen & peran'],
          ['.tcg bantuan [topik]', 'Panduan lengkap per topik']
        ]
      },
      {
        title: '🦹 AKSI EKONOMI',
        items: [
          ['.heist / .rampokbank [1-4]', 'Misi bobol brankas bank grup'],
          ['.steal / .maling @member', 'Curi poin member lain'],
          ['.jailbreak / .kabur', 'Teka-teki kabur dari penjara'],
          ['.tebus @napi', 'Bayar jaminan bebaskan teman']
        ]
      }
    ]
  },

  media: {
    id: 'media',
    number: '4',
    title: '📥 MEDIA & CREATIVE TOOLS',
    tagline: 'Downloader, stiker, AI drawing, remini & audio',
    aliases: ['4', 'media', 'downloader', 'tools', 'download', 'alat'],
    groups: [
      {
        title: '📥 DOWNLOADER',
        items: [
          ['.tt / .ig / .fb / .yt / .pin <link>', 'Unduh video, reels, slide & MP3'],
          ['.song / .play <judul>', 'Unduh lagu MP3 dari YouTube']
        ]
      },
      {
        title: '🎨 STIKER & GAMBAR',
        items: [
          ['.stiker / .s', 'Foto/video jadi stiker'],
          ['.toimg / .tovid', 'Stiker jadi foto / video'],
          ['.qc <teks>', 'Quote sticker chat estetik'],
          ['.brat <teks>', 'Stiker teks gaya Brat'],
          ['.hd / .remini', 'Perjelas foto buram jadi HD'],
          ['.draw <prompt>', 'Gambar AI dari deskripsi teks'],
          ['.meme atas | bawah', 'Buat meme dari foto'],
          ['.getpp / .colongpp', 'Ambil foto profil kualitas HD']
        ]
      },
      {
        title: '🔊 AUDIO & TEKS',
        items: [
          ['.tts <teks>', 'Ubah teks jadi voice note'],
          ['.tomp3 / .tovn', 'Ekstrak audio dari video'],
          ['.tr <bahasa> <teks>', 'Terjemahkan teks'],
          ['.sholat <kota>', 'Jadwal sholat wilayahmu'],
          ['.menfess <nomor> | <teks>', 'Kirim pesan anonim']
        ]
      }
    ]
  },

  reward: {
    id: 'reward',
    number: '5',
    title: '🏆 POIN, BANK & REWARD',
    tagline: 'Akbar Poin, bank, level, power-up & misi harian',
    aliases: ['5', 'poin', 'reward', 'bank', 'ekonomi', 'saldo', 'level'],
    groups: [
      {
        title: '💰 POIN & LEVEL',
        items: [
          ['.poin / .profile', 'Level, XP, ranking & saldo poin'],
          ['.dompet / .wallet / .aset', 'Semua aset: IDR, poin, TCG terpadu 🆕'],
          ['.daily', 'Klaim poin & XP gratis harian'],
          ['.lb / .rank', 'Papan peringkat — 13 kategori'],
          ['.lb lvl / raid / lelang / tcg', 'Peringkat per kategori + posisimu'],
          ['.lb peringkat / abadi / tcgstreak', 'Arena: duel, Menara Abadi, beruntun'],
          ['.lb kaya / menang / streak / chat', 'Sultan, juara, streak & paling aktif'],
          ['.misi', 'Misi & tantangan harian'],
          ['.badge', 'Koleksi badge pencapaian']
        ]
      },
      {
        title: '🏦 BANK POIN',
        items: [
          ['.bank / .brankas', 'Saldo bank (aman maling, bunga 2%)'],
          ['.depo [jumlah/all]', 'Setor poin ke bank'],
          ['.tarik [jumlah/all]', 'Tarik poin dari bank (pajak 2%)'],
          ['.transfer @user <jumlah>', 'Kirim poin ke member (pajak 1%)']
        ]
      },
      {
        title: '⚡ POWER-UP & BONUS',
        items: [
          ['.tukar', 'Toko Power-Up: XP Booster, perisai, dll'],
          ['.kupon <kode>', 'Pakai voucher diskon belanja'],
          ['.referral', 'Ajak teman, dapat hadiah']
        ]
      }
    ]
  },

  premium: {
    id: 'premium',
    number: '6',
    title: '👑 PREMIUM & AI',
    tagline: 'Membership VIP Silver/Gold/Diamond & AI Gemini',
    aliases: ['6', 'premium', 'vip', 'ai', 'gemini'],
    groups: [
      {
        title: '👑 MEMBERSHIP VIP',
        items: [
          ['.premium', 'Daftar paket, harga & benefit VIP'],
          ['.upgradepremium <tier>', 'Beli VIP pakai saldo deposit'],
          ['.claimvoucher', 'Klaim voucher bulanan (Diamond)']
        ]
      },
      {
        title: '🤖 FITUR VIP',
        items: [
          ['.ai <pertanyaan>', 'Tanya AI Gemini (bisa reply foto)'],
          ['.wishlist add <kode>', 'Notif DM saat produk restock']
        ]
      }
    ]
  },

  pdf: {
    id: 'pdf',
    number: '7',
    title: '📄 PDF & OCR TOOLS',
    tagline: 'Merge, split, gambar ke PDF & ekstrak teks (Premium)',
    aliases: ['7', 'pdf', 'dokumen', 'ocr'],
    groups: [
      {
        items: [
          ['.pdfmerge', 'Gabung beberapa PDF jadi satu'],
          ['.pdfsplit <halaman>', 'Potong halaman PDF tertentu'],
          ['.img2pdf', 'Ubah gambar jadi dokumen PDF'],
          ['.pdf2txt', 'Ekstrak teks dari dokumen PDF'],
          ['.ocr', 'Ekstrak teks dari gambar/foto']
        ]
      }
    ]
  },

  hiburan: {
    id: 'hiburan',
    number: '8',
    title: '🎉 HIBURAN & SOSIAL',
    tagline: 'AFK, Truth or Dare, khodam, poll & info game gratis',
    aliases: ['8', 'hiburan', 'fun', 'sosial', 'social'],
    groups: [
      {
        title: '🎲 ISENG & RAMALAN',
        items: [
          ['.truth / .dare / .tod', 'Permainan Truth or Dare'],
          ['.khodam <nama>', 'Ramalan khodam lucu'],
          ['.jodoh / .love', 'Persentase kecocokan jodoh'],
          ['.zodiak <zodiak>', 'Ramalan zodiak harian'],
          ['.dadu / .coinflip', 'Lempar dadu atau koin'],
          ['.karbit', 'Easter egg detektor fans karbit']
        ]
      },
      {
        title: '👥 GRUP & INFO',
        items: [
          ['.afk <alasan>', 'Status AFK, auto-reply saat ditag'],
          ['.poll tanya | opsi1 | opsi2', 'Buat voting polling grup'],
          ['.freegames', 'Info game PC original gratis']
        ]
      }
    ]
  },

  admin: {
    id: 'admin',
    number: '9',
    title: '🛡️ AKUN, GRUP & SISTEM',
    tagline: 'Profil member, pengaturan grup & status bot',
    aliases: ['9', 'admin', 'owner', 'pengaturan', 'setting'],
    groups: [
      {
        title: '👤 AKUN MEMBER',
        items: [
          ['.daftar <nama>', 'Registrasi member baru'],
          ['.gantinama <nama baru>', 'Ganti nama profil'],
          ['.profil', 'Detail lengkap profil member']
        ]
      },
      {
        title: '⚙️ PENGATURAN GRUP (Admin)',
        items: [
          ['.fiturgrup / .listfitur', 'Status & toggle fitur grup'],
          ['.mode <jualan/all>', 'Mode grup: khusus jualan / semua'],
          ['.autodl <on/off>', 'Auto-download TikTok & IG'],
          ['.levelup <on/off>', 'Notifikasi kartu level-up'],
          ['.tagall <pesan>', 'Mention seluruh anggota grup'],
          ['.cekwarn [@user]', 'Lihat siapa mendekati ambang kick'],
          ['.unwarn @user [1]', 'Maafkan peringatan moderasi']
        ]
      },
      {
        title: '🤖 SISTEM BOT',
        items: [
          ['.ping', 'Cek kecepatan & status server'],
          ['.owner', 'Kontak Developer & Owner bot'],
          ['.update / .changelog', 'Catatan pembaruan bot per versi'],
          ['.update broadcast (Owner)', 'Siarkan catatan rilis ke semua grup'],
          ['.update on / off (Owner)', 'Atur pengumuman rilis otomatis'],
          ['.bansos (Owner)', 'Bagi poin/keping/energi/kartu massal'],
          ['.bansos paket / drop (Owner)', 'Paket campuran & drop kartu semua grup'],
          ['.backup', 'Backup database (Owner)']
        ]
      }
    ]
  }
};

const GARIS = '━━━━━━━━━━━━━━━━━━━━';

function resolveCategory(value) {
  if (!value) return null;
  const val = String(value).trim().toLowerCase();
  if (['all', 'semua', 'menu', 'help', 'bantuan'].includes(val)) return 'INDEX';
  if (['full', 'semuanya', 'lengkap', 'allfull'].includes(val)) return 'FULL';
  return Object.entries(categories).find(([, category]) => category.aliases.includes(val))?.[0] || null;
}

/**
 * Id kategori hasil resolve, atau null untuk beranda/full/tidak dikenal.
 * Dipakai pemanggil supaya tombol navigasi tidak menawarkan kategori yang
 * sedang dibuka.
 */
export function resolveCategoryId(value) {
  const hasil = resolveCategory(value);
  return (hasil === 'INDEX' || hasil === 'FULL') ? null : hasil;
}

/** Render satu grup perintah menjadi baris-baris teks. */
function renderGroup(group, lines) {
  if (group.title) lines.push(`*${group.title}*`);
  for (const [cmd, desc] of group.items) {
    lines.push(`› \`${cmd}\` — ${desc}`);
  }
  if (group.inGame && group.inGame.length > 0) {
    lines.push(`   ↳ _saat main:_ ${group.inGame.map(c => `\`${c}\``).join(' ')}`);
  }
  lines.push('');
}

export function buildCommandMenu(value = 'all', { salesMode = false } = {}) {
  const normalized = String(value || 'all').toLowerCase();
  const selected = resolveCategory(normalized);
  const visibleCategories = salesMode
    ? ['jualan', 'transaksi', 'reward', 'admin']
    : Object.keys(categories);

  // KONDISI 1: Beranda menu (.menu)
  if (!selected || selected === 'INDEX') {
    const lines = [
      '🏪 *AKBAR STORE BOT*',
      '_Awali setiap perintah dengan titik._',
      GARIS,
      ''
    ];

    if (salesMode) {
      lines.push('🛍️ *MODE JUALAN AKTIF*');
      lines.push('_Fitur game & media dimatikan di grup ini._');
      lines.push('');
    }

    for (const key of visibleCategories) {
      const cat = categories[key];
      lines.push(`*${cat.number}. ${cat.title}*`);
      lines.push(`   _${cat.tagline}_`);
    }

    lines.push('');
    lines.push(GARIS);
    // Contoh diambil dari kategori pertama yang benar-benar tampil, supaya di
    // mode jualan tidak menyarankan kategori yang justru disembunyikan.
    const contoh = categories[visibleCategories[0]];
    lines.push(`📖 Buka kategori: \`.menu ${contoh.number}\` atau \`.menu ${contoh.id}\``);
    if (!salesMode) lines.push('📚 Semua perintah: `.menu full`');

    return lines.join('\n').trim();
  }

  // KONDISI 2: Seluruh perintah sekaligus (.menu full)
  if (selected === 'FULL') {
    const lines = [
      '📚 *SEMUA PERINTAH — AKBAR STORE BOT*',
      GARIS,
      ''
    ];

    for (const key of visibleCategories) {
      const cat = categories[key];
      lines.push(`*${cat.number}. ${cat.title}*`);
      lines.push('');
      for (const group of cat.groups) renderGroup(group, lines);
    }

    lines.push(GARIS);
    lines.push('🔙 Kembali ke ringkasan: `.menu`');
    return lines.join('\n').trim();
  }

  // KONDISI 3: Satu kategori (.menu game, .menu 3, .menu jualan)
  if (selected && visibleCategories.includes(selected)) {
    const cat = categories[selected];
    const lines = [
      `*${cat.title}*`,
      `_${cat.tagline}_`,
      GARIS,
      ''
    ];

    for (const group of cat.groups) renderGroup(group, lines);

    lines.push(GARIS);
    lines.push('🔙 Daftar kategori: `.menu`');
    return lines.join('\n').trim();
  }

  return null;
}

export function getRegisteredCommands() {
  return Object.values(categories).flatMap(category =>
    category.groups.flatMap(group => group.items.map(([command]) => command))
  );
}

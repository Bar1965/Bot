const categories = {
  jualan: {
    title: '🛍️ PRODUK & JUALAN',
    aliases: ['1', 'jualan', 'produk'],
    commands: [
      ['.produk', 'Lihat katalog dan stok'],
      ['.beli <kode> <jumlah>', 'Tambah produk ke keranjang'],
      ['.cari <kata kunci>', 'Cari produk toko'],
      ['.bundle', 'Lihat paket hemat']
    ]
  },
  transaksi: {
    title: '🛒 TRANSAKSI & PEMBAYARAN',
    aliases: ['2', 'transaksi', 'bayar'],
    commands: [
      ['.keranjang', 'Lihat keranjang belanja'],
      ['.checkout', 'Buat tagihan pembayaran'],
      ['.status', 'Cek status pesanan terakhir'],
      ['.riwayat', 'Lihat riwayat pesanan'],
      ['.batal', 'Batalkan pesanan aktif']
    ]
  },
  media: {
    title: '📥 MEDIA & CREATIVE',
    aliases: ['3', 'media', 'downloader'],
    commands: [
      ['.tt / .ig / .fb / .yt <link>', 'Download media'],
      ['.stiker', 'Foto/video menjadi stiker'],
      ['.toimg / .tovid', 'Konversi stiker'],
      ['.qc <teks>', 'Buat quote sticker'],
      ['.meme teks atas | teks bawah', 'Buat meme dari foto'],
      ['.brat <teks>', 'Buat stiker Brat'],
      ['.draw <prompt>', 'Buat gambar AI'],
      ['.tts <teks>', 'Ubah teks menjadi voice note']
    ]
  },
  hiburan: {
    title: '🎮 HIBURAN & GAME',
    aliases: ['hiburan', 'game', 'games', 'fun'],
    commands: [
      ['.freegames', 'Daftar semua game PC gratis 100% (Steam, Epic, GOG, dll)'],
      ['.slot [taruhan]', 'Spin judi slot machine virtual'],
      ['.zodiak <zodiak>', 'Ramalan harian zodiak'],
      ['.jodoh <nama1> & <nama2>', 'Tes kecocokan pasangan'],
      ['.quiz / .trivia', 'Kuis pilihan ganda'],
      ['.tebakemoji', 'Tebak arti emoji'],
      ['.tebakkata', 'Tebak kata dari petunjuk'],
      ['.tebakgambar', 'Tebak gambar dengan batas waktu'],
      ['.jawab <jawaban>', 'Jawab game yang aktif'],
      ['.hint', 'Minta petunjuk game'],
      ['.sambungkata', 'Game sambung kata grup'],
      ['.truth / .dare', 'Truth or Dare'],
      ['.dadu / .coinflip', 'Lempar dadu atau koin'],
      ['.khodam <nama>', 'Cek khodam lucu'],
      ['.poll pertanyaan | opsi 1 | opsi 2', 'Buat voting WhatsApp']
    ]
  },
  reward: {
    title: '🏆 POIN & REWARD',
    aliases: ['4', 'promo', 'diskon', 'referral', 'poin', 'rank', 'reward'],
    commands: [
      ['.daily', 'Klaim hadiah harian'],
      ['.poin / .profile', 'Lihat XP, level, dan poin'],
      ['.rank / .leaderboard', 'Lihat peringkat pemain'],
      ['.badge', 'Lihat pencapaian game'],
      ['.rekomendasi', 'Dapatkan rekomendasi produk'],
      ['.misi', 'Lihat misi harian'],
      ['.kupon <kode>', 'Gunakan kupon diskon'],
      ['.referral', 'Program ajak teman'],
      ['.favorit', 'Lihat wishlist produk']
    ]
  },
  favorit: {
    title: '💝 FAVORIT & NOTIFIKASI',
    aliases: ['5', 'favorit', 'wishlist'],
    commands: [
      ['.favorit', 'Lihat wishlist produk'],
      ['.simpan <kode>', 'Simpan produk ke wishlist'],
      ['.notify <kode>', 'Dapatkan notifikasi restock'],
      ['.rekomendasi', 'Dapatkan rekomendasi produk']
    ]
  },
  admin: {
    title: '🛡️ ADMIN & OWNER',
    aliases: ['6', 'admin'],
    commands: [
      ['.owner', 'Kontak resmi Owner'],
      ['.ping', 'Cek status dan kecepatan bot'],
      ['.mode <jualan/all>', 'Atur mode grup'],
      ['.tagall <pesan>', 'Mention anggota grup'],
      ['.daftar <nama>', 'Daftar profil member'],
      ['.profil', 'Lihat role, status, tier, level, dan poin'],
      ['.setmemberrole @user MEMBER|ADMIN', 'Ubah role member (Owner)'],
      ['.setmemberstatus @user ACTIVE|BANNED', 'Ubah status member (Admin)'],
      ['.backup', 'Buat backup database']
    ]
  }
};

function resolveCategory(value) {
  if (!value || ['all', 'semua', 'menu'].includes(value)) return null;
  return Object.entries(categories).find(([, category]) => category.aliases.includes(value))?.[0] || null;
}

export function buildCommandMenu(value = 'all', { salesMode = false } = {}) {
  const normalized = String(value || 'all').toLowerCase();
  const selected = resolveCategory(normalized);
  const visibleCategories = salesMode
    ? ['jualan', 'transaksi', 'reward', 'favorit', 'admin']
    : Object.keys(categories);

  if (selected && !visibleCategories.includes(selected)) return null;

  const lines = [
    '╭━━━ *AKBAR STORE BOT* ━━━╮',
    '┃ Menu command terstruktur',
    '┃ Prefix: `.`, `/`, atau `#`',
    '╰━━━━━━━━━━━━━━━━━━━━━━╯',
    ''
  ];

  const entries = selected ? [[selected, categories[selected]]] : visibleCategories.map(key => [key, categories[key]]);
  for (const [, category] of entries) {
    lines.push(`*${category.title}*`);
    for (const [command, description] of category.commands) {
      lines.push(`• \`${command}\` — ${description}`);
    }
    lines.push('');
  }

  if (!selected) {
    lines.push('Ketik `.menu hiburan` untuk membuka game, atau `.menu reward` untuk melihat poin dan hadiah.');
  }
  if (salesMode) {
    lines.push('Mode jualan aktif: game dan media disembunyikan agar grup tetap fokus transaksi.');
  }
  return lines.join('\n').trim();
}

export function getRegisteredCommands() {
  return Object.values(categories).flatMap(category => category.commands.map(([command]) => command));
}

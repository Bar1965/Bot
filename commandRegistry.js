const categories = {
  jualan: {
    title: '🛍️ PRODUK & JUALAN',
    aliases: ['1', 'jualan', 'produk', 'list', 'katalog'],
    commands: [
      ['.list / .produk', 'Lihat katalog produk ringkas'],
      ['.p <kode> / .detail <kode>', 'Lihat deskripsi & detail produk'],
      ['.beli <kode> <jumlah>', 'Tambah produk ke keranjang'],
      ['.lapak', 'Lihat / buka lapak reseller komunitas'],
      ['.lapak add <nama> <harga> <stok> <isi>', 'Buka lapak (Premium)'],
      ['.cari <kata kunci>', 'Cari produk toko'],
      ['.bundle', 'Lihat paket hemat']
    ]
  },
  transaksi: {
    title: '🛒 TRANSAKSI & PEMBAYARAN',
    aliases: ['2', 'transaksi', 'bayar'],
    commands: [
      ['.pay / .qris', 'Tampilkan QRIS pembayaran langsung'],
      ['.keranjang', 'Lihat keranjang belanja'],
      ['.checkout', 'Buat tagihan pembayaran'],
      ['.status', 'Cek status pesanan terakhir'],
      ['.garansi [orderId]', 'Cek masa garansi & klaim akun'],
      ['.riwayat', 'Lihat riwayat pesanan'],
      ['.batal', 'Batalkan pesanan aktif']
    ]
  },
  premium2: {
    title: '👑 PREMIUM MEMBERSHIP 2.0',
    aliases: ['premium', 'vip', 'ai'],
    commands: [
      ['.premium', 'Daftar paket & benefit Premium 2.0'],
      ['.upgradepremium <tier>', 'Upgrade ke Silver/Gold/Diamond'],
      ['.ai <pertanyaan>', 'Tanya AI Gemini (atau reply foto)'],
      ['.claimvoucher', 'Klaim voucher bulanan gratis (Diamond)'],
      ['.wishlist add <kode>', 'DM WhatsApp otomatis saat produk restock']
    ]
  },
  pdf: {
    title: '📄 PDF TOOLS (Premium)',
    aliases: ['pdf', 'dokumen'],
    commands: [
      ['.pdfmerge', 'Gabungkan beberapa file PDF'],
      ['.pdfsplit <halaman>', 'Ambil/potong halaman PDF tertentu'],
      ['.img2pdf', 'Ubah gambar menjadi dokumen PDF'],
      ['.pdf2txt', 'Ekstrak teks dari PDF asli'],
      ['.ocr', 'Ekstrak teks dari gambar / foto']
    ]
  },

  media: {
    title: '📥 MEDIA & CREATIVE',
    aliases: ['3', 'media', 'downloader'],
    commands: [
      ['.tt / .ig / .fb / .yt / .pin <link>', 'Download media (Foto, Slide/Carousel, Video)'],
      ['.stiker', 'Foto/video menjadi stiker'],
      ['.toimg / .tovid', 'Konversi stiker'],
      ['.qc <teks>', 'Buat quote sticker'],
      ['.brat <teks>', 'Buat stiker Brat'],
      ['.getpp / .colongpp', 'Ambil foto profil target HD (tag / reply / nomor)'],
      ['.stikerpp', 'Colong PP target langsung jadi stiker WA'],
      ['.meme teks atas | teks bawah', 'Buat meme dari foto'],
      ['.draw <prompt>', 'Buat gambar AI'],
      ['.tts <teks>', 'Ubah teks menjadi voice note'],
      ['.song / .play <judul>', 'Download musik MP3 dari YouTube'],
      ['.tomp3 / .tovn', 'Ekstrak audio dari video (reply video)'],
      ['.tr / .translate <lang> <teks>', 'Terjemahkan teks (atau reply pesan)'],
      ['.sholat <kota>', 'Cek jadwal sholat wilayah setempat'],
      ['.menfess <nomor> | <teks>', 'Kirim pesan anonim rahasia ke nomor target'],
      ['.balasmenfess <ID> <pesan>', 'Balas pesan rahasia anonim secara 2-arah'],
      ['.stopmenfess <ID>', 'Akhiri sesi percakapan anonim'],
      ['.hd / .remini', 'Tingkatkan kualitas foto buram jadi HD']
    ]
  },
  hiburan: {
    title: '🎮 HIBURAN & GAME',
    aliases: ['hiburan', 'game', 'games', 'fun'],
    commands: [
      ['.freegames', 'Daftar semua game PC gratis 100%'],
      ['.family100 / .f100', 'Kuis survei tebak banyak kata grup'],
      ['.caklontong', 'Teka-teki logika plesetan lucu Cak Lontong'],
      ['.duel @member [taruhan]', 'Duel tembak Russian Roulette 1v1 antar member'],
      ['.tembak / .terimaduel', 'Aksi tarik pelatuk / terima tantangan duel'],
      ['.bj / .blackjack [taruhan]', 'Main kartu kasino 21 melawan Dealer Bot (.hit / .stand)'],
      ['.heist / .rampokbank', 'Misi bobol brankas bank bersama tim (Awas penjara!)'],
      ['.joinheist / .startheist', 'Gabung regu / mulai operasi pembobolan bank'],
      ['.balapkuda', 'Pacuan kuda multi-betting grup (Waktu taruhan 2 menit)'],
      ['.pasangkuda [1-5] [jumlah]', 'Pasang taruhan pada kuda jagoan'],
      ['.steal @member / .maling', 'Misi pembobolan brankas poin dengan tantangan bypass'],
      ['.hack <jawaban>', 'Ketik jawaban bypass tantangan pembobolan brankas'],
      ['.ww / .werewolf', 'Mainkan game Werewolf/Mafia multiplayer'],
      ['.tebakbendera / .tebaknegara', 'Game tebak bendera & nama negara dunia'],
      ['.tebaklagu', 'Game kuis tebak judul lagu dari potongan musik audio'],
      ['.afk <alasan>', 'Set status AFK (Auto-reply saat di-mention)'],
      ['.slot [taruhan]', 'Spin judi slot machine virtual'],
      ['.suit @member [poin]', 'Tantang suit (Gunting-Batu-Kertas) multiplayer'],
      ['.spin [taruhan]', 'Putar Roda Keberuntungan (Lucky Spin)'],
      ['.tebakangka', 'Mulai game tebak angka Pot Progresif grup'],
      ['.tebak [angka]', 'Tebak angka rahasia aktif'],
      ['.cancelsuit', 'Batalkan tantangan suit aktif'],
      ['.quiz / .trivia', 'Kuis pilihan ganda'],
      ['.tebakemoji', 'Tebak arti emoji'],
      ['.tebakkata', 'Tebak kata dari petunjuk'],
      ['.tebakgambar', 'Tebak gambar dari teka-teki visual'],
      ['.susunkata', 'Menyusun huruf menjadi kata yang benar'],
      ['.jawab <jawaban>', 'Jawab game yang aktif'],
      ['.hint', 'Minta petunjuk game'],
      ['.sambungkata', 'Game sambung kata grup'],
      ['.truth / .dare', 'Truth or Dare'],
      ['.dadu / .coinflip', 'Lempar dadu atau koin'],
      ['.khodam <nama>', 'Cek khodam lucu'],
      ['.karbit', 'Easter egg detektor fans karbit'],
      ['.poll pertanyaan | opsi 1 | opsi 2', 'Buat voting WhatsApp']
    ]
  },
  reward: {
    title: '🏆 POIN & REWARD',
    aliases: ['4', 'promo', 'diskon', 'referral', 'poin', 'rank', 'reward', 'bank'],
    commands: [
      ['.bank / .brankas', 'Cek rekening bank poin (Aman dari maling + Bunga 2%/hari)'],
      ['.depo [jumlah/all]', 'Setor poin dompet ke rekening bank'],
      ['.tarik [jumlah/all]', 'Tarik poin dari bank ke dompet (Pajak 2%)'],
      ['.daily', 'Klaim hadiah harian'],
      ['.poin / .profile', 'Lihat XP, level, dan poin'],
      ['.transfer @user <jumlah>', 'Transfer poin ke member lain (Pajak 1%)'],
      ['.tukar [nomor]', 'Tukar poin dengan kupon belanja/premium'],
      ['.rank / .leaderboard', 'Lihat peringkat pemain'],
      ['.badge', 'Lihat pencapaian game'],
      ['.rekomendasi', 'Dapatkan rekomendasi produk'],
      ['.misi', 'Lihat misi harian'],
      ['.kupon <kode>', 'Gunakan kupon diskon'],
      ['.referral', 'Program ajak teman']
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
      ['.listfitur / .fiturgrup', 'Lihat daftar & status fitur grup yang bisa diatur'],
      ['.autodl <on/off>', 'Aktif/nonaktifkan auto-download video TikTok & IG'],
      ['.levelup <on/off>', 'Aktif/nonaktifkan notif kartu naik level di grup ini'],
      ['.globallevelup <on/off>', 'Matikan/aktifkan naik level di semua grup (Owner)'],
      ['.mode <jualan/all>', 'Atur mode grup'],
      ['.tagall <pesan>', 'Mention anggota grup'],
      ['.daftar <nama>', 'Daftar profil member'],
      ['.gantinama <nama baru>', 'Ganti nama profil member'],
      ['.profil', 'Lihat role, status, tier, level, dan poin'],
      ['.setmemberrole @user MEMBER|ADMIN', 'Ubah role member (Owner)'],
      ['.setmemberstatus @user ACTIVE|BANNED', 'Ubah status member (Admin)'],
      ['.addpoint @user <jumlah>', 'Tambah poin game member (Admin/Owner)'],
      ['.kurangpoin @user <jumlah>', 'Kurangi poin game member (Khusus Owner)'],
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

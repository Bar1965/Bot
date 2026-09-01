// ─── ⚙️ KONSTANTA & TABEL STATIS UNDERCOVER ──────────────────────────
// Modul paling bawah di rantai import Undercover: TIDAK BOLEH mengimpor modul
// Undercover lain supaya tidak pernah ikut terlibat dalam import cycle
// (AGENTS.md §16).

import path from 'path';

export const CLUE_TIMEOUT_MS = 25 * 1000;        // 25 detik giliran petunjuk normal
export const CLUE_TIMEOUT_FAST_MS = 15 * 1000;   // 15 detik (Speed Clue / Zona Merah / Putaran ke-2)
export const VOTE_TIMEOUT_MS = 35 * 1000;        // 35 detik fase voting
export const DISCUSSION_TIMEOUT_MS = 30 * 1000;  // 30 detik fase diskusi bebas
export const CATEGORY_VOTE_MS = 25 * 1000;       // 25 detik voting kategori kata
export const MRWHITE_GUESS_MS = 30 * 1000;       // 30 detik tebakan terakhir Mr. White
export const LOBBY_TIMEOUT_MS = 90 * 1000;       // 90 detik lobi kedaluwarsa
export const ANON_CLUE_MS = 60 * 1000;           // 60 detik setoran petunjuk Ronde Anonim
export const TRIAL_MS = 30 * 1000;               // 30 detik Sidang Terakhir (pembelaan + vonis)
export const MAX_ROUNDS = 7;                     // Batas maksimal 7 ronde
export const MAX_SKIPS = 2;                      // Maksimal 2x vote skip per game
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 3;

// Bisikan Arwah: pemain yang gugur boleh menitip 1 bisikan anonim per ronde,
// dibatasi ketat supaya tidak berubah jadi papan bocoran peran.
export const GHOST_WHISPER_MAX_WORDS = 6;
export const GHOST_WHISPER_PER_ROUND = 2;

// Pasar Gelap Mr. White: harga 1 huruf & batas pembelian per game.
export const BLACKMARKET_MAX_BUY = 2;
export const BLACKMARKET_MIN_PRICE = 25;

export const STATE_FILE = path.join(process.cwd(), 'data', 'undercover_state.json');

// Chaos Modifier / Tantangan Ronde Unik.
// `key` adalah identitas yang dipakai kode (jangan diubah); `name` hanya teks
// untuk pemain. Dulu pengecekan memakai `name.includes(...)` sehingga sekadar
// merapikan judul modifier diam-diam mematikan aturannya.
export const ROUND_MODIFIERS = [
  { key: 'NORMAL', name: 'Normal Clue', desc: 'Bebas memberikan petunjuk seperti biasa.' },
  { key: 'TIGA_KATA', name: 'Tantangan 3 Kata 🤐', desc: 'Petunjuk HANYA boleh terdiri dari maksimal 3 KATA!' },
  { key: 'SALES', name: 'Gaya Sales Marketing 📢', desc: 'Beri petunjuk seolah-olah kamu sedang promosi/jualan produk!' },
  { key: 'EMOSIONAL', name: 'Tantangan Emosional 🎭', desc: 'Beri petunjuk dengan nada dramatis / marah / terkejut!' },
  { key: 'TANPA_SIFAT', name: 'Dilarang Pakai Kata Sifat 🚫', desc: 'Petunjuk tidak boleh menggunakan kata enak/bagus/jelek/besar/kecil!' },
  { key: 'SPEED', name: 'Speed Clue ⚡', desc: 'Waktu giliran menjawab dipercepat jadi 15 detik!' },
  { key: 'SATU_KATA', name: 'Sumpah Bisu 🤫', desc: 'Petunjuk HANYA boleh 1 KATA saja!' },
  { key: 'ESTAFET', name: 'Petunjuk Estafet 🔗', desc: 'Petunjukmu WAJIB memuat salah satu kata dari petunjuk pemain sebelumnya!' },
  { key: 'TERBALIK', name: 'Urutan Terbalik 🔄', desc: 'Urutan bicara ronde ini dibalik total — yang biasa terakhir jadi pembuka.' },
  { key: 'ANON', name: 'Ronde Anonim 👤', desc: 'Semua petunjuk disetor lewat DM, lalu ditayangkan ACAK TANPA NAMA!' }
];

// Modifier yang tidak boleh keluar di Ronde 1 (ronde perkenalan, 2 putaran
// petunjuk) atau saat pemain tinggal sedikit.
export const MODIFIER_MIN_ROUND = { ANON: 2, ESTAFET: 2 };
export const MODIFIER_MIN_ALIVE = { ANON: 4, ESTAFET: 4, TERBALIK: 4 };

// Toko Kartu Aksi. Harga diskalakan dari taruhan lobi supaya tidak jadi pay-to-win
// di game taruhan kecil. `phase` menentukan kapan kartu boleh dibeli:
// - 'LOBBY': wajib dibeli sebelum game jalan (mencegah beli reaktif saat mau dieksekusi)
// - 'GAME' : boleh dibeli saat fase petunjuk/diskusi, TIDAK saat fase voting
export const CARD_DEFS = {
  shield: { key: 'shield', name: '🛡️ Rompi Anti-Peluru', mult: 1.6, minPrice: 40, phase: 'LOBBY' },
  gold: { key: 'gold', name: '🌟 Golden Vote', mult: 1.2, minPrice: 30, phase: 'LOBBY' },
  silence: { key: 'silence', name: '🤐 Kartu Lakban', mult: 1.0, minPrice: 25, phase: 'GAME' },
  radar: { key: 'radar', name: '🔮 Radar Sensor', mult: 1.4, minPrice: 35, phase: 'GAME' }
};

export const SKILL_PHASES = ['CLUE_PHASE', 'ANON_CLUE_PHASE', 'DISCUSSION_PHASE', 'VOTING_PHASE', 'TRIAL_PHASE'];

// ─── 🎯 MISI RAHASIA PERSONAL ────────────────────────────────────────
// Semua misi WAJIB bisa diverifikasi dari data yang memang sudah dicatat sesi
// (voteHistory, clueLog, alivePlayers) dan berhorizon pendek: game rata-rata
// tamat di ronde 3–4, jadi misi bergaya "bertahan sampai ronde 5" nyaris tidak
// pernah sempat dinilai. Misi juga sengaja netral terhadap kubu supaya tidak
// ada insentif menjatuhkan kubu sendiri demi bonus.
export const MISSION_DEFS = [
  {
    key: 'SURVIVOR',
    name: '🫀 Napas Panjang',
    desc: 'Masih HIDUP saat permainan berakhir.'
  },
  {
    key: 'PEMBURU',
    name: '🎯 Pemburu Jitu',
    desc: 'Minimal 2x mem-vote pemain yang ternyata BUKAN Warga Sipil.'
  },
  {
    key: 'TAK_TERSANGKA',
    name: '😇 Wajah Tak Berdosa',
    desc: 'Tidak pernah menerima lebih dari 1 suara dalam satu ronde.'
  },
  {
    key: 'PELINDUNG',
    name: '🛟 Penjaga Rahasia',
    desc: 'Pastikan seorang pemain tertentu masih hidup saat game berakhir.',
    needsTarget: true
  },
  {
    key: 'ORATOR',
    name: '🗣️ Mulut Tak Pernah Diam',
    desc: 'Beri petunjuk di SETIAP giliranmu — tidak pernah skip atau kehabisan waktu.'
  },
  {
    key: 'EKSEKUTOR',
    name: '⚖️ Tangan Algojo',
    desc: 'Ikut mem-vote pemain (bukan skip) di minimal 2 ronde yang berakhir dengan eksekusi.'
  }
];

// Bonus misi dibayar di luar pot taruhan supaya tidak mengurangi hadiah pemenang.
export const MISSION_BONUS_MIN = 20;
export const MISSION_BONUS_XP = 25;

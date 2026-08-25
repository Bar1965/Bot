import fs from 'fs';
import path from 'path';
import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeUndercoverGames = new Map();

const CLUE_TIMEOUT_MS = 25 * 1000;        // 25 detik giliran petunjuk normal
const CLUE_TIMEOUT_FAST_MS = 15 * 1000;   // 15 detik (Speed Clue / Zona Merah / Putaran ke-2)
const VOTE_TIMEOUT_MS = 35 * 1000;        // 35 detik fase voting
const DISCUSSION_TIMEOUT_MS = 30 * 1000;  // 30 detik fase diskusi bebas
const CATEGORY_VOTE_MS = 25 * 1000;       // 25 detik voting kategori kata
const MRWHITE_GUESS_MS = 30 * 1000;       // 30 detik tebakan terakhir Mr. White
const LOBBY_TIMEOUT_MS = 90 * 1000;       // 90 detik lobi kedaluwarsa
const MAX_ROUNDS = 7;                     // Batas maksimal 7 ronde
const MAX_SKIPS = 2;                      // Maksimal 2x vote skip per game
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 3;

const STATE_FILE = path.join(process.cwd(), 'data', 'undercover_state.json');

// Tema kata untuk fase voting kategori sebelum game dimulai.
// Setiap entri WORD_PAIRS memiliki field `theme` yang cocok dengan salah satu kunci di sini.
const THEMES = {
  KULINER: { label: '🍜 Kuliner & Jajanan', desc: 'Makanan, minuman, jajanan warung & resto' },
  GAMING: { label: '🎮 Gaming & Pop Culture', desc: 'Game, film, anime, musik & tontonan' },
  SOSIAL: { label: '🏠 Kehidupan & Budaya Modern', desc: 'Kosan, asmara, kerja, aplikasi & jalanan' },
  ALAM: { label: '🐾 Hewan, Alam, Profesi & Benda', desc: 'Hewan, tempat, pekerjaan & barang harian' }
};
const THEME_KEYS = Object.keys(THEMES);

const WORD_PAIRS = [
  // 🍜 Kuliner, Jajanan & Minuman
  { civilian: 'INDOMIE', undercover: 'MIE SEDAAP', category: '🍜 Kuliner / Mie Instan', theme: 'KULINER' },
  { civilian: 'MIE GACOAN', undercover: 'MIE JEBEW', category: '🌶️ Kuliner Mie Pedas', theme: 'KULINER' },
  { civilian: 'NASI PADANG', undercover: 'NASI UDUK', category: '🍛 Masakan Tradisional', theme: 'KULINER' },
  { civilian: 'KOPI SUSU', undercover: 'BOBA MILK', category: '🧋 Minuman Kekinian', theme: 'KULINER' },
  { civilian: 'TAHU BULAT', undercover: 'CIRENG', category: '🥟 Jajanan Gorengan', theme: 'KULINER' },
  { civilian: 'MARTABAK MANIS', undercover: 'TERANG BULAN', category: '🥞 Makanan Manis', theme: 'KULINER' },
  { civilian: 'AYAM GEPREK', undercover: 'AYAM PENYET', category: '🍗 Olahan Ayam Pedas', theme: 'KULINER' },
  { civilian: 'ES TEH MANIS', undercover: 'ES JERUK', category: '🍹 Minuman Warung', theme: 'KULINER' },
  { civilian: 'BAKSO', undercover: 'MIE AYAM', category: '🍲 Makanan Berkuah', theme: 'KULINER' },
  { civilian: 'SATE MADURA', undercover: 'SATE PADANG', category: '🍢 Kuliner Sate', theme: 'KULINER' },
  { civilian: 'RENDANG', undercover: 'GULAI', category: '🥘 Masakan Daging Padang', theme: 'KULINER' },
  { civilian: 'SEBLAK', undercover: 'BASO ACI', category: '🌶️ Jajanan Pedas Bandung', theme: 'KULINER' },
  { civilian: 'PECEL LELE', undercover: 'BEBEK GORENG', category: '🍱 Kuliner Kaki Lima', theme: 'KULINER' },
  { civilian: 'ES KRIM', undercover: 'COKELAT', category: '🍦 Makanan Penutup', theme: 'KULINER' },
  { civilian: 'PIZZA', undercover: 'BURGER', category: '🍔 Fast Food Barat', theme: 'KULINER' },
  { civilian: 'ROTI BAKAR', undercover: 'PISANG GORENG', category: '🍞 Camilan Malam', theme: 'KULINER' },
  { civilian: 'RICHEESE FACTORY', undercover: 'KFC', category: '🍗 Restoran Cepat Saji', theme: 'KULINER' },
  { civilian: 'BATAGOR', undercover: 'SIOMAY', category: '🥟 Jajanan Bumbu Kacang', theme: 'KULINER' },
  { civilian: 'ES CENDOL', undercover: 'ES DAWET', category: '🍧 Minuman Tradisional Segar', theme: 'KULINER' },
  { civilian: 'AQUA', undercover: 'LE MINERALE', category: '💧 Air Mineral Kemasan', theme: 'KULINER' },
  { civilian: 'KERUPUK PUTIH', undercover: 'KERUPUK KULIT', category: '🥢 Kerupuk Pelengkap', theme: 'KULINER' },
  { civilian: 'SOP KAKI KAMBING', undercover: 'TONGSENG', category: '🍲 Masakan Olahan Kambing', theme: 'KULINER' },
  { civilian: 'KEBAB', undercover: 'SHAWARMA', category: '🌯 Kuliner Khas Timur Tengah', theme: 'KULINER' },
  { civilian: 'MIXUE', undercover: 'MOMOYO', category: '🍦 Gerai Es Krim Viral', theme: 'KULINER' },

  // 🎮 Gaming, Hiburan & Pop Culture
  { civilian: 'MOBILE LEGENDS', undercover: 'FREE FIRE', category: '🎮 Game Mobile Populer', theme: 'GAMING' },
  { civilian: 'VALORANT', undercover: 'CS:GO (COUNTER-STRIKE)', category: '🔫 Game Tactical FPS PC', theme: 'GAMING' },
  { civilian: 'GENSHIN IMPACT', undercover: 'HONKAI STAR RAIL', category: '✨ Game Gacha Anime', theme: 'GAMING' },
  { civilian: 'PLAYSTATION', undercover: 'XBOX', category: '🎮 Konsol Game Rumah', theme: 'GAMING' },
  { civilian: 'MINECRAFT', undercover: 'ROBLOX', category: '🧱 Game Sandbox Dunia Kreatif', theme: 'GAMING' },
  { civilian: 'GTA V', undercover: 'CYBERPUNK 2077', category: '🌆 Game Open World', theme: 'GAMING' },
  { civilian: 'NETFLIX', undercover: 'YOUTUBE PREMIUM', category: '🎬 Layanan Streaming Video', theme: 'GAMING' },
  { civilian: 'SPOTIFY', undercover: 'APPLE MUSIC', category: '🎵 Layanan Musik Streaming', theme: 'GAMING' },
  { civilian: 'DRAKOR', undercover: 'ANIME', category: '📺 Serial Tontonan Favorit', theme: 'GAMING' },
  { civilian: 'BIOSKOP', undercover: 'HOME THEATER', category: '🍿 Tempat Nonton Film', theme: 'GAMING' },
  { civilian: 'CONAN EDOGAWA', undercover: 'SHERLOCK HOLMES', category: '🕵️ Karakter Detektif Terkenal', theme: 'GAMING' },
  { civilian: 'NARUTO', undercover: 'SASUKE', category: '🍥 Karakter Ninja Anime', theme: 'GAMING' },
  { civilian: 'DORAEMON', undercover: 'SHINCHAN', category: '🐱 Serial Kartun Masa Kecil', theme: 'GAMING' },

  // 🏠 Kehidupan, Romansa & Budaya Modern
  { civilian: 'KOSAN', undercover: 'KONTRAKAN', category: '🏠 Tempat Tinggal Sewa', theme: 'SOSIAL' },
  { civilian: 'SKRIPSI', undercover: 'TUGAS AKHIR', category: '🎓 Perjuangan Mahasiswa Akhir', theme: 'SOSIAL' },
  { civilian: 'DOSEN PEMBIMBING', undercover: 'HRD KANTOR', category: '👔 Sosok Penguji Karir', theme: 'SOSIAL' },
  { civilian: 'MANTAN', undercover: 'GEBETAN', category: '💔 Hubungan Asmara', theme: 'SOSIAL' },
  { civilian: 'PACARAN', undercover: 'HTS (HUBUNGAN TANPA STATUS)', category: '💘 Status Percintaan', theme: 'SOSIAL' },
  { civilian: 'DATING APP', undercover: 'KENALAN DI DM IG', category: '📱 Cara Mencari Jodoh Online', theme: 'SOSIAL' },
  { civilian: 'KONDANGAN', undercover: 'REUNI SEKOLAH', category: '👗 Acara Kumpul Formal', theme: 'SOSIAL' },
  { civilian: 'BEGADANG', undercover: 'OVERTHINKING', category: '🌙 Kebiasaan Larut Malam', theme: 'SOSIAL' },
  { civilian: 'PINJOL', undercover: 'PAYLATER', category: '💳 Hutang Digital Cepat', theme: 'SOSIAL' },
  { civilian: 'GAJI UMR', undercover: 'FREELANCE', category: '💵 Sumber Penghasilan Kerja', theme: 'SOSIAL' },
  { civilian: 'THR', undercover: 'BONUS TAHUNAN', category: '🎁 Rezeki Finansial Tambahan', theme: 'SOSIAL' },
  { civilian: 'WARKOP', undercover: 'KAFE AESTHETIC', category: '☕ Tempat Nongkrong Santai', theme: 'SOSIAL' },
  { civilian: 'SHOPEE', undercover: 'TOKOPEDIA', category: '🛍️ E-Commerce Belanja Online', theme: 'SOSIAL' },
  { civilian: 'INDOMARET', undercover: 'ALFAMART', category: '🏪 Jaringan Minimarket', theme: 'SOSIAL' },
  { civilian: 'WHATSAPP', undercover: 'TELEGRAM', category: '💬 Aplikasi Pesan Singkat', theme: 'SOSIAL' },
  { civilian: 'INSTAGRAM', undercover: 'TIKTOK', category: '📱 Media Sosial Konten Video', theme: 'SOSIAL' },
  { civilian: 'OJEK ONLINE', undercover: 'TAKSI', category: '🛵 Transportasi Umum Perjalanan', theme: 'SOSIAL' },
  { civilian: 'PULANG KAMPUNG', undercover: 'LIBURAN', category: '🧳 Perjalanan Jarak Jauh', theme: 'SOSIAL' },
  { civilian: 'KRL', undercover: 'MRT', category: '🚆 Transportasi Kereta Cepat', theme: 'SOSIAL' },
  { civilian: 'KARCIS PARKIR', undercover: 'HELM HILANG', category: '🛵 Derita Parkir Motor', theme: 'SOSIAL' },
  { civilian: 'SATPOL PP', undercover: 'PEDAGANG KAKI LIMA', category: '👮 Drama Jalanan', theme: 'SOSIAL' },
  { civilian: 'STNK', undercover: 'BPKB', category: '📄 Dokumen Kepemilikan Kendaraan', theme: 'SOSIAL' },
  { civilian: 'IPHONE', undercover: 'HP ANDROID', category: '📱 Perangkat Smartphone', theme: 'SOSIAL' },

  // 🐾 Hewan, Alam, Profesi & Benda
  { civilian: 'KUCING', undercover: 'HARIMAU', category: '🐾 Keluarga Hewan Kucing', theme: 'ALAM' },
  { civilian: 'SINGA', undercover: 'SERIGALA', category: '🐺 Predator Buas Liar', theme: 'ALAM' },
  { civilian: 'PESAWAT', undercover: 'HELIKOPTER', category: '✈️ Transportasi Angkutan Udara', theme: 'ALAM' },
  { civilian: 'PANTAI', undercover: 'GUNUNG', category: '🏞️ Destinasi Liburan Alam', theme: 'ALAM' },
  { civilian: 'GITAR', undercover: 'BIOLA', category: '🎻 Alat Musik Senar', theme: 'ALAM' },
  { civilian: 'MOBIL', undercover: 'MOTOR', category: '🚗 Kendaraan Bermotor Jalan Raya', theme: 'ALAM' },
  { civilian: 'BANTAL', undercover: 'GULING', category: '🛏️ Perlengkapan Tidur Nyenyak', theme: 'ALAM' },
  { civilian: 'KACAMATA', undercover: 'LENSA KONTAK', category: '👓 Alat Bantu Penglihatan', theme: 'ALAM' },
  { civilian: 'DOMPET', undercover: 'REKENING BANK', category: '💳 Tempat Simpan Saldo Uang', theme: 'ALAM' },
  { civilian: 'DOKTER', undercover: 'PERAWAT', category: '🏥 Profesi Medis Rumah Sakit', theme: 'ALAM' },
  { civilian: 'POLISI', undercover: 'SATPAM', category: '👮 Petugas Keamanan', theme: 'ALAM' },
  { civilian: 'PENSIL', undercover: 'PULPEN', category: '✏️ Alat Tulis Kantor', theme: 'ALAM' },
  { civilian: 'SUPERMARKET', undercover: 'PASAR TRADISIONAL', category: '🛒 Tempat Belanja Belanjaan', theme: 'ALAM' },
  { civilian: 'PAYUNG', undercover: 'JAS HUJAN', category: '🌧️ Perlengkapan Musim Hujan', theme: 'ALAM' },
  { civilian: 'JAM TANGAN', undercover: 'JAM DINDING', category: '⏱️ Alat Penunjuk Waktu', theme: 'ALAM' },
  { civilian: 'LAPTOP', undercover: 'KOMPUTER PC', category: '💻 Perangkat Komputasi Kerja', theme: 'ALAM' },
  { civilian: 'SEPATU FUTSAL', undercover: 'SEPATU BOLA', category: '⚽ Perlengkapan Olahraga Sepakbola', theme: 'ALAM' }
];
// Chaos Modifier / Tantangan Ronde Unik
const ROUND_MODIFIERS = [
  { name: 'Normal Clue', desc: 'Bebas memberikan petunjuk seperti biasa.' },
  { name: 'Tantangan 3 Kata 🤐', desc: 'Petunjuk HANYA boleh terdiri dari maksimal 3 KATA!' },
  { name: 'Gaya Sales Marketing 📢', desc: 'Beri petunjuk seolah-olah kamu sedang promosi/jualan produk!' },
  { name: 'Tantangan Emosional 🎭', desc: 'Beri petunjuk dengan nada dramatis / marah / terkejut!' },
  { name: 'Dilarang Pakai Kata Sifat 🚫', desc: 'Petunjuk tidak boleh menggunakan kata enak/bagus/jelek/besar/kecil!' },
  { name: 'Speed Clue ⚡', desc: 'Waktu giliran menjawab dipercepat jadi 15 detik!' }
];

// Toko Kartu Aksi. Harga diskalakan dari taruhan lobi supaya tidak jadi pay-to-win
// di game taruhan kecil. `phase` menentukan kapan kartu boleh dibeli:
// - 'LOBBY': wajib dibeli sebelum game jalan (mencegah beli reaktif saat mau dieksekusi)
// - 'GAME' : boleh dibeli saat fase petunjuk/diskusi, TIDAK saat fase voting
const CARD_DEFS = {
  shield: { key: 'shield', name: '🛡️ Rompi Anti-Peluru', mult: 1.6, minPrice: 40, phase: 'LOBBY' },
  gold: { key: 'gold', name: '🌟 Golden Vote', mult: 1.2, minPrice: 30, phase: 'LOBBY' },
  silence: { key: 'silence', name: '🤐 Kartu Lakban', mult: 1.0, minPrice: 25, phase: 'GAME' },
  radar: { key: 'radar', name: '🔮 Radar Sensor', mult: 1.4, minPrice: 35, phase: 'GAME' }
};

function cardPrice(session, def) {
  return Math.max(def.minPrice, Math.round((session?.buyIn || 30) * def.mult));
}

// ─── 🔧 UTILITAS DASAR ───────────────────────────────────────────────
function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return db.isPhoneMatch(a, b); } catch (e) { return false; }
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function clearSessionTimer(session) {
  if (session?.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
}

function findAliveIndex(session, jid) {
  return session.alivePlayers.findIndex(p => samePlayer(p, jid));
}

function isAlive(session, jid) {
  return findAliveIndex(session, jid) !== -1;
}

// Label pemain versi teks polos (tanpa mention) untuk DM & rekap
function plainLabel(session, jid) {
  const idx = session.players.findIndex(p => samePlayer(p, jid));
  const raw = idx !== -1 ? (session.playerLabels[idx] || '') : '';
  const cleaned = String(raw).replace(/\*/g, '').trim();
  return cleaned || `+${String(jid).split('@')[0]}`;
}

function tag(jid) {
  return `@${String(jid).split('@')[0]}`;
}

// Kembalikan taruhan & harga kartu jika sesi dibatalkan/kedaluwarsa sebelum tuntas,
// supaya pemain tidak kehilangan poin karena game yang tidak pernah selesai.
async function refundUndercoverSession(session) {
  if (!session) return { players: 0, cards: 0 };
  let refundedPlayers = 0;
  let refundedCards = 0;

  if (session.buyInCharged) {
    for (const p of session.players) {
      try { await db.addGamePoints(p, session.buyIn); refundedPlayers++; } catch (e) {}
    }
    session.buyInCharged = false;
  }

  for (const purchase of (session.cardPurchases || [])) {
    try { await db.addGamePoints(purchase.jid, purchase.price); refundedCards += purchase.price; } catch (e) {}
  }
  session.cardPurchases = [];

  return { players: refundedPlayers, cards: refundedCards };
}

// ─── 💾 PERSISTENSI SESI ─────────────────────────────────────────────
export function saveUndercoverSessions() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serialized = [];
    for (const [jid, s] of activeUndercoverGames.entries()) {
      if (s.status === 'LOBBY' || s.status === 'CATEGORY_VOTE') continue;

      const rolesObj = {};
      for (const [p, r] of s.playerRoles.entries()) {
        rolesObj[p] = {
          ...r,
          cards: r.cards ? Array.from(r.cards) : [],
          clueLog: Array.isArray(r.clueLog) ? r.clueLog : []
        };
      }

      serialized.push({
        jid,
        host: s.host,
        buyIn: s.buyIn,
        players: s.players,
        playerLabels: s.playerLabels,
        alivePlayers: s.alivePlayers,
        pair: s.pair,
        theme: s.theme || null,
        round: s.round,
        cluePass: s.cluePass || 1,
        status: s.status,
        turnIndex: s.turnIndex,
        turnSeq: s.turnSeq || 0,
        skipCount: s.skipCount || 0,
        modifier: s.modifier,
        guardedPlayer: s.guardedPlayer || null,
        framedPlayer: s.framedPlayer || null,
        mrWhiteGuessPending: s.mrWhiteGuessPending || null,
        goldenVoters: s.goldenVoters ? Array.from(s.goldenVoters) : [],
        shieldedPlayers: s.shieldedPlayers ? Array.from(s.shieldedPlayers) : [],
        silencedPlayers: s.silencedPlayers ? Array.from(s.silencedPlayers) : [],
        pendingSilence: s.pendingSilence ? Array.from(s.pendingSilence) : [],
        cardOwners: s.cardOwners ? Array.from(s.cardOwners) : [],
        cardPurchases: Array.isArray(s.cardPurchases) ? s.cardPurchases : [],
        buyInCharged: !!s.buyInCharged,
        shotVictims: Array.isArray(s.shotVictims) ? s.shotVictims : [],
        votes: s.votes ? Array.from(s.votes.entries()) : [],
        playerRoles: rolesObj
      });
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.error('[UNDERCOVER] Gagal menyimpan state game:', err.message);
  }
}

export async function restoreUndercoverSessions(sock) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    if (!content) return;
    const data = JSON.parse(content);
    if (!Array.isArray(data) || data.length === 0) return;

    for (const item of data) {
      const rolesMap = new Map();
      for (const [p, r] of Object.entries(item.playerRoles || {})) {
        rolesMap.set(p, {
          ...r,
          cards: new Set(r.cards || []),
          clueLog: Array.isArray(r.clueLog) ? r.clueLog : []
        });
      }

      const session = {
        jid: item.jid,
        host: item.host || null,
        buyIn: item.buyIn,
        players: item.players || [],
        playerLabels: item.playerLabels || [],
        alivePlayers: item.alivePlayers || [],
        pair: item.pair,
        theme: item.theme || null,
        round: item.round,
        cluePass: item.cluePass || 1,
        status: item.status,
        turnIndex: item.turnIndex || 0,
        turnSeq: item.turnSeq || 0,
        skipCount: item.skipCount || 0,
        modifier: item.modifier,
        guardedPlayer: item.guardedPlayer || null,
        framedPlayer: item.framedPlayer || null,
        mrWhiteGuessPending: item.mrWhiteGuessPending || null,
        goldenVoters: new Set(item.goldenVoters || []),
        shieldedPlayers: new Set(item.shieldedPlayers || []),
        silencedPlayers: new Set(item.silencedPlayers || []),
        pendingSilence: new Set(item.pendingSilence || []),
        cardOwners: new Set(item.cardOwners || []),
        cardPurchases: item.cardPurchases || [],
        buyInCharged: item.buyInCharged !== false,
        shotVictims: item.shotVictims || [],
        votes: new Map(item.votes || []),
        categoryVotes: new Map(),
        themeOptions: [],
        skipVotes: new Set(),
        discussionSkips: new Set(),
        playerRoles: rolesMap,
        timeout: null
      };

      activeUndercoverGames.set(item.jid, session);

      await send(sock, item.jid, null, `🔄 *GAME UNDERCOVER DIPULIHKAN DARI RESTART!* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSesi Ronde ${session.round} otomatis dilanjutkan dari titik terakhir.`);

      // Lanjutkan sesi memakai fungsi alur yang sama dengan permainan normal
      if (session.status === 'CLUE_PHASE') {
        if (session.turnIndex >= session.alivePlayers.length) {
          await finishCluePass(sock, item.jid, null);
        } else {
          await announceTurn(sock, item.jid, null);
        }
      } else if (session.status === 'DISCUSSION_PHASE') {
        await startDiscussionPhase(sock, item.jid, null, true);
      } else if (session.status === 'VOTING_PHASE') {
        await startVotingPhase(sock, item.jid, null, true);
      } else if (session.status === 'MR_WHITE_GUESS' && session.mrWhiteGuessPending) {
        await armMrWhiteGuessTimer(sock, item.jid, session.mrWhiteGuessPending);
      }
    }
  } catch (err) {
    console.error('[UNDERCOVER] Gagal memulihkan state game:', err.message);
  }
}

// ─── 🎮 ROUTER PERINTAH UTAMA ────────────────────────────────────────
export async function handleUndercover(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Game Undercover / Impostor hanya bisa dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['role', 'roles', 'panduan', 'help', 'bantuan'].includes(subCmd) || command === 'roleundercover') {
    return await showUndercoverRoleGuide(sock, jid, messageObj);
  }

  if (['card', 'cards', 'kartu', 'item'].includes(subCmd)) {
    return await handleUndercoverCardShop(sock, jid, senderNumber, messageObj, args);
  }

  if (['stats', 'profil', 'stat', 'statistik'].includes(subCmd)) {
    return await showUndercoverStats(sock, jid, senderNumber, messageObj);
  }

  if (['top', 'leaderboard', 'lb', 'rank', 'ranking'].includes(subCmd)) {
    return await showUndercoverLeaderboard(sock, jid, messageObj);
  }

  if (['join', 'ikut'].includes(subCmd) || command === 'joinundercover') {
    return await joinUndercoverLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'startgame'].includes(subCmd) || command === 'startundercover') {
    return await startUndercoverGame(sock, jid, senderNumber, messageObj);
  }

  if (['kategori', 'katakategori', 'tema', 'votekategori'].includes(subCmd)) {
    return await handleCategoryVote(sock, jid, senderNumber, messageObj, args[2]);
  }

  if (['lanjut', 'gasvote', 'mulaivote'].includes(subCmd)) {
    return await handleUndercoverContinue(sock, jid, senderNumber, messageObj);
  }

  if (['vote', 'v'].includes(subCmd)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[2];
    return await handleUndercoverVote(sock, jid, senderNumber, messageObj, target);
  }

  if (['tebakwarga', 'guess'].includes(subCmd)) {
    const guess = args.slice(2).join(' ').trim();
    return await handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess);
  }

  if (['skip', 'lewat', 'pass'].includes(subCmd)) {
    return await handleUndercoverSkip(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd)) {
    const session = activeUndercoverGames.get(jid);
    if (!session) {
      await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover aktif di grup ini.");
      return true;
    }
    if (session.host && !samePlayer(session.host, senderNumber)) {
      await send(sock, jid, messageObj, "❌ Hanya pembuat lobi yang dapat membatalkan game!");
      return true;
    }
    clearSessionTimer(session);
    const refund = await refundUndercoverSession(session);
    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    const refundNote = (refund.players > 0 || refund.cards > 0)
      ? `\n💸 *Taruhan dikembalikan* ke ${refund.players} pemain${refund.cards > 0 ? ` (+ ${refund.cards} Poin biaya kartu)` : ''}.`
      : '';
    await send(sock, jid, messageObj, `🛑 Permainan Undercover berhasil dibatalkan.${refundNote}`);
    return true;
  }

  if (activeUndercoverGames.has(jid)) {
    const s = activeUndercoverGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Undercover aktif di grup ini!\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.playerLabels.join(', ')}\n\nKetik \`.joinundercover\` untuk ikut atau \`.startundercover\` untuk mulai!`, { mentions: s.players });
    } else {
      await send(sock, jid, messageObj, `⚠️ Permainan Undercover sedang berlangsung di grup ini!`);
    }
    return true;
  }

  const buyIn = Math.max(10, parseInt(args[1], 10) || 30);
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka lobi.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    round: 0,
    cluePass: 1,
    pair: null,
    theme: null,
    modifier: null,
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerRoles: new Map(),
    turnIndex: 0,
    turnSeq: 0,
    skipCount: 0,
    alivePlayers: [],
    votes: new Map(),
    categoryVotes: new Map(),
    themeOptions: [],
    mrWhiteGuessPending: null,
    guardedPlayer: null,
    framedPlayer: null,
    shotVictims: [],
    silencedPlayers: new Set(),   // aktif ronde ini
    pendingSilence: new Set(),    // dibeli ronde ini, berlaku ronde depan
    shieldedPlayers: new Set(),
    goldenVoters: new Set(),
    cardOwners: new Set(),        // 1 kartu per pemain per game
    cardPurchases: [],            // riwayat pembelian untuk keperluan refund
    buyInCharged: false,          // taruhan baru dipotong setelah kategori terpilih
    skipVotes: new Set(),
    discussionSkips: new Set(),
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'LOBBY') return;
    const refund = await refundUndercoverSession(cur);
    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    const refundNote = refund.cards > 0 ? `\n💸 Biaya kartu sebesar *${refund.cards} Poin* dikembalikan.` : '';
    await send(sock, jid, null, `⌛ *LOBI UNDERCOVER KEDALUWARSA!* Game dibatalkan karena tidak dimulai dalam 90 detik.${refundNote}`);
  }, LOBBY_TIMEOUT_MS);

  activeUndercoverGames.set(jid, session);

  const shieldPrice = cardPrice(session, CARD_DEFS.shield);
  const goldPrice = cardPrice(session, CARD_DEFS.gold);

  const lobbyMsg =
`🕵️ *LOBBY UNDERCOVER ULTRA 3.0 — SOCIAL DEDUCTION* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host:* ${hostLabel}
👥 *Pemain (1/${MAX_PLAYERS}):* ${hostLabel}
💰 *Taruhan:* *${buyIn} Poin* / orang

🎭 *Daftar Peran Rahasia (Diacak via DM WhatsApp):*
▫️ 🧑‍🌾 *Civilian (Warga)*: Mendapat kata asli.
▫️ 🕵️ *Undercover / Impostor*: 1 Orang (3–5 Pemain) | 2 Orang (6–8 Pemain)!
▫️ 🤍 *Mr. White (Blank)*: Tidak dapat kata, pura-pura tahu! (5+ Pemain)
▫️ 🤡 *Si Badut (Jester)* (4+ Pemain): Ingin di-vote keluar Ronde 2–3 untuk menang solo!
▫️ 🔍 *Detektif Intel* (4+ Pemain): Bisa DM bot \`.intip @member\` untuk lacak penyamar!

🗳️ *BARU — VOTING KATEGORI KATA:* Begitu game dimulai, semua pemain memilih tema kata dulu!
🃏 *Kartu Pra-Game:* \`.undercover card shield\` (${shieldPrice} Poin) / \`card gold\` (${goldPrice} Poin) — *hanya bisa dibeli di lobi ini!*

👉 Ketik \`.joinundercover\` untuk bergabung!
🚀 Host ketik \`.startundercover\` jika sudah siap (Minimal ${MIN_PLAYERS} pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

async function joinUndercoverLobby(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Undercover aktif. Ketik `.undercover [taruhan]` untuk membuka game baru!");
    return true;
  }

  if (session.players.some(p => samePlayer(p, senderNumber))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di dalam lobi Undercover ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Lobi sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Butuh *${session.buyIn} Poin* untuk bergabung.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  session.players.push(senderNumber);
  session.playerLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil bergabung ke game Undercover!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.startundercover\` jika sudah siap!`, { mentions: session.players });
  return true;
}

// ─── 🗳️ FASE VOTING KATEGORI KATA ───────────────────────────────────
async function startUndercoverGame(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai game Undercover!`);
    return true;
  }

  clearSessionTimer(session);

  session.status = 'CATEGORY_VOTE';
  session.categoryVotes = new Map();
  session.themeOptions = shuffleArray(THEME_KEYS);

  const optionLines = session.themeOptions
    .map((key, i) => `*${i + 1}.* ${THEMES[key].label}\n     _${THEMES[key].desc}_`)
    .join('\n');
  const randomIndex = session.themeOptions.length + 1;

  const voteMsg =
`🗳️ *VOTING KATEGORI KATA — PILIH TEMA PERMAINAN!* 🎲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sebelum peran dibagikan, tentukan dulu tema kata yang akan dipakai ronde ini!

${optionLines}
*${randomIndex}.* 🎲 *ACAK TOTAL* — Serahkan pada nasib!

👉 *Cara Vote:* Ketik \`.vote [1-${randomIndex}]\` atau \`.undercover kategori [1-${randomIndex}]\`
⏳ *Waktu:* ${Math.round(CATEGORY_VOTE_MS / 1000)} detik — tema dengan suara terbanyak yang dipakai.
💡 _Suara seri atau tidak ada yang vote ➔ tema dipilih acak._

👥 Pemilih (${session.players.length}): ${session.players.map(p => tag(p)).join(', ')}`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'CATEGORY_VOTE') return;
    await resolveCategoryVote(sock, jid, null);
  }, CATEGORY_VOTE_MS);

  await send(sock, jid, messageObj, voteMsg, { mentions: session.players });
  return true;
}

export async function handleCategoryVote(sock, jid, senderNumber, messageObj, rawChoice) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CATEGORY_VOTE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting kategori kata Undercover.");
    return true;
  }

  const voter = session.players.find(p => samePlayer(p, senderNumber));
  if (!voter) {
    await send(sock, jid, messageObj, "❌ Kamu tidak terdaftar sebagai pemain di sesi ini!");
    return true;
  }

  const totalOptions = session.themeOptions.length + 1;
  const choice = parseInt(String(rawChoice || '').trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > totalOptions) {
    await send(sock, jid, messageObj, `⚠️ Pilihan tidak valid! Ketik \`.vote [1-${totalOptions}]\` untuk memilih kategori kata.`);
    return true;
  }

  const picked = choice === totalOptions ? 'RANDOM' : session.themeOptions[choice - 1];
  session.categoryVotes.set(voter, picked);

  const pickedLabel = picked === 'RANDOM' ? '🎲 ACAK TOTAL' : THEMES[picked].label;
  await send(sock, jid, messageObj, `🗳️ ${tag(voter)} memilih *${pickedLabel}*! (${session.categoryVotes.size}/${session.players.length} suara)`, { mentions: [voter] });

  if (session.categoryVotes.size >= session.players.length) {
    clearSessionTimer(session);
    await resolveCategoryVote(sock, jid, messageObj);
  }
  return true;
}

async function resolveCategoryVote(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CATEGORY_VOTE') return;
  clearSessionTimer(session);

  const tally = new Map();
  for (const picked of session.categoryVotes.values()) {
    if (picked === 'RANDOM') continue;
    tally.set(picked, (tally.get(picked) || 0) + 1);
  }

  let winners = [];
  let best = 0;
  for (const [theme, count] of tally.entries()) {
    if (count > best) { best = count; winners = [theme]; }
    else if (count === best) winners.push(theme);
  }

  let chosenTheme;
  let reason;
  if (winners.length === 1) {
    chosenTheme = winners[0];
    reason = `Menang voting dengan *${best} suara*`;
  } else if (winners.length > 1) {
    chosenTheme = winners[Math.floor(Math.random() * winners.length)];
    reason = `Suara seri (${best} suara) ➔ dipilih acak dari kandidat teratas`;
  } else {
    chosenTheme = THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
    reason = 'Tidak ada suara tema ➔ dipilih acak total';
  }

  session.theme = chosenTheme;
  await send(sock, jid, messageObj, `🎯 *KATEGORI KATA TERPILIH!* 🎲\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 Tema: *${THEMES[chosenTheme].label}*\n📝 ${reason}.\n\n_Membagikan peran rahasia ke DM masing-masing pemain..._`);

  await assignRolesAndStart(sock, jid, messageObj);
}

// ─── 🎭 PEMBAGIAN PERAN & MULAI RONDE 1 ──────────────────────────────
async function assignRolesAndStart(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  // Taruhan baru dipotong di titik ini (bukan sebelum voting kategori), supaya
  // pembatalan/restart saat pemilihan tema tidak menghanguskan poin pemain.
  if (!session.buyInCharged) {
    for (const p of session.players) {
      await db.deductGamePoints(p, session.buyIn);
    }
    session.buyInCharged = true;
  }

  const themePool = WORD_PAIRS.filter(w => w.theme === session.theme);
  const pool = themePool.length > 0 ? themePool : WORD_PAIRS;
  const pair = pool[Math.floor(Math.random() * pool.length)];
  session.pair = pair;

  const shuffled = shuffleArray(session.players);
  session.alivePlayers = [...shuffled];

  const count = shuffled.length;

  // Pool peran Impostor. Assassin & Saboteur dikunci di game kecil supaya
  // 1 tembakan Ronde 1 tidak langsung menutup permainan (parity instan).
  let underPool;
  if (count >= 6) underPool = shuffleArray(['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR']);
  else if (count === 5) underPool = shuffleArray(['UNDERCOVER', 'ASSASSIN', 'FRAMER']);
  else if (count === 4) underPool = shuffleArray(['UNDERCOVER', 'FRAMER']);
  else underPool = ['UNDERCOVER'];

  const underRole1 = underPool[0];
  const underRole2 = underPool[1] || 'UNDERCOVER';

  // Pool peran Netral. Mr. White butuh minimal 5 pemain agar tidak
  // menghabisi game 4 orang lewat satu kali salah vote.
  const neutralPool = count >= 5 ? ['MRWHITE', 'JESTER', 'BUNGLON'] : ['JESTER', 'BUNGLON'];
  const neutralRole = neutralPool[Math.floor(Math.random() * neutralPool.length)];

  const specialCivPool = shuffleArray(['SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR']);

  const assignedRoles = [];
  if (count === 3) {
    assignedRoles.push(underRole1, 'CIVILIAN', 'CIVILIAN');
  } else if (count === 4) {
    assignedRoles.push(underRole1, neutralRole, specialCivPool[0], 'CIVILIAN');
  } else if (count === 5) {
    assignedRoles.push(underRole1, neutralRole, specialCivPool[0], 'CIVILIAN', 'CIVILIAN');
  } else if (count === 6) {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], 'CIVILIAN', 'CIVILIAN');
  } else if (count === 7) {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], specialCivPool[1], 'CIVILIAN', 'CIVILIAN');
  } else {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], specialCivPool[1], 'CIVILIAN', 'CIVILIAN', 'CIVILIAN');
  }

  const themeLabel = THEMES[session.theme]?.label || 'Acak';

  for (let i = 0; i < count; i++) {
    const p = shuffled[i];
    const role = assignedRoles[i];
    const partnerJid = (count >= 6 && (i === 0 || i === 1)) ? (i === 0 ? shuffled[1] : shuffled[0]) : null;
    const partnerMsg = partnerJid ? `\n🤝 *Rekan Penyamar Anda:* ${tag(partnerJid)} (Kalian satu kubu dan memegang kata yang sama!)` : '';
    const mentions = partnerJid ? [partnerJid] : [];
    const headInfo = `🏷️ Kategori: ${pair.category}\n📚 Tema Terpilih: ${themeLabel}`;

    const base = { isAlive: true, clue: '', clueLog: [], cards: new Set() };

    if (role === 'ASSASSIN') {
      session.playerRoles.set(p, { ...base, role: 'ASSASSIN', word: pair.undercover, hasBullet: true });
      await dm(sock, p, `🗡️ *PERAN ANDA: ASSASSIN (PEMBUNUH BAYARAN)* 🩸\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n${headInfo}${partnerMsg}\n\n⚠️ *Misi Khusus:* Anda adalah eksekutor rahasia kubu penyamar!\n🎯 *Sniper Senyap (1x Pakai — Mulai Ronde 2):*\nKirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`) untuk mengeksekusi musuh tanpa perlu voting!\n💡 _Senjata terkunci di Ronde 1, sama seperti Sheriff._`, mentions);
    } else if (role === 'FRAMER') {
      session.playerRoles.set(p, { ...base, role: 'FRAMER', word: pair.undercover, hasFramed: false });
      await dm(sock, p, `🗣️ *PERAN ANDA: FRAMER (TUKANG FITNAH)* 🎭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n${headInfo}${partnerMsg}\n\n⚠️ *Skill Fitnah (1x Pakai via DM):*\nKirim DM ke bot: \`.fitnah @member\` (atau \`.fitnah <nomor>\`)\n\n🎯 *Efek Fitnah:*\n1. Memanipulasi laporan Detektif: Jika target diintip Detektif, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR/IMPOSTOR)**!\n2. Di fase voting ronde ini, target otomatis mendapatkan **+1 Suara Kutukan Tambahan**!`, mentions);
    } else if (role === 'SABOTEUR') {
      session.playerRoles.set(p, { ...base, role: 'SABOTEUR', word: pair.undercover });
      await dm(sock, p, `🦹 *PERAN ANDA: SABOTEUR (PENYABOT INTEL)* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n${headInfo}${partnerMsg}\n\n⚠️ *Skill Sabotase:* Tiap ronde Anda bisa meretas peran pemain via DM:\n👉 Ketik: \`.hack @member\` (atau \`.sabotase <nomor>\`) untuk mengintip peran target!`, mentions);
    } else if (role === 'UNDERCOVER') {
      session.playerRoles.set(p, { ...base, role: 'UNDERCOVER', word: pair.undercover, hasSwap: true });
      await dm(sock, p, `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n${headInfo}${partnerMsg}\n\n⚠️ *Misi Penyamaran:* Berikan petunjuk yang mengecoh agar dikira warga sipil!\n🔀 *Skill Tukar Giliran (1x Pakai):* Kirim DM \`.tukargiliran\` saat giliranmu untuk melempar giliran bicara ke pemain berikutnya dan bicara paling akhir!`, mentions);
    } else if (role === 'MRWHITE') {
      session.playerRoles.set(p, { ...base, role: 'MRWHITE', word: '' });
      await dm(sock, p, `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA (BLANK)*\n${headInfo}\n\n⚠️ *Misi Anda:* Anda tidak punya kata! Dengarkan petunjuk orang lain, pura-pura tahu!\n💡 *Skill Tebak Kata:* Tebak kata warga kapan saja via DM/grup dengan \`.tebakwarga <kata>\` untuk MENANG SOLO INSTAN! Atau bertahan hidup hingga akhir bersama kubu pemenang.`);
    } else if (role === 'JESTER') {
      session.playerRoles.set(p, { ...base, role: 'JESTER', word: pair.civilian });
      await dm(sock, p, `🤡 *PERAN ANDA: SI BADUT (JESTER)* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Gila Anda:* Buat diri Anda DICURIGAI dan DI-VOTE KELUAR oleh grup di *Ronde 2 atau Ronde 3*! Jika berhasil, Anda MENANG SOLO dan mencuri seluruh pot taruhan!\n💡 _Jika gagal tapi berhasil bertahan hidup sampai game usai, taruhan Anda dikembalikan utuh._`);
    } else if (role === 'BUNGLON') {
      session.playerRoles.set(p, { ...base, role: 'BUNGLON', word: pair.civilian });
      await dm(sock, p, `🦎 *PERAN ANDA: BUNGLON (NETRAL BEBAS)* 🤝\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Bertahan Hidup:* Anda adalah pihak netral yang fleksibel. Triknya jangan sampai tereliminasi/tertembak! Jika kubu mana pun (Warga atau Undercover) menang saat Anda masih HIDUP, Anda IKUT MENANG dan mendapat bagian hadiah pot!`);
    } else if (role === 'SHERIFF') {
      session.playerRoles.set(p, { ...base, role: 'SHERIFF', word: pair.civilian, hasBullet: true });
      await dm(sock, p, `🤠 *PERAN ANDA: KOBOI / SHERIFF (PENEMBAK)* 🔫\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi & Senjata Revolver (1x Pakai — Mulai Ronde 2):*\n👉 Kirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`)\n\n🎯 *HUKUM TEMBAKAN:*\n• Tembakan baru aktif mulai **Ronde 2 ke atas**!\n• Jika sasaran adalah **Penyamar**, **Mr. White**, atau **Si Badut** ➔ Target **TEWAS SEKETIKA**!\n• 💀 **JIKA SALAH SASARAN** menembak Warga Sipil/Sekutu ➔ **ANDA SENDIRI YANG TEWAS DI TEMPAT (Suicide)**!`);
    } else if (role === 'DETECTIVE') {
      session.playerRoles.set(p, { ...base, role: 'DETECTIVE', word: pair.civilian, hasUsedIntel: false });
      await dm(sock, p, `🔍 *PERAN ANDA: DETEKTIF INTEL (DETECTIVE)* 🕵️‍♂️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Intel (1x Pakai — Mulai Ronde 2):*\nKirim pesan DM ke bot: \`.intip @member\` (atau \`.intip <nomor>\`) untuk mengetahui apakah target Warga Asli atau Bukan Warga!\n💡 _Skill baru terbuka setelah melewati Ronde 1._`);
    } else if (role === 'GUARDIAN') {
      session.playerRoles.set(p, { ...base, role: 'GUARDIAN', word: pair.civilian, lastGuarded: null });
      await dm(sock, p, `🛡️ *PERAN ANDA: GUARDIAN (BODYGUARD PELINDUNG)* 🔰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Perlindungan (tiap ronde, 1 target):*\nKirim DM ke bot: \`.lindung @member\` (atau \`.guard <nomor>\`).\n🎯 Jika target yang Anda lindungi ditembak atau dieksekusi vote, nyawanya SELAMAT!\n🚫 *Aturan:* Perlindungan **hanya berlaku 1 ronde** (harus dipasang ulang tiap ronde), **tidak boleh melindungi diri sendiri**, dan **tidak boleh target yang sama 2 ronde berturut-turut**.`);
    } else if (role === 'DOCTOR') {
      session.playerRoles.set(p, { ...base, role: 'DOCTOR', word: pair.civilian, hasUsedRevive: false });
      await dm(sock, p, `🩺 *PERAN ANDA: DOKTER LAPANGAN (MEDIC)* 💉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Medis (1x Pakai via DM):*\nKirim pesan DM ke bot: \`.sembuhkan @member\` (atau \`.revive <nomor>\`)\n\n🎯 *Efek Medis:* Menghidupkan kembali rekan pemain yang tewas akibat tembakan (Sheriff / Assassin)!\n💡 _Dokter tidak dapat menghidupkan korban eksekusi voting grup._`);
    } else {
      session.playerRoles.set(p, { ...base, role: 'CIVILIAN', word: pair.civilian });
      await dm(sock, p, `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat bagi sesama warga, temukan sang penyamar, dan jangan sampai salah vote!`);
    }
  }

  saveUndercoverSessions();
  await startNextUndercoverRound(sock, jid, messageObj, true);
}

async function dm(sock, jid, text, mentions = []) {
  try {
    await sock.sendMessage(jid, mentions.length > 0 ? { text, mentions } : { text });
    return true;
  } catch (e) {
    return false;
  }
}

// ─── 🏷️ HELPER PERAN ─────────────────────────────────────────────────
export function getPlayerRoleData(session, targetJid) {
  if (!session || !session.playerRoles || !targetJid) return null;
  if (session.playerRoles.has(targetJid)) return session.playerRoles.get(targetJid);
  for (const [p, data] of session.playerRoles.entries()) {
    if (samePlayer(p, targetJid)) return data;
  }
  return null;
}

export function isUndercoverRole(role) {
  return ['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR'].includes(role);
}

export function isCivilianRole(role) {
  return ['CIVILIAN', 'SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR'].includes(role);
}

export function isNeutralRole(role) {
  return ['MRWHITE', 'JESTER', 'BUNGLON'].includes(role);
}

function factionOf(role) {
  if (isUndercoverRole(role)) return 'IMPOSTOR';
  if (isCivilianRole(role)) return 'CIVILIAN';
  return 'NEUTRAL';
}

export function getRoleBadge(role) {
  switch (role) {
    case 'UNDERCOVER': return '🕵️ UNDERCOVER (PENYAMAR)';
    case 'ASSASSIN': return '🗡️ ASSASSIN (PEMBUNUH BAYARAN)';
    case 'FRAMER': return '🗣️ FRAMER (TUKANG FITNAH)';
    case 'SABOTEUR': return '🦹 SABOTEUR (PENYABOT INTEL)';
    case 'SHERIFF': return '🤠 KOBOI / SHERIFF';
    case 'DETECTIVE': return '🔍 DETEKTIF INTEL';
    case 'GUARDIAN': return '🛡️ GUARDIAN (BODYGUARD)';
    case 'DOCTOR': return '🩺 DOKTER LAPANGAN (MEDIC)';
    case 'MRWHITE': return '🤍 MR. WHITE (BLANK)';
    case 'JESTER': return '🤡 SI BADUT (JESTER)';
    case 'BUNGLON': return '🦎 BUNGLON (NETRAL)';
    default: return '🧑‍🌾 WARGA SIPIL';
  }
}

export function findUndercoverSessionAndPlayer(senderNumber) {
  for (const s of activeUndercoverGames.values()) {
    if (s.playerRoles?.has(senderNumber)) return { session: s, playerJid: senderNumber };
    for (const p of s.playerRoles.keys()) {
      if (samePlayer(p, senderNumber)) return { session: s, playerJid: p };
    }
  }
  return { session: null, playerJid: null };
}

export function resolveTargetInSession(session, rawTarget, allowDead = false) {
  if (!session || rawTarget === undefined || rawTarget === null) return null;
  const targetList = allowDead ? session.players : session.alivePlayers;
  const str = String(rawTarget).trim();
  if (!str) return null;

  const parsedNum = parseInt(str, 10);
  if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= targetList.length && !str.includes('@') && str.length <= 2) {
    return targetList[parsedNum - 1];
  }
  const direct = targetList.find(p => p === str);
  if (direct) return direct;

  const digits = str.replace(/\D/g, '');
  if (digits.length >= 4) {
    const found = targetList.find(p => samePlayer(p, digits) || p.replace(/\D/g, '').includes(digits) || digits.includes(p.replace(/\D/g, '')));
    if (found) return found;
  }
  return null;
}

// ─── 🔄 MESIN RONDE & GILIRAN PETUNJUK ───────────────────────────────
function computeTurnTimeout(session) {
  if (session.round >= 4) return CLUE_TIMEOUT_FAST_MS;
  if ((session.cluePass || 1) >= 2) return CLUE_TIMEOUT_FAST_MS;
  if (session.modifier?.name?.includes('Speed')) return CLUE_TIMEOUT_FAST_MS;
  return CLUE_TIMEOUT_MS;
}

function clueOf(session, p) {
  const rd = getPlayerRoleData(session, p);
  if (!rd) return '-';
  if (session.round === 1 && Array.isArray(rd.clueLog)) {
    const r1 = rd.clueLog.filter(c => c.round === 1);
    if (r1.length >= 2) return `${r1[0].text} → ${r1[1].text}`;
  }
  return rd.clue || '-';
}

function buildClueBoard(session) {
  return session.alivePlayers
    .map((p, i) => `${i + 1}. ${tag(p)}: _"${clueOf(session, p)}"_`)
    .join('\n');
}

async function startNextUndercoverRound(sock, jid, messageObj, isFirstRound = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  if (isFirstRound) {
    session.round = 1;
    session.skipCount = 0;
  } else {
    session.round++;
  }

  if (session.round > MAX_ROUNDS) {
    return await resolveMaxRoundLimit(sock, jid);
  }

  // Reset efek per-ronde
  session.status = 'CLUE_PHASE';
  session.cluePass = 1;
  session.turnIndex = 0;
  session.votes.clear();
  session.skipVotes = new Set();
  session.discussionSkips = new Set();
  session.guardedPlayer = null; // perlindungan Guardian hanya berlaku 1 ronde
  session.silencedPlayers = new Set(session.pendingSilence || []);
  session.pendingSilence = new Set();

  // Rotasi urutan bicara supaya pemain pertama tidak selalu dirugikan
  if (!isFirstRound && session.alivePlayers.length > 1) {
    session.alivePlayers.push(session.alivePlayers.shift());
  }

  session.modifier = ROUND_MODIFIERS[Math.floor(Math.random() * ROUND_MODIFIERS.length)];

  const mod = session.modifier;
  const totalPot = session.buyIn * session.players.length;
  const isSuddenDeath = session.round >= 4;
  const turnSeconds = Math.round(computeTurnTimeout(session) / 1000);
  const themeLabel = THEMES[session.theme]?.label || 'Acak';

  let roundHeader = '';
  if (isFirstRound) {
    const roleCounts = {};
    for (const [, r] of session.playerRoles.entries()) {
      roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
    }
    const roleSummary = [
      roleCounts.CIVILIAN ? `🧑‍🌾 ${roleCounts.CIVILIAN} Warga` : null,
      roleCounts.SHERIFF ? `🤠 ${roleCounts.SHERIFF} Koboi` : null,
      roleCounts.DETECTIVE ? `🔍 ${roleCounts.DETECTIVE} Detektif` : null,
      roleCounts.GUARDIAN ? `🛡️ ${roleCounts.GUARDIAN} Guardian` : null,
      roleCounts.DOCTOR ? `🩺 ${roleCounts.DOCTOR} Dokter` : null,
      roleCounts.UNDERCOVER ? `🕵️ ${roleCounts.UNDERCOVER} Undercover` : null,
      roleCounts.ASSASSIN ? `🗡️ ${roleCounts.ASSASSIN} Assassin` : null,
      roleCounts.FRAMER ? `🗣️ ${roleCounts.FRAMER} Framer` : null,
      roleCounts.SABOTEUR ? `🦹 ${roleCounts.SABOTEUR} Saboteur` : null,
      roleCounts.MRWHITE ? `🤍 ${roleCounts.MRWHITE} Mr. White` : null,
      roleCounts.JESTER ? `🤡 ${roleCounts.JESTER} Si Badut` : null,
      roleCounts.BUNGLON ? `🦎 ${roleCounts.BUNGLON} Bunglon` : null
    ].filter(Boolean).join(' | ');

    roundHeader =
`🎮 *UNDERCOVER ULTRA 3.0 RESMI DIMULAI — RONDE 1* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kata rahasia telah dikirim ke DM WhatsApp masing-masing!*
📚 *Tema Pilihan Grup:* ${themeLabel}
🏷️ *Kategori:* ${session.pair.category}
💰 *Total Prizepool:* *${totalPot.toLocaleString('id-ID')} Poin*
🎭 *Komposisi Peran:* ${roleSummary}

╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE 1:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

📜 *ATURAN GAME 3.0:*
🔁 *Ronde 1 = 2 Putaran Petunjuk!* Semua bicara 2x sebelum voting pertama (biar tidak vote buta).
💬 *Fase Diskusi:* 30 detik diskusi bebas setelah petunjuk, sebelum voting dibuka.
⏱️ *Durasi:* ${Math.round(CLUE_TIMEOUT_MS / 1000)}s Petunjuk (putaran 2 & Zona Merah: ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s), ${Math.round(VOTE_TIMEOUT_MS / 1000)}s Voting
🚫 *Batas Vote Skip:* Maksimal ${MAX_SKIPS}x per permainan
💀 *Zona Merah:* Mulai Ronde 4+ (Waktu ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s & Vote Skip Dikunci!)
⏳ *Batas Ronde:* Maksimal ${MAX_ROUNDS} Ronde

📋 *Urutan Giliran Pemain:*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}

💡 _Ketik \`.undercover role\` untuk membaca panduan peran._`;
  } else if (isSuddenDeath) {
    roundHeader =
`🚨 *ZONA MERAH / SUDDEN DEATH — RONDE ${session.round}* ☠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *PERINGATAN ZONA MERAH:*
• Waktu giliran petunjuk dipercepat jadi **${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)} Detik**!
• Opsi \`.vote skip\` **DIKUNCI** (Wajib ada yang dieksekusi)!
• Batas akhir game: Ronde ${MAX_ROUNDS}.

╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE ${session.round}:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}`;
  } else {
    roundHeader =
`🔄 *UNDERCOVER — MASUK RONDE ${session.round}* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE ${session.round}:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

🔀 _Urutan bicara dirotasi — pembuka ronde ini bukan orang yang sama._
👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}`;
  }

  if (session.silencedPlayers.size > 0) {
    const muted = session.alivePlayers.filter(p => session.silencedPlayers.has(p));
    if (muted.length > 0) {
      roundHeader += `\n\n🤐 *KORBAN KARTU LAKBAN RONDE INI:* ${muted.map(m => tag(m)).join(', ')} — hanya boleh menulis *1 KATA*!`;
    }
  }

  saveUndercoverSessions();
  await send(sock, jid, messageObj, roundHeader, { mentions: session.alivePlayers });
  await announceTurn(sock, jid, messageObj);
}

async function announceTurn(sock, jid, messageObj, prefix = '') {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return;
  clearSessionTimer(session);

  if (session.turnIndex >= session.alivePlayers.length) {
    return await finishCluePass(sock, jid, messageObj);
  }

  const player = session.alivePlayers[session.turnIndex];
  if (!player) return await finishCluePass(sock, jid, messageObj);

  const seq = ++session.turnSeq;
  const ms = computeTurnTimeout(session);
  const isSuddenDeath = session.round >= 4;
  const passLabel = (session.cluePass || 1) >= 2 ? ' — PUTARAN KE-2' : '';
  const silencedNote = session.silencedPlayers.has(player)
    ? `\n🤐 *KAMU KENA KARTU LAKBAN!* Petunjukmu hanya boleh *1 KATA*.`
    : '';
  const modInfo = session.modifier
    ? `\n🎲 *Tantangan Ronde:* *${session.modifier.name}* — _${session.modifier.desc}_`
    : '';

  const turnMsg =
`${prefix}👉 *GILIRAN PETUNJUK${passLabel}:* ${tag(player)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔢 Pemain ${session.turnIndex + 1}/${session.alivePlayers.length} | ⏳ Waktu: *${Math.round(ms / 1000)} detik*${modInfo}${silencedNote}
_Tulis 1 kalimat petunjuk katamu di grup ini!_
${isSuddenDeath ? '🚫 _(Zona Merah: Vote Skip Dikunci)_' : '_Atau ketik `.skip` untuk melewati giliran._'}`;

  session.skipVotes = new Set();
  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'CLUE_PHASE' || cur.turnSeq !== seq) return;
    const afkPlayer = cur.alivePlayers[cur.turnIndex];
    if (!afkPlayer) return;
    recordClue(cur, afkPlayer, '(Melewatkan giliran / AFK)');
    await send(sock, jid, null, `⌛ ${tag(afkPlayer)} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [afkPlayer] });
    await advanceTurn(sock, jid, null);
  }, ms);

  saveUndercoverSessions();
  await send(sock, jid, messageObj, turnMsg, { mentions: [player] });
}

async function advanceTurn(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return;
  clearSessionTimer(session);
  session.turnIndex++;
  saveUndercoverSessions();

  if (session.turnIndex < session.alivePlayers.length) {
    return await announceTurn(sock, jid, messageObj);
  }
  return await finishCluePass(sock, jid, messageObj);
}

// Selesai satu putaran petunjuk. Ronde 1 memakai 2 putaran supaya voting
// pertama tidak dilakukan tanpa informasi.
async function finishCluePass(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  if (session.round === 1 && (session.cluePass || 1) === 1 && session.alivePlayers.length >= 3) {
    session.cluePass = 2;
    session.turnIndex = 0;
    saveUndercoverSessions();

    const board = buildClueBoard(session);
    await send(sock, jid, messageObj,
`🔁 *PUTARAN PETUNJUK KEDUA — RONDE 1!* 🗣️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Semua sudah bicara sekali. Sekarang beri petunjuk *BARU* (dilarang mengulang persis petunjuk pertamamu)!

📋 *Rekap Putaran 1:*
${board}

⏳ Waktu tiap giliran dipercepat jadi ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)} detik.`, { mentions: session.alivePlayers });

    return await announceTurn(sock, jid, messageObj);
  }

  return await startDiscussionPhase(sock, jid, messageObj);
}

function recordClue(session, player, text) {
  const rd = getPlayerRoleData(session, player);
  if (!rd) return;
  rd.clue = text;
  if (!Array.isArray(rd.clueLog)) rd.clueLog = [];
  rd.clueLog.push({ round: session.round, pass: session.cluePass || 1, text });
}

function clueLeaksSecret(clue, word) {
  if (!word) return false;
  const nClue = normalizeAnswer(clue);
  const nWord = normalizeAnswer(word);
  if (!nClue || !nWord) return false;
  if (nClue.includes(nWord)) return true;

  // Potongan kata diambil dua cara: per-spasi DAN per-tanda-baca. Dua-duanya perlu,
  // karena kata seperti "CS:GO" hanya utuh di pemisahan spasi, sedangkan
  // "(COUNTER-STRIKE)" hanya terpecah benar di pemisahan tanda baca.
  const candidates = new Set();
  for (const seg of String(word).split(/\s+/)) candidates.add(normalizeAnswer(seg));
  for (const seg of String(word).split(/[^A-Za-z0-9]+/)) candidates.add(normalizeAnswer(seg));

  for (const c of candidates) {
    if (c.length >= 4 && nClue.includes(c)) return true;
  }
  return false;
}

export async function handleUndercoverClue(sock, jid, senderNumber, messageObj, text) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return false;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  if (!currentTurnPlayer || !samePlayer(senderNumber, currentTurnPlayer)) return false;

  const cleanClue = String(text || '').trim();
  if (cleanClue.length < 2) {
    await send(sock, jid, messageObj, "⚠️ Petunjuk terlalu pendek! Tulis minimal 2 karakter.");
    return true;
  }

  const pRole = getPlayerRoleData(session, currentTurnPlayer);

  if (clueLeaksSecret(cleanClue, pRole?.word)) {
    await send(sock, jid, messageObj, "❌ DILARANG menyebutkan kata rahasia Anda (atau bagian dari kata itu) dalam petunjuk! Tulis deskripsi/kiasan lain.");
    return true;
  }

  // Kartu Lakban: korban hanya boleh 1 kata
  if (session.silencedPlayers.has(currentTurnPlayer)) {
    const wc = cleanClue.split(/\s+/).filter(Boolean).length;
    if (wc > 1) {
      await send(sock, jid, messageObj, `🤐 *KAMU SEDANG DILAKBAN!* Petunjukmu hanya boleh *1 KATA* ronde ini (petunjukmu: ${wc} kata). Coba lagi!`);
      return true;
    }
  }

  if (session.modifier?.name?.includes('3 Kata')) {
    const wordCount = cleanClue.split(/\s+/).filter(Boolean).length;
    if (wordCount > 3) {
      await send(sock, jid, messageObj, `⚠️ *Tantangan Ronde Ini:* Maksimal hanya boleh *3 kata*! (Petunjukmu: ${wordCount} kata). Coba lagi!`);
      return true;
    }
  }

  // Putaran ke-2 tidak boleh menyalin persis petunjuk sendiri di putaran 1
  if ((session.cluePass || 1) >= 2 && Array.isArray(pRole?.clueLog)) {
    const prev = pRole.clueLog.find(c => c.round === session.round && c.pass === 1);
    if (prev && normalizeAnswer(prev.text) === normalizeAnswer(cleanClue)) {
      await send(sock, jid, messageObj, "⚠️ Petunjuk putaran kedua tidak boleh sama persis dengan petunjuk pertamamu! Beri sudut pandang baru.");
      return true;
    }
  }

  recordClue(session, currentTurnPlayer, cleanClue);
  await advanceTurn(sock, jid, messageObj);
  return true;
}

// ─── 💬 FASE DISKUSI BEBAS ───────────────────────────────────────────
async function startDiscussionPhase(sock, jid, messageObj, isResume = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'DISCUSSION_PHASE';
  session.discussionSkips = new Set();
  saveUndercoverSessions();

  const board = buildClueBoard(session);
  const header = isResume ? '🔄 *FASE DISKUSI DIPULIHKAN!*' : '💬 *SEMUA PETUNJUK SELESAI — FASE DISKUSI BEBAS!*';

  const msg =
`${header} 🗣️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Papan Petunjuk Ronde ${session.round}:*
${board}

🔎 *Silakan berdebat, saling tuduh, dan bela diri sekarang!*
⏳ Waktu diskusi: *${Math.round(DISCUSSION_TIMEOUT_MS / 1000)} detik* — setelah itu voting otomatis dibuka.
⏩ Ketik \`.lanjut\` untuk langsung membuka voting (Host/Admin instan, pemain biasa butuh 2 suara).`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'DISCUSSION_PHASE') return;
    await startVotingPhase(sock, jid, null);
  }, DISCUSSION_TIMEOUT_MS);

  await send(sock, jid, messageObj, msg, { mentions: session.alivePlayers });
}

export async function handleUndercoverContinue(sock, jid, senderNumber, messageObj, isAdmin = false, isOwner = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  if (session.status !== 'DISCUSSION_PHASE') {
    await send(sock, jid, messageObj, "❌ Perintah `.lanjut` hanya bisa dipakai saat fase diskusi Undercover.");
    return true;
  }

  const isHost = session.host && samePlayer(session.host, senderNumber);
  if (isHost || isAdmin || isOwner) {
    await send(sock, jid, messageObj, "⏩ *Diskusi ditutup lebih awal oleh Host/Admin!* Membuka fase voting...");
    return await startVotingPhase(sock, jid, messageObj) || true;
  }

  const voter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!voter) {
    await send(sock, jid, messageObj, "❌ Hanya pemain yang masih hidup yang bisa mempercepat diskusi!");
    return true;
  }

  if (!session.discussionSkips) session.discussionSkips = new Set();
  session.discussionSkips.add(voter);
  const needed = Math.min(2, Math.max(1, session.alivePlayers.length - 1));

  if (session.discussionSkips.size >= needed) {
    await send(sock, jid, messageObj, "⏩ *Diskusi ditutup atas kesepakatan pemain!* Membuka fase voting...");
    await startVotingPhase(sock, jid, messageObj);
    return true;
  }

  await send(sock, jid, messageObj, `⏩ ${tag(voter)} ingin langsung voting (${session.discussionSkips.size}/${needed} suara).`, { mentions: [voter] });
  return true;
}

// ─── 🗳️ FASE VOTING ELIMINASI ────────────────────────────────────────
async function startVotingPhase(sock, jid, messageObj, isResume = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'VOTING_PHASE';
  if (!isResume) session.votes.clear();
  saveUndercoverSessions();

  const isSuddenDeath = session.round >= 4;
  const board = buildClueBoard(session);
  const header = isResume ? '🔄 *FASE VOTING DIPULIHKAN!*' : '🗳️ *DISKUSI SELESAI — FASE VOTING DIBUKA!*';
  const sisaSkip = Math.max(0, MAX_SKIPS - (session.skipCount || 0));

  const msg =
`${header} ⚖️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${board}

👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSuddenDeath ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `• Ketik: \`.vote skip\` (atau \`.skip\`) untuk **Abstain** (Sisa Kuota: ${sisaSkip}/${MAX_SKIPS})`}
⏳ Waktu voting: ${Math.round(VOTE_TIMEOUT_MS / 1000)} detik.`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'VOTING_PHASE') return;
    await processUndercoverVotes(sock, jid, null);
  }, VOTE_TIMEOUT_MS);

  await send(sock, jid, messageObj, msg, { mentions: session.alivePlayers });
}

// ─── ⏩ SKIP GILIRAN / ABSTAIN ────────────────────────────────────────
export async function handleUndercoverSkip(sock, jid, senderNumber, messageObj, text = '', isAdmin = false, isOwner = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  if (session.status === 'DISCUSSION_PHASE') {
    return await handleUndercoverContinue(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  if (session.status === 'VOTING_PHASE') {
    return await handleUndercoverVote(sock, jid, senderNumber, messageObj, 'SKIP');
  }

  if (session.status !== 'CLUE_PHASE') return false;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  if (!currentTurnPlayer) return false;

  const isCurrentTurn = samePlayer(senderNumber, currentTurnPlayer);
  const isHost = session.host && samePlayer(session.host, senderNumber);
  const isPrivileged = isHost || isAdmin || isOwner;

  if (!session.skipVotes) session.skipVotes = new Set();

  if (isCurrentTurn) {
    recordClue(session, currentTurnPlayer, '(Melewatkan giliran / Skip)');
    await send(sock, jid, messageObj, `⏩ ${tag(currentTurnPlayer)} memilih untuk **MELEWATKAN GILIRAN (SKIP)**!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  if (isPrivileged) {
    recordClue(session, currentTurnPlayer, '(Di-skip oleh Host/Admin)');
    await send(sock, jid, messageObj, `⏩ *FORCE SKIP:* Giliran ${tag(currentTurnPlayer)} dilewati oleh Host/Admin!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  const voter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!voter) return false;

  session.skipVotes.add(voter);
  const needed = Math.min(2, Math.max(1, session.alivePlayers.length - 1));

  if (session.skipVotes.size >= needed) {
    recordClue(session, currentTurnPlayer, '(Di-skip oleh voting pemain lain)');
    await send(sock, jid, messageObj, `⏩ *VOTE SKIP BERHASIL:* Giliran ${tag(currentTurnPlayer)} dilewati karena tidak merespons!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  await send(sock, jid, messageObj, `🗳️ ${tag(voter)} mengajukan vote skip untuk ${tag(currentTurnPlayer)} (${session.skipVotes.size}/${needed} suara diperlukan).`, { mentions: [voter, currentTurnPlayer] });
  return true;
}

// ─── 🔀 SKILL TUKAR GILIRAN UNDERCOVER (.tukargiliran) ──────────────────────
export async function handleUndercoverSwap(sock, jid, senderNumber, messageObj) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);
  if (!session || session.status !== 'CLUE_PHASE') {
    await send(sock, jid, messageObj, "❌ Skill tukar giliran hanya bisa dipakai saat fase petunjuk berlangsung!");
    return true;
  }

  const roleData = getPlayerRoleData(session, resolvedSender);
  if (!roleData || roleData.role !== 'UNDERCOVER') {
    await send(sock, jid, messageObj, "❌ Hanya Undercover yang memiliki skill tukar giliran!");
    return true;
  }
  if (!roleData.hasSwap) {
    await send(sock, jid, messageObj, "❌ Skill tukar giliran sudah kamu pakai (maksimal 1x per game)!");
    return true;
  }

  const idx = findAliveIndex(session, resolvedSender);
  if (idx === -1 || idx !== session.turnIndex) {
    await send(sock, jid, messageObj, "⚠️ Skill tukar giliran hanya bisa dipakai tepat saat giliranmu bicara!");
    return true;
  }
  if (session.turnIndex >= session.alivePlayers.length - 1) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di urutan terakhir, tidak ada giliran untuk ditukar!");
    return true;
  }

  roleData.hasSwap = false;
  const me = session.alivePlayers.splice(idx, 1)[0];
  session.alivePlayers.push(me);
  saveUndercoverSessions();

  const gameJid = session.jid;
  await send(sock, jid, messageObj, "🔀 *Skill Tukar Giliran dipakai!* Kamu dilempar ke urutan terakhir ronde ini. Dengarkan semua petunjuk dulu, baru bicara.");
  await send(sock, gameJid, null, `🔀 *PERGANTIAN URUTAN MENDADAK!* ${tag(me)} melempar gilirannya ke urutan paling akhir ronde ini!`, { mentions: [me] });
  await announceTurn(sock, gameJid, null);
  return true;
}

// ─── ☠️ ELIMINASI, INTEL KEMATIAN & SINKRONISASI GILIRAN ─────────────
function killPlayer(session, jid, { byShoot = false } = {}) {
  const idx = findAliveIndex(session, jid);
  const roleData = getPlayerRoleData(session, jid);
  if (roleData) {
    roleData.isAlive = false;
    if (byShoot) roleData.killedByShoot = true;
  }
  if (idx === -1) return { idx: -1, wasCurrent: false };

  const wasCurrent = session.status === 'CLUE_PHASE' && idx === session.turnIndex;
  session.alivePlayers.splice(idx, 1);
  if (session.status === 'CLUE_PHASE' && idx < session.turnIndex) session.turnIndex--;

  // Bersihkan suara & efek yang menempel pada pemain yang gugur
  if (session.votes) {
    for (const voter of Array.from(session.votes.keys())) {
      if (samePlayer(voter, jid)) session.votes.delete(voter);
    }
  }
  session.goldenVoters?.delete(jid);
  session.shieldedPlayers?.delete(jid);
  session.silencedPlayers?.delete(jid);

  if (byShoot) {
    if (!Array.isArray(session.shotVictims)) session.shotVictims = [];
    if (!session.shotVictims.some(v => samePlayer(v, jid))) session.shotVictims.push(jid);
  }
  return { idx, wasCurrent };
}

// Dipanggil setelah ada kematian di luar jalur voting (tembakan) agar giliran
// bicara tidak macet. Tanpa ini, timer lama tidak cocok lagi dan game menggantung.
async function resyncAfterDeath(sock, jid, killInfo) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  if (session.status === 'CLUE_PHASE') {
    if (!killInfo?.wasCurrent) return; // pembicara saat ini tidak berubah
    clearSessionTimer(session);
    if (session.turnIndex >= session.alivePlayers.length) {
      return await finishCluePass(sock, jid, null);
    }
    return await announceTurn(sock, jid, null, '🔄 *Giliran disesuaikan ulang setelah ada korban berjatuhan!*\n');
  }

  if (session.status === 'VOTING_PHASE') {
    if (session.votes.size >= session.alivePlayers.length && session.alivePlayers.length > 0) {
      clearSessionTimer(session);
      return await processUndercoverVotes(sock, jid, null);
    }
  }
}

// Pemain yang gugur dikirimi bocoran seluruh peran via DM (dead chat).
async function sendDeathIntel(sock, session, deadJid, cause = 'tereliminasi') {
  const board = session.players.map(p => {
    const rd = getPlayerRoleData(session, p);
    const mark = isAlive(session, p) ? '🟢 HIDUP' : '⚫ GUGUR';
    return `${mark} — ${plainLabel(session, p)}\n     ${getRoleBadge(rd?.role)}`;
  }).join('\n');

  await dm(sock, deadJid,
`👻 *KAMU SUDAH GUGUR — AKSES INTEL ALAM BAKA* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kamu ${cause} di Ronde ${session.round}. Sebagai arwah, kamu berhak tahu semuanya:

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

📋 *Bocoran Seluruh Peran:*
${board}

🚫 *DILARANG KERAS membocorkan informasi ini ke grup!* Nikmati sisa permainan sebagai penonton.`);
}

// ─── 🗳️ PEMROSESAN HASIL VOTING ──────────────────────────────────────
async function processUndercoverVotes(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  const voteCounts = new Map();
  for (const [voter, target] of session.votes.entries()) {
    if (!isAlive(session, voter)) continue;
    const weight = session.goldenVoters?.has(voter) ? 2 : 1;
    voteCounts.set(target, (voteCounts.get(target) || 0) + weight);
  }

  if (session.framedPlayer && isAlive(session, session.framedPlayer)) {
    const framed = session.framedPlayer;
    voteCounts.set(framed, (voteCounts.get(framed) || 0) + 1);
    await send(sock, jid, messageObj, `🗣️ *JEJAK FITNAH TERBUKTI!* ${tag(framed)} terkena **+1 Suara Kutukan Tambahan** dari aksi Framer!`, { mentions: [framed] });
  }
  session.framedPlayer = null;

  let maxVotes = 0;
  let eliminated = null;
  let isTie = false;
  for (const [target, count] of voteCounts.entries()) {
    if (count > maxVotes) { maxVotes = count; eliminated = target; isTie = false; }
    else if (count === maxVotes) isTie = true;
  }

  if (isTie || !eliminated || eliminated === 'SKIP') {
    if (eliminated === 'SKIP' && !isTie) session.skipCount = (session.skipCount || 0) + 1;
    const reasonMsg = (eliminated === 'SKIP' && !isTie)
      ? `⚖️ *HASIL VOTING TERBANYAK ADALAH SKIP / ABSTAIN!* Tidak ada pemain yang dieliminasi ronde ini. (Penggunaan Skip: ${session.skipCount}/${MAX_SKIPS})`
      : `⚖️ *HASIL VOTING SERI / IMBANG!* Tidak ada yang dieliminasi ronde ini.`;
    await send(sock, jid, messageObj, `${reasonMsg}\nPermainan dilanjutkan ke ronde berikutnya!`);
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  if (session.guardedPlayer && samePlayer(session.guardedPlayer, eliminated)) {
    session.guardedPlayer = null;
    await send(sock, jid, messageObj, `🛡️ *GUARDIAN MENYELAMATKAN DARI EKSEKUSI!* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${tag(eliminated)} seharusnya dieksekusi oleh voting grup, namun Bodyguard berhasil melindunginya dari maut! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  if (session.shieldedPlayers?.has(eliminated)) {
    session.shieldedPlayers.delete(eliminated);
    await send(sock, jid, messageObj, `🛡️ *ROMPI ANTI-PELURU AKTIF!* ${tag(eliminated)} selamat dari eksekusi vote berkat Rompi Pelindung! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  const eliminatedRole = getPlayerRoleData(session, eliminated);
  killPlayer(session, eliminated);

  await send(sock, jid, messageObj, `☠️ *${tag(eliminated)}* resmi dieliminasi dari grup dengan ${maxVotes} suara!\n🎭 Peran Terbuka: *${getRoleBadge(eliminatedRole?.role)}*`, { mentions: [eliminated] });
  saveUndercoverSessions();

  // 1. Kemenangan solo Si Badut (Ronde 2 atau 3)
  if (eliminatedRole?.role === 'JESTER' && (session.round === 2 || session.round === 3)) {
    try { await db.bumpUndercoverCounter(eliminated, 'jester_win'); } catch (e) {}
    return await finishGame(sock, jid, {
      headline: `🃏 *SI BADUT (JESTER) MENANG SOLO TELAK!* 🤡`,
      detail: `🎉 *PLOT TWIST RONDE ${session.round}!* ${tag(eliminated)} berhasil memprovokasi grup agar mem-vote dirinya keluar!\n_Seluruh pot taruhan disapu bersih oleh Si Badut!_`,
      winners: [eliminated],
      xpEach: 150
    });
  }

  await sendDeathIntel(sock, session, eliminated, 'dieksekusi lewat voting grup');

  // 2. Mr. White dapat kesempatan tebak kata terakhir
  if (eliminatedRole?.role === 'MRWHITE') {
    session.status = 'MR_WHITE_GUESS';
    session.mrWhiteGuessPending = eliminated;
    saveUndercoverSessions();
    await send(sock, jid, messageObj, `🤍 *MR. WHITE DIBERI KESEMPATAN TERAKHIR!* 🤍\n${tag(eliminated)} punya ${Math.round(MRWHITE_GUESS_MS / 1000)} detik untuk menebak kata warga sipil!\n👉 Ketik: \`.tebakwarga <kata>\``, { mentions: [eliminated] });
    return await armMrWhiteGuessTimer(sock, jid, eliminated);
  }

  const isWon = await checkUndercoverWinCondition(sock, jid);
  if (!isWon) await startNextUndercoverRound(sock, jid, messageObj, false);
}

async function armMrWhiteGuessTimer(sock, jid, pendingJid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);
  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'MR_WHITE_GUESS') return;
    cur.mrWhiteGuessPending = null;
    await send(sock, jid, null, `⏰ Waktu Mr. White habis! Kata warga tidak tertebak.`);
    const isWon = await checkUndercoverWinCondition(sock, jid);
    if (!isWon) await startNextUndercoverRound(sock, jid, null, false);
  }, MRWHITE_GUESS_MS);
}

export async function handleUndercoverVote(sock, jid, senderNumber, messageObj, targetJid) {
  let session = activeUndercoverGames.get(jid);
  if (!session) {
    const found = findUndercoverSessionAndPlayer(senderNumber);
    session = found.session;
  }
  if (!session) {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  // Voting kategori kata sebelum game dimulai
  if (session.status === 'CATEGORY_VOTE') {
    return await handleCategoryVote(sock, session.jid, senderNumber, messageObj, targetJid);
  }

  // Vote saat diskusi = langsung tutup diskusi lalu catat suaranya
  if (session.status === 'DISCUSSION_PHASE') {
    await send(sock, session.jid, null, "⏩ *Ada yang sudah mantap memilih!* Fase diskusi ditutup, voting dibuka sekarang.");
    await startVotingPhase(sock, session.jid, null);
  }

  if (session.status !== 'VOTING_PHASE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  const resolvedVoter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!resolvedVoter) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur/mati tidak dapat memberikan suara!");
    return true;
  }

  let rawTarget = targetJid ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.participant;

  const isSkipVote = ['skip', '0', 'lewat', 'abstain', 'pass', 'voteskip'].includes(String(rawTarget || '').trim().toLowerCase());
  let resolvedTarget = null;

  if (isSkipVote) {
    if (session.round >= 4) {
      await send(sock, jid, messageObj, "🚨 *ZONA MERAH (SUDDEN DEATH)!* Mulai Ronde 4, opsi vote skip dikunci. Seluruh pemain wajib memilih salah satu tersangka!");
      return true;
    }
    if ((session.skipCount || 0) >= MAX_SKIPS) {
      await send(sock, jid, messageObj, `❌ *KUOTA VOTE SKIP HABIS!* Vote skip hanya bisa dipakai ${MAX_SKIPS}x per game. Silakan pilih tersangka!`);
      return true;
    }
    resolvedTarget = 'SKIP';
  } else if (rawTarget) {
    resolvedTarget = resolveTargetInSession(session, rawTarget);
  }

  if (!resolvedTarget || (resolvedTarget !== 'SKIP' && !isAlive(session, resolvedTarget))) {
    const isSd = session.round >= 4;
    await send(sock, jid, messageObj, `⚠️ Target vote tidak valid atau sudah mati!\n👉 *Cara Vote:* \`.vote @member\`, nomor urut \`.vote [1-${session.alivePlayers.length}]\`${isSd ? '' : ' atau `.vote skip` (Abstain)'}`);
    return true;
  }

  if (resolvedTarget !== 'SKIP' && samePlayer(resolvedTarget, resolvedVoter)) {
    await send(sock, jid, messageObj, `⚠️ Kamu tidak bisa mem-vote dirimu sendiri! ${session.round >= 4 ? 'Wajib pilih pemain lain!' : 'Jika ingin abstain, ketik `.vote skip`.'}`);
    return true;
  }

  session.votes.set(resolvedVoter, resolvedTarget);
  saveUndercoverSessions();

  const isGolden = session.goldenVoters?.has(resolvedVoter);
  const goldNote = isGolden ? '🌟 *(Golden Vote x2)*' : '';

  if (resolvedTarget === 'SKIP') {
    await send(sock, session.jid, messageObj, `🗳️ ${tag(resolvedVoter)} memilih **SKIP / ABSTAIN**! ${goldNote} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter] });
  } else {
    await send(sock, session.jid, messageObj, `🗳️ ${tag(resolvedVoter)} mem-vote ${tag(resolvedTarget)}! ${goldNote} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter, resolvedTarget] });
  }

  if (session.votes.size >= session.alivePlayers.length) {
    clearSessionTimer(session);
    await processUndercoverVotes(sock, session.jid, messageObj);
  }
  return true;
}

// ─── 🏁 PENUTUPAN GAME, REKAP & STATISTIK ────────────────────────────
function buildFinalRecap(session) {
  const lines = session.players.map(p => {
    const rd = getPlayerRoleData(session, p);
    const mark = isAlive(session, p) ? '🟢' : '⚫';
    const clues = Array.isArray(rd?.clueLog) ? rd.clueLog : [];
    const byRound = new Map();
    for (const c of clues) {
      if (!byRound.has(c.round)) byRound.set(c.round, []);
      byRound.get(c.round).push(String(c.text || '').slice(0, 40));
    }
    const clueText = byRound.size > 0
      ? Array.from(byRound.entries()).map(([r, list]) => `R${r}: "${list.join(' → ')}"`).join(' | ')
      : '(tidak sempat memberi petunjuk)';
    return `${mark} ${plainLabel(session, p)}\n     ${getRoleBadge(rd?.role)}\n     💬 ${clueText}`;
  }).join('\n');

  return `\n\n🎬 *REKAP LENGKAP PERMAINAN* 🎞️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${lines}`;
}

async function recordMatchStats(session, winners, prizePer) {
  for (const p of session.players) {
    const rd = getPlayerRoleData(session, p);
    const won = winners.some(w => samePlayer(w, p));
    try {
      await db.recordUndercoverResult(p, {
        faction: factionOf(rd?.role),
        role: rd?.role || 'CIVILIAN',
        won,
        prize: won ? prizePer : 0
      });
    } catch (e) {
      console.error('[UNDERCOVER] Gagal menyimpan statistik:', e.message);
    }
  }
}

async function finishGame(sock, jid, { headline, detail, winners = [], xpEach = 100 }) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return true;
  clearSessionTimer(session);

  const totalPrize = session.buyIn * session.players.length;
  const uniqWinners = [];
  for (const w of winners) {
    if (w && !uniqWinners.some(u => samePlayer(u, w))) uniqWinners.push(w);
  }

  const prizePer = uniqWinners.length > 0 ? Math.floor(totalPrize / uniqWinners.length) : 0;
  for (const w of uniqWinners) {
    await db.addGamePoints(w, prizePer);
    await db.addMessageXp(w, xpEach);
  }

  // Konsolasi Si Badut: gagal menang tapi selamat sampai akhir ➔ taruhan dikembalikan
  let jesterNote = '';
  const survivingJester = session.alivePlayers.filter(p => {
    const rd = getPlayerRoleData(session, p);
    return rd?.role === 'JESTER' && !uniqWinners.some(u => samePlayer(u, p));
  });
  for (const j of survivingJester) {
    await db.addGamePoints(j, session.buyIn);
    jesterNote += `\n🤡 *Konsolasi Si Badut:* ${tag(j)} selamat sampai akhir ➔ taruhan *${session.buyIn} Poin* dikembalikan.`;
  }

  await recordMatchStats(session, uniqWinners, prizePer);

  const winnerLine = uniqWinners.length > 0
    ? `\n🏆 *Pemenang:* ${uniqWinners.map(w => tag(w)).join(', ')}\n🎁 *Hadiah Tiap Pemenang:* *+${prizePer.toLocaleString('id-ID')} Poin* & *+${xpEach} XP*`
    : `\n🤷 Tidak ada pemenang di permainan ini.`;

  const msg =
`${headline}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${detail}

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*
📚 Tema: *${THEMES[session.theme]?.label || 'Acak'}*${winnerLine}${jesterNote}${buildFinalRecap(session)}

📊 Ketik \`.undercover stats\` untuk melihat statistikmu, atau \`.undercover top\` untuk papan peringkat.`;

  const mentions = [...new Set([...uniqWinners, ...survivingJester])];
  activeUndercoverGames.delete(jid);
  saveUndercoverSessions();
  await send(sock, jid, null, msg, { mentions });
  return true;
}

export async function checkUndercoverWinCondition(sock, jid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  const aliveUndercover = session.alivePlayers.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
  const aliveMrWhite = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'MRWHITE');
  const aliveCivilians = session.alivePlayers.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
  const aliveBunglon = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'BUNGLON');
  const totalAlive = session.alivePlayers.length;

  // 1. Seluruh penyamar & Mr. White gugur ➔ Warga menang
  if (aliveUndercover.length === 0 && aliveMrWhite.length === 0) {
    const civTeam = session.players.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
    const bunglonText = aliveBunglon.length > 0
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => tag(b)).join(', ')} (Ikut menang karena selamat!)`
      : '';
    return await finishGame(sock, jid, {
      headline: `🎉 *WARGA SIPIL MENANG! (CIVILIAN VICTORY)* 🛡️`,
      detail: `Seluruh penyamar berhasil dibongkar dan dieliminasi warga!${bunglonText}`,
      winners: [...civTeam, ...aliveBunglon],
      xpEach: 80
    });
  }

  // 2. Kemenangan Kubu Penyamar (Undercover Victory):
  //    Penyamar HANYA menang jika:
  //    a) Seluruh Warga Sipil sudah habis (aliveCivilians.length === 0), ATAU
  //    b) Sisa pemain hidup <= 2 orang (misal 1v1), ATAU
  //    c) Penyamar menguasai mayoritas mutlak dari SELURUH pemain hidup (aliveUndercover.length * 2 > totalAlive).
  //    Jika masih ada pemain Netral dan Warga yang bisa membalikkan keadaan (misal 1 Under, 1 Netral, 1 Warga), game TETAP LANJUT!
  const isUndercoverDominant = (aliveCivilians.length === 0) || 
    (totalAlive <= 2 && aliveUndercover.length > 0) || 
    (aliveUndercover.length * 2 > totalAlive);

  if (aliveUndercover.length > 0 && isUndercoverDominant) {
    const underTeam = session.players.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
    const bunglonText = aliveBunglon.length > 0
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => tag(b)).join(', ')} (Ikut menang karena selamat!)`
      : '';
    return await finishGame(sock, jid, {
      headline: `🎭 *UNDERCOVER MENANG! (IMPOSTOR VICTORY)* 🕵️`,
      detail: `Penyamar berhasil menguasai permainan dan mengeliminasi mayoritas warga!${bunglonText}`,
      winners: [...underTeam, ...aliveMrWhite, ...aliveBunglon],
      xpEach: 120
    });
  }

  // 3. Penyamar habis tapi Mr. White menguasai lapangan ➔ Mr. White menang solo
  const isMrWhiteDominant = aliveUndercover.length === 0 && aliveMrWhite.length > 0 && 
    ((aliveCivilians.length === 0) || (totalAlive <= 2) || (aliveMrWhite.length * 2 > totalAlive));

  if (isMrWhiteDominant) {
    return await finishGame(sock, jid, {
      headline: `🤍 *MR. WHITE MENANG SOLO! (BLANK VICTORY)* 👻`,
      detail: `Semua penyamar sudah gugur, tapi Mr. White justru bertahan sampai warga kehabisan orang!`,
      winners: [...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  return false;
}

async function resolveMaxRoundLimit(sock, jid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  const aliveUndercover = session.alivePlayers.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
  const aliveMrWhite = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'MRWHITE');
  const aliveBunglon = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'BUNGLON');

  if (aliveUndercover.length > 0) {
    const underTeam = session.players.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
    return await finishGame(sock, jid, {
      headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🕵️👑`,
      detail: `Warga sipil kehabisan waktu dan gagal membongkar penyamar!\n🏆 *UNDERCOVER MENANG SURVIVAL!* 🎭`,
      winners: [...underTeam, ...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  if (aliveMrWhite.length > 0) {
    return await finishGame(sock, jid, {
      headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🤍`,
      detail: `Semua penyamar sudah gugur, tapi warga tidak pernah berhasil membekuk Mr. White!\n🏆 *MR. WHITE MENANG SURVIVAL!* 👻`,
      winners: [...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  const civTeam = session.players.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
  return await finishGame(sock, jid, {
    headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🛡️`,
    detail: `Tidak ada penyamar tersisa di lapangan — warga bertahan sampai peluit akhir!\n🏆 *WARGA SIPIL MENANG SURVIVAL!*`,
    winners: [...civTeam, ...aliveBunglon],
    xpEach: 100
  });
}

// ─── 🤍 TEBAKAN KATA MR. WHITE ───────────────────────────────────────
export async function handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  const allowedStatus = ['CLUE_PHASE', 'DISCUSSION_PHASE', 'VOTING_PHASE', 'MR_WHITE_GUESS'];
  if (!targetSession || !allowedStatus.includes(targetSession.status)) {
    if (activeUndercoverGames.has(jid)) {
      await send(sock, jid, messageObj, "❌ Hanya Mr. White yang dapat menebak kata warga dengan `.tebakwarga <kata>`!");
      return true;
    }
    return false;
  }

  const senderRoleData = getPlayerRoleData(targetSession, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'MRWHITE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Mr. White di game ini!");
    return true;
  }

  const isPendingGuesser = targetSession.mrWhiteGuessPending && samePlayer(targetSession.mrWhiteGuessPending, resolvedSender);
  if (!isAlive(targetSession, resolvedSender) && !isPendingGuesser) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan kesempatan menebak kata telah berakhir!");
    return true;
  }

  const gameJid = targetSession.jid;

  if (!guess) {
    await send(sock, jid, messageObj, "⚠️ Masukkan kata tebakanmu!\n*Contoh:* `.tebakwarga Kopi` atau `.guess Kopi`");
    return true;
  }

  if (targetSession.status === 'MR_WHITE_GUESS') clearSessionTimer(targetSession);

  let cleanGuessText = String(guess || '').trim().replace(/^["']|["']$/g, '');
  if (cleanGuessText.toLowerCase().startsWith('kata ')) cleanGuessText = cleanGuessText.slice(5).trim();
  else if (cleanGuessText.toLowerCase().startsWith('katanya ')) cleanGuessText = cleanGuessText.slice(8).trim();

  const isCorrect = normalizeAnswer(cleanGuessText) === normalizeAnswer(targetSession.pair.civilian);

  if (isCorrect) {
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🎉 Tebakan Anda BENAR (*${cleanGuessText}*)! Anda memenangkan permainan!`);
    }
    try { await db.bumpUndercoverCounter(resolvedSender, 'mrwhite_guess_win'); } catch (e) {}
    return await finishGame(sock, gameJid, {
      headline: `🏆 *MR. WHITE BERHASIL MENEBAK KATA WARGA!* 🤍`,
      detail: `🎉 ${tag(resolvedSender)} menebak: *"${cleanGuessText}"* — TEPAT SASARAN!\n_Mr. White menyapu bersih seluruh pot taruhan permainan!_`,
      winners: [resolvedSender],
      xpEach: 150
    });
  }

  await send(sock, gameJid, null, `❌ *TEBAKAN MR. WHITE GAGAL!* 🤍\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${tag(resolvedSender)} menebak kata warga: *"${cleanGuessText}"* (SALAH!)`, { mentions: [resolvedSender] });
  if (jid !== gameJid) {
    await send(sock, jid, messageObj, `❌ Tebakan Anda (*${cleanGuessText}*) SALAH!`);
  }

  if (targetSession.status === 'MR_WHITE_GUESS') {
    targetSession.mrWhiteGuessPending = null;
    saveUndercoverSessions();
    const isWon = await checkUndercoverWinCondition(sock, gameJid);
    if (!isWon) await startNextUndercoverRound(sock, gameJid, null, false);
    return true;
  }

  // Salah menebak saat masih hidup di tengah permainan ➔ langsung gugur
  const killInfo = killPlayer(targetSession, resolvedSender);
  saveUndercoverSessions();
  await send(sock, gameJid, null, `☠️ Karena salah menebak kata warga di tengah permainan, Mr. White ${tag(resolvedSender)} **TEWAS TERELIMINASI**!`, { mentions: [resolvedSender] });
  await sendDeathIntel(sock, targetSession, resolvedSender, 'gugur akibat salah menebak kata warga');

  const isWon = await checkUndercoverWinCondition(sock, gameJid);
  if (!isWon) await resyncAfterDeath(sock, gameJid, killInfo);
  return true;
}

// ─── 🔍 DETEKTIF INTEL VIA DM (.intip @member) ──────────────────────
const SKILL_PHASES = ['CLUE_PHASE', 'DISCUSSION_PHASE', 'VOTING_PHASE'];

export async function handleDetectiveCheck(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'DETECTIVE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Detektif di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan intip!");
    return true;
  }
  if (session.round < 2) {
    await send(sock, jid, messageObj, "⏳ *KEMAMPUAN TERKUNCI!* Detektif baru bisa mengintip peran mulai Ronde 2 ke atas.");
    return true;
  }
  if (senderRoleData.hasUsedIntel) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan intip Anda (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.intip @member\` atau nomor urut \`.intip [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa mengintip diri sendiri!");
    return true;
  }

  senderRoleData.hasUsedIntel = true;
  saveUndercoverSessions();

  const targetRole = getPlayerRoleData(session, resolvedTarget);
  const isFramed = session.framedPlayer && samePlayer(session.framedPlayer, resolvedTarget);
  const isCiv = targetRole && isCivilianRole(targetRole.role) && !isFramed;

  if (!isCiv && !isFramed) {
    try { await db.bumpUndercoverCounter(resolvedSender, 'detective_correct'); } catch (e) {}
  }

  const report = isCiv
    ? `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🟢 Status: *WARGA SIPIL (CIVILIAN)* 🛡️\n\n_Target adalah sekutu warga yang aman!_`
    : `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🔴 Status: *BUKAN WARGA (PENYAMAR / NETRAL)!* 🚨\n\n_Target sangat mencurigakan, arahkan warga untuk mem-votenya!_`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🛡️ GUARDIAN BODYGUARD VIA DM (.lindung @member) ────────────────
export async function handleGuardianProtect(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'GUARDIAN') {
    await send(sock, jid, messageObj, "❌ Anda bukan Guardian/Bodyguard di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan perlindungan!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.lindung @member\` atau nomor urut \`.lindung [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "🚫 *Guardian dilarang melindungi dirinya sendiri!* Pilih pemain lain.");
    return true;
  }
  if (senderRoleData.lastGuarded && samePlayer(senderRoleData.lastGuarded, resolvedTarget)) {
    await send(sock, jid, messageObj, "🚫 *Dilarang melindungi target yang sama dua ronde berturut-turut!* Pilih pemain lain ronde ini.");
    return true;
  }
  if (session.guardedPlayer) {
    await send(sock, jid, messageObj, `⚠️ Anda sudah memasang perlindungan untuk ${tag(session.guardedPlayer)} di ronde ini. Tunggu ronde berikutnya!`, { mentions: [session.guardedPlayer] });
    return true;
  }

  session.guardedPlayer = resolvedTarget;
  senderRoleData.lastGuarded = resolvedTarget;
  saveUndercoverSessions();

  await send(sock, jid, messageObj, `🛡️ *PERLINDUNGAN GUARDIAN AKTIF!* 🔰\nAnda mengawal ketat ${tag(resolvedTarget)} untuk *Ronde ${session.round} saja*. Jika dia diserang/dieksekusi ronde ini, nyawanya terselamatkan!\n💡 _Ronde depan perlindungan hangus dan wajib dipasang ulang ke orang berbeda._`, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🩺 DOKTER LAPANGAN VIA DM (.sembuhkan @member) ─────────────────
/**
 * Apakah pengirim benar-benar Dokter yang masih hidup di sesi Undercover aktif?
 *
 * Dipakai router game untuk memilah alias `.heal` / `.revive` yang dipakai
 * bersama oleh Dokter Undercover dan Healer Raid Boss. Predikat ini tidak
 * mengirim pesan apa pun — murni pengecekan supaya router bisa memutuskan
 * pemilik command tanpa efek samping.
 */
export function isUndercoverDoctorActive(senderNumber) {
  const { session, playerJid } = findUndercoverSessionAndPlayer(senderNumber);
  if (!session || !SKILL_PHASES.includes(session.status)) return false;
  const roleData = getPlayerRoleData(session, playerJid);
  if (!roleData || roleData.role !== 'DOCTOR') return false;
  return isAlive(session, playerJid);
}

export async function handleDoctorRevive(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'DOCTOR') {
    await send(sock, jid, messageObj, "❌ Anda bukan Dokter Lapangan di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan medis!");
    return true;
  }
  if (senderRoleData.hasUsedRevive) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan 1x kemampuan CPR/Revive Anda dalam game ini!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam, true);
  if (!resolvedTarget) {
    await send(sock, jid, messageObj, `⚠️ Target tidak ditemukan!\n👉 *Format:* \`.sembuhkan @member\` atau \`.sembuhkan <nomor>\``);
    return true;
  }
  if (isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, "⚠️ Target tersebut masih hidup dan tidak membutuhkan pertolongan medis!");
    return true;
  }

  const targetRoleData = getPlayerRoleData(session, resolvedTarget);
  if (!targetRoleData) {
    await send(sock, jid, messageObj, "❌ Data target tidak ditemukan di sesi permainan ini!");
    return true;
  }

  const wasShot = targetRoleData.killedByShoot ||
    (Array.isArray(session.shotVictims) && session.shotVictims.some(v => samePlayer(v, resolvedTarget)));
  if (!wasShot) {
    await send(sock, jid, messageObj, "❌ Dokter hanya dapat menghidupkan korban tembakan (Sheriff/Assassin), bukan korban voting grup!");
    return true;
  }

  senderRoleData.hasUsedRevive = true;
  targetRoleData.isAlive = true;
  targetRoleData.killedByShoot = false;
  if (Array.isArray(session.shotVictims)) {
    session.shotVictims = session.shotVictims.filter(v => !samePlayer(v, resolvedTarget));
  }
  session.alivePlayers.push(resolvedTarget);
  saveUndercoverSessions();

  const gameJid = session.jid;
  await send(sock, gameJid, null,
`🩺 *KEAJAIBAN MEDIS! DOKTER BERAKSI!* 💉
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dokter Lapangan ${tag(resolvedSender)} menggunakan jarum adrenalin & CPR darurat!
✨ Nyawa ${tag(resolvedTarget)} yang tewas tertembak berhasil diselamatkan!
${tag(resolvedTarget)} **BANGKIT KEMBALI KE PERMAINAN**! 🛡️`, { mentions: [resolvedSender, resolvedTarget] });

  if (jid !== gameJid) {
    await send(sock, jid, messageObj, `✨ Anda berhasil menghidupkan kembali ${tag(resolvedTarget)}! Pasien telah sadar dan kembali ke grup.`, { mentions: [resolvedTarget] });
  }
  return true;
}

// ─── 🗣️ FRAMER TUKANG FITNAH VIA DM (.fitnah @member) ───────────────
export async function handleFramerFrame(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'FRAMER') {
    await send(sock, jid, messageObj, "❌ Anda bukan Framer di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan fitnah!");
    return true;
  }
  if (senderRoleData.hasFramed) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan fitnah (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.fitnah @member\` atau nomor urut \`.fitnah [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa memfitnah diri sendiri!");
    return true;
  }

  senderRoleData.hasFramed = true;
  session.framedPlayer = resolvedTarget;
  saveUndercoverSessions();

  await send(sock, jid, messageObj,
`🗣️ *AKSI FITNAH BERHASIL DILANCARKAN!* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target ${tag(resolvedTarget)} berhasil Anda jebak!
🎯 *Efek Berjalan (Ronde ${session.round}):*
1. Jika Detektif mengintipnya, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR)**!
2. Pada fase voting ronde ini, target otomatis mendapat **+1 Suara Kutukan Eksekusi**!`, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🦹 SABOTEUR MERETAS STATUS VIA DM (.hack @member) ──────────────
export async function handleSaboteurHack(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'SABOTEUR') {
    await send(sock, jid, messageObj, "❌ Anda bukan Saboteur di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat meretas status!");
    return true;
  }

  if (senderRoleData.lastHackRound === session.round) {
    await send(sock, jid, messageObj, "❌ Anda sudah meretas 1 target di ronde ini! Tunggu ronde berikutnya.");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.hack @member\` atau nomor urut \`.hack [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa meretas diri sendiri!");
    return true;
  }

  senderRoleData.lastHackRound = session.round;
  saveUndercoverSessions();

  const targetRoleData = getPlayerRoleData(session, resolvedTarget);
  const isVip = ['SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR'].includes(targetRoleData?.role);

  const report = isVip
    ? `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🚨 Status Intel: *WARGA SPESIAL / VIP BERBAHAYA!* (${getRoleBadge(targetRoleData?.role)})\n\n_Target memegang kemampuan khusus, segera habisi dia!_`
    : `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🛡️ Status Intel: *${getRoleBadge(targetRoleData?.role)}*\n\n_Target tidak memiliki senjata berbahaya._`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🤠🔫 TEMBAKAN RAHASIA VIA DM (.tembak @member) ─────────────────
export async function handleUndercoverShoot(sock, jid, senderNumber, messageObj, args = []) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) return false;

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || !['SHERIFF', 'ASSASSIN'].includes(senderRoleData.role)) {
    await send(sock, jid, messageObj, "❌ Peran Anda tidak memiliki senjata! Hanya Assassin & Sheriff yang dapat menembak.");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menembak!");
    return true;
  }
  if (!senderRoleData.hasBullet) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan 1 peluru tembakan Anda dalam game ini!");
    return true;
  }

  // Sheriff & Assassin sama-sama terkunci di Ronde 1 agar game kecil tidak
  // selesai sebelum ada informasi apa pun untuk dianalisis.
  if (session.round < 2) {
    await send(sock, jid, messageObj, "⏳ *SENJATA TERKUNCI!* Tembakan baru bisa dilepaskan mulai Ronde 2 ke atas. Analisis petunjuk dulu!");
    return true;
  }

  const rawTarget = args[1] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.participant;

  const resolvedTarget = resolveTargetInSession(session, rawTarget);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tembakan tidak valid atau sudah mati!\n👉 *Format:* \`.tembak @member\` atau nomor urut \`.tembak [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa menembak diri sendiri!");
    return true;
  }

  senderRoleData.hasBullet = false;
  const gameJid = session.jid;
  const targetRoleData = getPlayerRoleData(session, resolvedTarget);

  // Perlindungan Guardian menangkis tembakan
  if (session.guardedPlayer && samePlayer(session.guardedPlayer, resolvedTarget)) {
    session.guardedPlayer = null;
    saveUndercoverSessions();
    await send(sock, gameJid, null,
`🛡️ *SERANGAN DIGAGALKAN OLEH GUARDIAN!* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seseorang melepaskan tembakan ke arah ${tag(resolvedTarget)}, namun Bodyguard berhasil menangkisnya!
${tag(resolvedTarget)} **SELAMAT DARI MAUT**!`, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🛡️ Tembakan Anda ke ${tag(resolvedTarget)} digagalkan oleh perlindungan Guardian!`, { mentions: [resolvedTarget] });
    }
    return true;
  }

  let killInfo = { idx: -1, wasCurrent: false };
  let victim = null;

  if (senderRoleData.role === 'SHERIFF') {
    const isEnemy = targetRoleData ? (isUndercoverRole(targetRoleData.role) || isNeutralRole(targetRoleData.role)) : false;

    if (isEnemy) {
      victim = resolvedTarget;
      killInfo = killPlayer(session, resolvedTarget, { byShoot: true });
      try { await db.bumpUndercoverCounter(resolvedSender, 'sheriff_kills'); } catch (e) {}
      await send(sock, gameJid, null,
`💥 *DORRR! TEMBAKAN REVOLVER SHERIFF!* 🤠🔫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff ${tag(resolvedSender)} melepaskan tembakan ke arah ${tag(resolvedTarget)}!
☠️ ${tag(resolvedTarget)} **TEWAS DI TEMPAT** tanpa perlu voting!
🎭 Peran Terbuka: *${getRoleBadge(targetRoleData?.role)}*`, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `🎯 Tembakan Anda berhasil! ${tag(resolvedTarget)} (${getRoleBadge(targetRoleData?.role)}) telah tewas!`, { mentions: [resolvedTarget] });
      }
    } else {
      victim = resolvedSender;
      killInfo = killPlayer(session, resolvedSender, { byShoot: true });
      await send(sock, gameJid, null,
`💥 *DORRR! TRAGEDI SALAH TEMBAK!* 🤠💀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff ${tag(resolvedSender)} melepaskan tembakan ke arah Warga ${tag(resolvedTarget)}!
☠️ Menyadari dirinya menembak warga tak bersalah, ${tag(resolvedSender)} **TEWAS DI TEMPAT (SUICIDE)**!
🧑‍🌾 ${tag(resolvedTarget)} selamat tanpa luka!`, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `💀 Anda salah menembak warga sipil! Anda tewas seketika karena rasa bersalah!`);
      }
    }
  } else {
    victim = resolvedTarget;
    killInfo = killPlayer(session, resolvedTarget, { byShoot: true });
    try { await db.bumpUndercoverCounter(resolvedSender, 'assassin_kills'); } catch (e) {}
    await send(sock, gameJid, null,
`🩸 *PEMBUNUHAN RAHASIA DI MALAM HARI!* 🗡️🩸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Terdengar suara letupan sniper senyap di kejauhan...
☠️ ${tag(resolvedTarget)} **DITEMUKAN TEWAS** dibunuh Assassin!
🎭 Peran Terbuka: *${getRoleBadge(targetRoleData?.role)}*`, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🗡️ Target ${tag(resolvedTarget)} (${getRoleBadge(targetRoleData?.role)}) berhasil Anda bunuh!`, { mentions: [resolvedTarget] });
    }
  }

  saveUndercoverSessions();
  if (victim) await sendDeathIntel(sock, session, victim, 'tewas tertembak');

  const isGameOver = await checkUndercoverWinCondition(sock, gameJid);
  if (isGameOver) return true;

  await resyncAfterDeath(sock, gameJid, killInfo);
  return true;
}

// ─── 🃏 POWER CARDS SHOP (.undercover card) ──────────────────────────
// Setiap pembelian dicatat agar bisa dikembalikan kalau sesi dibatalkan.
async function chargeCard(session, buyer, price) {
  await db.deductGamePoints(buyer, price);
  if (!Array.isArray(session.cardPurchases)) session.cardPurchases = [];
  session.cardPurchases.push({ jid: buyer, price });
}

async function handleUndercoverCardShop(sock, jid, senderNumber, messageObj, args) {
  const session = activeUndercoverGames.get(jid);
  const cardType = (args[2] || '').toLowerCase();
  const ref = session || { buyIn: 30 };

  const shopGuide =
`🃏 *TOKO KARTU AKSI UNDERCOVER (POWER CARDS)* ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *ATURAN BARU:* Maksimal *1 kartu per pemain per game*, dan harga mengikuti taruhan lobi.

*KARTU PRA-GAME* (wajib dibeli saat masih di LOBI):
1. 🛡️ *Rompi Anti-Peluru (Shield)* — *${cardPrice(ref, CARD_DEFS.shield)} Poin*
   • Kebal dari 1x eliminasi voting grup.
   • Beli: \`.undercover card shield\`

2. 🌟 *Golden Vote (Double Suara)* — *${cardPrice(ref, CARD_DEFS.gold)} Poin*
   • Suara votingmu dihitung **2 suara**.
   • Beli: \`.undercover card gold\`

*KARTU DALAM PERMAINAN* (fase petunjuk/diskusi, TIDAK saat voting):
3. 🤐 *Kartu Lakban (Silence)* — *${cardPrice(ref, CARD_DEFS.silence)} Poin*
   • Target hanya boleh memberi petunjuk **1 KATA** di ronde BERIKUTNYA.
   • Beli: \`.undercover card silence @target\`

4. 🔮 *Radar Sensor (Clue Spy)* — *${cardPrice(ref, CARD_DEFS.radar)} Poin*
   • (Khusus kubu Penyamar / Mr. White) Bocoran kategori & huruf depan kata warga via DM.
   • Beli: \`.undercover card radar\`

💡 _Kartu Shield & Golden Vote sengaja dikunci di lobi supaya tidak bisa dibeli mendadak saat kamu hampir dieksekusi._`;

  if (!cardType) {
    await send(sock, jid, messageObj, shopGuide);
    return true;
  }

  const def = CARD_DEFS[cardType];
  if (!def) {
    await send(sock, jid, messageObj, shopGuide);
    return true;
  }

  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover di grup ini. Buka lobi dulu dengan `.undercover [taruhan]`!");
    return true;
  }

  const buyer = session.players.find(p => samePlayer(p, senderNumber));
  if (!buyer) {
    await send(sock, jid, messageObj, "❌ Kamu bukan peserta sesi Undercover ini!");
    return true;
  }

  if (def.phase === 'LOBBY' && session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, `❌ *${def.name}* hanya bisa dibeli saat masih di LOBI (sebelum game dimulai)!`);
    return true;
  }

  if (def.phase === 'GAME' && !['CLUE_PHASE', 'DISCUSSION_PHASE'].includes(session.status)) {
    await send(sock, jid, messageObj, `❌ *${def.name}* hanya bisa dibeli saat fase petunjuk atau diskusi — tidak saat fase voting!`);
    return true;
  }

  if (session.status !== 'LOBBY' && !isAlive(session, buyer)) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur tidak bisa membeli kartu aksi!");
    return true;
  }

  if (session.cardOwners?.has(buyer)) {
    await send(sock, jid, messageObj, "❌ *Batas 1 kartu per pemain!* Kamu sudah membeli kartu aksi di game ini.");
    return true;
  }

  const price = cardPrice(session, def);
  const prof = await db.getGameProfile(buyer);
  if ((prof?.points || 0) < price) {
    await send(sock, jid, messageObj, `❌ Poin tidak cukup! Butuh *${price} Poin* untuk ${def.name}.`);
    return true;
  }

  if (cardType === 'silence') {
    const rawTarget = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[3];
    const resolvedTarget = resolveTargetInSession(session, rawTarget);
    if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
      await send(sock, jid, messageObj, `⚠️ Tentukan target lakban yang masih hidup!\n👉 Format: \`.undercover card silence @target\` atau \`.undercover card silence [1-${session.alivePlayers.length}]\``);
      return true;
    }
    if (samePlayer(resolvedTarget, buyer)) {
      await send(sock, jid, messageObj, "⚠️ Tidak bisa melakban diri sendiri!");
      return true;
    }
    await chargeCard(session, buyer, price);
    session.cardOwners.add(buyer);
    session.pendingSilence.add(resolvedTarget);
    saveUndercoverSessions();
    await send(sock, jid, messageObj, `🤐 ${tag(buyer)} melakban ${tag(resolvedTarget)} dengan *Kartu Lakban* (-${price} Poin)!\n📌 Efek aktif *mulai Ronde ${session.round + 1}*: korban hanya boleh menulis *1 KATA*.`, { mentions: [buyer, resolvedTarget] });
    return true;
  }

  if (cardType === 'radar') {
    const roleData = getPlayerRoleData(session, buyer);
    if (!roleData || (!isUndercoverRole(roleData.role) && roleData.role !== 'MRWHITE')) {
      await send(sock, jid, messageObj, "❌ Kartu Radar hanya bisa digunakan oleh kubu Penyamar atau Mr. White!");
      return true;
    }
    await chargeCard(session, buyer, price);
    session.cardOwners.add(buyer);
    saveUndercoverSessions();
    const civWord = session.pair.civilian;
    await dm(sock, buyer, `🔮 *RADAR SENSOR AKTIF!* 📡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷️ Kategori Kata Warga: *${session.pair.category}*\n🔤 Huruf Depan: *"${civWord.charAt(0).toUpperCase()}"*\n📏 Panjang Kata: *${civWord.length} karakter*\n\n_Gunakan bocoran ini untuk mengecoh mereka!_`);
    await send(sock, jid, messageObj, `🔮 ${tag(buyer)} mengaktifkan *Radar Sensor* (-${price} Poin). Info rahasia dikirim ke DM!`, { mentions: [buyer] });
    return true;
  }

  await chargeCard(session, buyer, price);
  session.cardOwners.add(buyer);

  if (cardType === 'shield') {
    session.shieldedPlayers.add(buyer);
    await send(sock, jid, messageObj, `🛡️ ${tag(buyer)} membeli *Rompi Anti-Peluru* (-${price} Poin)! Kebal dari 1x eksekusi voting sepanjang game.`, { mentions: [buyer] });
  } else {
    session.goldenVoters.add(buyer);
    await send(sock, jid, messageObj, `🌟 ${tag(buyer)} membeli *Golden Vote* (-${price} Poin)! Suaranya bernilai 2x di setiap fase voting.`, { mentions: [buyer] });
  }
  saveUndercoverSessions();
  return true;
}

// ─── 📊 STATISTIK & PAPAN PERINGKAT ──────────────────────────────────
function winRateText(won, played) {
  if (!played) return '0%';
  return `${Math.round((won / played) * 100)}%`;
}

function agentTitle(stats) {
  const played = stats.games_played || 0;
  const won = stats.games_won || 0;
  if (played < 5) return '🥚 Agen Magang';
  const rate = won / played;
  if (rate >= 0.7) return '👑 Legenda Undercover';
  if (rate >= 0.55) return '🎖️ Agen Elite';
  if (rate >= 0.4) return '🕵️ Agen Lapangan';
  return '🧑‍🌾 Warga Biasa';
}

async function showUndercoverStats(sock, jid, senderNumber, messageObj) {
  const cust = await db.getCustomerByPhone(senderNumber);
  const name = cust?.nama || tag(senderNumber);
  const prof = await db.getGameProfile(senderNumber);

  let s;
  try {
    s = await db.getUndercoverStats(senderNumber);
  } catch (e) {
    s = null;
  }

  if (!s || !s.games_played) {
    await send(sock, jid, messageObj, `🕵️ *PROFIL AGEN UNDERCOVER* 🎭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Agen: *${name}*\n💰 Akbar Poin: *${(prof?.points || 0).toLocaleString('id-ID')}*\n\n📊 Kamu belum pernah menyelesaikan satu game Undercover pun!\n👉 Ketik \`.undercover\` di grup untuk membuka lobi dan mulai mencatat statistik.`, { mentions: [senderNumber] });
    return true;
  }

  const statsMsg =
`🕵️ *PROFIL & STATISTIK AGEN UNDERCOVER* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Agen: *${name}*
🎖️ Gelar: *${agentTitle(s)}*
💰 Akbar Poin: *${(prof?.points || 0).toLocaleString('id-ID')}*
⭐ Rank Level: *Level ${prof?.level || 1}* (${prof?.xp || 0} XP)

📊 *REKAM JEJAK PERTANDINGAN:*
🎮 Total Main: *${s.games_played}x*
🏆 Total Menang: *${s.games_won}x* (Win Rate: *${winRateText(s.games_won, s.games_played)}*)
🔥 Streak Menang: *${s.win_streak}* (Rekor Terbaik: *${s.best_streak}*)
💵 Total Poin Dimenangkan: *${(s.points_won || 0).toLocaleString('id-ID')}*

🎭 *PERFORMA PER KUBU:*
🛡️ Warga: *${s.wins_civilian}/${s.times_civilian}* (${winRateText(s.wins_civilian, s.times_civilian)})
🕵️ Penyamar: *${s.wins_impostor}/${s.times_impostor}* (${winRateText(s.wins_impostor, s.times_impostor)})
🎲 Netral: *${s.wins_neutral}/${s.times_neutral}* (${winRateText(s.wins_neutral, s.times_neutral)})

⚡ *AKSI SPESIAL:*
🤍 Tebakan Mr. White Tepat: *${s.mrwhite_guess_win}x*
🤡 Kemenangan Si Badut: *${s.jester_win}x*
🤠 Eksekusi Sheriff Tepat: *${s.sheriff_kills}x*
🗡️ Pembunuhan Assassin: *${s.assassin_kills}x*
🔍 Intel Detektif Akurat: *${s.detective_correct}x*

👉 Ketik \`.undercover top\` untuk melihat papan peringkat!`;

  await send(sock, jid, messageObj, statsMsg, { mentions: [senderNumber] });
  return true;
}

async function showUndercoverLeaderboard(sock, jid, messageObj) {
  let rows = [];
  try {
    rows = await db.getUndercoverLeaderboard(10);
  } catch (e) {
    rows = [];
  }

  if (!rows || rows.length === 0) {
    await send(sock, jid, messageObj, "📊 *PAPAN PERINGKAT UNDERCOVER*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nBelum ada data pertandingan yang tercatat. Mainkan `.undercover` untuk jadi yang pertama!");
    return true;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const nama = r.customer_nama || `+${String(r.customer_jid).split('@')[0]}`;
    return `${medals[i] || `${i + 1}.`} *${nama}*\n     🏆 ${r.games_won}/${r.games_played} menang (${winRateText(r.games_won, r.games_played)}) | 🔥 Rekor Streak: ${r.best_streak}`;
  }).join('\n');

  await send(sock, jid, messageObj,
`📊 *PAPAN PERINGKAT AGEN UNDERCOVER* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Minimal 3x bermain untuk masuk daftar._

${lines}

👉 Ketik \`.undercover stats\` untuk statistik pribadimu.`);
  return true;
}

// ─── 📖 PANDUAN PERAN ────────────────────────────────────────────────
export async function showUndercoverRoleGuide(sock, jid, messageObj) {
  const guide =
`🎭 *PANDUAN LENGKAP PERAN & ATURAN UNDERCOVER 3.0* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Game deduksi sosial berbasis kata rahasia via DM WhatsApp & diskusi grup (${MIN_PLAYERS}–${MAX_PLAYERS} pemain).

🆕 *YANG BARU DI VERSI 3.0:*
🗳️ *Voting Kategori Kata:* Setelah \`.startundercover\`, semua pemain vote tema kata dulu (\`.vote 1-5\`).
🔁 *Ronde 1 = 2 Putaran Petunjuk:* Semua bicara 2x sebelum voting pertama dibuka.
💬 *Fase Diskusi 30 Detik:* Ada waktu debat sebelum voting (\`.lanjut\` untuk mempercepat).
🔀 *Urutan Bicara Dirotasi:* Pembuka ronde berganti tiap ronde.
👻 *Dead Chat:* Pemain yang gugur menerima bocoran seluruh peran via DM.
🎬 *Rekap Akhir:* Semua peran & petunjuk dibongkar saat game usai.
📊 *Statistik Nyata:* \`.undercover stats\` & \`.undercover top\`.

📜 *SISTEM RONDE:*
👥 *Komposisi:* 1 Penyamar (${MIN_PLAYERS}–5 Pemain) | 2 Penyamar (6–${MAX_PLAYERS} Pemain).
⏱️ *Durasi:* ${Math.round(CLUE_TIMEOUT_MS / 1000)}s Petunjuk (putaran ke-2 & Zona Merah ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s), ${Math.round(DISCUSSION_TIMEOUT_MS / 1000)}s Diskusi, ${Math.round(VOTE_TIMEOUT_MS / 1000)}s Voting.
🚫 *Batas Vote Skip:* Maksimal ${MAX_SKIPS}x per game.
💀 *Zona Merah:* Mulai Ronde 4+ (waktu dipercepat & vote skip dikunci).
⏳ *Batas Ronde:* Maksimal ${MAX_ROUNDS} Ronde.
🏁 *Menang Penyamar:* Jumlah penyamar hidup ≥ jumlah warga hidup. (Mr. White dihitung terpisah!)

👥 *DAFTAR LENGKAP PERAN:*

🛡️ *1. KUBU WARGA:*
▫️ 🧑‍🌾 *Civilian:* Kata asli, cari penyamar lewat analisis petunjuk.
▫️ 🤠 *Koboi / Sheriff:* 1x peluru (\`.tembak\` via DM, *Ronde 2+*). Kena musuh/netral = target mati; salah tembak warga = *kamu* yang mati.
▫️ 🔍 *Detektif Intel:* 1x intip (\`.intip\` via DM, *Ronde 2+*) untuk cek Warga Asli / Bukan Warga.
▫️ 🛡️ *Guardian:* \`.lindung\` via DM tiap ronde. *Tidak boleh diri sendiri*, *tidak boleh target sama 2 ronde beruntun*, dan hangus tiap ganti ronde.
▫️ 🩺 *Dokter Lapangan:* 1x \`.sembuhkan\` via DM untuk menghidupkan korban tembakan (bukan korban voting).

🕵️ *2. KUBU PENYAMAR:*
▫️ 🕵️ *Undercover:* Kata mirip. Punya 1x \`.tukargiliran\` via DM untuk melempar gilirannya ke urutan terakhir.
▫️ 🗡️ *Assassin:* 1x peluru sniper (\`.tembak\` via DM, *Ronde 2+*, khusus 5+ pemain).
▫️ 🗣️ *Framer:* 1x \`.fitnah\` via DM — memanipulasi hasil intip Detektif & +1 suara kutukan.
▫️ 🦹 *Saboteur:* \`.hack\` via DM 1x per ronde (khusus 6+ pemain) untuk mengintip peran target.

🎭 *3. KUBU NETRAL:*
▫️ 🤍 *Mr. White* (5+ pemain): Tanpa kata. \`.tebakwarga <kata>\` kapan saja untuk MENANG SOLO. Salah tebak saat masih hidup = langsung gugur.
▫️ 🤡 *Si Badut (Jester):* Menang solo jika di-vote keluar di *Ronde 2 atau 3*. Jika gagal tapi selamat sampai akhir, taruhan dikembalikan.
▫️ 🦎 *Bunglon:* Ikut menang bersama kubu mana pun asal masih hidup saat game usai.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *PERINTAH UTAMA:*
• \`.undercover [taruhan]\` — Buka lobi (Default 30 Poin)
• \`.joinundercover\` / \`.startundercover\` — Gabung / mulai
• \`.vote [1-5]\` — Vote kategori kata (saat fase pemilihan tema)
• \`.vote [nomor/@member]\` / \`.vote skip\` — Vote eliminasi / abstain
• \`.lanjut\` — Tutup diskusi lebih cepat, buka voting
• \`.skip\` — Lewati giliran petunjuk / abstain
• \`.tembak\`, \`.intip\`, \`.lindung\`, \`.sembuhkan\`, \`.fitnah\`, \`.hack\`, \`.tukargiliran\` — Skill peran via DM
• \`.tebakwarga <kata>\` — Khusus Mr. White
• \`.undercover card\` — Toko Kartu Aksi
• \`.undercover stats\` / \`.undercover top\` — Statistik & peringkat
• \`.undercover cancel\` — Batalkan sesi (khusus host)`;

  await send(sock, jid, messageObj, guide);
  return true;
}

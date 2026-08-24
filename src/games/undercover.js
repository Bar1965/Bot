import fs from 'fs';
import path from 'path';
import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeUndercoverGames = new Map();
const CLUE_TIMEOUT_MS = 25 * 1000; // 25 detik
const VOTE_TIMEOUT_MS = 35 * 1000; // 35 detik
const MAX_ROUNDS = 7; // Batas maksimal 7 ronde
const MAX_SKIPS = 2; // Maksimal 2x vote skip per game

const STATE_FILE = path.join(process.cwd(), 'data', 'undercover_state.json');

export function saveUndercoverSessions() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serialized = [];
    for (const [jid, s] of activeUndercoverGames.entries()) {
      if (s.status === 'LOBBY') continue;
      
      const rolesObj = {};
      for (const [p, r] of s.playerRoles.entries()) {
        rolesObj[p] = {
          ...r,
          cards: r.cards ? Array.from(r.cards) : []
        };
      }

      serialized.push({
        jid,
        buyIn: s.buyIn,
        players: s.players,
        playerLabels: s.playerLabels,
        alivePlayers: s.alivePlayers,
        pair: s.pair,
        round: s.round,
        status: s.status,
        turnIndex: s.turnIndex,
        skipCount: s.skipCount || 0,
        modifier: s.modifier,
        guardedPlayer: s.guardedPlayer || null,
        framedPlayer: s.framedPlayer || null,
        mrWhiteGuessPending: s.mrWhiteGuessPending || null,
        goldenVoters: s.goldenVoters ? Array.from(s.goldenVoters) : [],
        shieldedPlayers: s.shieldedPlayers ? Array.from(s.shieldedPlayers) : [],
        silencedPlayers: s.silencedPlayers ? Array.from(s.silencedPlayers) : [],
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
          cards: new Set(r.cards || [])
        });
      }

      const votesMap = new Map(item.votes || []);
      const goldenSet = new Set(item.goldenVoters || []);
      const shieldSet = new Set(item.shieldedPlayers || []);
      const silenceSet = new Set(item.silencedPlayers || []);

      const session = {
        jid: item.jid,
        buyIn: item.buyIn,
        players: item.players,
        playerLabels: item.playerLabels,
        alivePlayers: item.alivePlayers,
        pair: item.pair,
        round: item.round,
        status: item.status,
        turnIndex: item.turnIndex,
        skipCount: item.skipCount || 0,
        modifier: item.modifier,
        guardedPlayer: item.guardedPlayer,
        framedPlayer: item.framedPlayer,
        mrWhiteGuessPending: item.mrWhiteGuessPending,
        goldenVoters: goldenSet,
        shieldedPlayers: shieldSet,
        silencedPlayers: silenceSet,
        votes: votesMap,
        playerRoles: rolesMap,
        timeout: null
      };

      activeUndercoverGames.set(item.jid, session);

      // Re-arm timer & pulihkan sesi permainan di grup!
      if (session.status === 'CLUE_PHASE') {
        const currentTurn = session.alivePlayers[session.turnIndex] || session.alivePlayers[0];
        const isSuddenDeath = session.round >= 4;
        const turnTimeoutMs = isSuddenDeath ? 15 * 1000 : (session.modifier?.name?.includes('Speed') ? 15 * 1000 : CLUE_TIMEOUT_MS);
        
        await send(sock, item.jid, null, `🔄 *GAME UNDERCOVER DIPULIHKAN DARI UPDATE!* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nPermainan Ronde ${session.round} otomatis dilanjutkan!\n👉 *Giliran Petunjuk:* @${currentTurn.split('@')[0]} (Waktu: ${Math.round(turnTimeoutMs / 1000)}s)\n_Ketik petunjukmu di grup!_`, { mentions: [currentTurn] });
        
        session.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(item.jid)) return;
          const cur = activeUndercoverGames.get(item.jid);
          if (cur.status === 'CLUE_PHASE' && cur.alivePlayers[cur.turnIndex] === currentTurn) {
            const pRole = cur.playerRoles.get(currentTurn);
            if (pRole) pRole.clue = '(Melewatkan giliran / AFK)';
            await send(sock, item.jid, null, `⌛ @${currentTurn.split('@')[0]} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [currentTurn] });
            cur.turnIndex++;
            saveUndercoverSessions();
            if (cur.turnIndex < cur.alivePlayers.length) {
              await advanceClueTurn(sock, item.jid, null);
            } else {
              cur.status = 'VOTING_PHASE';
              cur.votes.clear();
              saveUndercoverSessions();
              let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
              cur.alivePlayers.forEach((p, i) => {
                const roleData = cur.playerRoles.get(p);
                voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue || '-'}"_\n`;
              });
              const isSd = cur.round >= 4;
              voteList += `\n💬 *Diskusikan siapa penyamarnya!*
👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : '• Ketik: \`.vote skip\` untuk **Abstain**'}
⏳ Waktu voting: 35 detik.`;
              await send(sock, item.jid, null, voteList, { mentions: cur.alivePlayers });
            }
          }
        }, turnTimeoutMs);
      } else if (session.status === 'VOTING_PHASE') {
        const isSd = session.round >= 4;
        let voteList = `🔄 *GAME UNDERCOVER DIPULIHKAN (FASE VOTING)!* 🗳️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        session.alivePlayers.forEach((p, i) => {
          const roleData = session.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue || '-'}"_\n`;
        });
        voteList += `\n👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : '• Ketik: \`.vote skip\` untuk **Abstain**'}
⏳ Waktu voting: 35 detik.`;
        await send(sock, item.jid, null, voteList, { mentions: session.alivePlayers });

        session.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(item.jid)) return;
          const cur = activeUndercoverGames.get(item.jid);
          if (cur.status === 'VOTING_PHASE') {
            await processUndercoverVotes(sock, item.jid, null);
          }
        }, VOTE_TIMEOUT_MS);
      }
    }
  } catch (err) {
    console.error('[UNDERCOVER] Gagal memulihkan state game:', err.message);
  }
}

// Database Pasangan Kata Super Relatable, Meme, Gaming & Pop Culture (100+ Pasangan Kata)
const WORD_PAIRS = [
  // 🍜 Kuliner, Jajanan & Minuman
  { civilian: 'INDOMIE', undercover: 'MIE SEDAAP', category: '🍜 Kuliner / Mie Instan' },
  { civilian: 'MIE GACOAN', undercover: 'MIE JEBEW', category: '🌶️ Kuliner Mie Pedas' },
  { civilian: 'NASI PADANG', undercover: 'NASI UDUK', category: '🍛 Masakan Tradisional' },
  { civilian: 'KOPI SUSU', undercover: 'BOBA MILK', category: '🧋 Minuman Kekinian' },
  { civilian: 'TAHU BULAT', undercover: 'CIRENG', category: '🥟 Jajanan Gorengan' },
  { civilian: 'MARTABAK MANIS', undercover: 'TERANG BULAN', category: '🥞 Makanan Manis' },
  { civilian: 'AYAM GEPREK', undercover: 'AYAM PENYET', category: '🍗 Olahan Ayam Pedas' },
  { civilian: 'ES TEH MANIS', undercover: 'ES JERUK', category: '🍹 Minuman Warung' },
  { civilian: 'BAKSO', undercover: 'MIE AYAM', category: '🍲 Makanan Berkuah' },
  { civilian: 'SATE MADURA', undercover: 'SATE PADANG', category: '🍢 Kuliner Sate' },
  { civilian: 'RENDANG', undercover: 'GULAI', category: '🥘 Masakan Daging Padang' },
  { civilian: 'SEBLAK', undercover: 'BASO ACI', category: '🌶️ Jajanan Pedas Bandung' },
  { civilian: 'PECEL LELE', undercover: 'BEBEK GORENG', category: '🍱 Kuliner Kaki Lima' },
  { civilian: 'ES KRIM', undercover: 'COKELAT', category: '🍦 Makanan Penutup' },
  { civilian: 'PIZZA', undercover: 'BURGER', category: '🍔 Fast Food Barat' },
  { civilian: 'ROTI BAKAR', undercover: 'PISANG GORENG', category: '🍞 Camilan Malam' },
  { civilian: 'RICHEESE FACTORY', undercover: 'KFC', category: '🍗 Restoran Cepat Saji' },
  { civilian: 'BATAGOR', undercover: 'SIOMAY', category: '🥟 Jajanan Bumbu Kacang' },
  { civilian: 'ES CENDOL', undercover: 'ES DAWET', category: '🍧 Minuman Tradisional Segar' },
  { civilian: 'AQUA', undercover: 'LE MINERALE', category: '💧 Air Mineral Kemasan' },
  { civilian: 'KERUPUK PUTIH', undercover: 'KERUPUK KULIT', category: '🥢 Kerupuk Pelengkap' },
  { civilian: 'SOP KAKI KAMBING', undercover: 'TONGSENG', category: '🍲 Masakan Olahan Kambing' },
  { civilian: 'KEBAB', undercover: 'SHAWARMA', category: '🌯 Kuliner Khas Timur Tengah' },
  { civilian: 'MIXUE', undercover: 'MOMOYO', category: '🍦 Gerai Es Krim Viral' },

  // 🎮 Gaming, Hiburan & Pop Culture
  { civilian: 'MOBILE LEGENDS', undercover: 'FREE FIRE', category: '🎮 Game Mobile Populer' },
  { civilian: 'VALORANT', undercover: 'CS:GO (COUNTER-STRIKE)', category: '🔫 Game Tactical FPS PC' },
  { civilian: 'GENSHIN IMPACT', undercover: 'HONKAI STAR RAIL', category: '✨ Game Gacha Anime' },
  { civilian: 'PLAYSTATION', undercover: 'XBOX', category: '🎮 Konsol Game Rumah' },
  { civilian: 'MINECRAFT', undercover: 'ROBLOX', category: '🧱 Game Sandbox Dunia Kreatif' },
  { civilian: 'GTA V', undercover: 'CYBERPUNK 2077', category: '🌆 Game Open World' },
  { civilian: 'NETFLIX', undercover: 'YOUTUBE PREMIUM', category: '🎬 Layanan Streaming Video' },
  { civilian: 'SPOTIFY', undercover: 'APPLE MUSIC', category: '🎵 Layanan Musik Streaming' },
  { civilian: 'DRAKOR', undercover: 'ANIME', category: '📺 Serial Tontonan Favorit' },
  { civilian: 'BIOSKOP', undercover: 'HOME THEATER', category: '🍿 Tempat Nonton Film' },
  { civilian: 'CONAN EDOGAWA', undercover: 'SHERLOCK HOLMES', category: '🕵️ Karakter Detektif Terkenal' },
  { civilian: 'NARUTO', undercover: 'SASUKE', category: '🍥 Karakter Ninja Anime' },
  { civilian: 'DORAEMON', undercover: 'SHINCHAN', category: '🐱 Serial Kartun Masa Kecil' },

  // 🏠 Kehidupan, Romansa & Budaya Modern
  { civilian: 'KOSAN', undercover: 'KONTRAKAN', category: '🏠 Tempat Tinggal Sewa' },
  { civilian: 'SKRIPSI', undercover: 'TUGAS AKHIR', category: '🎓 Perjuangan Mahasiswa Akhir' },
  { civilian: 'DOSEN PEMBIMBING', undercover: 'HRD KANTOR', category: '👔 Sosok Penguji Karir' },
  { civilian: 'MANTAN', undercover: 'GEBETAN', category: '💔 Hubungan Asmara' },
  { civilian: 'PACARAN', undercover: 'HTS (HUBUNGAN TANPA STATUS)', category: '💘 Status Percintaan' },
  { civilian: 'DATING APP', undercover: 'KENALAN DI DM IG', category: '📱 Cara Mencari Jodoh Online' },
  { civilian: 'KONDANGAN', undercover: 'REUNI SEKOLAH', category: '👗 Acara Kumpul Formal' },
  { civilian: 'BEGADANG', undercover: 'OVERTHINKING', category: '🌙 Kebiasaan Larut Malam' },
  { civilian: 'PINJOL', undercover: 'PAYLATER', category: '💳 Hutang Digital Cepat' },
  { civilian: 'GAJI UMR', undercover: 'FREELANCE', category: '💵 Sumber Penghasilan Kerja' },
  { civilian: 'THR', undercover: 'BONUS TAHUNAN', category: '🎁 Rezeki Finansial Tambahan' },
  { civilian: 'WARKOP', undercover: 'KAFE AESTHETIC', category: '☕ Tempat Nongkrong Santai' },
  { civilian: 'SHOPEE', undercover: 'TOKOPEDIA', category: '🛍️ E-Commerce Belanja Online' },
  { civilian: 'INDOMARET', undercover: 'ALFAMART', category: '🏪 Jaringan Minimarket' },
  { civilian: 'WHATSAPP', undercover: 'TELEGRAM', category: '💬 Aplikasi Pesan Singkat' },
  { civilian: 'INSTAGRAM', undercover: 'TIKTOK', category: '📱 Media Sosial Konten Video' },
  { civilian: 'OJEK ONLINE', undercover: 'TAKSI', category: '🛵 Transportasi Umum Perjalanan' },
  { civilian: 'PULANG KAMPUNG', undercover: 'LIBURAN', category: '🧳 Perjalanan Jarak Jauh' },
  { civilian: 'KRL', undercover: 'MRT', category: '🚆 Transportasi Kereta Cepat' },
  { civilian: 'KARCIS PARKIR', undercover: 'HELM HILANG', category: '🛵 Derita Parkir Motor' },
  { civilian: 'SATPOL PP', undercover: 'PEDAGANG KAKI LIMA', category: '👮 Drama Jalanan' },
  { civilian: 'STNK', undercover: 'BPKB', category: '📄 Dokumen Kepemilikan Kendaraan' },
  { civilian: 'IPHONE', undercover: 'HP ANDROID', category: '📱 Perangkat Smartphone' },

  // 🐾 Hewan, Alam, Profesi & Benda
  { civilian: 'KUCING', undercover: 'HARIMAU', category: '🐾 Keluarga Hewan Kucing' },
  { civilian: 'SINGA', undercover: 'SERIGALA', category: '🐺 Predator Buas Liar' },
  { civilian: 'PESAWAT', undercover: 'HELIKOPTER', category: '✈️ Transportasi Angkutan Udara' },
  { civilian: 'PANTAI', undercover: 'GUNUNG', category: '🏞️ Destinasi Liburan Alam' },
  { civilian: 'GITAR', undercover: 'BIOLA', category: '🎻 Alat Musik Senar' },
  { civilian: 'MOBIL', undercover: 'MOTOR', category: '🚗 Kendaraan Bermotor Jalan Raya' },
  { civilian: 'BANTAL', undercover: 'GULING', category: '🛏️ Perlengkapan Tidur Nyenyak' },
  { civilian: 'KACAMATA', undercover: 'LENSA KONTAK', category: '👓 Alat Bantu Penglihatan' },
  { civilian: 'DOMPET', undercover: 'REKENING BANK', category: '💳 Tempat Simpan Saldo Uang' },
  { civilian: 'DOKTER', undercover: 'PERAWAT', category: '🏥 Profesi Medis Rumah Sakit' },
  { civilian: 'POLISI', undercover: 'SATPAM', category: '👮 Petugas Keamanan' },
  { civilian: 'PENSIL', undercover: 'PULPEN', category: '✏️ Alat Tulis Kantor' },
  { civilian: 'SUPERMARKET', undercover: 'PASAR TRADISIONAL', category: '🛒 Tempat Belanja Belanjaan' },
  { civilian: 'PAYUNG', undercover: 'JAS HUJAN', category: '🌧️ Perlengkapan Musim Hujan' },
  { civilian: 'JAM TANGAN', undercover: 'JAM DINDING', category: '⏱️ Alat Penunjuk Waktu' },
  { civilian: 'LAPTOP', undercover: 'KOMPUTER PC', category: '💻 Perangkat Komputasi Kerja' },
  { civilian: 'SEPATU FUTSAL', undercover: 'SEPATU BOLA', category: '⚽ Perlengkapan Olahraga Sepakbola' }
];

// Chaos Modifier / Tantangan Ronde Unik
const ROUND_MODIFIERS = [
  { name: 'Normal Clue', desc: 'Bebas memberikan petunjuk seperti biasa.' },
  { name: 'Tantangan 3 Kata 🤐', desc: 'Petunjuk HANYA boleh terdiri dari maksimal 3 KATA!' },
  { name: 'Gaya Sales Marketing 📢', desc: 'Beri petunjuk seolah-olah kamu sedang promosi/jualan produk!' },
  { name: 'Tantangan Emosional 🎭', desc: 'Beri petunjuk dengan nada dramatis / marah / terkejut!' },
  { name: 'Dilarang Pakai Kata Sifat 🚫', desc: 'Petunjuk tidak boleh menggunakan kata enak/bagus/jelek/besar/kecil!' },
  { name: 'Speed Clue ⚡', desc: 'Waktu giliran menjawab dipercepat jadi 20 detik!' }
];

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

  if (['stats', 'profil', 'stat'].includes(subCmd)) {
    return await showUndercoverStats(sock, jid, senderNumber, messageObj);
  }

  if (['join', 'ikut'].includes(subCmd) || command === 'joinundercover') {
    return await joinUndercoverLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'startgame'].includes(subCmd) || command === 'startundercover') {
    return await startUndercoverGame(sock, jid, senderNumber, messageObj);
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
    if (session.host !== senderNumber) {
      await send(sock, jid, messageObj, "❌ Hanya pembuat lobi yang dapat membatalkan game!");
      return true;
    }
    if (session.timeout) clearTimeout(session.timeout);
    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    await send(sock, jid, messageObj, "🛑 Permainan Undercover berhasil dibatalkan.");
    return true;
  }

  if (activeUndercoverGames.has(jid)) {
    const s = activeUndercoverGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Undercover aktif di grup ini!\n👥 Pemain (${s.players.length}/8): ${s.playerLabels.join(', ')}\n\nKetik \`.joinundercover\` untuk ikut atau \`.startundercover\` untuk mulai!`);
    } else {
      await send(sock, jid, messageObj, `⚠️ Permainan Undercover sedang berlangsung di grup ini!`);
    }
    return true;
  }

  const buyIn = parseInt(args[1], 10) || 30;
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka lobi.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    round: 0,
    pair: null,
    modifier: null,
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerRoles: new Map(), // jid -> { role: 'CIVILIAN'|'UNDERCOVER'|'MRWHITE'|'JESTER'|'DETECTIVE', word: string, isAlive: boolean, clue: string, cards: Set }
    turnIndex: 0,
    alivePlayers: [],
    votes: new Map(),
    mrWhiteGuessPending: null,
    detectiveChecksThisRound: new Set(),
    silencedPlayers: new Set(), // jid -> max 1 word
    shieldedPlayers: new Set(), // jid -> immune 1 vote death
    goldenVoters: new Set(), // jid -> vote count = 2
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    if (!activeUndercoverGames.has(jid)) return;
    const cur = activeUndercoverGames.get(jid);
    if (cur.status === 'LOBBY') {
      activeUndercoverGames.delete(jid);
      saveUndercoverSessions();
      await send(sock, jid, messageObj, `⌛ *LOBI UNDERCOVER KEDALUWARSA!* Game dibatalkan karena tidak dimulai dalam 90 detik.`);
    }
  }, 90 * 1000);

  activeUndercoverGames.set(jid, session);

  const lobbyMsg = 
`🕵️ *LOBBY UNDERCOVER ULTRA 2.0 — SOCIAL DEDUCTION* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host:* ${hostLabel}
👥 *Pemain (1/8):* ${hostLabel}
💰 *Taruhan:* *${buyIn} Poin* / orang

🎭 *Daftar Peran Rahasia (Diacak via DM WhatsApp):*
▫️ 🧑‍🌾 *Civilian (Warga)*: Mendapat kata asli.
▫️ 🕵️ *Undercover (Penyamar)*: Mendapat kata mirip tapi berbeda!
▫️ 🤍 *Mr. White (Blank)*: Tidak dapat kata, pura-pura tahu!
▫️ 🤡 *Si Badut (Jester)* (5+ Pemain): Ingin di-vote keluar untuk menang solo!
▫️ 🔍 *Detektif Intel* (6+ Pemain): Bisa DM bot \`.intip @member\` untuk lacak penyamar!

🃏 *Power Cards Shop:* Ketik \`.undercover card\` untuk melihat kartu aksi khusus!

👉 Ketik \`.joinundercover\` untuk bergabung!
🚀 Host ketik \`.startundercover\` jika sudah siap (Minimal 3 pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

async function joinUndercoverLobby(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Undercover aktif. Ketik `.undercover [taruhan]` untuk membuka game baru!");
    return true;
  }

  if (session.players.includes(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di dalam lobi Undercover ini!");
    return true;
  }

  if (session.players.length >= 8) {
    await send(sock, jid, messageObj, "❌ Lobi sudah penuh (Maksimal 8 pemain)!");
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Butuh *${session.buyIn} Poin* untuk bergabung.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  session.players.push(senderNumber);
  session.playerLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil bergabung ke game Undercover!\n👥 Total Pemain (${session.players.length}/8): ${session.playerLabels.join(', ')}\n\nKetik \`.startundercover\` jika sudah siap!`, { mentions: session.players });
  return true;
}

async function startUndercoverGame(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.length < 3) {
    await send(sock, jid, messageObj, "❌ Butuh minimal *3 pemain* untuk memulai game Undercover!");
    return true;
  }

  if (session.timeout) clearTimeout(session.timeout);

  for (const p of session.players) {
    await db.deductGamePoints(p, session.buyIn);
  }

  // Pilih pasangan kata acak dari 100+ kata
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  session.pair = pair;

  // Acak pemain untuk pembagian peran dinamis
  const shuffled = [...session.players].sort(() => 0.5 - Math.random());
  session.alivePlayers = [...shuffled];

  const count = shuffled.length;
  // 1. IMPOSTOR / UNDERCOVER ROLE (Selalu 1 orang, index 0, diacak dari pool Impostor)
  const undercoverJid = shuffled[0];
  const underPool = ['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR'];
  const undercoverRole = underPool[Math.floor(Math.random() * underPool.length)];

  // 2. NETRAL ROLE (Index 1 jika count >= 4, diacak dari pool Netral)
  let neutralJid1 = null;
  let neutralRole1 = null;
  let neutralJid2 = null;
  let neutralRole2 = null;

  const neutralPool = ['MRWHITE', 'JESTER', 'BUNGLON'];
  if (count === 4) {
    neutralJid1 = shuffled[1];
    neutralRole1 = 'MRWHITE';
  } else if (count === 5) {
    neutralJid1 = shuffled[1];
    neutralRole1 = neutralPool[Math.floor(Math.random() * neutralPool.length)];
  } else if (count >= 6) {
    neutralJid1 = shuffled[1];
    neutralRole1 = 'MRWHITE';
    neutralJid2 = shuffled[2];
    const remNeutral = neutralPool.filter(r => r !== 'MRWHITE');
    neutralRole2 = remNeutral[Math.floor(Math.random() * remNeutral.length)];
  }

  // 3. WARGA SPESIAL (Diacak dari pool Special Civilians: SHERIFF, DETECTIVE, GUARDIAN)
  const specialCivPool = ['SHERIFF', 'DETECTIVE', 'GUARDIAN'].sort(() => 0.5 - Math.random());
  
  // Warga Spesial 1 (jika count >= 5)
  const specialCivJid1 = count >= 5 ? (count >= 6 ? shuffled[3] : shuffled[2]) : null;
  const specialCivRole1 = count >= 5 ? specialCivPool[0] : null;

  // Warga Spesial 2 (jika count >= 7)
  const specialCivJid2 = count >= 7 ? shuffled[4] : null;
  const specialCivRole2 = count >= 7 ? specialCivPool[1] : null;

  for (const p of shuffled) {
    if (p === undercoverJid) {
      if (undercoverRole === 'ASSASSIN') {
        session.playerRoles.set(p, { role: 'ASSASSIN', word: pair.undercover, isAlive: true, clue: '', hasBullet: true, cards: new Set() });
        try {
          await sock.sendMessage(p, { 
            text: `🗡️ *PERAN ANDA: ASSASSIN (PEMBUNUH BAYARAN)* 🩸\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Khusus:* Anda adalah eksekutor rahasia kubu penyamar!\n🎯 *Sniper Senyap (1x Pakai):*\nKirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`) untuk mengeksekusi musuh tanpa perlu voting!`
          });
        } catch (e) {}
      } else if (undercoverRole === 'FRAMER') {
        session.playerRoles.set(p, { role: 'FRAMER', word: pair.undercover, isAlive: true, clue: '', hasFramed: false, cards: new Set() });
        try {
          await sock.sendMessage(p, { 
            text: `🗣️ *PERAN ANDA: FRAMER (TUKANG FITNAH)* 🎭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Skill Fitnah (1x Pakai via DM):*\nKirim DM ke bot: \`.fitnah @member\` (atau \`.fitnah <nomor>\`)\n\n🎯 *Efek Fitnah:*\n1. Memanipulasi laporan Detektif: Jika target diintip Detektif, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR/IMPOSTOR)**!\n2. Di fase voting ronde ini, target otomatis mendapatkan **+1 Suara Kutukan Tambahan**!`
          });
        } catch (e) {}
      } else if (undercoverRole === 'SABOTEUR') {
        session.playerRoles.set(p, { role: 'SABOTEUR', word: pair.undercover, isAlive: true, clue: '', cards: new Set() });
        try {
          await sock.sendMessage(p, { 
            text: `🦹 *PERAN ANDA: SABOTEUR (PENYABOT INTEL)* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Skill Sabotase:* Tiap ronde Anda bisa meretas peran pemain via DM:\n👉 Ketik: \`.hack @member\` (atau \`.sabotase <nomor>\`) untuk mengintip peran target!`
          });
        } catch (e) {}
      } else {
        // UNDERCOVER STANDAR
        session.playerRoles.set(p, { role: 'UNDERCOVER', word: pair.undercover, isAlive: true, clue: '', hasBullet: true, cards: new Set() });
        try {
          await sock.sendMessage(p, { 
            text: `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang mengecoh agar dikira warga sipil! Jangan sebutkan kata rahasiamu.\n🔫 *Peluru Racun Rahasia (1x Pakai):*\nAnda bisa mengeksekusi 1 pemain tanpa vote!\n👉 Kirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`)`
          });
        } catch (e) {}
      }
    } else if (p === neutralJid1 || p === neutralJid2) {
      const activeNeutralRole = p === neutralJid1 ? neutralRole1 : neutralRole2;
      if (activeNeutralRole === 'MRWHITE') {
        session.playerRoles.set(p, { role: 'MRWHITE', word: '', isAlive: true, clue: '', cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA (BLANK)*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Anda tidak punya kata! Dengarkan petunjuk orang lain, pura-pura tahu!\n💡 *Skill Tebak Kata:* Tebak kata warga kapan saja via DM/grup dengan \`.tebakwarga <kata>\` untuk MENANG SOLO INSTAN! Atau bertahan hidup hingga akhir bersama kubu pemenang.` });
        } catch (e) {}
      } else if (activeNeutralRole === 'JESTER') {
        session.playerRoles.set(p, { role: 'JESTER', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🤡 *PERAN ANDA: SI BADUT (JESTER)* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Gila Anda:* Buat diri Anda DICURIGAI dan DI-VOTE KELUAR oleh grup! Jika Anda berhasil dieliminasi di Ronde 1 atau 2, Anda MENANG SOLO dan mencuri seluruh pot taruhan!` });
        } catch (e) {}
      } else {
        // BUNGLON
        session.playerRoles.set(p, { role: 'BUNGLON', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🦎 *PERAN ANDA: BUNGLON (NETRAL BEBAS)* 🤝\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Bertahan Hidup:* Anda adalah pihak netral yang fleksibel. Triknya jangan sampai tereliminasi/tertembak! Jika kubu mana pun (Warga atau Undercover) menang saat Anda masih HIDUP, Anda IKUT MENANG dan mendapat bagian hadiah pot!` });
        } catch (e) {}
      }
    } else if (p === specialCivJid1 || p === specialCivJid2) {
      const activeSpecialCiv = p === specialCivJid1 ? specialCivRole1 : specialCivRole2;
      if (activeSpecialCiv === 'SHERIFF') {
        session.playerRoles.set(p, { role: 'SHERIFF', word: pair.civilian, isAlive: true, clue: '', hasBullet: true, cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🤠 *PERAN ANDA: KOBOI / SHERIFF (PENEMBAK)* 🔫\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi & Senjata Revolver (1x Pakai):*\nAnda adalah penegak hukum bersenjata warga!\n👉 Kirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`)\n\n🎯 *HUKUM TEMBAKAN:*\n• Jika sasaran adalah **Undercover**, **Mr. White**, atau **Si Badut** ➔ Target **TEWAS SEKETIKA**!\n• 💀 **JIKA SALAH SASARAN** menembak Warga Sipil/Sekutu ➔ **ANDA SENDIRI YANG TEWAS DI TEMPAT (Suicide)** karena rasa bersalah!` });
        } catch (e) {}
      } else if (activeSpecialCiv === 'DETECTIVE') {
        session.playerRoles.set(p, { role: 'DETECTIVE', word: pair.civilian, isAlive: true, clue: '', hasUsedIntel: false, cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🔍 *PERAN ANDA: DETEKTIF INTEL (DETECTIVE)* 🕵️‍♂️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Skill Intel (1x Pakai — Mulai Ronde 2):*\nKirim pesan DM ke bot: \`.intip @member\` (atau \`.intip <nomor>\`) untuk mengetahui apakah target adalah Warga Asli atau Bukan Warga!\n💡 *Catatan:* Skill ini baru terbuka setelah melewati Ronde 1 (Mulai Ronde 2 ke atas).` });
        } catch (e) {}
      } else {
        // GUARDIAN / BODYGUARD
        session.playerRoles.set(p, { role: 'GUARDIAN', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
        try {
          await sock.sendMessage(p, { text: `🛡️ *PERAN ANDA: GUARDIAN (BODYGUARD PELINDUNG)* 🔰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Skill Perlindungan:* Tiap ronde bisa kirim DM ke bot: \`.lindung @member\` (atau \`.guard <nomor>\`). Jika target yang Anda lindungi ditembak atau dieksekusi vote, nyawanya akan SELAMAT dari maut!` });
        } catch (e) {}
      }
    } else {
      session.playerRoles.set(p, { role: 'CIVILIAN', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
      try {
        await sock.sendMessage(p, { text: `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat bagi sesama warga, temukan sang penyamar (Undercover), dan jangan sampai salah vote!` });
      } catch (e) {}
    }
  }

  saveUndercoverSessions();
  await startNextUndercoverRound(sock, jid, messageObj, true);
  return true;
}

export async function handleUndercoverClue(sock, jid, senderNumber, messageObj, text) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return false;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  if (senderNumber !== currentTurnPlayer) return false;

  const cleanClue = text.trim();
  if (cleanClue.length < 2) {
    await send(sock, jid, messageObj, "⚠️ Petunjuk terlalu pendek! Tulis minimal 2 karakter.");
    return true;
  }

  const pRole = session.playerRoles.get(senderNumber);
  if (pRole?.word && cleanClue.toUpperCase().includes(pRole.word)) {
    await send(sock, jid, messageObj, "❌ DILARANG menyebutkan kata rahasia Anda secara langsung dalam petunjuk! Tulis deskripsi/kiasan lain.");
    return true;
  }

  // Cek jika modifier adalah 3 Kata
  if (session.modifier?.name?.includes('3 Kata')) {
    const wordCount = cleanClue.split(/\s+/).length;
    if (wordCount > 3) {
      await send(sock, jid, messageObj, `⚠️ *Tantangan Ronde Ini:* Maksimal hanya boleh *3 kata*! (Petunjukmu: ${wordCount} kata). Coba lagi!`);
      return true;
    }
  }

  pRole.clue = cleanClue;
  if (session.timeout) clearTimeout(session.timeout);

  session.turnIndex++;
  saveUndercoverSessions();

  if (session.turnIndex < session.alivePlayers.length) {
    await advanceClueTurn(sock, jid, messageObj);
    return true;
  } else {
    // Seluruh pemain sudah memberi petunjuk -> Masuk ke FASE VOTING
    session.status = 'VOTING_PHASE';
    session.votes.clear();
    saveUndercoverSessions();

    const isSuddenDeath = session.round >= 4;
    let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    session.alivePlayers.forEach((p, i) => {
      const roleData = session.playerRoles.get(p);
      voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
    });
    voteList += `\n💬 *Diskusikan siapa penyamarnya!*
👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSuddenDeath ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `• Ketik: \`.vote skip\` (atau \`.skip\`) untuk **Abstain** (Sisa Kuota: ${Math.max(0, MAX_SKIPS - (session.skipCount || 0))}/2)`}
⏳ Waktu voting: 35 detik.`;

    session.timeout = setTimeout(async () => {
      if (!activeUndercoverGames.has(jid)) return;
      const cur = activeUndercoverGames.get(jid);
      if (cur.status === 'VOTING_PHASE') {
        await processUndercoverVotes(sock, jid, messageObj);
      }
    }, VOTE_TIMEOUT_MS);

    await send(sock, jid, messageObj, voteList, { mentions: session.alivePlayers });
    return true;
  }
}

async function advanceClueTurn(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  const nextPlayer = session.alivePlayers[session.turnIndex];
  if (!nextPlayer) return;

  const isSuddenDeath = session.round >= 4;
  const turnTimeoutMs = isSuddenDeath ? 15 * 1000 : (session.modifier?.name?.includes('Speed') ? 15 * 1000 : CLUE_TIMEOUT_MS);

  const turnMsg = `✅ Petunjuk diterima!\n\n👉 *Giliran Selanjutnya:* @${nextPlayer.split('@')[0]} (Pemain ${session.turnIndex + 1}/${session.alivePlayers.length})\n⏳ *Waktu:* ${Math.round(turnTimeoutMs / 1000)} Detik\n_Tulis 1 kalimat petunjuk katamu di grup ini! ${isSuddenDeath ? '🚫 (Vote Skip Dikunci)' : '(Atau ketik `.skip` untuk melewati giliran)'}_`;

  session.timeout = setTimeout(async () => {
    if (!activeUndercoverGames.has(jid)) return;
    const cur = activeUndercoverGames.get(jid);
    if (cur.status === 'CLUE_PHASE' && cur.alivePlayers[cur.turnIndex] === nextPlayer) {
      const pRole = cur.playerRoles.get(nextPlayer);
      if (pRole) pRole.clue = '(Melewatkan giliran / AFK)';
      await send(sock, jid, messageObj, `⌛ @${nextPlayer.split('@')[0]} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [nextPlayer] });
      cur.turnIndex++;
      saveUndercoverSessions();
      if (cur.turnIndex < cur.alivePlayers.length) {
        await advanceClueTurn(sock, jid, messageObj);
      } else {
        cur.status = 'VOTING_PHASE';
        cur.votes.clear();
        saveUndercoverSessions();

        const isSd = cur.round >= 4;
        let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        cur.alivePlayers.forEach((p, i) => {
          const roleData = cur.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
        });
        voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` ${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `atau \`.vote skip\` (Abstain, Sisa Kuota: ${Math.max(0, MAX_SKIPS - (cur.skipCount || 0))}/2)`}!\n⏳ Waktu voting: 35 detik.`;
        
        cur.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(jid)) return;
          const cur2 = activeUndercoverGames.get(jid);
          if (cur2.status === 'VOTING_PHASE') {
            await processUndercoverVotes(sock, jid, messageObj);
          }
        }, VOTE_TIMEOUT_MS);

        await send(sock, jid, messageObj, voteList, { mentions: cur.alivePlayers });
      }
    }
  }, turnTimeoutMs);

  await send(sock, jid, messageObj, turnMsg, { mentions: [nextPlayer] });
}

export async function handleUndercoverSkip(sock, jid, senderNumber, messageObj, text = '', isAdmin = false, isOwner = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  // 1. JIKA SEDANG DI FASE PETUNJUK (CLUE_PHASE)
  if (session.status === 'CLUE_PHASE') {
    const currentTurnPlayer = session.alivePlayers[session.turnIndex];
    const isCurrentTurn = senderNumber === currentTurnPlayer || db.isPhoneMatch(senderNumber, currentTurnPlayer);
    const isHost = senderNumber === session.host || db.isPhoneMatch(senderNumber, session.host);
    const isPrivileged = isHost || isAdmin || isOwner;

    if (!session.skipVotes) session.skipVotes = new Set();

    if (isCurrentTurn) {
      // Pemain yang sedang giliran skip sendiri
      const pRole = session.playerRoles.get(currentTurnPlayer);
      if (pRole) pRole.clue = '(Melewatkan giliran / Skip)';
      if (session.timeout) clearTimeout(session.timeout);
      session.skipVotes.clear();

      await send(sock, jid, messageObj, `⏩ @${currentTurnPlayer.split('@')[0]} memilih untuk **MELEWATKAN GILIRAN (SKIP)**! Giliran dialihkan ke pemain berikutnya...`, { mentions: [currentTurnPlayer] });

      session.turnIndex++;
      saveUndercoverSessions();

      if (session.turnIndex < session.alivePlayers.length) {
        await advanceClueTurn(sock, jid, messageObj);
      } else {
        session.status = 'VOTING_PHASE';
        session.votes.clear();
        saveUndercoverSessions();

        const isSd = session.round >= 4;
        let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        session.alivePlayers.forEach((p, i) => {
          const roleData = session.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
        });
        voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` ${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `atau \`.vote skip\` (Abstain, Sisa Kuota: ${Math.max(0, MAX_SKIPS - (session.skipCount || 0))}/2)`}!\n⏳ Waktu voting: 35 detik.`;

        session.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(jid)) return;
          const cur = activeUndercoverGames.get(jid);
          if (cur.status === 'VOTING_PHASE') {
            await processUndercoverVotes(sock, jid, messageObj);
          }
        }, VOTE_TIMEOUT_MS);

        await send(sock, jid, messageObj, voteList, { mentions: session.alivePlayers });
      }
      return true;
    } else if (isPrivileged) {
      // Host / Admin force skip AFK player
      const pRole = session.playerRoles.get(currentTurnPlayer);
      if (pRole) pRole.clue = '(Di-skip oleh Host/Admin)';
      if (session.timeout) clearTimeout(session.timeout);
      session.skipVotes.clear();

      await send(sock, jid, messageObj, `⏩ *FORCE SKIP:* Giliran @${currentTurnPlayer.split('@')[0]} dilewati oleh Host/Admin!`, { mentions: [currentTurnPlayer] });

      session.turnIndex++;
      saveUndercoverSessions();

      if (session.turnIndex < session.alivePlayers.length) {
        await advanceClueTurn(sock, jid, messageObj);
      } else {
        session.status = 'VOTING_PHASE';
        session.votes.clear();
        saveUndercoverSessions();

        const isSd = session.round >= 4;
        let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        session.alivePlayers.forEach((p, i) => {
          const roleData = session.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
        });
        voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` ${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `atau \`.vote skip\` (Abstain, Sisa Kuota: ${Math.max(0, MAX_SKIPS - (session.skipCount || 0))}/2)`}!\n⏳ Waktu voting: 35 detik.`;

        session.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(jid)) return;
          const cur = activeUndercoverGames.get(jid);
          if (cur.status === 'VOTING_PHASE') {
            await processUndercoverVotes(sock, jid, messageObj);
          }
        }, VOTE_TIMEOUT_MS);

        await send(sock, jid, messageObj, voteList, { mentions: session.alivePlayers });
      }
      return true;
    } else if (session.alivePlayers.some(p => p === senderNumber || db.isPhoneMatch(p, senderNumber))) {
      // Vote skip bersama oleh pemain lain
      session.skipVotes.add(senderNumber);
      const needed = Math.min(2, session.alivePlayers.length - 1);
      if (session.skipVotes.size >= needed) {
        const pRole = session.playerRoles.get(currentTurnPlayer);
        if (pRole) pRole.clue = '(Di-skip oleh voting pemain lain)';
        if (session.timeout) clearTimeout(session.timeout);
        session.skipVotes.clear();

        await send(sock, jid, messageObj, `⏩ *VOTE SKIP BERHASIL:* Giliran @${currentTurnPlayer.split('@')[0]} dilewati karena tidak merespons!`, { mentions: [currentTurnPlayer] });

        session.turnIndex++;
        saveUndercoverSessions();

        if (session.turnIndex < session.alivePlayers.length) {
          await advanceClueTurn(sock, jid, messageObj);
        } else {
          session.status = 'VOTING_PHASE';
          session.votes.clear();
          saveUndercoverSessions();

          const isSd = session.round >= 4;
          let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          session.alivePlayers.forEach((p, i) => {
            const roleData = session.playerRoles.get(p);
            voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
          });
          voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` ${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `atau \`.vote skip\` (Abstain, Sisa Kuota: ${Math.max(0, MAX_SKIPS - (session.skipCount || 0))}/2)`}!\n⏳ Waktu voting: 35 detik.`;

          session.timeout = setTimeout(async () => {
            if (!activeUndercoverGames.has(jid)) return;
            const cur = activeUndercoverGames.get(jid);
            if (cur.status === 'VOTING_PHASE') {
              await processUndercoverVotes(sock, jid, messageObj);
            }
          }, VOTE_TIMEOUT_MS);

          await send(sock, jid, messageObj, voteList, { mentions: session.alivePlayers });
        }
      } else {
        await send(sock, jid, messageObj, `🗳️ @${senderNumber.split('@')[0]} mengajukan vote skip untuk @${currentTurnPlayer.split('@')[0]} (${session.skipVotes.size}/${needed} suara diperlukan).`, { mentions: [senderNumber, currentTurnPlayer] });
      }
      return true;
    }
  }

  // 2. JIKA SEDANG DI FASE VOTING (VOTING_PHASE)
  if (session.status === 'VOTING_PHASE') {
    return await handleUndercoverVote(sock, session.jid || jid, senderNumber, messageObj, 'SKIP');
  }

  return false;
}

export async function handleUndercoverVote(sock, jid, senderNumber, messageObj, targetJid) {
  let session = activeUndercoverGames.get(jid);
  if (!session) {
    for (const s of activeUndercoverGames.values()) {
      if (s.playerRoles?.has(senderNumber) || Array.from(s.playerRoles.keys()).some(p => db.isPhoneMatch(p, senderNumber))) {
        session = s;
        break;
      }
    }
  }

  if (!session || session.status !== 'VOTING_PHASE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  const resolvedVoter = session.alivePlayers.find(p => p === senderNumber || db.isPhoneMatch(p, senderNumber));
  if (!resolvedVoter) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur/mati tidak dapat memberikan suara!");
    return true;
  }

  let rawTarget = targetJid ||
    messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj.message?.extendedTextMessage?.contextInfo?.participant;

  const isSkipVote = ['skip', '0', 'lewat', 'abstain', 'pass', 'voteskip'].includes(String(rawTarget || '').trim().toLowerCase());
  let resolvedTarget = null;

  if (isSkipVote) {
    if (session.round >= 4) {
      await send(sock, jid, messageObj, "🚨 *ZONA MERAH (SUDDEN DEATH)!* Mulai Ronde 4, opsi vote skip telah dikunci. Seluruh pemain wajib memilih salah satu tersangka untuk dieksekusi!");
      return true;
    }
    if ((session.skipCount || 0) >= MAX_SKIPS) {
      await send(sock, jid, messageObj, "❌ *KUOTA VOTE SKIP HABIS!* Vote skip hanya dapat digunakan maksimal 2x per game (Sudah terpakai 2/2). Silakan pilih tersangka!");
      return true;
    }
    resolvedTarget = 'SKIP';
  } else if (rawTarget) {
    const parsedNum = parseInt(String(rawTarget).trim(), 10);
    if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= session.alivePlayers.length && !String(rawTarget).includes('@') && String(rawTarget).trim().length <= 2) {
      resolvedTarget = session.alivePlayers[parsedNum - 1];
    } else if (session.alivePlayers.includes(rawTarget)) {
      resolvedTarget = rawTarget;
    } else {
      const targetDigits = String(rawTarget).replace(/\D/g, '');
      if (targetDigits.length >= 4) {
        resolvedTarget = session.alivePlayers.find(p => db.isPhoneMatch(p, targetDigits) || p.replace(/\D/g, '').includes(targetDigits) || targetDigits.includes(p.replace(/\D/g, '')));
      }
    }
  }

  if (!resolvedTarget || (resolvedTarget !== 'SKIP' && !session.alivePlayers.includes(resolvedTarget))) {
    const isSd = session.round >= 4;
    await send(sock, jid, messageObj, `⚠️ Target vote tidak valid atau sudah mati!\n👉 *Cara Vote:* Ketik \`.vote @member\`, nomor urut \`.vote [1-${session.alivePlayers.length}]\`${isSd ? '' : ' atau `.vote skip` (Abstain)'}`);
    return true;
  }

  if (resolvedTarget === resolvedVoter) {
    await send(sock, jid, messageObj, `⚠️ Kamu tidak bisa mem-vote dirimu sendiri! ${session.round >= 4 ? 'Wajib pilih pemain lain!' : 'Jika ingin abstain, ketik `.vote skip`.'}`);
    return true;
  }

  session.votes.set(resolvedVoter, resolvedTarget);
  saveUndercoverSessions();

  const voterPhone = resolvedVoter.split('@')[0];
  const isGolden = session.goldenVoters?.has(resolvedVoter);

  if (resolvedTarget === 'SKIP') {
    await send(sock, session.jid, messageObj, `🗳️ @${voterPhone} memilih untuk **SKIP / ABSTAIN**! ${isGolden ? '🌟 *(Golden Vote x2)*' : ''} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter] });
  } else {
    const targetPhone = resolvedTarget.split('@')[0];
    await send(sock, session.jid, messageObj, `🗳️ @${voterPhone} mem-vote @${targetPhone}! ${isGolden ? '🌟 *(Golden Vote x2)*' : ''} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter, resolvedTarget] });
  }

  if (session.votes.size >= session.alivePlayers.length) {
    if (session.timeout) clearTimeout(session.timeout);
    await processUndercoverVotes(sock, session.jid, messageObj);
  }
  return true;
}

async function processUndercoverVotes(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  const voteCounts = new Map();
  for (const [voter, target] of session.votes.entries()) {
    const weight = session.goldenVoters?.has(voter) ? 2 : 1;
    voteCounts.set(target, (voteCounts.get(target) || 0) + weight);
  }

  // Cek jika ada target yang difitnah oleh Framer (+1 suara kutukan fitnah)
  if (session.framedPlayer && session.alivePlayers.includes(session.framedPlayer)) {
    const cur = voteCounts.get(session.framedPlayer) || 0;
    voteCounts.set(session.framedPlayer, cur + 1);
    await send(sock, jid, messageObj, `🗣️ *JEJAK FITNAH TERBUKTI!* @${session.framedPlayer.split('@')[0]} terkena **+1 Suara Kutukan Tambahan** dari aksi Framer!`, { mentions: [session.framedPlayer] });
    session.framedPlayer = null;
  }

  let maxVotes = 0;
  let eliminated = null;
  let isTie = false;

  for (const [target, count] of voteCounts.entries()) {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = target;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  }

  if (isTie || !eliminated || eliminated === 'SKIP') {
    if (eliminated === 'SKIP') {
      session.skipCount = (session.skipCount || 0) + 1;
    }
    const reasonMsg = eliminated === 'SKIP' 
      ? `⚖️ *HASIL VOTING TERBANYAK ADALAH SKIP / ABSTAIN!* Tidak ada pemain yang dieliminasi ronde ini. (Penggunaan Skip: ${session.skipCount}/2)`
      : `⚖️ *HASIL VOTING SERI / IMBANG!* Tidak ada yang dieliminasi ronde ini.`;
    
    await send(sock, jid, messageObj, `${reasonMsg}\nPermainan dilanjutkan ke ronde berikutnya!`);
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // Cek jika target dilindungi oleh GUARDIAN (Bodyguard)
  if (session.guardedPlayer === eliminated) {
    session.guardedPlayer = null;
    await send(sock, jid, messageObj, `🛡️ *GUARDIAN MENYELAMATKAN DARI EKSEKUSI!* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n@${eliminated.split('@')[0]} seharusnya dieksekusi oleh voting grup, namun Bodyguard/Guardian berhasil melindunginya dari maut! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // Cek jika target memiliki Rompi Anti-Peluru (Shield Card)
  if (session.shieldedPlayers?.has(eliminated)) {
    session.shieldedPlayers.delete(eliminated);
    await send(sock, jid, messageObj, `🛡️ *ROMPI ANTI-PELURU AKTIF!* @${eliminated.split('@')[0]} berhasil selamat dari eksekusi vote berkat Rompi Pelindung! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // Eliminasi pemain
  session.alivePlayers = session.alivePlayers.filter(p => p !== eliminated);
  const eliminatedRole = session.playerRoles.get(eliminated);
  eliminatedRole.isAlive = false;

  const elimPhone = eliminated.split('@')[0];
  const roleName = getRoleBadge(eliminatedRole.role);

  await send(sock, jid, messageObj, `☠️ *@${elimPhone}* resmi dieliminasi dari grup dengan ${maxVotes} suara!\n🎭 Peran Terbuka: *${roleName}*`, { mentions: [eliminated] });
  saveUndercoverSessions();

  // 1. Cek Kemenangan Spesial JESTER (Si Badut Menang Solo jika di-vote di ronde 1 atau 2)
  if (eliminatedRole.role === 'JESTER' && session.round <= 2) {
    const totalPrize = session.buyIn * session.players.length;
    await db.addGamePoints(eliminated, totalPrize);
    await db.addMessageXp(eliminated, 150);

    const jesterWinMsg = 
`🃏 *SI BADUT (JESTER) MENANG SOLO TELAK!* 🤡
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 *PLOT TWIST!* @${elimPhone} berhasil memprovokasi grup agar mem-vote dirinya keluar!
💰 Hadiah Kemenangan Jester: *+${totalPrize.toLocaleString('id-ID')} Poin* & *+150 XP*!

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

_Seluruh pot taruhan disapu bersih oleh Si Badut!_`;

    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    await send(sock, jid, messageObj, jesterWinMsg, { mentions: [eliminated] });
    return;
  }

  // 2. Cek jika Mr. White dieliminasi -> Diberi kesempatan tebak kata warga
  if (eliminatedRole.role === 'MRWHITE') {
    session.status = 'MR_WHITE_GUESS';
    session.mrWhiteGuessPending = eliminated;
    saveUndercoverSessions();
    await send(sock, jid, messageObj, `🤍 *MR. WHITE DIBERI KESEMPATAN TERAKHIR!* 🤍\n@${elimPhone} memiliki 30 detik untuk menebak kata warga sipil!\n👉 Ketik: \`.tebakwarga <kata>\``, { mentions: [eliminated] });

    session.timeout = setTimeout(async () => {
      if (!activeUndercoverGames.has(jid)) return;
      const cur = activeUndercoverGames.get(jid);
      if (cur.status === 'MR_WHITE_GUESS') {
        await send(sock, jid, null, `⏰ Waktu Mr. White habis! Kata warga tidak tertebak.`);
        const isWon = await checkUndercoverWinCondition(sock, jid);
        if (!isWon) {
          await startNextUndercoverRound(sock, jid, null, false);
        }
      }
    }, 30 * 1000);
    return;
  }

  const isWon = await checkUndercoverWinCondition(sock, jid);
  if (!isWon) {
    await startNextUndercoverRound(sock, jid, messageObj, false);
  }
}

export async function handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE' && targetSession.status !== 'MR_WHITE_GUESS')) {
    if (activeUndercoverGames.has(jid)) {
      await send(sock, jid, messageObj, "❌ Hanya Mr. White yang dapat menebak kata warga dengan `.tebakwarga <kata>`!");
      return true;
    }
    return false;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'MRWHITE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Mr. White di game ini!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) && targetSession.mrWhiteGuessPending !== resolvedSender) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan kesempatan menebak kata telah berakhir!");
    return true;
  }

  const gameJid = targetSession.jid;
  const senderPhone = resolvedSender.split('@')[0];

  if (!guess) {
    await send(sock, jid, messageObj, "⚠️ Masukkan kata tebakanmu!\n*Contoh:* `.tebakwarga Kopi`");
    return true;
  }

  if (targetSession.timeout && targetSession.status === 'MR_WHITE_GUESS') {
    clearTimeout(targetSession.timeout);
  }

  const cleanGuess = normalizeAnswer(guess);
  const correctCivWord = normalizeAnswer(targetSession.pair.civilian);

  if (cleanGuess === correctCivWord) {
    const totalPrize = targetSession.buyIn * targetSession.players.length;
    await db.addGamePoints(resolvedSender, totalPrize);
    await db.addMessageXp(resolvedSender, 150);

    const winMsg = 
`🏆 *MR. WHITE BERHASIL MENEBAK KATA WARGA!* 🤍
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 @${senderPhone} menebak: *"${guess}"* (BENAR!)
💰 Mr. White MENANG SOLO & Meraup: *+${totalPrize.toLocaleString('id-ID')} Poin* & *+150 XP*!

💡 Kata Warga: *${targetSession.pair.civilian}*
🤫 Kata Undercover: *${targetSession.pair.undercover}*

_Mr. White menyapu bersih seluruh pot taruhan permainan!_`;

    activeUndercoverGames.delete(gameJid);
    saveUndercoverSessions();
    await send(sock, gameJid, null, winMsg, { mentions: [resolvedSender] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🎉 Tebakan Anda BENAR (*${guess}*)! Anda memenangkan permainan!`);
    }
    return true;
  } else {
    // Tebakan SALAH!
    const failMsg = 
`❌ *TEBAKAN MR. WHITE GAGAL!* 🤍
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
@${senderPhone} mencoba menebak kata warga dengan: *"${guess}"* (SALAH!)`;

    await send(sock, gameJid, null, failMsg, { mentions: [resolvedSender] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `❌ Tebakan Anda (*${guess}*) SALAH!`);
    }

    if (targetSession.status === 'MR_WHITE_GUESS') {
      targetSession.mrWhiteGuessPending = null;
      saveUndercoverSessions();
      const isWon = await checkUndercoverWinCondition(sock, gameJid);
      if (!isWon) {
        await startNextUndercoverRound(sock, gameJid, null, false);
      }
    }
    return true;
  }
}

export function isUndercoverRole(role) {
  return ['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR'].includes(role);
}

export function isCivilianRole(role) {
  return ['CIVILIAN', 'SHERIFF', 'DETECTIVE', 'GUARDIAN'].includes(role);
}

export function isNeutralRole(role) {
  return ['MRWHITE', 'JESTER', 'BUNGLON'].includes(role);
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
    case 'MRWHITE': return '🤍 MR. WHITE (BLANK)';
    case 'JESTER': return '🤡 SI BADUT (JESTER)';
    case 'BUNGLON': return '🦎 BUNGLON (NETRAL)';
    default: return '🧑‍🌾 WARGA SIPIL';
  }
}

export async function checkUndercoverWinCondition(sock, jid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  const aliveUndercover = session.alivePlayers.filter(p => isUndercoverRole(session.playerRoles.get(p)?.role));
  const aliveMrWhite = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'MRWHITE');
  const aliveCivilians = session.alivePlayers.filter(p => isCivilianRole(session.playerRoles.get(p)?.role));
  const aliveBunglon = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'BUNGLON');

  const totalPrize = session.buyIn * session.players.length;

  // 1. Seluruh Penyamar & Mr White Mati -> Warga Sipil (+ Bunglon yang masih hidup) Menang!
  if (aliveUndercover.length === 0 && aliveMrWhite.length === 0) {
    if (session.timeout) clearTimeout(session.timeout);
    const winningCivilians = session.players.filter(p => isCivilianRole(session.playerRoles.get(p)?.role));
    const allWinners = [...winningCivilians, ...aliveBunglon];
    const prizePerWinner = Math.floor(totalPrize / Math.max(1, allWinners.length));

    for (const w of allWinners) {
      await db.addGamePoints(w, prizePerWinner);
      await db.addMessageXp(w, 80);
    }

    const bunglonText = aliveBunglon.length > 0 
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => `@${b.split('@')[0]}`).join(', ')} (Ikut menang karena selamat!)`
      : '';

    const winMsg = 
`🎉 *WARGA SIPIL MENANG! (CIVILIAN VICTORY)* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seluruh penyamar berhasil dieliminasi!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*${bunglonText}

🎁 Hadiah Tiap Pemenang: *+${prizePerWinner.toLocaleString('id-ID')} Poin* & *+80 XP*!
👥 Warga Pemenang: ${winningCivilians.map(c => `@${c.split('@')[0]}`).join(', ')}`;

    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    await send(sock, jid, null, winMsg, { mentions: allWinners });
    return true;
  }

  // 2. Undercover >= Warga Sipil -> Undercover (+ surviving Mr White & Bunglon) Menang!
  if ((aliveUndercover.length + aliveMrWhite.length) >= aliveCivilians.length) {
    if (session.timeout) clearTimeout(session.timeout);
    const winningUndercovers = session.players.filter(p => isUndercoverRole(session.playerRoles.get(p)?.role));
    const allWinners = [...winningUndercovers, ...aliveMrWhite, ...aliveBunglon];
    const prizePerWinner = Math.floor(totalPrize / Math.max(1, allWinners.length));

    for (const w of allWinners) {
      await db.addGamePoints(w, prizePerWinner);
      await db.addMessageXp(w, 120);
    }

    const bunglonText = aliveBunglon.length > 0 
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => `@${b.split('@')[0]}`).join(', ')} (Ikut menang karena selamat!)`
      : '';

    const winMsg = 
`🎭 *UNDERCOVER MENANG! (IMPOSTOR VICTORY)* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Penyamar berhasil mengecoh seluruh warga sipil hingga akhir!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*${bunglonText}

🏆 Pemenang: ${allWinners.map(w => `@${w.split('@')[0]}`).join(', ')}
💰 Hadiah Tiap Pemenang: *+${prizePerWinner.toLocaleString('id-ID')} Poin* & *+120 XP*!`;

    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    await send(sock, jid, null, winMsg, { mentions: allWinners });
    return true;
  }

  return false;
}

async function startNextUndercoverRound(sock, jid, messageObj, isFirstRound = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  if (!isFirstRound) {
    session.round++;
  } else {
    session.round = 1;
    session.skipCount = 0;
  }

  // 1. Cek jika mencapai batas maksimal ronde (Max 7 Ronde)
  if (session.round > MAX_ROUNDS) {
    if (session.timeout) clearTimeout(session.timeout);
    const totalPrize = session.buyIn * session.players.length;
    const winningUndercovers = session.players.filter(p => isUndercoverRole(session.playerRoles.get(p)?.role));
    const aliveMrWhite = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'MRWHITE');
    const aliveBunglon = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'BUNGLON');
    const allWinners = [...winningUndercovers, ...aliveMrWhite, ...aliveBunglon];
    const prizePerWinner = Math.floor(totalPrize / Math.max(1, allWinners.length));

    for (const w of allWinners) {
      await db.addGamePoints(w, prizePerWinner);
      await db.addMessageXp(w, 150);
    }

    const maxRoundWinMsg = 
`⌛ *BATAS MAKSIMAL 7 RONDE TERCAPAI!* 🕵️👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Warga sipil kehabisan waktu dan gagal membongkar penyamar hingga akhir Ronde 7!
🏆 *UNDERCOVER MENANG SURVIVAL! (SURVIVAL VICTORY)* 🎭

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

🎁 Hadiah Tiap Pemenang: *+${prizePerWinner.toLocaleString('id-ID')} Poin* & *+150 XP*!
🏆 Pemenang: ${allWinners.map(w => `@${w.split('@')[0]}`).join(', ')}`;

    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    await send(sock, jid, null, maxRoundWinMsg, { mentions: allWinners });
    return;
  }

  session.status = 'CLUE_PHASE';
  session.turnIndex = 0;
  session.detectiveChecksThisRound?.clear();
  session.silencedPlayers?.clear(); 

  const mod = ROUND_MODIFIERS[Math.floor(Math.random() * ROUND_MODIFIERS.length)];
  session.modifier = mod;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  const totalPot = session.buyIn * session.players.length;
  const isSuddenDeath = session.round >= 4;
  const turnTimeoutMs = isSuddenDeath ? 15 * 1000 : (mod.name?.includes('Speed') ? 15 * 1000 : CLUE_TIMEOUT_MS);

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
      roleCounts.UNDERCOVER ? `🕵️ ${roleCounts.UNDERCOVER} Undercover` : null,
      roleCounts.ASSASSIN ? `🗡️ ${roleCounts.ASSASSIN} Assassin` : null,
      roleCounts.FRAMER ? `🗣️ ${roleCounts.FRAMER} Framer` : null,
      roleCounts.SABOTEUR ? `🦹 ${roleCounts.SABOTEUR} Saboteur` : null,
      roleCounts.MRWHITE ? `🤍 ${roleCounts.MRWHITE} Mr. White` : null,
      roleCounts.JESTER ? `🤡 ${roleCounts.JESTER} Si Badut` : null,
      roleCounts.BUNGLON ? `🦎 ${roleCounts.BUNGLON} Bunglon` : null
    ].filter(Boolean).join(' | ');

    roundHeader = 
`🎮 *UNDERCOVER ULTRA 2.0 RESMI DIMULAI — RONDE 1* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kata rahasia telah dikirim ke DM WhatsApp masing-masing!*
🏷️ *Kategori:* ${session.pair.category}
💰 *Total Prizepool:* *${totalPot.toLocaleString('id-ID')} Poin*
🎭 *Komposisi Peran:* ${roleSummary}
🎲 *Tantangan Ronde:* *${mod.name}* (${mod.desc})

📜 *ATURAN GAME TERBARU:*
⏱️ *Durasi:* 25s Petunjuk, 35s Voting
🚫 *Batas Vote Skip:* Maksimal 2x per permainan
💀 *Zona Merah (Sudden Death):* Mulai Ronde 4+ (Waktu 15s & Vote Skip Dikunci!)
⏳ *Batas Ronde:* Maksimal 7 Ronde (Jika R7 usai ➔ Penyamar Menang Survival!)

📋 *Urutan Giliran Pemain:*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran Pertama:* @${currentTurnPlayer.split('@')[0]} (Waktu 25s)
_Ketik 1 kalimat petunjuk katamu di grup ini! (Atau .skip)_
💡 _Ketik \`.undercover role\` untuk membaca panduan peran._`;
  } else if (isSuddenDeath) {
    roundHeader = 
`🚨 *ZONA MERAH / SUDDEN DEATH DIAKTIFKAN — RONDE ${session.round}* ☠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *PERINGATAN ZONA MERAH:*
• Waktu giliran petunjuk dipercepat jadi **15 Detik**!
• Opsi \`.vote skip\` **DIKUNCI / DILARANG** (Wajib ada yang dieksekusi)!
• Batas akhir game: Ronde 7 (Penyamar menang jika selamat).

🎲 *Tantangan Ronde:* *${mod.name}* (${mod.desc})
👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran:* @${currentTurnPlayer.split('@')[0]} (Waktu 15s)
_Ketik petunjuk barumu di grup!_`;
  } else {
    roundHeader = 
`🔄 *UNDERCOVER — MASUK RONDE ${session.round}* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎲 *Tantangan Ronde:* *${mod.name}* (${mod.desc})
👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran:* @${currentTurnPlayer.split('@')[0]} (Waktu 25s)
_Ketik petunjuk barumu di grup! (Atau .skip)_`;
  }

  saveUndercoverSessions();

  session.timeout = setTimeout(async () => {
    if (!activeUndercoverGames.has(jid)) return;
    const cur = activeUndercoverGames.get(jid);
    if (cur.status === 'CLUE_PHASE' && cur.alivePlayers[cur.turnIndex] === currentTurnPlayer) {
      const pRole = cur.playerRoles.get(currentTurnPlayer);
      if (pRole) pRole.clue = '(Melewatkan giliran / AFK)';
      await send(sock, jid, messageObj, `⌛ @${currentTurnPlayer.split('@')[0]} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [currentTurnPlayer] });
      cur.turnIndex++;
      saveUndercoverSessions();
      if (cur.turnIndex < cur.alivePlayers.length) {
        await advanceClueTurn(sock, jid, messageObj);
      } else {
        cur.status = 'VOTING_PHASE';
        cur.votes.clear();
        saveUndercoverSessions();

        const isSd = cur.round >= 4;
        let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        cur.alivePlayers.forEach((p, i) => {
          const roleData = cur.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue || '-'}"_\n`;
        });
        voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` ${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `atau \`.vote skip\` (Abstain, Sisa Kuota: ${Math.max(0, MAX_SKIPS - (cur.skipCount || 0))}/2)`}!\n⏳ Waktu voting: 35 detik.`;

        cur.timeout = setTimeout(async () => {
          if (!activeUndercoverGames.has(jid)) return;
          const cur2 = activeUndercoverGames.get(jid);
          if (cur2.status === 'VOTING_PHASE') {
            await processUndercoverVotes(sock, jid, messageObj);
          }
        }, VOTE_TIMEOUT_MS);

        await send(sock, jid, messageObj, voteList, { mentions: cur.alivePlayers });
      }
    }
  }, turnTimeoutMs);

  await send(sock, jid, messageObj, roundHeader, { mentions: session.alivePlayers });
}

// ─── 🔍 DETEKTIF INTEL VIA DM (.intip @member) ──────────────────────
export function findUndercoverSessionAndPlayer(senderNumber) {
  for (const s of activeUndercoverGames.values()) {
    if (s.playerRoles?.has(senderNumber)) {
      return { session: s, playerJid: senderNumber };
    }
    for (const p of s.playerRoles.keys()) {
      if (db.isPhoneMatch(p, senderNumber)) {
        return { session: s, playerJid: p };
      }
    }
  }
  return { session: null, playerJid: null };
}

export function resolveTargetInSession(session, rawTarget) {
  if (!session || !rawTarget) return null;
  const str = String(rawTarget).trim();
  const parsedNum = parseInt(str, 10);
  if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= session.alivePlayers.length && !str.includes('@')) {
    return session.alivePlayers[parsedNum - 1];
  }
  if (session.alivePlayers.includes(str)) return str;
  const digits = str.replace(/\D/g, '');
  if (digits.length >= 4) {
    const found = session.alivePlayers.find(p => db.isPhoneMatch(p, digits) || p.replace(/\D/g, '').includes(digits) || digits.includes(p.replace(/\D/g, '')));
    if (found) return found;
  }
  return null;
}

// ─── 🔍 DETEKTIF INTEL VIA DM (.intip @member) ──────────────────────
export async function handleDetectiveCheck(sock, jid, senderNumber, messageObj, targetParam) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE')) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'DETECTIVE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Detektif di game ini!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) || !senderRoleData.isAlive) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan tidak dapat menggunakan kemampuan intip!");
    return true;
  }

  // 1. Batasan Ronde: Hanya bisa dipakai setelah melewati Ronde 1 (Mulai Ronde 2 ke atas)
  if (targetSession.round < 2) {
    await send(sock, jid, messageObj, "⏳ *KEMAMPUAN TERKUNCI!* Detektif baru bisa mengintip peran setelah melewati Ronde 1 (Mulai Ronde 2 ke atas).");
    return true;
  }

  // 2. Batasan Pemakaian: Hanya 1x seumur permainan
  if (senderRoleData.hasUsedIntel) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan intip Anda (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(targetSession, targetParam);

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.intip @member\` atau nomor urut \`.intip [1-${targetSession.alivePlayers.length}]\``);
    return true;
  }

  if (resolvedTarget === resolvedSender) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa mengintip diri sendiri!");
    return true;
  }

  senderRoleData.hasUsedIntel = true;
  saveUndercoverSessions();

  const targetRole = targetSession.playerRoles.get(resolvedTarget);
  const isFramed = targetSession.framedPlayer === resolvedTarget;
  const isCiv = isCivilianRole(targetRole.role) && !isFramed;

  const report = isCiv 
    ? `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${resolvedTarget.split('@')[0]}\n🟢 Status: *WARGA SIPIL (CIVILIAN)* 🛡️\n\n_Target adalah sekutu warga yang aman!_`
    : `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${resolvedTarget.split('@')[0]}\n🔴 Status: *BUKAN WARGA (PENYAMAR / IMPOSTOR / BADUT)!* 🚨\n\n_Target sangat mencurigakan, arahkan warga untuk mem-votenya!_`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🛡️ GUARDIAN BODYGUARD VIA DM (.lindung @member / .guard @member) ────────
export async function handleGuardianProtect(sock, jid, senderNumber, messageObj, targetParam) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE')) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'GUARDIAN') {
    await send(sock, jid, messageObj, "❌ Anda bukan Guardian/Bodyguard di game ini!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) || !senderRoleData.isAlive) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan tidak dapat menggunakan kemampuan perlindungan!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(targetSession, targetParam);

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.lindung @member\` atau nomor urut \`.lindung [1-${targetSession.alivePlayers.length}]\``);
    return true;
  }

  targetSession.guardedPlayer = resolvedTarget;
  saveUndercoverSessions();

  const targetPhone = resolvedTarget.split('@')[0];
  await send(sock, jid, messageObj, `🛡️ *PERLINDUNGAN GUARDIAN AKTIF!* 🔰\nAnda berhasil menugaskan pengawalan ketat untuk @${targetPhone} di ronde ini. Jika dia diserang/dieksekusi, nyawanya akan terselamatkan!`, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🗣️ FRAMER TUKANG FITNAH VIA DM (.fitnah @member / .frame @member) ──────
export async function handleFramerFrame(sock, jid, senderNumber, messageObj, targetParam) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE')) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'FRAMER') {
    await send(sock, jid, messageObj, "❌ Anda bukan Framer di game ini!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) || !senderRoleData.isAlive) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan tidak dapat menggunakan kemampuan fitnah!");
    return true;
  }

  if (senderRoleData.hasFramed) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan fitnah (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(targetSession, targetParam);

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.fitnah @member\` atau nomor urut \`.fitnah [1-${targetSession.alivePlayers.length}]\``);
    return true;
  }

  if (resolvedTarget === resolvedSender) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa memfitnah diri sendiri!");
    return true;
  }

  senderRoleData.hasFramed = true;
  targetSession.framedPlayer = resolvedTarget;
  saveUndercoverSessions();

  const targetPhone = resolvedTarget.split('@')[0];

  const successMsg = 
`🗣️ *AKSI FITNAH BERHASIL DILANCARKAN!* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target @${targetPhone} berhasil Anda jebak!
🎯 *Efek Berjalan:*
1. Jika Detektif mengintipnya, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR/IMPOSTOR)**!
2. Pada fase voting ronde ini, target akan otomatis mendapatkan **+1 Suara Kutukan Eksekusi**!`;

  await send(sock, jid, messageObj, successMsg, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🦹 SABOTEUR MERETAS STATUS VIA DM (.hack @member / .sabotase @member) ───
export async function handleSaboteurHack(sock, jid, senderNumber, messageObj, targetParam) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE')) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'SABOTEUR') {
    await send(sock, jid, messageObj, "❌ Anda bukan Saboteur di game ini!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) || !senderRoleData.isAlive) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan tidak dapat meretas status!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(targetSession, targetParam);

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.hack @member\` atau nomor urut \`.hack [1-${targetSession.alivePlayers.length}]\``);
    return true;
  }

  const targetRoleData = targetSession.playerRoles.get(resolvedTarget);
  const targetPhone = resolvedTarget.split('@')[0];
  const isVip = ['SHERIFF', 'DETECTIVE', 'GUARDIAN'].includes(targetRoleData?.role);

  const report = isVip
    ? `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${targetPhone}\n🚨 Status Intel: *WARGA SPESIAL / VIP BERBAHAYA!* (${getRoleBadge(targetRoleData.role)})\n\n_Target memegang kemampuan khusus, segera habisi dia!_`
    : `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${targetPhone}\n🛡️ Status Intel: *${getRoleBadge(targetRoleData.role)}*\n\n_Target tidak memiliki senjata berbahaya._`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🤠🔫 TEMBAKAN RAHASIA VIA DM (.tembak @member / .shoot @member) ──────
export async function handleUndercoverShoot(sock, jid, senderNumber, messageObj, args = []) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!targetSession || (targetSession.status !== 'CLUE_PHASE' && targetSession.status !== 'VOTING_PHASE')) {
    return false;
  }

  const senderRoleData = targetSession.playerRoles.get(resolvedSender);
  if (!senderRoleData || !['SHERIFF', 'UNDERCOVER', 'ASSASSIN'].includes(senderRoleData.role)) {
    await send(sock, jid, messageObj, "❌ Peran Anda tidak memiliki senjata untuk menembak!");
    return true;
  }

  if (!targetSession.alivePlayers.includes(resolvedSender) || !senderRoleData.isAlive) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur/mati dan tidak dapat menembak!");
    return true;
  }

  if (!senderRoleData.hasBullet) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan 1 peluru tembakan Anda dalam game ini!");
    return true;
  }

  const rawTarget = args[1] ||
    messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj.message?.extendedTextMessage?.contextInfo?.participant;

  const resolvedTarget = resolveTargetInSession(targetSession, rawTarget);

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tembakan tidak valid atau sudah mati!\n👉 *Format:* \`.tembak @member\` atau nomor urut \`.tembak [1-${targetSession.alivePlayers.length}]\``);
    return true;
  }

  if (resolvedTarget === resolvedSender) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa menembak diri sendiri!");
    return true;
  }

  senderRoleData.hasBullet = false;
  saveUndercoverSessions();

  const gameJid = targetSession.jid;
  const senderPhone = resolvedSender.split('@')[0];
  const targetPhone = resolvedTarget.split('@')[0];
  const targetRoleData = targetSession.playerRoles.get(resolvedTarget);

  // Cek jika target dilindungi Guardian
  if (targetSession.guardedPlayer === resolvedTarget) {
    targetSession.guardedPlayer = null;
    saveUndercoverSessions();

    const blockMsg = 
`🛡️ *SERANGAN DIGAGALKAN OLEH GUARDIAN!* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seseorang mencoba melepaskan tembakan ke arah @${targetPhone}, namun Bodyguard/Guardian berhasil menangkis serangan tersebut!
@${targetPhone} **SELAMAT DARI MAUT**!`;

    await send(sock, gameJid, null, blockMsg, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🛡️ Tembakan Anda ke @${targetPhone} berhasil digagalkan oleh perlindungan Guardian!`);
    }
    return true;
  }

  let deadPlayer = null;

  // 1. JIKA PENEMBAK ADALAH SHERIFF (KOBOI)
  if (senderRoleData.role === 'SHERIFF') {
    const isEnemy = isUndercoverRole(targetRoleData.role) || isNeutralRole(targetRoleData.role);

    if (isEnemy) {
      // Sasaran tepat! Musuh tewas!
      deadPlayer = resolvedTarget;
      targetSession.alivePlayers = targetSession.alivePlayers.filter(p => p !== resolvedTarget);
      targetRoleData.isAlive = false;

      const hitMsg = 
`💥 *DORRR! TEMBAKAN REVOLVER SHERIFF!* 🤠🔫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff @${senderPhone} melepaskan tembakan revolver ke arah @${targetPhone}!
☠️ @${targetPhone} **TEWAS DI TEMPAT** tanpa perlu voting!
🎭 Peran Terbuka: *${getRoleBadge(targetRoleData.role)}*`;

      await send(sock, gameJid, null, hitMsg, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `🎯 Tembakan Anda berhasil! @${targetPhone} (${getRoleBadge(targetRoleData.role)}) telah tewas!`);
      }
    } else {
      // SALAH SASARAN! Menembak Warga / Sekutu -> Sheriff Suicide!
      deadPlayer = resolvedSender;
      targetSession.alivePlayers = targetSession.alivePlayers.filter(p => p !== resolvedSender);
      senderRoleData.isAlive = false;

      const suicideMsg = 
`💥 *DORRR! TRAGEDI SALAH TEMBAK!* 🤠💀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff @${senderPhone} melepaskan tembakan ke arah Warga @${targetPhone}!
☠️ Menyadari dirinya salah menembak warga sekutu tak bersalah, @${senderPhone} **TEWAS DI TEMPAT (SUICIDE)**!
🧑‍🌾 @${targetPhone} selamat tanpa luka!`;

      await send(sock, gameJid, null, suicideMsg, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `💀 Anda salah menembak warga sipil! Anda tewas seketika karena rasa bersalah!`);
      }
    }
  } 
  // 2. JIKA PENEMBAK ADALAH UNDERCOVER ATAU ASSASSIN
  else if (['UNDERCOVER', 'ASSASSIN'].includes(senderRoleData.role)) {
    deadPlayer = resolvedTarget;
    targetSession.alivePlayers = targetSession.alivePlayers.filter(p => p !== resolvedTarget);
    targetRoleData.isAlive = false;

    const killMsg = 
`🩸 *PEMBUNUHAN RAHASIA DI MALAM HARI!* 🕵️🗡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Terdengar suara letupan tembakan senyap di kejauhan...
☠️ @${targetPhone} **DITEMUKAN TEWAS** secara misterius!
🎭 Peran Terbuka: *${getRoleBadge(targetRoleData.role)}*`;

    await send(sock, gameJid, null, killMsg, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🗡️ Target @${targetPhone} (${getRoleBadge(targetRoleData.role)}) berhasil Anda bunuh!`);
    }
  }

  saveUndercoverSessions();

  // Evaluasi kondisi kemenangan game
  const isGameOver = await checkUndercoverWinCondition(sock, gameJid);
  if (isGameOver) return true;

  // Jika game masih lanjut & sedang fase petunjuk, sesuaikan giliran jika pemain mati sedang giliran
  if (targetSession.status === 'CLUE_PHASE' && deadPlayer) {
    if (targetSession.turnIndex >= targetSession.alivePlayers.length) {
      targetSession.status = 'VOTING_PHASE';
      targetSession.votes.clear();
      saveUndercoverSessions();

      const isSd = targetSession.round >= 4;
      let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      targetSession.alivePlayers.forEach((p, i) => {
        const roleData = targetSession.playerRoles.get(p);
        voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue || '-'}"_\n`;
      });
      voteList += `\n💬 *Diskusikan siapa penyamarnya!*
👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSd ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `• Ketik: \`.vote skip\` (atau \`.skip\`) untuk **Abstain** (Sisa Kuota: ${Math.max(0, MAX_SKIPS - (targetSession.skipCount || 0))}/2)`}
⏳ Waktu voting: 35 detik.`;

      targetSession.timeout = setTimeout(async () => {
        if (!activeUndercoverGames.has(gameJid)) return;
        const cur = activeUndercoverGames.get(gameJid);
        if (cur.status === 'VOTING_PHASE') {
          await processUndercoverVotes(sock, gameJid, messageObj);
        }
      }, VOTE_TIMEOUT_MS);

      await send(sock, gameJid, null, voteList, { mentions: targetSession.alivePlayers });
    }
  }

  return true;
}

// ─── 🃏 POWER CARDS SHOP (.undercover card) ──────────────────────────
async function handleUndercoverCardShop(sock, jid, senderNumber, messageObj, args) {
  const session = activeUndercoverGames.get(jid);
  const cardType = (args[2] || '').toLowerCase();

  const shopGuide = 
`🃏 *TOKO KARTU AKSI UNDERCOVER (POWER CARDS)* ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Gunakan Akbar Poin untuk membeli kartu aksi trik khusus saat bermain!

1. 🛡️ *Rompi Anti-Peluru (Shield)* — *50 Poin*
   • Kebal dari 1x eliminasi voting grup!
   • Beli: \`.undercover card shield\`

2. 🎯 *Golden Vote (Double Suara)* — *35 Poin*
   • Suara voting kamu dihitung bernilai **2 suara**!
   • Beli: \`.undercover card gold\`

3. 🤐 *Kartu Lakban (Silence)* — *30 Poin*
   • Bungkam target agar hanya boleh memberi petunjuk **1 KATA** di ronde berikutnya!
   • Beli: \`.undercover card silence @target\`

4. 🔮 *Radar Sensor (Clue Spy)* — *40 Poin*
   • (Khusus Undercover / Mr. White) Mengintip kategori & huruf depan kata warga via DM!
   • Beli: \`.undercover card radar\``;

  if (!cardType) {
    await send(sock, jid, messageObj, shopGuide);
    return true;
  }

  if (!session || session.status === 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Kartu aksi hanya bisa dibeli saat game Undercover sedang berlangsung di grup!");
    return true;
  }

  if (!session.alivePlayers.includes(senderNumber)) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur tidak bisa membeli kartu aksi!");
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  const curPoints = prof?.points || 0;

  if (cardType === 'shield') {
    if (curPoints < 50) return await send(sock, jid, messageObj, "❌ Poin tidak cukup! Butuh 50 Poin untuk Rompi Shield.");
    await db.deductGamePoints(senderNumber, 50);
    session.shieldedPlayers.add(senderNumber);
    await send(sock, jid, messageObj, `🛡️ @${senderNumber.split('@')[0]} berhasil mengaktifkan *Rompi Anti-Peluru*! Kebal dari 1x vote eksekusi.`, { mentions: [senderNumber] });
    return true;
  }

  if (cardType === 'gold') {
    if (curPoints < 35) return await send(sock, jid, messageObj, "❌ Poin tidak cukup! Butuh 35 Poin untuk Golden Vote.");
    await db.deductGamePoints(senderNumber, 35);
    session.goldenVoters.add(senderNumber);
    await send(sock, jid, messageObj, `🌟 @${senderNumber.split('@')[0]} berhasil mengaktifkan *Golden Vote (x2 Suara)* di fase voting mendatang!`, { mentions: [senderNumber] });
    return true;
  }

  if (cardType === 'silence') {
    const rawTarget = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[3];
    let resolvedTarget = null;
    if (rawTarget) {
      const parsedNum = parseInt(String(rawTarget).trim(), 10);
      if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= session.alivePlayers.length) {
        resolvedTarget = session.alivePlayers[parsedNum - 1];
      } else if (session.alivePlayers.includes(rawTarget)) {
        resolvedTarget = rawTarget;
      }
    }
    if (!resolvedTarget) {
      await send(sock, jid, messageObj, "⚠️ Tentukan target lakban! Format: `.undercover card silence @target` atau `.undercover card silence [nomor urut]`");
      return true;
    }
    if (curPoints < 30) return await send(sock, jid, messageObj, "❌ Poin tidak cukup! Butuh 30 Poin untuk Kartu Lakban.");
    await db.deductGamePoints(senderNumber, 30);
    session.silencedPlayers.add(resolvedTarget);
    await send(sock, jid, messageObj, `🤐 @${senderNumber.split('@')[0]} membungkam @${resolvedTarget.split('@')[0]} dengan *Kartu Lakban*! Korban hanya boleh memberikan petunjuk 1 KATA.`, { mentions: [senderNumber, resolvedTarget] });
    return true;
  }

  if (cardType === 'radar') {
    const roleData = session.playerRoles.get(senderNumber);
    if (!['UNDERCOVER', 'MRWHITE'].includes(roleData?.role)) {
      await send(sock, jid, messageObj, "❌ Kartu Radar hanya bisa digunakan oleh Undercover atau Mr. White!");
      return true;
    }
    if (curPoints < 40) return await send(sock, jid, messageObj, "❌ Poin tidak cukup! Butuh 40 Poin untuk Kartu Radar.");
    await db.deductGamePoints(senderNumber, 40);
    const civWord = session.pair.civilian;
    const initialChar = civWord.charAt(0).toUpperCase();
    try {
      await sock.sendMessage(senderNumber, { text: `🔮 *RADAR SENSOR AKTIF!* 📡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷️ Kategori Kata Warga: *${session.pair.category}*\n🔤 Huruf Depan Kata Warga: *"${initialChar}"* (Panjang kata: ${civWord.length} karakter)\n\n_Gunakan petunjuk rahasia ini untuk mengecoh mereka!_` });
      await send(sock, jid, messageObj, `🔮 @${senderNumber.split('@')[0]} berhasil mengaktifkan *Radar Sensor* (Info rahasia dikirim ke DM WhatsApp)!`, { mentions: [senderNumber] });
    } catch (e) {}
    return true;
  }

  await send(sock, jid, messageObj, shopGuide);
  return true;
}

// ─── 📊 STATISTIK UNDERCOVER ─────────────────────────────────────────
async function showUndercoverStats(sock, jid, senderNumber, messageObj) {
  const cust = await db.getCustomerByPhone(senderNumber);
  const name = cust?.nama || `@${senderNumber.split('@')[0]}`;
  const prof = await db.getGameProfile(senderNumber);

  const statsMsg = 
`🕵️ *PROFIL & STATISTIK AGEN UNDERCOVER* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Agen: *${name}*
💰 Akbar Poin: *${(prof?.points || 0).toLocaleString('id-ID')} Poin*
⭐ Rank Level: *Level ${prof?.level || 1}* (${prof?.xp || 0} XP)

🎖️ *Gelar Agen:*
▫️ *Master Impostor* — Penyamar Ahli Manipulasi
▫️ *Detektif Agung* — Pelindung Warga Sipil
▫️ *Raja Badut* — Provokator Suara Voting

👉 Mainkan lebih banyak game Undercover untuk mengumpulkan poin dan menaikkan reputasimu!`;

  await send(sock, jid, messageObj, statsMsg, { mentions: [senderNumber] });
  return true;
}

export async function showUndercoverRoleGuide(sock, jid, messageObj) {
  const guide = 
`🎭 *PANDUAN LENGKAP PERAN & ATURAN UNDERCOVER 2.0* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Undercover adalah game deduksi sosial berbasis kata rahasia via DM WhatsApp & diskusi di grup (3–8 pemain).
Peran khusus dibagikan secara *ACAK & DINAMIS* di setiap permainan!

📜 *ATURAN DINAMIS & SISTEM RONDE:*
⏱️ *Durasi Waktu:* 25 Detik Petunjuk (Ronde 1-3) & 35 Detik Voting.
🚫 *Batas Vote Skip:* Maksimal **2x per game**. Setelah 2x, wajib memilih target eliminasi.
💀 *Zona Merah (Sudden Death):* Mulai **Ronde 4 ke atas** (Petunjuk dipercepat jadi 15 detik & \`.vote skip\` dikunci).
⏳ *Batas Maksimal Ronde:* **Maksimal 7 Ronde**. Jika sampai Ronde 7 selesai penyamar belum tereliminasi, Penyamar otomatis menang (*Survival Victory*)!

👥 *DAFTAR LENGKAP PERAN:*

🛡️ *1. KUBU WARGA (CIVILIANS):*
▫️ 🧑‍🌾 *Civilian:* Menerima kata asli, mencari penyamar.
▫️ 🤠 *Koboi / Sheriff:* 1x Peluru Revolver (\`.tembak @member\` via DM). Tembak musuh = MATI! Salah tembak warga = KAU SENDIRI YANG TEWAS (Suicide)!
▫️ 🔍 *Detektif Intel:* 1x Intip per game seumur hidup (\`.intip @member\` via DM). Hanya bisa digunakan mulai *Ronde 2 ke atas*!
▫️ 🛡️ *Guardian (Bodyguard):* 1x Lindungi per ronde (\`.lindung @member\` via DM). Jika target ditembak/dieksekusi, nyawanya SELAMAT!

🕵️ *2. KUBU PENYAMAR (IMPOSTORS):*
▫️ 🕵️ *Undercover:* Menerima kata mirip, 1x Peluru Racun (\`.tembak @member\` via DM).
▫️ 🗡️ *Assassin:* Eksekutor maut, 1x Sniper (\`.tembak @member\` via DM) mematikan musuh seketika!
▫️ 🗣️ *Framer:* Tukang fitnah 1x per game (\`.fitnah @member\` via DM). Memanipulasi hasil intip Detektif & memberi +1 suara kutukan pada target di fase vote!
▫️ 🦹 *Saboteur:* Peretas status (\`.hack @member\` via DM). Mengintip peran target untuk membidik warga VIP!

🎭 *3. KUBU NETRAL (NEUTRALS):*
▫️ 🤍 *Mr. White (Blank):* Tanpa kata rahasia. Tebak kata warga (\`.tebakwarga <kata>\`) kapan saja untuk MENANG SOLO INSTAN!
▫️ 🤡 *Si Badut (Jester):* Menang solo jika di-vote keluar di Ronde 1 atau 2!
▫️ 🦎 *Bunglon:* Pihak netral bebas. Ikut menang dan dapat pot jika bertahan hidup sampai akhir!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *PERINTAH UTAMA VIA DM & GRUP:*
• \`.undercover [taruhan]\` — Buka lobi permainan (Default 30 Poin)
• \`.joinundercover\` — Bergabung ke lobi
• \`.startundercover\` — Memulai permainan (Minimal 3 orang)
• \`.skip\` — Lewati giliran petunjuk / vote skip
• \`.tembak @member\` — (Koboi/Undercover/Assassin via DM) Eksekusi sasaran
• \`.intip @member\` — (Detektif via DM, mulai Ronde 2) Lacak status pemain
• \`.lindung @member\` — (Guardian via DM) Lindungi pemain dari maut
• \`.fitnah @member\` — (Framer via DM) Jebak target & beri +1 vote kutukan
• \`.hack @member\` — (Saboteur via DM) Retas peran sasaran
• \`.vote [nomor/@member]\` — Vote eliminasi di fase voting
• \`.vote skip\` / \`.skip\` — Vote abstain melewati eliminasi (Maks 2x/game)
• \`.tebakwarga <kata>\` — Khusus Mr. White
• \`.undercover card\` — Toko Kartu Aksi Khusus
• \`.undercover role\` — Tampilkan panduan ini`;

  await send(sock, jid, messageObj, guide);
  return true;
}

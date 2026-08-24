import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeUndercoverGames = new Map();
const CLUE_TIMEOUT_MS = 35 * 1000;
const VOTE_TIMEOUT_MS = 60 * 1000;

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
  // 6+ pemain -> Duo Undercover
  const undercoverJid1 = shuffled[0];
  const undercoverJid2 = count >= 6 ? shuffled[1] : null;
  const mrWhiteJid = count >= 4 ? (count >= 6 ? shuffled[2] : shuffled[1]) : null;
  const jesterJid = count >= 5 ? (count >= 6 ? shuffled[3] : shuffled[2]) : null;
  const detectiveJid = count >= 7 ? shuffled[4] : (count === 6 ? shuffled[3] : null);

  const undercovers = [undercoverJid1, undercoverJid2].filter(Boolean);

  for (const p of shuffled) {
    if (undercovers.includes(p)) {
      session.playerRoles.set(p, { role: 'UNDERCOVER', word: pair.undercover, isAlive: true, clue: '', cards: new Set() });
      const partnerText = undercovers.length > 1 
        ? `\n🤝 *Rekan Penyamar Anda:* @${undercovers.find(u => u !== p).split('@')[0]} (Bekerjasamalah!)` 
        : '';
      try {
        await sock.sendMessage(p, { 
          text: `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}${partnerText}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang mengecoh agar dikira warga sipil! Jangan sebutkan kata rahasiamu secara langsung.`,
          mentions: undercovers.length > 1 ? [undercovers.find(u => u !== p)] : []
        });
      } catch (e) {}
    } else if (p === mrWhiteJid) {
      session.playerRoles.set(p, { role: 'MRWHITE', word: '', isAlive: true, clue: '', cards: new Set() });
      try {
        await sock.sendMessage(p, { text: `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA (BLANK)*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Anda tidak punya kata! Dengarkan petunjuk orang lain, pura-pura tahu, dan tebak kata warga (\`.tebakwarga <kata>\`) jika Anda di-vote keluar!` });
      } catch (e) {}
    } else if (p === jesterJid) {
      session.playerRoles.set(p, { role: 'JESTER', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
      try {
        await sock.sendMessage(p, { text: `🤡 *PERAN ANDA: SI BADUT (JESTER / KARBIT)* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Gila Anda:* Buat diri Anda DICURIGAI dan DI-VOTE KELUAR oleh grup! Jika Anda berhasil dieliminasi di Ronde 1 atau 2, Anda MENANG SOLO dan mencuri seluruh pot taruhan!` });
      } catch (e) {}
    } else if (p === detectiveJid) {
      session.playerRoles.set(p, { role: 'DETECTIVE', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
      try {
        await sock.sendMessage(p, { text: `🔍 *PERAN ANDA: DETEKTIF INTEL (DETECTIVE)* 🕵️‍♂️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi & Skill Intel:* Anda bisa mengintip identitas 1 pemain per ronde dengan mengirim pesan DM ke bot ini:\n👉 Ketik: \`.intip @member\` (atau \`.intip <nomor urut>\`)` });
      } catch (e) {}
    } else {
      session.playerRoles.set(p, { role: 'CIVILIAN', word: pair.civilian, isAlive: true, clue: '', cards: new Set() });
      try {
        await sock.sendMessage(p, { text: `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat bagi sesama warga, temukan sang penyamar (Undercover), dan jangan sampai salah vote!` });
      } catch (e) {}
    }
  }

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

  // Cek jika pemain terkena Lakban (Silence Card)
  if (session.silencedPlayers?.has(senderNumber)) {
    const wordCount = cleanClue.split(/\s+/).length;
    if (wordCount > 1) {
      await send(sock, jid, messageObj, `🤐 *MULUTMU DILAKBAN!* Kamu terkena Kartu Lakban, sehingga HANYA boleh memberi petunjuk *1 KATA* saja! Coba lagi.`);
      return true;
    }
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

  if (session.turnIndex < session.alivePlayers.length) {
    await advanceClueTurn(sock, jid, messageObj);
    return true;
  } else {
    // Seluruh pemain sudah memberi petunjuk -> Masuk ke FASE VOTING
    session.status = 'VOTING_PHASE';
    session.votes.clear();

    let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    session.alivePlayers.forEach((p, i) => {
      const roleData = session.playerRoles.get(p);
      voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
    });
    voteList += `\n💬 *Diskusikan siapa penyamarnya!*
👉 Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka!
⏳ Waktu voting: 60 detik.`;

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
  const turnTimeoutMs = session.modifier?.name?.includes('Speed') ? 20 * 1000 : CLUE_TIMEOUT_MS;

  const turnMsg = `✅ Petunjuk diterima!\n\n👉 *Giliran Selanjutnya:* @${nextPlayer.split('@')[0]} (Pemain ${session.turnIndex + 1}/${session.alivePlayers.length})\n⏳ *Waktu:* ${Math.round(turnTimeoutMs / 1000)} Detik\n_Tulis 1 kalimat petunjuk katamu di grup ini!_`;

  session.timeout = setTimeout(async () => {
    if (!activeUndercoverGames.has(jid)) return;
    const cur = activeUndercoverGames.get(jid);
    if (cur.status === 'CLUE_PHASE' && cur.alivePlayers[cur.turnIndex] === nextPlayer) {
      const pRole = cur.playerRoles.get(nextPlayer);
      if (pRole) pRole.clue = '(Melewatkan giliran / AFK)';
      await send(sock, jid, messageObj, `⌛ @${nextPlayer.split('@')[0]} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [nextPlayer] });
      cur.turnIndex++;
      if (cur.turnIndex < cur.alivePlayers.length) {
        await advanceClueTurn(sock, jid, messageObj);
      } else {
        cur.status = 'VOTING_PHASE';
        cur.votes.clear();
        let voteList = `🗳️ *SEMUA PETUNJUK SELESAI — FASE VOTING!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        cur.alivePlayers.forEach((p, i) => {
          const roleData = cur.playerRoles.get(p);
          voteList += `${i + 1}. @${p.split('@')[0]}: _"${roleData.clue}"_\n`;
        });
        voteList += `\n👉 Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi penyamar!`;
        await send(sock, jid, messageObj, voteList, { mentions: cur.alivePlayers });
      }
    }
  }, turnTimeoutMs);

  await send(sock, jid, messageObj, turnMsg, { mentions: [nextPlayer] });
}

export async function handleUndercoverVote(sock, jid, senderNumber, messageObj, targetJid) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'VOTING_PHASE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  if (!session.alivePlayers.includes(senderNumber)) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur tidak dapat memberikan suara!");
    return true;
  }

  let rawTarget = targetJid ||
    messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj.message?.extendedTextMessage?.contextInfo?.participant;

  let resolvedTarget = null;
  if (rawTarget) {
    const parsedNum = parseInt(String(rawTarget).trim(), 10);
    if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= session.alivePlayers.length && !String(rawTarget).includes('@') && String(rawTarget).trim().length <= 2) {
      resolvedTarget = session.alivePlayers[parsedNum - 1];
    } else if (session.alivePlayers.includes(rawTarget)) {
      resolvedTarget = rawTarget;
    } else {
      const targetDigits = String(rawTarget).replace(/\D/g, '');
      if (targetDigits.length > 5) {
        resolvedTarget = session.alivePlayers.find(p => p.replace(/\D/g, '').includes(targetDigits) || targetDigits.includes(p.replace(/\D/g, '')));
      }
    }
  }

  if (!resolvedTarget || !session.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target vote tidak valid!\n👉 *Cara Vote:* Ketik \`.vote @member\` atau nomor urut \`.vote [1-${session.alivePlayers.length}]\``);
    return true;
  }

  if (resolvedTarget === senderNumber) {
    await send(sock, jid, messageObj, "⚠️ Kamu tidak bisa mem-vote dirimu sendiri!");
    return true;
  }

  session.votes.set(senderNumber, resolvedTarget);
  const voterPhone = senderNumber.split('@')[0];
  const targetPhone = resolvedTarget.split('@')[0];
  const isGolden = session.goldenVoters?.has(senderNumber);

  await send(sock, jid, messageObj, `🗳️ @${voterPhone} mem-vote @${targetPhone}! ${isGolden ? '🌟 *(Golden Vote x2)*' : ''} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [senderNumber, resolvedTarget] });

  if (session.votes.size >= session.alivePlayers.length) {
    if (session.timeout) clearTimeout(session.timeout);
    await processUndercoverVotes(sock, jid, messageObj);
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

  if (isTie || !eliminated) {
    await send(sock, jid, messageObj, `⚖️ *HASIL VOTING SERI / IMBANG!* Tidak ada yang dieliminasi ronde ini. Permainan dilanjutkan ke ronde berikutnya!`);
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // Cek jika target memiliki Rompi Anti-Peluru (Shield Card)
  if (session.shieldedPlayers?.has(eliminated)) {
    session.shieldedPlayers.delete(eliminated);
    await send(sock, jid, messageObj, `🛡️ *ROMPI ANTI-PELURU AKTIF!* @${eliminated.split('@')[0]} berhasil selamat dari eksekusi vote berkat Rompi Pelindung! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // Eliminasi pemain
  session.alivePlayers = session.alivePlayers.filter(p => p !== eliminated);
  const eliminatedRole = session.playerRoles.get(eliminated);
  eliminatedRole.isAlive = false;

  const elimPhone = eliminated.split('@')[0];
  const roleName = eliminatedRole.role === 'UNDERCOVER' 
    ? '🕵️ UNDERCOVER (PENYAMAR)' 
    : eliminatedRole.role === 'MRWHITE' 
    ? '🤍 MR. WHITE (BLANK)' 
    : eliminatedRole.role === 'JESTER' 
    ? '🤡 SI BADUT (JESTER)' 
    : eliminatedRole.role === 'DETECTIVE'
    ? '🔍 DETEKTIF INTEL'
    : '🧑‍🌾 WARGA SIPIL';

  await send(sock, jid, messageObj, `☠️ *@${elimPhone}* resmi dieliminasi dari grup dengan ${maxVotes} suara!\n🎭 Peran Terbuka: *${roleName}*`, { mentions: [eliminated] });

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
    await send(sock, jid, messageObj, jesterWinMsg, { mentions: [eliminated] });
    return;
  }

  // 2. Cek jika Mr. White dieliminasi -> Diberi kesempatan tebak kata warga
  if (eliminatedRole.role === 'MRWHITE') {
    session.status = 'MR_WHITE_GUESS';
    session.mrWhiteGuessPending = eliminated;
    await send(sock, jid, messageObj, `🤍 *MR. WHITE DIBERI KESEMPATAN TERAKHIR!* 🤍\n@${elimPhone} memiliki 30 detik untuk menebak kata warga sipil!\n👉 Ketik: \`.tebakwarga <kata>\``, { mentions: [eliminated] });

    session.timeout = setTimeout(async () => {
      if (!activeUndercoverGames.has(jid)) return;
      const cur = activeUndercoverGames.get(jid);
      if (cur.status === 'MR_WHITE_GUESS') {
        await send(sock, jid, messageObj, `⏰ Waktu Mr. White habis! Kata warga tidak tertebak.`);
        await evaluateUndercoverWin(sock, jid, messageObj);
      }
    }, 30 * 1000);
    return;
  }

  await evaluateUndercoverWin(sock, jid, messageObj);
}

export async function handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'MR_WHITE_GUESS' || session.mrWhiteGuessPending !== senderNumber) {
    return false;
  }

  if (session.timeout) clearTimeout(session.timeout);

  const cleanGuess = normalizeAnswer(guess);
  const correctCivWord = normalizeAnswer(session.pair.civilian);

  if (cleanGuess === correctCivWord) {
    const totalPrize = session.buyIn * session.players.length;
    await db.addGamePoints(senderNumber, totalPrize);
    await db.addMessageXp(senderNumber, 150);

    const winMsg = 
`🏆 *MR. WHITE MENANG TELAK!* 🤍
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 @${senderNumber.split('@')[0]} berhasil menebak kata warga: *${session.pair.civilian}*!
💰 Hadiah Kemenangan: *+${totalPrize.toLocaleString('id-ID')} Poin* & *+150 XP*!

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*`;

    activeUndercoverGames.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: [senderNumber] });
    return true;
  } else {
    await send(sock, jid, messageObj, `❌ Tebakan Mr. White salah (*${guess}*)!`);
    await evaluateUndercoverWin(sock, jid, messageObj);
    return true;
  }
}

async function evaluateUndercoverWin(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  const aliveUndercovers = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'UNDERCOVER');
  const aliveMrWhite = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'MRWHITE');
  const aliveCivilians = session.alivePlayers.filter(p => ['CIVILIAN', 'DETECTIVE', 'JESTER'].includes(session.playerRoles.get(p)?.role));

  const totalPrize = session.buyIn * session.players.length;

  // 1. Seluruh Penyamar Mati -> Warga Sipil Menang
  if (aliveUndercovers.length === 0 && aliveMrWhite.length === 0) {
    const winningCivilians = session.players.filter(p => ['CIVILIAN', 'DETECTIVE'].includes(session.playerRoles.get(p)?.role));
    const prizePerCiv = Math.floor(totalPrize / winningCivilians.length);

    for (const c of winningCivilians) {
      await db.addGamePoints(c, prizePerCiv);
      await db.addMessageXp(c, 80);
    }

    const winMsg = 
`🎉 *WARGA SIPIL MENANG! (CIVILIAN VICTORY)* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seluruh penyamar berhasil dieliminasi!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

🎁 Hadiah Tiap Warga: *+${prizePerCiv.toLocaleString('id-ID')} Poin* & *+80 XP*!
👥 Warga Berjaya: ${winningCivilians.map(c => `@${c.split('@')[0]}`).join(', ')}`;

    activeUndercoverGames.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: winningCivilians });
    return;
  }

  // 2. Jumlah Penyamar >= Warga Sipil -> Penyamar Menang
  if ((aliveUndercovers.length + aliveMrWhite.length) >= aliveCivilians.length) {
    const winners = [...aliveUndercovers, ...aliveMrWhite];
    const prizePerWinner = Math.floor(totalPrize / winners.length);

    for (const w of winners) {
      await db.addGamePoints(w, prizePerWinner);
      await db.addMessageXp(w, 120);
    }

    const winMsg = 
`🎭 *UNDERCOVER MENANG! (IMPOSTOR VICTORY)* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Penyamar berhasil mengecoh seluruh warga sipil hingga akhir!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

🏆 Pemenang: ${winners.map(w => `@${w.split('@')[0]}`).join(', ')}
💰 Hadiah Tiap Pemenang: *+${prizePerWinner.toLocaleString('id-ID')} Poin* & *+120 XP*!`;

    activeUndercoverGames.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: winners });
    return;
  }

  // Game berlanjut ke ronde berikutnya
  await startNextUndercoverRound(sock, jid, messageObj, false);
}

async function startNextUndercoverRound(sock, jid, messageObj, isFirstRound = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  session.round++;
  session.status = 'CLUE_PHASE';
  session.turnIndex = 0;
  session.detectiveChecksThisRound?.clear();
  session.silencedPlayers?.clear(); // Reset silence per round

  // Pilih Tantangan Ronde Unik
  const mod = ROUND_MODIFIERS[Math.floor(Math.random() * ROUND_MODIFIERS.length)];
  session.modifier = mod;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  const totalPot = session.buyIn * session.players.length;

  let roundHeader = '';
  if (isFirstRound) {
    const roleCounts = {};
    for (const [, r] of session.playerRoles.entries()) {
      roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
    }
    const roleSummary = [
      roleCounts.CIVILIAN ? `🧑‍🌾 ${roleCounts.CIVILIAN} Warga Sipil` : null,
      roleCounts.UNDERCOVER ? `🕵️ ${roleCounts.UNDERCOVER} Undercover` : null,
      roleCounts.MRWHITE ? `🤍 ${roleCounts.MRWHITE} Mr. White` : null,
      roleCounts.JESTER ? `🤡 ${roleCounts.JESTER} Si Badut` : null,
      roleCounts.DETECTIVE ? `🔍 ${roleCounts.DETECTIVE} Detektif` : null
    ].filter(Boolean).join(' | ');

    roundHeader = 
`🎮 *UNDERCOVER ULTRA 2.0 RESMI DIMULAI — RONDE 1* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kata rahasia telah dikirim ke DM WhatsApp masing-masing!*
🏷️ *Kategori:* ${session.pair.category}
💰 *Total Prizepool:* *${totalPot.toLocaleString('id-ID')} Poin*
🎭 *Komposisi Peran:* ${roleSummary}
🎲 *Tantangan Ronde:* *${mod.name}* (${mod.desc})

📋 *Urutan Giliran Pemain:*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran Pertama:* @${currentTurnPlayer.split('@')[0]} (Waktu 35s)
_Ketik 1 kalimat petunjuk katamu di grup ini!_
💡 _Ketik \`.undercover role\` untuk membaca panduan peran._`;
  } else {
    roundHeader = 
`🔄 *UNDERCOVER — MASUK RONDE ${session.round}* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎲 *Tantangan Ronde:* *${mod.name}* (${mod.desc})
👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran:* @${currentTurnPlayer.split('@')[0]} (Waktu 35s)
_Ketik petunjuk barumu di grup!_`;
  }

  session.timeout = setTimeout(async () => {
    if (!activeUndercoverGames.has(jid)) return;
    const cur = activeUndercoverGames.get(jid);
    if (cur.status === 'CLUE_PHASE' && cur.alivePlayers[cur.turnIndex] === currentTurnPlayer) {
      const pRole = cur.playerRoles.get(currentTurnPlayer);
      if (pRole) pRole.clue = '(Melewatkan giliran)';
      cur.turnIndex++;
      await advanceClueTurn(sock, jid, messageObj);
    }
  }, CLUE_TIMEOUT_MS);

  await send(sock, jid, messageObj, roundHeader, { mentions: session.alivePlayers });
}

// ─── 🔍 DETEKTIF INTEL VIA DM (.intip @member) ──────────────────────
export async function handleDetectiveCheck(sock, jid, senderNumber, messageObj, targetParam) {
  // Cari sesi aktif di mana senderNumber adalah DETECTIVE dan masih hidup
  let targetSession = null;
  for (const s of activeUndercoverGames.values()) {
    if (s.playerRoles?.has(senderNumber) && s.playerRoles.get(senderNumber).role === 'DETECTIVE' && s.playerRoles.get(senderNumber).isAlive) {
      targetSession = s;
      break;
    }
  }

  if (!targetSession) {
    await send(sock, jid, messageObj, "❌ Anda bukan Detektif aktif di game Undercover yang sedang berjalan!");
    return true;
  }

  if (targetSession.detectiveChecksThisRound?.has(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Anda sudah menggunakan kemampuan intip di ronde ini! Tunggu hingga ronde berikutnya.");
    return true;
  }

  let resolvedTarget = null;
  if (targetParam) {
    const parsedNum = parseInt(String(targetParam).trim(), 10);
    if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= targetSession.alivePlayers.length && !String(targetParam).includes('@')) {
      resolvedTarget = targetSession.alivePlayers[parsedNum - 1];
    } else if (targetSession.alivePlayers.includes(targetParam)) {
      resolvedTarget = targetParam;
    } else {
      const targetDigits = String(targetParam).replace(/\D/g, '');
      if (targetDigits.length > 5) {
        resolvedTarget = targetSession.alivePlayers.find(p => p.replace(/\D/g, '').includes(targetDigits) || targetDigits.includes(p.replace(/\D/g, '')));
      }
    }
  }

  if (!resolvedTarget || !targetSession.alivePlayers.includes(resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid!\n👉 *Format:* \`.intip @member\` atau \`.intip [1-${targetSession.alivePlayers.length}] (nomor urut)\``);
    return true;
  }

  if (resolvedTarget === senderNumber) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa mengintip diri sendiri!");
    return true;
  }

  targetSession.detectiveChecksThisRound.add(senderNumber);
  const targetRole = targetSession.playerRoles.get(resolvedTarget);
  const isCiv = targetRole.role === 'CIVILIAN';

  const report = isCiv 
    ? `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${resolvedTarget.split('@')[0]}\n🟢 Status: *WARGA SIPIL (CIVILIAN)* 🛡️\n\n_Target adalah sekutu warga yang aman!_`
    : `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: @${resolvedTarget.split('@')[0]}\n🔴 Status: *BUKAN WARGA (PENYAMAR / IMPOSTOR / BADUT)!* 🚨\n\n_Target sangat mencurigakan, arahkan warga untuk mem-votenya!_`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
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
`🎭 *PANDUAN LENGKAP PERAN GAME UNDERCOVER 2.0* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Undercover adalah game deduksi sosial berbasis kata rahasia via DM WhatsApp & diskusi di grup (3–8 pemain).

👥 *DAFTAR LENGKAP PERAN RAHASIA:*

1. 🧑‍🌾 *Civilian (Warga Sipil)* [Mayoritas]
▫️ *Kata Rahasia:* Menerima Kata Asli (misal: "Kopi").
▫️ *Misi:* Berikan petunjuk yang akurat agar sesama warga tahu kamu teman, jangan sampai dicurigai, dan temukan penyamar!
▫️ *Kemenangan:* Jika seluruh Undercover & Mr. White berhasil dieliminasi.

2. 🕵️ *Undercover (Penyamar / Duo)* [1-2 Orang]
▫️ *Kata Rahasia:* Menerima Kata Mirip tapi Berbeda (misal: "Teh").
▫️ *Misi:* Berikan petunjuk samar/mengecoh agar dikira warga sipil, cari tahu kata asli warga, dan bertahan sampai akhir!
▫️ *Kemenangan:* Jika jumlah Penyamar (Undercover + Mr. White) sama atau lebih banyak dari sisa Warga.

3. 🤍 *Mr. White (Blank / Hantu)* [Game 4+ Pemain]
▫️ *Kata Rahasia:* TIDAK ADA KATA (Blank / Kosong).
▫️ *Misi:* Pura-pura tahu dengan menyimak petunjuk pemain sebelumnya!
▫️ *Skill Spesial:* Jika di-vote keluar, diberi 30 detik untuk menebak kata warga (\`.tebakwarga <kata>\`). Jika tebakan benar ➔ MENANG INSTAN & SAPU BERSIH HADIAH!

4. 🤡 *Si Badut (Jester / Karbit)* [Game 5+ Pemain]
▫️ *Kata Rahasia:* Menerima Kata Asli Warga.
▫️ *Misi Gila:* Sengaja berakting aneh/mencurigakan agar di-vote keluar oleh grup!
▫️ *Kemenangan Solo:* Jika berhasil di-vote keluar di Ronde 1 atau 2 ➔ MENANG SOLO & mencuri seluruh pot taruhan!

5. 🔍 *Detektif Intel* [Game 6+ Pemain]
▫️ *Kata Rahasia:* Menerima Kata Asli Warga.
▫️ *Skill Intel:* Kirim pesan DM ke bot \`.intip @member\` untuk melacak status pemain lain!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *PERINTAH UTAMA:*
• \`.undercover [taruhan]\` — Buka lobi permainan (Default 30 Poin)
• \`.joinundercover\` — Bergabung ke lobi
• \`.startundercover\` — Memulai permainan (Minimal 3 orang)
• \`.vote [nomor/@member]\` — Vote eliminasi di fase voting
• \`.tebakwarga <kata>\` — Khusus Mr. White saat gugur
• \`.intip @member\` — Khusus Detektif via DM ke bot
• \`.undercover card\` — Buka Toko Kartu Aksi Khusus
• \`.undercover role\` — Tampilkan panduan peran ini`;

  await send(sock, jid, messageObj, guide);
  return true;
}

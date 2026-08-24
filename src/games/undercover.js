import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeUndercoverGames = new Map();
const CLUE_TIMEOUT_MS = 35 * 1000;
const VOTE_TIMEOUT_MS = 60 * 1000;

// Database Pasangan Kata Relatable & Seru (60+ Pasang Kata)
const WORD_PAIRS = [
  // Kuliner & Jajanan
  { civilian: 'INDOMIE', undercover: 'MIE SEDAAP', category: '🍜 Kuliner / Mie Instan' },
  { civilian: 'NASI PADANG', undercover: 'NASI UDUK', category: '🍛 Makanan Khas' },
  { civilian: 'KOPI SUSU', undercover: 'BOBA MILK', category: '🧋 Minuman Kekinian' },
  { civilian: 'TAHU BULAT', undercover: 'CIRENG', category: '🥟 Jajanan Gorengan' },
  { civilian: 'MARTABAK MANIS', undercover: 'TERANG BULAN', category: '🥞 Makanan Manis' },
  { civilian: 'AYAM GEPREK', undercover: 'AYAM PENYET', category: '🍗 Olahan Ayam' },
  { civilian: 'ES TEH MANIS', undercover: 'ES JERUK', category: '🍹 Minuman Warung' },
  { civilian: 'BAKSO', undercover: 'MIE AYAM', category: '🍲 Makanan Berkuah' },
  { civilian: 'SATE MADURA', undercover: 'SATE PADANG', category: '🍢 Kuliner Sate' },
  { civilian: 'RENDANG', undercover: 'GULAI', category: '🥘 Masakan Daging' },
  { civilian: 'SEBLAK', undercover: 'BASO ACI', category: '🌶️ Jajanan Pedas' },
  { civilian: 'PECEL LELE', undercover: 'BEBEK GORENG', category: '🍱 Kuliner Kaki Lima' },
  { civilian: 'ES KRIM', undercover: 'COKELAT', category: '🍦 Makanan Penutup' },
  { civilian: 'PIZZA', undercover: 'BURGER', category: '🍔 Fast Food' },
  { civilian: 'ROTI BAKAR', undercover: 'PISANG GORENG', category: '🍞 Camilan Malam' },

  // Kehidupan, Romansa & Budaya Modern
  { civilian: 'KOSAN', undercover: 'KONTRAKAN', category: '🏠 Tempat Tinggal' },
  { civilian: 'SKRIPSI', undercover: 'TUGAS AKHIR', category: '🎓 Perjuangan Kampus' },
  { civilian: 'DOSEN PEMBIMBING', undercover: 'HRD KANTOR', category: '👔 Sosok Penguji' },
  { civilian: 'MANTAN', undercover: 'GEBETAN', category: '💔 Hubungan Asmara' },
  { civilian: 'SHOPEE', undercover: 'TOKOPEDIA', category: '🛍️ Belanja Online' },
  { civilian: 'WHATSAPP', undercover: 'TELEGRAM', category: '💬 Aplikasi Chat' },
  { civilian: 'INSTAGRAM', undercover: 'TIKTOK', category: '📱 Media Sosial' },
  { civilian: 'OJEK ONLINE', undercover: 'TAKSI', category: '🛵 Transportasi Umum' },
  { civilian: 'BEGADANG', undercover: 'OVERTHINKING', category: '🌙 Kebiasaan Malam' },
  { civilian: 'GAJIAN', undercover: 'THR', category: '💵 Rezeki Finansial' },
  { civilian: 'WARKOP', undercover: 'KAFE AESTHETIC', category: '☕ Tempat Nongkrong' },
  { civilian: 'BIOSKOP', undercover: 'NETFLIX', category: '🎬 Nonton Film' },
  { civilian: 'PACARAN', undercover: 'HTS (HUBUNGAN TANPA STATUS)', category: '💘 Status Percintaan' },
  { civilian: 'PULANG KAMPUNG', undercover: 'LIBURAN', category: '🧳 Perjalanan Jauh' },
  { civilian: 'KRL', undercover: 'MRT', category: '🚆 Kereta Komuter' },

  // Hewan, Alam & Profesi
  { civilian: 'KUCING', undercover: 'HARIMAU', category: '🐾 Keluarga Kucing' },
  { civilian: 'SINGA', undercover: 'SERIGALA', category: '🐺 Predator Liar' },
  { civilian: 'PESAWAT', undercover: 'HELIKOPTER', category: '✈️ Angkutan Udara' },
  { civilian: 'PANTAI', undercover: 'GUNUNG', category: '🏞️ Objek Wisata' },
  { civilian: 'GITAR', undercover: 'BIOLA', category: '🎻 Alat Musik Petik/Gesek' },
  { civilian: 'MOBIL', undercover: 'MOTOR', category: '🚗 Kendaraan Bermotor' },
  { civilian: 'BANTAL', undercover: 'GULING', category: '🛏️ Perlengkapan Kamar' },
  { civilian: 'KACAMATA', undercover: 'LENSA KONTAK', category: '👓 Alat Bantu Penglihatan' },
  { civilian: 'DOMPET', undercover: 'REKENING BANK', category: '💳 Tempat Simpan Uang' },
  { civilian: 'DOKTER', undercover: 'PERAWAT', category: '🏥 Tenaga Medis' },
  { civilian: 'POLISI', undercover: 'SATPAM', category: '👮 Penegak Keamanan' },
  { civilian: 'PENSIL', undercover: 'PULPEN', category: '✏️ Alat Menulis' },
  { civilian: 'SUPERMARKET', undercover: 'PASAR TRADISIONAL', category: '🛒 Tempat Belanja' }
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
    playerRoles: new Map(), // jid -> { role: 'CIVILIAN'|'UNDERCOVER'|'MRWHITE'|'JESTER'|'DETECTIVE', word: string, isAlive: boolean, clue: string }
    turnIndex: 0,
    alivePlayers: [],
    votes: new Map(),
    mrWhiteGuessPending: null,
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
`🕵️ *LOBBY UNDERCOVER ULTRA — SOCIAL DEDUCTION* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host:* ${hostLabel}
👥 *Pemain (1/8):* ${hostLabel}
💰 *Taruhan:* *${buyIn} Poin* / orang

🎭 *Daftar Peran Rahasia (Diacak via DM):*
▫️ 🧑‍🌾 *Civilian (Warga)*: Mendapat kata asli.
▫️ 🕵️ *Undercover (Penyamar)*: Mendapat kata mirip tapi berbeda!
▫️ 🤍 *Mr. White (Blank)*: Tidak dapat kata, pura-pura tahu!
▫️ 🤡 *Si Badut (Jester)* (Game 5+ Orang): Ingin di-vote keluar untuk menang solo!
▫️ 🔍 *Detektif Intel* (Game 6+ Orang): Bisa mengintip status 1 pemain via DM!

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

  // Pilih pasangan kata acak
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  session.pair = pair;

  // Acak pemain untuk pembagian peran dinamis
  const shuffled = [...session.players].sort(() => 0.5 - Math.random());
  session.alivePlayers = [...shuffled];

  const count = shuffled.length;
  const undercoverJid = shuffled[0];
  const mrWhiteJid = count >= 4 ? shuffled[1] : null;
  const jesterJid = count >= 5 ? shuffled[2] : null;
  const detectiveJid = count >= 6 ? shuffled[3] : null;

  for (const p of shuffled) {
    if (p === undercoverJid) {
      session.playerRoles.set(p, { role: 'UNDERCOVER', word: pair.undercover, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang mengecoh agar dikira warga sipil! Jangan sebutkan kata rahasiamu secara langsung.` });
      } catch (e) {}
    } else if (p === mrWhiteJid) {
      session.playerRoles.set(p, { role: 'MRWHITE', word: '', isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA (BLANK)*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Anda tidak punya kata! Dengarkan petunjuk orang lain, pura-pura tahu, dan tebak kata warga jika Anda di-vote keluar!` });
      } catch (e) {}
    } else if (p === jesterJid) {
      session.playerRoles.set(p, { role: 'JESTER', word: pair.civilian, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🤡 *PERAN ANDA: SI BADUT (JESTER / KARBIT)* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Buat diri Anda DICURIGAI dan DI-VOTE KELUAR oleh grup! Jika Anda berhasil dieliminasi di Ronde 1 atau 2, Anda MENANG SOLO dan mencuri seluruh pot taruhan!` });
      } catch (e) {}
    } else if (p === detectiveJid) {
      session.playerRoles.set(p, { role: 'DETECTIVE', word: pair.civilian, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🔍 *PERAN ANDA: DETEKTIF INTEL (DETECTIVE)* 🕵️‍♂️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Temukan penyamar! Anda bisa mengintip peran pemain lain dengan membalas pesan DM ini:\n👉 Ketik: \`.cek @member\`` });
      } catch (e) {}
    } else {
      session.playerRoles.set(p, { role: 'CIVILIAN', word: pair.civilian, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat, temukan sang penyamar (Undercover), dan jangan sampai salah vote!` });
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
👉 Ketik: \`.vote @member\` atau \`.vote [1-${session.alivePlayers.length}] (nomor urut)\`
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

  await send(sock, jid, messageObj, `🗳️ @${voterPhone} mem-vote @${targetPhone}! (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [senderNumber, resolvedTarget] });

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
  for (const [, target] of session.votes.entries()) {
    voteCounts.set(target, (voteCounts.get(target) || 0) + 1);
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
`🎮 *UNDERCOVER RESMI DIMULAI — RONDE 1* 🕵️
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
💡 _Ketik \`.undercover role\` untuk melihat panduan lengkap peran._`;
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

export async function showUndercoverRoleGuide(sock, jid, messageObj) {
  const guide = 
`🎭 *PANDUAN LENGKAP PERAN GAME UNDERCOVER* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Undercover adalah game deduksi sosial berbasis kata rahasia via DM WhatsApp & diskusi di grup (3–8 pemain).

👥 *DAFTAR LENGKAP PERAN RAHASIA:*

1. 🧑‍🌾 *Civilian (Warga Sipil)* [Mayoritas]
▫️ *Kata Rahasia:* Menerima Kata Asli (misal: "Kopi").
▫️ *Misi:* Berikan petunjuk yang akurat agar sesama warga tahu kamu teman, jangan sampai dicurigai, dan temukan penyamar!
▫️ *Kemenangan:* Jika seluruh Undercover & Mr. White berhasil dieliminasi.

2. 🕵️ *Undercover (Penyamar)* [1 Orang]
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
▫️ *Tugas:* Memimpin warga sipil membongkar penyamar.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *PERINTAH UTAMA:*
• \`.undercover [taruhan]\` — Buka lobi permainan (Default 30 Poin)
• \`.joinundercover\` — Bergabung ke lobi
• \`.startundercover\` — Memulai permainan (Minimal 3 orang)
• \`.vote [nomor/@member]\` — Vote eliminasi di fase voting
• \`.tebakwarga <kata>\` — Khusus Mr. White saat gugur
• \`.undercover role\` — Tampilkan panduan peran ini`;

  await send(sock, jid, messageObj, guide);
  return true;
}

import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeUndercoverGames = new Map();

const WORD_PAIRS = [
  { civilian: 'KOPI', undercover: 'TEH', category: 'Minuman' },
  { civilian: 'PANTAI', undercover: 'GUNUNG', category: 'Tempat Wisata' },
  { civilian: 'KUCING', undercover: 'HARIMAU', category: 'Hewan' },
  { civilian: 'NASI PADANG', undercover: 'NASI UDUK', category: 'Makanan' },
  { civilian: 'GITAR', undercover: 'BIOLA', category: 'Alat Musik' },
  { civilian: 'MOBIL', undercover: 'MOTOR', category: 'Kendaraan' },
  { civilian: 'PIZZA', undercover: 'BURGER', category: 'Makanan Cepat Saji' },
  { civilian: 'SINGA', undercover: 'SERIGALA', category: 'Hewan Liar' },
  { civilian: 'BIOSKOP', undercover: 'KONSER', category: 'Hiburan' },
  { civilian: 'MATAHARI', undercover: 'BULAN', category: 'Benda Langit' },
  { civilian: 'BUKU', undercover: 'MAJALAH', category: 'Bacaan' },
  { civilian: 'PESAWAT', undercover: 'HELIKOPTER', category: 'Transportasi Udara' },
  { civilian: 'SEPATU', undercover: 'SANDAL', category: 'Alas Kaki' },
  { civilian: 'DOKTER', undercover: 'PERAWAT', category: 'Profesi Kesehatan' },
  { civilian: 'ES KRIM', undercover: 'COKELAT', category: 'Makanan Manis' },
  { civilian: 'PENSIL', undercover: 'PULPEN', category: 'Alat Tulis' },
  { civilian: 'BANTAL', undercover: 'GULING', category: 'Perlengkapan Tidur' },
  { civilian: 'SUPERMARKET', undercover: 'PASAR', category: 'Tempat Belanja' }
];

export async function handleUndercover(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Game Undercover / Impostor hanya bisa dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

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

  // Buka Lobi Baru
  if (activeUndercoverGames.has(jid)) {
    const s = activeUndercoverGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Undercover aktif di grup ini!\n👥 Pemain (${s.players.length}/8): ${s.playerLabels.join(', ')}\n\nKetik \`.joinundercover\` untuk ikut atau \`.startundercover\` untuk mulai!`);
    } else {
      await send(sock, jid, messageObj, `⚠️ Permainan Undercover sedang berlangsung di grup ini!`);
    }
    return true;
  }

  const buyIn = parseInt(args[1], 10) || 25;
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
    round: 1,
    pair: null,
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerRoles: new Map(), // jid -> { role: 'CIVILIAN'|'UNDERCOVER'|'MRWHITE', word: string, isAlive: boolean, clue: string }
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
`🕵️ *LOBBY GAME UNDERCOVER / IMPOSTOR KATA* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 Host: ${hostLabel}
👥 Pemain (1/8): ${hostLabel}
💰 Taruhan: *${buyIn} Poin* / orang

📌 *Cara Main:*
• Bot mengirim kata rahasia ke DM WhatsApp masing-masing pemain.
• Warga Sipil mendapat kata asli, Undercover mendapat kata mirip!
• Tiap pemain bergiliran menulis 1 kalimat petunjuk di grup, lalu voting eliminasi!

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

  // Potong tiket taruhan dari seluruh pemain
  for (const p of session.players) {
    await db.deductGamePoints(p, session.buyIn);
  }

  // Pilih pasangan kata acak
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  session.pair = pair;
  session.status = 'CLUE_PHASE';
  session.round = 1;

  // Acak peran
  const shuffledPlayers = [...session.players].sort(() => 0.5 - Math.random());
  session.alivePlayers = [...shuffledPlayers];

  const undercoverJid = shuffledPlayers[0];
  const hasMrWhite = shuffledPlayers.length >= 5;
  const mrWhiteJid = hasMrWhite ? shuffledPlayers[1] : null;

  for (const p of shuffledPlayers) {
    if (p === undercoverJid) {
      session.playerRoles.set(p, { role: 'UNDERCOVER', word: pair.undercover, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.undercover}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Tugas Anda:* Buat petunjuk yang mirip dengan warga sipil tanpa ketahuan! Jangan gunakan kata rahasia secara terang-terangan.` });
      } catch (e) {}
    } else if (p === mrWhiteJid) {
      session.playerRoles.set(p, { role: 'MRWHITE', word: '', isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Tugas Anda:* Anda tidak memiliki kata! Dengarkan petunjuk orang lain, pura-pura tahu, dan tebak kata warga jika Anda di-vote keluar!` });
      } catch (e) {}
    } else {
      session.playerRoles.set(p, { role: 'CIVILIAN', word: pair.civilian, isAlive: true, clue: '' });
      try {
        await sock.sendMessage(p, { text: `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n🏷️ Kategori: ${pair.category}\n\n⚠️ *Tugas Anda:* Berikan petunjuk yang akurat bagi sesama warga, dan temukan sang penyamar (Undercover)!` });
      } catch (e) {}
    }
  }

  session.turnIndex = 0;
  const currentTurnPlayer = session.alivePlayers[session.turnIndex];

  const startAnnouncement = 
`🎮 *GAME UNDERCOVER DIMULAI!* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kata rahasia telah dikirim ke DM WhatsApp masing-masing pemain!*
📦 Total Hadiah Prizepool: *${(session.buyIn * session.players.length).toLocaleString('id-ID')} Poin*
🏷️ Kategori: *${pair.category}*

📋 *Urutan Giliran Memberi Petunjuk:*
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran Pertama:* @${currentTurnPlayer.split('@')[0]}
_Ketik 1 kalimat deskripsi / petunjuk tentang katamu di grup ini!_`;

  await send(sock, jid, messageObj, startAnnouncement, { mentions: session.alivePlayers });
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

  // Cegah membocorkan kata rahasia secara terang-terangan
  const pRole = session.playerRoles.get(senderNumber);
  if (pRole?.word && cleanClue.toUpperCase().includes(pRole.word)) {
    await send(sock, jid, messageObj, "❌ DILARANG menyebutkan kata rahasia Anda secara langsung dalam petunjuk! Tulis deskripsi/kiasan lain.");
    return true;
  }

  pRole.clue = cleanClue;
  session.turnIndex++;

  if (session.turnIndex < session.alivePlayers.length) {
    const nextPlayer = session.alivePlayers[session.turnIndex];
    await send(sock, jid, messageObj, `✅ Petunjuk diterima!\n\n👉 *Giliran Selanjutnya:* @${nextPlayer.split('@')[0]}\n_Silakan tulis 1 kalimat petunjuk katamu!_`, { mentions: [nextPlayer] });
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
👉 Ketik \`.vote @member\` untuk memilih orang yang dicurigai sebagai Undercover.
⏳ Waktu voting: 60 detik.`;

    session.timeout = setTimeout(async () => {
      if (!activeUndercoverGames.has(jid)) return;
      const cur = activeUndercoverGames.get(jid);
      if (cur.status === 'VOTING_PHASE') {
        await processUndercoverVotes(sock, jid, messageObj);
      }
    }, 60 * 1000);

    await send(sock, jid, messageObj, voteList, { mentions: session.alivePlayers });
    return true;
  }
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

  // Cari target dari mention contextInfo, quoted msg, nomor urut, atau argumen
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
  const roleName = eliminatedRole.role === 'UNDERCOVER' ? '🕵️ UNDERCOVER' : eliminatedRole.role === 'MRWHITE' ? '🤍 MR. WHITE' : '🧑‍🌾 WARGA SIPIL';

  await send(sock, jid, messageObj, `☠️ *@${elimPhone}* dieliminasi dengan ${maxVotes} suara!\n🎭 Peran: *${roleName}*`, { mentions: [eliminated] });

  // Cek jika Mr. White dieliminasi
  if (eliminatedRole.role === 'MRWHITE') {
    session.status = 'MR_WHITE_GUESS';
    session.mrWhiteGuessPending = eliminated;
    await send(sock, jid, messageObj, `🤍 *MR. WHITE DIBERI KESEMPATAN TERAKHIR!* 🤍\n@${elimPhone} memiliki 30 detik untuk menebak kata warga sipil!\n👉 Ketik: \`.undercover tebakwarga <kata>\``, { mentions: [eliminated] });

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

Kata Warga: *${session.pair.civilian}*
Kata Undercover: *${session.pair.undercover}*`;

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
  const aliveCivilians = session.alivePlayers.filter(p => session.playerRoles.get(p)?.role === 'CIVILIAN');

  const totalPrize = session.buyIn * session.players.length;

  // 1. Jika seluruh penyamar mati -> Warga Sipil Menang
  if (aliveUndercovers.length === 0 && aliveMrWhite.length === 0) {
    const allCivilians = session.players.filter(p => session.playerRoles.get(p)?.role === 'CIVILIAN');
    const prizePerCiv = Math.floor(totalPrize / allCivilians.length);

    for (const c of allCivilians) {
      await db.addGamePoints(c, prizePerCiv);
      await db.addMessageXp(c, 75);
    }

    const winMsg = 
`🎉 *WARGA SIPIL MENANG! (CIVILIAN VICTORY)* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seluruh penyamar berhasil dieliminasi!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

🎁 Hadiah Tiap Warga: *+${prizePerCiv.toLocaleString('id-ID')} Poin* & *+75 XP*!
👥 Warga: ${allCivilians.map(c => `@${c.split('@')[0]}`).join(', ')}`;

    activeUndercoverGames.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: allCivilians });
    return;
  }

  // 2. Jika Undercover & Mr. White >= Warga Sipil -> Penyamar Menang
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
Penyamar berhasil mengecoh seluruh warga sipil!
💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: *${session.pair.undercover}*

🏆 Pemenang: ${winners.map(w => `@${w.split('@')[0]}`).join(', ')}
💰 Hadiah Tiap Pemenang: *+${prizePerWinner.toLocaleString('id-ID')} Poin* & *+120 XP*!`;

    activeUndercoverGames.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: winners });
    return;
  }

  // Game berlanjut ke ronde berikutnya
  await startNextUndercoverRound(sock, jid, messageObj);
}

async function startNextUndercoverRound(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  session.round++;
  session.status = 'CLUE_PHASE';
  session.turnIndex = 0;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];

  const roundMsg = 
`🔄 *UNDERCOVER — RONDE ${session.round}* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 Pemain Bertahan (${session.alivePlayers.length}):
${session.alivePlayers.map((p, i) => `${i + 1}. @${p.split('@')[0]}`).join('\n')}

👉 *Giliran:* @${currentTurnPlayer.split('@')[0]}
_Berikan petunjuk baru tentang katamu!_`;

  await send(sock, jid, messageObj, roundMsg, { mentions: session.alivePlayers });
}

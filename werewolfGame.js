/**
 * WEREWOLF / MAFIA MULTIPLAYER GAME ENGINE FOR WHATSAPP
 */

export const activeWwGames = new Map();

/**
 * Format durasi ke teks detik/menit
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${seconds} detik`;
}

/**
 * Memulai Lobby Game Werewolf di Grup
 */
export async function startWwLobby(sock, groupJid, hostJid, hostName) {
  if (activeWwGames.has(groupJid)) {
    return { success: false, message: '⚠️ Permainan Werewolf sudah berjalan atau sedang berada di lobby grup ini!' };
  }

  const session = {
    groupJid,
    hostJid,
    status: 'LOBBY', // LOBBY | NIGHT | DAY
    dayNumber: 1,
    players: [
      { jid: hostJid, name: hostName, role: null, isAlive: true, isProtected: false, votedFor: null }
    ],
    nightActions: {
      werewolfTarget: null,
      seerTarget: null,
      guardianTarget: null
    },
    timer: null
  };

  activeWwGames.set(groupJid, session);

  const text = `🐺 *LOBBY WEREWOLF GAME DIKEMBANGKAN!* 🐺\n\n` +
    `👤 *Host:* ${hostName}\n` +
    `👥 *Pemain (1):*\n1. @${hostJid.split('@')[0]}\n\n` +
    `🎮 *Cara Bergabung:* Ketik \`.ww join\`\n` +
    `🚀 *Cara Memulai:* Ketik \`.ww startgame\` (Minimal 4 Pemain)\n` +
    `❌ *Membatalkan:* Ketik \`.ww cancel\``;

  return { success: true, message: text, mentions: [hostJid] };
}

/**
 * Pemain Bergabung ke Lobby
 */
export async function joinWwLobby(sock, groupJid, playerJid, playerName) {
  const session = activeWwGames.get(groupJid);
  if (!session) return { success: false, message: '⚠️ Belum ada lobby Werewolf yang dibuka. Ketik `.ww start` untuk membuka lobby!' };
  if (session.status !== 'LOBBY') return { success: false, message: '⚠️ Permainan Werewolf sudah dimulai!' };

  if (session.players.some(p => p.jid === playerJid)) {
    return { success: false, message: `⚠️ @${playerJid.split('@')[0]} sudah bergabung di lobby!`, mentions: [playerJid] };
  }

  if (session.players.length >= 15) {
    return { success: false, message: '⚠️ Lobby Werewolf sudah penuh! (Maksimal 15 pemain)' };
  }

  session.players.push({ jid: playerJid, name: playerName, role: null, isAlive: true, isProtected: false, votedFor: null });

  let text = `✅ *@${playerJid.split('@')[0]}* berhasil bergabung ke lobby Werewolf!\n\n` +
    `👥 *Daftar Pemain (${session.players.length}):*\n`;
  session.players.forEach((p, idx) => {
    text += `${idx + 1}. @${p.jid.split('@')[0]}\n`;
  });

  return { success: true, message: text, mentions: session.players.map(p => p.jid) };
}

/**
 * Memulai Permainan (Mengacak Peran & Mengirimkan PM)
 */
export async function startGameWw(sock, groupJid, senderJid) {
  const session = activeWwGames.get(groupJid);
  if (!session) return { success: false, message: '⚠️ Tidak ada permainan Werewolf yang bisa dimulai.' };
  if (senderJid && session.hostJid && senderJid !== session.hostJid) {
    return { success: false, message: '⚠️ Hanya host yang membuat room yang dapat memulai game Werewolf!' };
  }
  if (session.status !== 'LOBBY') return { success: false, message: '⚠️ Permainan Werewolf sudah dimulai!' };
  if (session.players.length < 4) {
    return { success: false, message: `⚠️ Pemain kurang! Minimal butuh 4 pemain untuk memulai. (Saat ini: ${session.players.length} pemain)` };
  }

  // Acak urutan pemain
  const shuffled = [...session.players].sort(() => Math.random() - 0.5);
  const count = shuffled.length;

  // Tentukan Alokasi Peran
  let numWw = Math.max(1, Math.floor(count / 4));
  let numSeer = 1;
  let numGuardian = count >= 4 ? 1 : 0;

  shuffled.forEach((p, idx) => {
    if (idx < numWw) p.role = 'WEREWOLF';
    else if (idx < numWw + numSeer) p.role = 'SEER';
    else if (idx < numWw + numSeer + numGuardian) p.role = 'GUARDIAN';
    else p.role = 'VILLAGER';
  });

  session.players = shuffled;
  session.status = 'NIGHT';

  // Kirim PM Rahasia ke Setiap Pemain
  for (const p of session.players) {
    let roleText = '';
    if (p.role === 'WEREWOLF') {
      roleText = `🐺 *PERAN ANDA: WEREWOLF*\n\nTugas Anda adalah memangsa warga setiap malam! Jangan sampai ketahuan saat siang hari.\nKetik \`.ww kill <nomor/mention>\` untuk memilih korban malam ini.`;
    } else if (p.role === 'SEER') {
      roleText = `🔮 *PERAN ANDA: SEER (PERAMAL)*\n\nAnda memiliki kemampuan menerawang peran pemain lain di malam hari!\nKetik \`.ww inspect <nomor/mention>\` untuk menerawang peran pemain.`;
    } else if (p.role === 'GUARDIAN') {
      roleText = `🛡️ *PERAN ANDA: GUARDIAN (PELINDUNG)*\n\nAnda bisa melindungi 1 pemain dari serangan Werewolf di malam hari!\nKetik \`.ww protect <nomor/mention>\` untuk melindungi pemain.`;
    } else {
      roleText = `👨‍🌾 *PERAN ANDA: VILLAGER (WARGA)*\n\nAnda adalah warga desa yang polos. Bekerjasamalah dengan warga lain di siang hari untuk menemukan & mengeksekusi Werewolf!`;
    }

    try {
      await sock.sendMessage(p.jid, { text: `🌕 *WEREWOLF GAME STARTED*\n\n${roleText}` });
    } catch (e) {
      console.warn(`[WEREWOLF] Gagal kirim PM ke ${p.jid}:`, e.message);
    }
  }

  // Pengumuman Malam Pertama di Grup
  const announcement = `🌕 *MALAM HARUS TIBA (HARI KE-${session.dayNumber})* 🌙\n\n` +
    `Semua warga desa tertidur pulas...\n` +
    `🐺 Werewolf, 🔮 Seer, dan 🛡️ Guardian harap mengeksekusi aksi rahasia via PM bot (\`.ww kill\`, \`.ww inspect\`, \`.ww protect\`)!\n\n` +
    `⏰ Waktu Malam: *60 Detik*`;

  await sock.sendMessage(groupJid, { text: announcement });

  // Timer Fase Malam (60 Detik)
  session.timer = setTimeout(() => {
    processNightPhaseEnd(sock, groupJid);
  }, 60000);

  return { success: true };
}

/**
 * Proses Aksi Malam (Kill, Inspect, Protect)
 */
export async function handleNightAction(sock, senderJid, command, targetArg) {
  // Cari session aktif di mana senderJid menjadi pemain hidup
  let session = null;
  for (const s of activeWwGames.values()) {
    if (s.status === 'NIGHT' && s.players.some(p => p.jid === senderJid && p.isAlive)) {
      session = s;
      break;
    }
  }

  if (!session) return { success: false, message: '⚠️ Anda sedang tidak berada di sesi game Werewolf malam hari yang aktif.' };

  const player = session.players.find(p => p.jid === senderJid);
  if (!player || !player.isAlive) return { success: false, message: '⚠️ Anda sudah mati dalam permainan ini!' };

  // Parse Target
  let targetPlayer = null;
  const safeTargetArg = (targetArg || '').toString().trim();
  const numIndex = parseInt(safeTargetArg, 10);
  if (!isNaN(numIndex) && numIndex >= 1 && numIndex <= session.players.length) {
    targetPlayer = session.players[numIndex - 1];
  } else if (safeTargetArg.includes('@')) {
    const cleanJid = safeTargetArg.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    targetPlayer = session.players.find(p => p.jid === cleanJid);
  }

  if (!targetPlayer) {
    let listText = `⚠️ Target tidak ditemukan. Pilih nomor pemain berikut:\n`;
    session.players.forEach((p, i) => {
      if (p.isAlive) listText += `${i + 1}. ${p.name} (@${p.jid.split('@')[0]})\n`;
    });
    return { success: false, message: listText };
  }

  if (!targetPlayer.isAlive) {
    return { success: false, message: '⚠️ Pemain tersebut sudah mati!' };
  }

  if (command === 'kill' && player.role === 'WEREWOLF') {
    session.nightActions.werewolfTarget = targetPlayer.jid;
    return { success: true, message: `🐺 *Target Mangsa Dipilih:* You decided to hunt @${targetPlayer.jid.split('@')[0]} tonight!`, mentions: [targetPlayer.jid] };
  }

  if (command === 'inspect' && player.role === 'SEER') {
    session.nightActions.seerTarget = targetPlayer.jid;
    const isWw = targetPlayer.role === 'WEREWOLF';
    const resultText = isWw
      ? `🔮 *HASIL PENERAWANGAN:* @${targetPlayer.jid.split('@')[0]} ADALAH **WEREWOLF**! 🐺`
      : `🔮 *HASIL PENERAWANGAN:* @${targetPlayer.jid.split('@')[0]} ADALAH **WARGA BAIK** (Bukan Werewolf). 👨‍🌾`;
    return { success: true, message: resultText, mentions: [targetPlayer.jid] };
  }

  if (command === 'protect' && player.role === 'GUARDIAN') {
    session.nightActions.guardianTarget = targetPlayer.jid;
    return { success: true, message: `🛡️ *Target Perlindungan:* You decided to protect @${targetPlayer.jid.split('@')[0]} tonight!`, mentions: [targetPlayer.jid] };
  }

  return { success: false, message: '⚠️ Peran Anda tidak bisa menggunakan perintah ini.' };
}

/**
 * Mengakhiri Fase Malam & Memulai Fase Siang
 */
async function processNightPhaseEnd(sock, groupJid) {
  const session = activeWwGames.get(groupJid);
  if (!session || session.status !== 'NIGHT') return;

  const { werewolfTarget, guardianTarget } = session.nightActions;
  let killedPlayer = null;

  if (werewolfTarget && werewolfTarget !== guardianTarget) {
    killedPlayer = session.players.find(p => p.jid === werewolfTarget);
    if (killedPlayer) {
      killedPlayer.isAlive = false;
    }
  }

  // Reset aksi malam
  session.nightActions = { werewolfTarget: null, seerTarget: null, guardianTarget: null };

  // Cek Kondisi Menang
  const winCheck = checkWinCondition(session);
  if (winCheck.isGameOver) {
    return endGame(sock, groupJid, winCheck.winnerMessage);
  }

  // Ubah Status ke DAY
  session.status = 'DAY';
  session.players.forEach(p => p.votedFor = null);

  let resultMsg = `☀️ *MATAHARI TERBIT (SIANG HARI KE-${session.dayNumber})* 🌾\n\n`;
  if (killedPlayer) {
    resultMsg += `☠️ Warga desa terbangun dan menemukan *@${killedPlayer.jid.split('@')[0]}* telah tewas mengenaskan dimangsa Werewolf tadi malam!\n\n`;
  } else {
    resultMsg += `🛡️ *Malam yang damai!* Tidak ada korban jiwa tadi malam (Guardian berhasil melindungi target atau Werewolf tidak menyerang)!\n\n`;
  }

  resultMsg += `💬 *WAKTU DISKUSI & VOTING (90 Detik)!*\n` +
    `Diskusikan siapa yang mencurigakan dan ketik \`.ww vote @user\` atau \`.ww vote <nomor>\` untuk memilih pemain yang akan dieksekusi!\n\n` +
    `👥 *DAFTAR PEMAIN HIDUP:*\n`;

  const mentions = [];
  session.players.forEach((p, idx) => {
    if (p.isAlive) {
      resultMsg += `${idx + 1}. @${p.jid.split('@')[0]}\n`;
      mentions.push(p.jid);
    }
  });

  await sock.sendMessage(groupJid, { text: resultMsg, mentions });

  // Timer Fase Siang (90 Detik)
  session.timer = setTimeout(() => {
    processDayPhaseEnd(sock, groupJid);
  }, 90000);
}

/**
 * Voting di Siang Hari
 */
export async function handleDayVote(sock, groupJid, voterJid, targetArg) {
  const session = activeWwGames.get(groupJid);
  if (!session || session.status !== 'DAY') {
    return { success: false, message: '⚠️ Voting hanya bisa dilakukan di siang hari!' };
  }

  const voter = session.players.find(p => p.jid === voterJid);
  if (!voter || !voter.isAlive) {
    return { success: false, message: '⚠️ Anda tidak berhak melakukan voting!' };
  }

  let targetPlayer = null;
  const safeTargetArg = (targetArg || '').toString().trim();
  const numIndex = parseInt(safeTargetArg, 10);
  if (!isNaN(numIndex) && numIndex >= 1 && numIndex <= session.players.length) {
    targetPlayer = session.players[numIndex - 1];
  } else if (safeTargetArg.includes('@')) {
    const cleanJid = safeTargetArg.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    targetPlayer = session.players.find(p => p.jid === cleanJid);
  }

  if (!targetPlayer || !targetPlayer.isAlive) {
    return { success: false, message: '⚠️ Target vote tidak valid atau sudah mati!' };
  }

  voter.votedFor = targetPlayer.jid;

  const votesCount = session.players.filter(p => p.isAlive && p.votedFor === targetPlayer.jid).length;
  const totalAlive = session.players.filter(p => p.isAlive).length;

  const msg = `🗳️ *@${voterJid.split('@')[0]}* memberikan vote untuk *@${targetPlayer.jid.split('@')[0]}*! (Total Vote: ${votesCount}/${totalAlive})`;

  return { success: true, message: msg, mentions: [voterJid, targetPlayer.jid] };
}

/**
 * Mengakhiri Fase Siang (Hitung Vote & Eksekusi)
 */
async function processDayPhaseEnd(sock, groupJid) {
  const session = activeWwGames.get(groupJid);
  if (!session || session.status !== 'DAY') return;

  // Hitung Suara Vote
  const voteMap = new Map();
  session.players.filter(p => p.isAlive && p.votedFor).forEach(p => {
    voteMap.set(p.votedFor, (voteMap.get(p.votedFor) || 0) + 1);
  });

  let maxVotes = 0;
  let lynchedJid = null;
  let isTie = false;

  for (const [jid, votes] of voteMap.entries()) {
    if (votes > maxVotes) {
      maxVotes = votes;
      lynchedJid = jid;
      isTie = false;
    } else if (votes === maxVotes) {
      isTie = true;
    }
  }

  let lynchedMsg = '';
  if (lynchedJid && !isTie && maxVotes > 0) {
    const lynchedPlayer = session.players.find(p => p.jid === lynchedJid);
    lynchedPlayer.isAlive = false;
    lynchedMsg = `⚖️ *HASIL VOTING GRUP:*\n\n` +
      `Warga desa sepakat mengeksekusi *@${lynchedPlayer.jid.split('@')[0]}*!\n` +
      `Peran sebenarnya adalah: **${lynchedPlayer.role}**!\n\n`;
  } else {
    lynchedMsg = `⚖️ *HASIL VOTING GRUP:*\n\nHasil voting seimbang atau tidak ada cukup suara. Tidak ada warga yang dieksekusi hari ini!\n\n`;
  }

  // Cek Kondisi Menang
  const winCheck = checkWinCondition(session);
  if (winCheck.isGameOver) {
    return endGame(sock, groupJid, lynchedMsg + winCheck.winnerMessage);
  }

  // Lanjut ke Malam Berikutnya
  session.dayNumber += 1;
  session.status = 'NIGHT';

  lynchedMsg += `🌙 *MALAM HARI KE-${session.dayNumber} TIBA...*\nWarga kembali tertidur. Para peran khusus harap mengeksekusi aksi via PM bot!`;

  await sock.sendMessage(groupJid, { text: lynchedMsg, mentions: lynchedJid ? [lynchedJid] : [] });

  // Timer Fase Malam Berikutnya (60 Detik)
  session.timer = setTimeout(() => {
    processNightPhaseEnd(sock, groupJid);
  }, 60000);
}

/**
 * Mengecek Apakah Ada Pemenang (Kondisi Menang)
 */
function checkWinCondition(session) {
  const alivePlayers = session.players.filter(p => p.isAlive);
  const aliveWw = alivePlayers.filter(p => p.role === 'WEREWOLF');
  const aliveVillagers = alivePlayers.filter(p => p.role !== 'WEREWOLF');

  if (aliveWw.length === 0) {
    let msg = `🎉 *WARGA DESA (VILLAGERS) MENANG!* 🎉\n\nSemua Werewolf telah berhasil dimusnahkan! Desa kembali aman dan damai.\n\n`;
    msg += `👥 *DAFTAR PERAN SEMUA PEMAIN:*\n`;
    session.players.forEach(p => {
      msg += `• @${p.jid.split('@')[0]}: ${p.role}\n`;
    });
    return { isGameOver: true, winnerMessage: msg };
  }

  if (aliveWw.length >= aliveVillagers.length) {
    let msg = `🐺 *WEREWOLF MENANG!* 🐺\n\nJumlah Werewolf telah menguasai desa! Warga desa tidak memiliki cukup suara untuk bertahan.\n\n`;
    msg += `👥 *DAFTAR PERAN SEMUA PEMAIN:*\n`;
    session.players.forEach(p => {
      msg += `• @${p.jid.split('@')[0]}: ${p.role}\n`;
    });
    return { isGameOver: true, winnerMessage: msg };
  }

  return { isGameOver: false };
}

/**
 * Mengakhiri & Membersihkan Permainan Werewolf
 */
export async function endGame(sock, groupJid, finalMessage) {
  const session = activeWwGames.get(groupJid);
  if (session && session.timer) {
    clearTimeout(session.timer);
  }
  activeWwGames.delete(groupJid);

  if (finalMessage) {
    await sock.sendMessage(groupJid, { text: finalMessage });
  }
}

/**
 * Membatalkan Game oleh Host / Admin
 */
export function cancelWwGame(groupJid, senderJid, isAdmin = false) {
  const session = activeWwGames.get(groupJid);
  if (!session) return { success: false, message: '⚠️ Tidak ada game Werewolf yang aktif di grup ini.' };
  if (senderJid && session.hostJid && senderJid !== session.hostJid && !isAdmin) {
    return { success: false, message: '⚠️ Hanya host game atau admin grup yang dapat membatalkan permainan.' };
  }

  if (session.timer) clearTimeout(session.timer);
  activeWwGames.delete(groupJid);
  return { success: true, message: '🛑 Permainan Werewolf berhasil dibatalkan.' };
}

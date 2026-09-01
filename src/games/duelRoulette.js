import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeDuels = new Map();
export const pendingDuels = new Map();

const DUEL_TURN_TIMEOUT_MS = 45 * 1000;

function scheduleTurnTimer(sock, jid, session) {
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    const cur = activeDuels.get(jid);
    if (!cur || cur !== session || cur.status !== 'IN_PROGRESS') return;
    activeDuels.delete(jid);

    const afkUser = cur.turn;
    const isAfkChallenger = afkUser === cur.challenger || db.isPhoneMatch(afkUser, cur.challenger);
    const winner = isAfkChallenger ? cur.target : cur.challenger;
    const loser = isAfkChallenger ? cur.challenger : cur.target;
    const totalWin = cur.bet * 2;

    await db.addGamePoints(winner, totalWin);
    await db.grantXp(winner, 25);

    const winnerCust = await db.getCustomerByPhone(winner);
    const loserCust = await db.getCustomerByPhone(loser);
    const winnerLabel = winnerCust?.nama ? `*${winnerCust.nama}* (@${winner.split('@')[0]})` : `@${winner.split('@')[0]}`;
    const loserLabel = loserCust?.nama ? `*${loserCust.nama}* (@${loser.split('@')[0]})` : `@${loser.split('@')[0]}`;

    const timeoutMsg =
`⏰ *WAKTU GILIRAN DUEL HABIS!* 🤠
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${loserLabel} tidak menarik pelatuk dalam 45 detik dan dinyatakan *Kalah WO*!

🏆 *PEMENANG:* ${winnerLabel}
💰 Hadiah WO: *+${totalWin} Poin* & *+25 XP*!`;

    await send(sock, jid, null, timeoutMsg, { mentions: [winner, loser] });
  }, DUEL_TURN_TIMEOUT_MS);
}

// ─── 3. DUEL TEMBAK (RUSSIAN ROULETTE) ────────────────────────
async function handleDuelCommand(sock, jid, senderNumber, messageObj, args, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Permainan Duel Tembak hanya bisa dimainkan di grup!");
    return true;
  }

  const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
  const mentions = contextInfo?.mentionedJid || [];
  let targetNumber = mentions[0] || contextInfo?.participant;
  let bet = 50;

  if (!targetNumber && args[1]) {
    const res = await db.resolveTargetJid(args[1]);
    if (res?.ditemukan && res.jid) targetNumber = res.jid;
    else {
      const cleanNum = args[1].replace(/[^0-9]/g, '');
      if (cleanNum.length > 5) targetNumber = `${cleanNum}@s.whatsapp.net`;
    }
  }

  if (args[2]) bet = Math.max(10, parseInt(args[2], 10) || 50);
  else if (args[1] && !isNaN(parseInt(args[1], 10)) && !targetNumber) bet = Math.max(10, parseInt(args[1], 10));

  if (!targetNumber || targetNumber === senderNumber || db.isPhoneMatch(targetNumber, senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ *Format Perintah Duel:*\n▫️ `.duel @member [taruhan]`\n▫️ Balas/Quote pesan lawan lalu ketik `.duel [taruhan]`\n\n*Contoh:* `.duel @628123456789 100`");
    return true;
  }

  if (activeDuels.has(jid)) {
    await send(sock, jid, messageObj, "⚠️ Sedang ada duel yang berlangsung di grup ini! Tunggu hingga duel selesai.");
    return true;
  }

  const p1Prof = await db.getGameProfile(senderNumber);
  const p2Prof = await db.getGameProfile(targetNumber);

  if ((p1Prof?.points || 0) < bet) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi untuk taruhan *${bet} Poin*! (Poinmu: ${p1Prof?.points || 0})`);
    return true;
  }
  if ((p2Prof?.points || 0) < bet) {
    await send(sock, jid, messageObj, `❌ Poin lawan tidak mencukupi untuk taruhan *${bet} Poin*! (Poin lawan: ${p2Prof?.points || 0})`);
    return true;
  }

  const senderCust = await db.getCustomerByPhone(senderNumber);
  const targetCust = await db.getCustomerByPhone(targetNumber);
  const senderLabel = senderCust?.nama ? `*${senderCust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;
  const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetNumber.split('@')[0]})` : `@${targetNumber.split('@')[0]}`;

  const bulletChamber = Math.floor(Math.random() * 6);

  const duelSession = {
    jid,
    challenger: senderNumber,
    target: targetNumber,
    challengerLabel: senderLabel,
    targetLabel: targetLabel,
    bet,
    status: 'WAITING_ACCEPT',
    bulletChamber,
    currentChamber: 0,
    turn: senderNumber,
    timeout: null
  };

  duelSession.timeout = setTimeout(async () => {
    if (!activeDuels.has(jid)) return;
    activeDuels.delete(jid);
    await send(sock, jid, messageObj, `⌛ *TANTANGAN DUEL KEDALUWARSA!* Tantangan dari ${senderLabel} kepada ${targetLabel} telah dibatalkan karena tidak ada respon dalam 60 detik.`, { mentions: [senderNumber, targetNumber] });
  }, 60 * 1000);

  activeDuels.set(jid, duelSession);

  const challengeMsg = 
`🤠 *TANTANGAN DUEL TEMBAK (RUSSIAN ROULETTE)* 🔫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Penantang: ${senderLabel}
🎯 Lawan: ${targetLabel}
💰 Taruhan: *${bet} Poin* (Total Pot: *${bet * 2} Poin*)

🔫 *Peraturan Duel:*
Pistol revolver berisi 6 kamar silinder dengan *1 peluru aktif*. Pemain bergantian menarik pelatuk!

👉 ${targetLabel}, ketik:
▫️ \`.terimaduel\` atau \`.gas\` untuk menerima!
▫️ \`.tolakduel\` untuk menolak tantangan.

⏰ Waktu Respon: 60 Detik`;

  await send(sock, jid, messageObj, challengeMsg, { mentions: [senderNumber, targetNumber] });
  return true;
}

async function handleDuelAction(sock, jid, senderNumber, messageObj, command) {
  const session = activeDuels.get(jid);
  if (!session) return false;

  const isTarget = senderNumber === session.target || db.isPhoneMatch(senderNumber, session.target);
  const isChallenger = senderNumber === session.challenger || db.isPhoneMatch(senderNumber, session.challenger);

  if (['terimaduel', 'gasduel', 'gas'].includes(command)) {
    if (!isTarget) {
      await send(sock, jid, messageObj, "❌ Hanya lawan yang ditantang yang bisa menerima duel ini!");
      return true;
    }
    if (session.status !== 'WAITING_ACCEPT') return true;

    if (session.timeout) clearTimeout(session.timeout);

    const p1Deduct = await db.deductGamePoints(session.challenger, session.bet);
    if (!p1Deduct?.success) {
      activeDuels.delete(jid);
      await send(sock, jid, messageObj, `❌ Duel batal: Poin penantang (${session.challengerLabel}) sudah tidak mencukupi.`);
      return true;
    }

    const p2Deduct = await db.deductGamePoints(session.target, session.bet);
    if (!p2Deduct?.success) {
      await db.addGamePoints(session.challenger, session.bet);
      activeDuels.delete(jid);
      await send(sock, jid, messageObj, `❌ Duel batal: Poinmu tidak mencukupi untuk taruhan *${session.bet} Poin*.`);
      return true;
    }

    session.status = 'IN_PROGRESS';
    session.turn = session.challenger;
    scheduleTurnTimer(sock, jid, session);

    const startMsg = 
`🔫 *DUEL RESMI DIMULAI!* 🤠
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🥊 ${session.challengerLabel} VS ${session.targetLabel}
💰 Total Pot Taruhan: *${session.bet * 2} Poin*
🎯 Silinder pistol diputar... *KREK KREK KREK!*

👉 Giliran pertama: ${session.challengerLabel}! (Waktu: 45 detik)
Ketik: \`.tembak\` atau \`.dor\` untuk menarik pelatuk!`;

    await send(sock, jid, messageObj, startMsg, { mentions: [session.challenger, session.target] });
    return true;
  }

  if (['tolakduel'].includes(command)) {
    if (!isTarget && !isChallenger) return true;
    if (session.timeout) clearTimeout(session.timeout);
    activeDuels.delete(jid);
    await send(sock, jid, messageObj, `🏳️ Tantangan duel telah ditolak/dibatalkan.`);
    return true;
  }

  if (['tembak', 'dor', 'pull'].includes(command)) {
    if (session.status !== 'IN_PROGRESS') return true;
    const isCurrentTurn = senderNumber === session.turn || db.isPhoneMatch(senderNumber, session.turn);
    if (!isCurrentTurn) {
      await send(sock, jid, messageObj, "⏳ Tunggu giliranmu untuk menembak!");
      return true;
    }

    if (session.timeout) clearTimeout(session.timeout);

    const currentChamber = session.currentChamber;
    session.currentChamber += 1;

    const isBulletFired = currentChamber === session.bulletChamber;
    if (isBulletFired) {
      activeDuels.delete(jid);
      const isChallengerShooter = senderNumber === session.challenger || db.isPhoneMatch(senderNumber, session.challenger);
      const loser = isChallengerShooter ? session.challenger : session.target;
      const winner = isChallengerShooter ? session.target : session.challenger;
      const totalWin = session.bet * 2;

      await db.addGamePoints(winner, totalWin);
      await db.grantXp(winner, 50);

      const winnerCust = await db.getCustomerByPhone(winner);
      const loserCust = await db.getCustomerByPhone(loser);
      const winnerLabel = winnerCust?.nama ? `*${winnerCust.nama}* (@${winner.split('@')[0]})` : `@${winner.split('@')[0]}`;
      const loserLabel = loserCust?.nama ? `*${loserCust.nama}* (@${loser.split('@')[0]})` : `@${loser.split('@')[0]}`;

      const winMsg = 
`💥 *DORRRRRRRRRRR!* 💥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💀 Peluru meledak di putaran ke-${currentChamber + 1}!
🩸 ${loserLabel} tertembak dan tumbang!

🏆 *PEMENANG DUEL:* ${winnerLabel}
💰 Membawa Pulang Hadiah: *+${totalWin} Poin* & *+50 XP*!`;

      await send(sock, jid, messageObj, winMsg, { mentions: [winner, loser] });
      return true;
    } else {
      const isChallengerTurn = session.turn === session.challenger || db.isPhoneMatch(session.turn, session.challenger);
      const nextTurn = isChallengerTurn ? session.target : session.challenger;
      session.turn = nextTurn;
      scheduleTurnTimer(sock, jid, session);

      const nextCust = await db.getCustomerByPhone(nextTurn);
      const nextLabel = nextCust?.nama ? `*${nextCust.nama}* (@${nextTurn.split('@')[0]})` : `@${nextTurn.split('@')[0]}`;

      const safeMsg = 
`*KLIK!* 💨 Suara pelatuk berbunyi kosong...
Kamar ke-${currentChamber + 1} kosong! Peluru belum meledak.

👉 Sekarang giliran ${nextLabel}! (Waktu: 45 detik)
Ketik \`.tembak\` untuk menarik pelatuk!`;

      await send(sock, jid, messageObj, safeMsg, { mentions: [nextTurn] });
      return true;
    }
  }

  return false;
}


export { handleDuelCommand, handleDuelAction };
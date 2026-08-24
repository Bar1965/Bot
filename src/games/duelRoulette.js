import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeDuels = new Map();
export const pendingDuels = new Map();

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
    const cleanNum = args[1].replace(/[^0-9]/g, '');
    if (cleanNum.length > 5) targetNumber = `${cleanNum}@s.whatsapp.net`;
  }

  if (args[2]) bet = Math.max(10, parseInt(args[2], 10) || 50);
  else if (args[1] && !isNaN(parseInt(args[1], 10)) && !targetNumber) bet = Math.max(10, parseInt(args[1], 10));

  if (!targetNumber || targetNumber === senderNumber) {
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

  if (['terimaduel', 'gasduel', 'gas'].includes(command)) {
    if (senderNumber !== session.target) {
      await send(sock, jid, messageObj, "❌ Hanya lawan yang ditantang yang bisa menerima duel ini!");
      return true;
    }
    if (session.status !== 'WAITING_ACCEPT') return true;

    if (session.timeout) clearTimeout(session.timeout);
    session.status = 'IN_PROGRESS';
    session.turn = session.challenger;

    await db.deductGamePoints(session.challenger, session.bet);
    await db.deductGamePoints(session.target, session.bet);

    const startMsg = 
`🔫 *DUEL RESMI DIMULAI!* 🤠
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🥊 ${session.challengerLabel} VS ${session.targetLabel}
💰 Total Pot Taruhan: *${session.bet * 2} Poin*
🎯 Silinder pistol diputar... *KREK KREK KREK!*

👉 Giliran pertama: ${session.challengerLabel}!
Ketik: \`.tembak\` atau \`.dor\` untuk menarik pelatuk!`;

    await send(sock, jid, messageObj, startMsg, { mentions: [session.challenger, session.target] });
    return true;
  }

  if (['tolakduel'].includes(command)) {
    if (senderNumber !== session.target && senderNumber !== session.challenger) return true;
    if (session.timeout) clearTimeout(session.timeout);
    activeDuels.delete(jid);
    await send(sock, jid, messageObj, `🏳️ Tantangan duel telah ditolak/dibatalkan.`);
    return true;
  }

  if (['tembak', 'dor', 'pull'].includes(command)) {
    if (session.status !== 'IN_PROGRESS') return true;
    if (senderNumber !== session.turn) {
      await send(sock, jid, messageObj, "⏳ Tunggu giliranmu untuk menembak!");
      return true;
    }

    const currentChamber = session.currentChamber;
    session.currentChamber += 1;

    const isBulletFired = currentChamber === session.bulletChamber;
    if (isBulletFired) {
      activeDuels.delete(jid);
      const loser = senderNumber;
      const winner = loser === session.challenger ? session.target : session.challenger;
      const totalWin = session.bet * 2;

      await db.addGamePoints(winner, totalWin);
      await db.addMessageXp(winner, 50);

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
      const nextTurn = session.turn === session.challenger ? session.target : session.challenger;
      session.turn = nextTurn;

      const nextCust = await db.getCustomerByPhone(nextTurn);
      const nextLabel = nextCust?.nama ? `*${nextCust.nama}* (@${nextTurn.split('@')[0]})` : `@${nextTurn.split('@')[0]}`;

      const safeMsg = 
`*KLIK!* 💨 Suara pelatuk berbunyi kosong...
Kamar ke-${currentChamber + 1} kosong! Peluru belum meledak.

👉 Sekarang giliran ${nextLabel}!
Ketik \`.tembak\` untuk menarik pelatuk!`;

      await send(sock, jid, messageObj, safeMsg, { mentions: [nextTurn] });
      return true;
    }
  }

  return false;
}


export { handleDuelCommand, handleDuelAction };
// ─── 🀄 CAPSA SUSUN (CHINESE POKER 13 CARDS) ENGINE ──────────────
import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { createDeck, shuffleDeck, formatCards } from './deck.js';
import { autoArrangeCapsa, validateCapsaArrangement, compareScores } from './evaluator.js';

export const activeCapsaGames = new Map();

const LOBBY_TIMEOUT_MS = 90 * 1000;
const ARRANGE_TIMEOUT_MS = 60 * 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const DEFAULT_BUYIN = 50;
const MIN_BUYIN = 20;
// Batas meja, disamakan dengan TARUHAN_MAX Blackjack.
const MAX_BUYIN = 5000;

function tag(jid) {
  return `@${String(jid).split('@')[0]}`;
}

function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return db.isPhoneMatch(a, b); } catch (_) { return false; }
}

function clearSessionTimer(session) {
  if (session?.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
}

async function dm(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeBuyIn(raw) {
  const n = parseInt(raw, 10);
  const val = (!isFinite(n) || isNaN(n)) ? DEFAULT_BUYIN : n;
  return Math.min(MAX_BUYIN, Math.max(MIN_BUYIN, val));
}

async function refundCapsaSession(session) {
  if (!session) return 0;
  let refunded = 0;
  if (session.chargedPlayers && session.chargedPlayers.size > 0) {
    for (const p of session.chargedPlayers) {
      try {
        await db.addGamePoints(p, session.buyIn);
        refunded++;
      } catch (_) {}
    }
    session.chargedPlayers.clear();
  }
  return refunded;
}

/**
 * Pasang ulang timer kedaluwarsa lobi.
 *
 * startCapsaGame memanggil clearSessionTimer di awal, jadi lobi yang gagal start
 * (ada pemain yang poinnya keburu habis) dulu kehilangan timer sama sekali dan
 * mengunci grup sampai host mengetik `.batalcapsa`.
 */
function armLobbyTimer(sock, jid) {
  const sesi = activeCapsaGames.get(jid);
  if (!sesi || sesi.status !== 'LOBBY') return;
  clearSessionTimer(sesi);
  sesi.timeout = setTimeout(async () => {
    const cur = activeCapsaGames.get(jid);
    if (!cur || cur.status !== 'LOBBY') return;
    const refundCount = await refundCapsaSession(cur);
    activeCapsaGames.delete(jid);
    const refundNote = refundCount > 0 ? `\n💸 Taruhan dikembalikan ke ${refundCount} pemain.` : '';
    await send(sock, jid, null, `⌛ *LOBI CAPSA SUSUN KEDALUWARSA!* Meja dibatalkan karena tidak dimulai dalam ${LOBBY_TIMEOUT_MS / 1000} detik.${refundNote}`);
  }, LOBBY_TIMEOUT_MS);
}

/**
 * Entry point perintah Capsa Susun
 */
export async function handleCapsaSusun(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Game Capsa Susun hanya dapat dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['join', 'ikut', 'masuk'].includes(subCmd) || command === 'joincapsa') {
    return await joinCapsaLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'gas'].includes(subCmd) || command === 'startcapsa') {
    return await startCapsaGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd) || command === 'batalcapsa') {
    return await cancelCapsaGame(sock, jid, senderNumber, messageObj);
  }

  if (['auto', 'otomatis', 'siap', 'ready'].includes(subCmd)) {
    return await handlePlayerReadyCapsa(sock, jid, senderNumber, messageObj);
  }

  // Buka Lobi Baru
  if (activeCapsaGames.has(jid)) {
    const s = activeCapsaGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Capsa Susun aktif di grup ini!\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.playerLabels.join(', ')}\n💰 Taruhan: *${s.buyIn} Poin*\n\nKetik \`.capsa join\` untuk ikut atau \`.capsa start\` untuk mulai!`, { mentions: s.players });
    } else {
      await send(sock, jid, messageObj, `⚠️ Permainan Capsa Susun sedang berlangsung di grup ini! Sisa waktu susun kartu: *${Math.max(1, Math.ceil((s.expiresAt - Date.now()) / 1000))} detik*.`);
    }
    return true;
  }

  const buyIn = normalizeBuyIn(args[1]);
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka meja Capsa Susun.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerCards: new Map(),
    playerArrangements: new Map(),
    readyPlayers: new Set(),
    chargedPlayers: new Set(),
    pot: 0,
    expiresAt: 0,
    timeout: null
  };

  activeCapsaGames.set(jid, session);
  armLobbyTimer(sock, jid);

  const lobbyMsg =
`🀄 *LOBBY CAPSA SUSUN (13 KARTU)* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host Meja:* ${hostLabel}
👥 *Pemain (1/${MAX_PLAYERS}):* ${hostLabel}
💰 *Taruhan:* *${buyIn} Poin* / orang

🎴 *CARA BERMAIN:*
1. Setiap pemain akan menerima *13 Kartu Acak* via DM WhatsApp!
2. Bot otomatis menyusun kombinasi kartu terkuat (Top: 3, Mid: 5, Bot: 5).
3. Pemain cukup konfirmasi di grup dengan \`.capsa auto\` atau \`.capsa ready\`.
4. Setelah 60 detik, seluruh kartu dibuka dan diadu serentak di grup!

👉 Ketik \`.capsa join\` untuk bergabung!
🚀 Host ketik \`.capsa start\` jika sudah siap (2 - ${MAX_PLAYERS} pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

/**
 * Join lobi Capsa Susun
 */
async function joinCapsaLobby(sock, jid, senderNumber, messageObj) {
  const session = activeCapsaGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Capsa aktif. Ketik `.capsa [taruhan]` untuk membuka meja baru!");
    return true;
  }

  if (session.players.some(p => samePlayer(p, senderNumber))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah terdaftar di meja Capsa ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Meja Capsa sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
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

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil masuk meja Capsa Susun!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.capsa start\` untuk mulai!`, { mentions: session.players });
  return true;
}

/**
 * Mulai Game Capsa Susun
 */
async function startCapsaGame(sock, jid, senderNumber, messageObj) {
  const session = activeCapsaGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  // Tanpa cek host, anggota grup mana pun bisa mengetik `.startcapsa` dan
  // memaksa taruhan semua orang terpotong.
  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host meja (${tag(session.host)}) yang boleh memulai permainan!`, { mentions: [session.host] });
    return true;
  }

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai Capsa Susun!`);
    return true;
  }

  clearSessionTimer(session);

  // Potong taruhan
  const failed = [];
  for (const p of session.players) {
    const deduct = await db.deductGamePoints(p, session.buyIn);
    if (deduct?.success) {
      session.chargedPlayers.add(p);
    } else {
      failed.push(p);
    }
  }

  if (failed.length > 0) {
    await refundCapsaSession(session);
    session.status = 'LOBBY';
    armLobbyTimer(sock, jid);
    await send(sock, jid, messageObj, `❌ Gagal memulai: Poin pemain tidak cukup untuk taruhan *${session.buyIn} Poin*!\nPemain: ${failed.map(f => tag(f)).join(', ')}`, { mentions: failed });
    return true;
  }

  // 🛡️ Rekam sesi aktif ke database
  await db.createActiveGameSession({
    id: db.sesiGameId('capsa', jid),
    gameType: 'Capsa Susun (13 Kartu)',
    jid,
    host: session.host,
    buyIn: session.buyIn,
    pot: session.buyIn * session.players.length,
    players: session.players.map(p => ({ jid: p, points: session.buyIn }))
  });

  session.status = 'ARRANGING';
  session.pot = session.buyIn * session.players.length;
  session.expiresAt = Date.now() + ARRANGE_TIMEOUT_MS;

  const deck = shuffleDeck(createDeck());

  // Bagikan 13 kartu per pemain & hitung auto-arrangement terbaik
  for (const p of session.players) {
    const hand13 = [];
    for (let i = 0; i < 13; i++) {
      hand13.push(deck.pop());
    }
    session.playerCards.set(p, hand13);

    // Hitung susunan terbaik otomatis
    const auto = autoArrangeCapsa(hand13);
    session.playerArrangements.set(p, auto);

    const dmText =
`🀄 *KARTU CAPSA SUSUN ANDA (13 KARTU)* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎴 *13 Kartu Tangan:*
${formatCards(hand13)}

🤖 *SUSUNAN OTOMATIS TERBAIK:*
🔺 *Atas (3 Kartu):* ${formatCards(auto.top)} ➔ ${auto.topEval.name}
➖ *Tengah (5 Kartu):* ${formatCards(auto.middle)} ➔ ${auto.middleEval.name}
🔻 *Bawah (5 Kartu):* ${formatCards(auto.bottom)} ➔ ${auto.bottomEval.name}

💬 *Status:* Susunan otomatis telah disimpan! Ketik \`.capsa ready\` di grup jika sudah puas dengan susunan ini.`;

    await dm(sock, p, dmText);
  }

  const startMsg =
`🀄 *GAME CAPSA SUSUN DIMULAI!* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Total Pot Hadiah:* *${session.pot} Poin*
👥 *Peserta:* ${session.players.map(p => tag(p)).join(', ')}

🤫 *13 Kartu* dan susunan otomatis telah dikirim ke DM masing-masing!
⏳ *Waktu Menyusun:* 60 Detik.
👉 Ketik \`.capsa ready\` atau \`.capsa auto\` di grup ini untuk konfirmasi susunan kartu Anda!`;

  session.timeout = setTimeout(async () => {
    const cur = activeCapsaGames.get(jid);
    if (!cur || cur.status !== 'ARRANGING') return;
    await conductCapsaShowdown(sock, jid);
  }, ARRANGE_TIMEOUT_MS);

  await send(sock, jid, messageObj, startMsg, { mentions: session.players });
  return true;
}

/**
 * Pemain konfirmasi siap
 */
async function handlePlayerReadyCapsa(sock, jid, senderNumber, messageObj) {
  const session = activeCapsaGames.get(jid);
  if (!session || session.status !== 'ARRANGING') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase menyusun kartu Capsa.");
    return true;
  }

  const player = session.players.find(p => samePlayer(p, senderNumber));
  if (!player) {
    await send(sock, jid, messageObj, "❌ Kamu tidak terdaftar sebagai pemain di meja ini!");
    return true;
  }

  session.readyPlayers.add(player);
  await send(sock, jid, messageObj, `✅ ${tag(player)} telah *SIAP* dengan susunan kartunya! (${session.readyPlayers.size}/${session.players.length})`, { mentions: [player] });

  // Jika semua pemain sudah siap, langsung lakukan Showdown
  if (session.readyPlayers.size >= session.players.length) {
    clearSessionTimer(session);
    await conductCapsaShowdown(sock, jid);
  }
  return true;
}

/**
 * Showdown Capsa: Buka susunan semua pemain dan hitung skor
 */
async function conductCapsaShowdown(sock, jid) {
  const session = activeCapsaGames.get(jid);
  if (!session) return;

  clearSessionTimer(session);
  session.status = 'SHOWDOWN';

  const playerScores = new Map();
  for (const p of session.players) {
    playerScores.set(p, 0);
  }

  // Bandingkan head-to-head setiap pasangan pemain
  const n = session.players.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pA = session.players[i];
      const pB = session.players[j];
      const arrA = session.playerArrangements.get(pA);
      const arrB = session.playerArrangements.get(pB);

      let unitsA = 0;

      // Bandingkan Top (Atas)
      const cmpTop = compareScores(arrA.topEval.score, arrB.topEval.score);
      if (cmpTop > 0) unitsA += 1;
      else if (cmpTop < 0) unitsA -= 1;

      // Bandingkan Middle (Tengah)
      const cmpMid = compareScores(arrA.middleEval.score, arrB.middleEval.score);
      if (cmpMid > 0) unitsA += 1;
      else if (cmpMid < 0) unitsA -= 1;

      // Bandingkan Bottom (Bawah)
      const cmpBot = compareScores(arrA.bottomEval.score, arrB.bottomEval.score);
      if (cmpBot > 0) unitsA += 1;
      else if (cmpBot < 0) unitsA -= 1;

      // Tembak / Sweep bonus: jika menang di ketiga baris (+3 -> +6)
      if (unitsA === 3) unitsA += 3;
      if (unitsA === -3) unitsA -= 3;

      playerScores.set(pA, playerScores.get(pA) + unitsA);
      playerScores.set(pB, playerScores.get(pB) - unitsA);
    }
  }

  // Tentukan urutan peringkat pemenang
  const ranking = session.players.map(p => ({
    player: p,
    units: playerScores.get(p) || 0,
    arr: session.playerArrangements.get(p)
  }));
  ranking.sort((a, b) => b.units - a.units);

  // Tentukan pemenang poin
  const highestUnits = ranking[0].units;
  const winners = ranking.filter(r => r.units === highestUnits);
  const winShare = Math.floor(session.pot / winners.length);

  for (const w of winners) {
    await db.addGamePoints(w.player, winShare);
  }

  let breakdownText = ranking.map((r, idx) => {
    const isWin = winners.some(w => w.player === r.player);
    const medal = isWin ? '🏆' : `${idx + 1}.`;
    return `${medal} ${tag(r.player)} (Total: *${r.units > 0 ? '+' : ''}${r.units} Unit*):\n` +
      `   🔺 *Atas:* ${formatCards(r.arr.top)} ➔ ${r.arr.topEval.name}\n` +
      `   ➖ *Tengah:* ${formatCards(r.arr.middle)} ➔ ${r.arr.middleEval.name}\n` +
      `   🔻 *Bawah:* ${formatCards(r.arr.bottom)} ➔ ${r.arr.bottomEval.name}`;
  }).join('\n\n');

  const winnerTags = winners.map(w => tag(w.player)).join(' & ');
  const finalMsg =
`🀄 *HASIL SHOWDOWN CAPSA SUSUN* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Total Pot:* *${session.pot} Poin*
🎉 *PEMENANG:* ${winnerTags} (+*${winShare} Poin*${winners.length > 1 ? ' masing-masing' : ''})!

📊 *Susunan Kartu Lengkap:*
${breakdownText}

_Ketik \`.capsa [taruhan]\` untuk membuka ronde baru!_`;

  await db.finishActiveGameSession(db.sesiGameId('capsa', jid), 'COMPLETED');
  activeCapsaGames.delete(jid);
  await send(sock, jid, null, finalMsg, { mentions: session.players });
}

/**
 * Batalkan sesi Capsa
 */
async function cancelCapsaGame(sock, jid, senderNumber, messageObj) {
  const session = activeCapsaGames.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada meja Capsa Susun aktif di grup ini.");
    return true;
  }

  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, "❌ Hanya host yang dapat membatalkan permainan!");
    return true;
  }

  clearSessionTimer(session);
  const refundCount = await refundCapsaSession(session);
  await db.finishActiveGameSession(db.sesiGameId('capsa', jid), 'CANCELLED');
  activeCapsaGames.delete(jid);

  const refundNote = refundCount > 0 ? `\n💸 Taruhan buy-in dikembalikan ke ${refundCount} pemain.` : '';
  await send(sock, jid, messageObj, `🛑 Permainan Capsa Susun dibatalkan.${refundNote}`);
  return true;
}

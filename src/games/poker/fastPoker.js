// ─── ⚡ FAST 3-CARD POKER ENGINE ─────────────────────────────────
import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { createDeck, shuffleDeck, formatCards } from './deck.js';
import { evaluate3Cards, compareScores } from './evaluator.js';

export const activeFastPokerGames = new Map();

const LOBBY_TIMEOUT_MS = 60 * 1000;
const TURN_TIMEOUT_MS = 25 * 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const DEFAULT_BUYIN = 30;
const MIN_BUYIN = 10;
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

async function refundFastPokerSession(session) {
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
 * startFastPokerGame memanggil clearSessionTimer di awal, jadi lobi yang gagal
 * start (ada pemain yang poinnya keburu habis) dulu kehilangan timer sama sekali
 * dan mengunci grup sampai host mengetik `.batalfastpoker`.
 */
function armLobbyTimer(sock, jid) {
  const session = activeFastPokerGames.get(jid);
  if (!session || session.status !== 'LOBBY') return;
  clearSessionTimer(session);
  session.timeout = setTimeout(async () => {
    const cur = activeFastPokerGames.get(jid);
    if (!cur || cur.status !== 'LOBBY') return;
    const refundCount = await refundFastPokerSession(cur);
    activeFastPokerGames.delete(jid);
    const refundNote = refundCount > 0 ? `\n💸 Taruhan dikembalikan ke ${refundCount} pemain.` : '';
    await send(sock, jid, null, `⌛ *LOBI FAST POKER KEDALUWARSA!* Meja dibatalkan karena tidak dimulai dalam ${LOBBY_TIMEOUT_MS / 1000} detik.${refundNote}`);
  }, LOBBY_TIMEOUT_MS);
}

/**
 * Entry point Fast 3-Card Poker
 */
export async function handleFastPoker(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Permainan Fast Poker hanya dapat dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['join', 'ikut', 'masuk'].includes(subCmd) || command === 'joinfastpoker') {
    return await joinFastPokerLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'gas'].includes(subCmd) || command === 'startfastpoker') {
    return await startFastPokerGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd) || command === 'batalfastpoker') {
    return await cancelFastPokerGame(sock, jid, senderNumber, messageObj);
  }

  // Buka Lobi Baru
  if (activeFastPokerGames.has(jid)) {
    const s = activeFastPokerGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Fast Poker aktif di grup ini!\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.playerLabels.join(', ')}\n💰 Taruhan: *${s.buyIn} Poin*\n\nKetik \`.fastpoker join\` untuk ikut atau \`.fastpoker start\` untuk mulai!`, { mentions: s.players });
    } else {
      await send(sock, jid, messageObj, "⚠️ Sesi Fast Poker sedang berlangsung di grup ini!");
    }
    return true;
  }

  const buyIn = normalizeBuyIn(args[1]);
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka meja Fast Poker.`);
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
    foldedPlayers: new Set(),
    chargedPlayers: new Set(),
    pot: 0,
    activePlayerIndex: 0,
    timeout: null
  };

  activeFastPokerGames.set(jid, session);
  armLobbyTimer(sock, jid);

  const lobbyMsg =
`⚡ *LOBBY FAST 3-CARD POKER (POKER KILAT)* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host Meja:* ${hostLabel}
👥 *Pemain (1/${MAX_PLAYERS}):* ${hostLabel}
💰 *Taruhan Ante:* *${buyIn} Poin* / orang

⚡ *CARA BERMAIN:*
1. Setiap pemain akan menerima *3 Kartu Tangan* via DM WhatsApp!
2. Ranking: Straight Flush > Tris > Straight > Flush > Pair > High Card.
3. Showdown kilat langsung di grup!

👉 Ketik \`.fastpoker join\` untuk ikut!
🚀 Host ketik \`.fastpoker start\` jika sudah siap (Minimal ${MIN_PLAYERS} pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

/**
 * Join lobi Fast Poker
 */
async function joinFastPokerLobby(sock, jid, senderNumber, messageObj) {
  const session = activeFastPokerGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Fast Poker aktif. Ketik `.fastpoker [taruhan]` untuk membuka meja baru!");
    return true;
  }

  if (session.players.some(p => samePlayer(p, senderNumber))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di meja Fast Poker ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Meja sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
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

  await send(sock, jid, messageObj, `✅ ${userLabel} masuk meja Fast Poker!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.fastpoker start\` untuk mulai!`, { mentions: session.players });
  return true;
}

/**
 * Mulai Fast Poker
 */
async function startFastPokerGame(sock, jid, senderNumber, messageObj) {
  const session = activeFastPokerGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  // Tanpa cek host, anggota grup mana pun bisa mengetik `.startfastpoker` dan
  // memaksa ante semua orang terpotong.
  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host meja (${tag(session.host)}) yang boleh memulai permainan!`, { mentions: [session.host] });
    return true;
  }

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai Fast Poker!`);
    return true;
  }

  clearSessionTimer(session);

  // Potong Ante
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
    await refundFastPokerSession(session);
    session.status = 'LOBBY';
    armLobbyTimer(sock, jid);
    await send(sock, jid, messageObj, `❌ Gagal memulai: Poin pemain tidak cukup untuk Ante *${session.buyIn} Poin*!\nPemain: ${failed.map(f => tag(f)).join(', ')}`, { mentions: failed });
    return true;
  }

  // 🛡️ Rekam sesi aktif ke database
  await db.createActiveGameSession({
    id: db.sesiGameId('fastpoker', jid),
    gameType: 'Fast 3-Card Poker',
    jid,
    host: session.host,
    buyIn: session.buyIn,
    pot: session.buyIn * session.players.length,
    players: session.players.map(p => ({ jid: p, points: session.buyIn }))
  });

  session.status = 'SHOWDOWN';
  session.pot = session.buyIn * session.players.length;

  const deck = shuffleDeck(createDeck());
  const results = [];

  for (const p of session.players) {
    const cards3 = [deck.pop(), deck.pop(), deck.pop()];
    session.playerCards.set(p, cards3);
    const evaluated = evaluate3Cards(cards3);
    results.push({
      player: p,
      cards: cards3,
      evaluated
    });

    const dmText =
`⚡ *KARTU FAST POKER ANDA (3 KARTU)* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🃏 Kartu: ${formatCards(cards3)}
➔ *Kombinasi:* ${evaluated.name} (${evaluated.description})`;

    await dm(sock, p, dmText);
  }

  // Urutkan dari hand terkuat ke terlemah
  results.sort((a, b) => compareScores(b.evaluated.score, a.evaluated.score));

  // Tentukan pemenang
  const winners = [results[0]];
  for (let i = 1; i < results.length; i++) {
    if (compareScores(results[i].evaluated.score, winners[0].evaluated.score) === 0) {
      winners.push(results[i]);
    } else {
      break;
    }
  }

  const winShare = Math.floor(session.pot / winners.length);
  for (const w of winners) {
    await db.addGamePoints(w.player, winShare);
  }

  const winnerTags = winners.map(w => tag(w.player)).join(' & ');
  const resultLines = results.map((r, idx) => {
    const isWin = winners.some(w => w.player === r.player);
    const medal = isWin ? '🏆' : `${idx + 1}.`;
    return `${medal} ${tag(r.player)}: ${formatCards(r.cards)}\n   ➔ *${r.evaluated.name}* (${r.evaluated.description})`;
  }).join('\n\n');

  const finalMsg =
`⚡ *HASIL SHOWDOWN FAST 3-CARD POKER* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Total Pot:* *${session.pot} Poin*
🎉 *PEMENANG:* ${winnerTags} (+*${winShare} Poin*${winners.length > 1 ? ' masing-masing' : ''})!

📊 *Buka Kartu Seluruh Pemain:*
${resultLines}

_Ketik \`.fastpoker [taruhan]\` untuk bermain ronde baru!_`;

  await db.finishActiveGameSession(db.sesiGameId('fastpoker', jid), 'COMPLETED');
  activeFastPokerGames.delete(jid);
  await send(sock, jid, messageObj, finalMsg, { mentions: session.players });
  return true;
}

/**
 * Batalkan sesi Fast Poker
 */
async function cancelFastPokerGame(sock, jid, senderNumber, messageObj) {
  const session = activeFastPokerGames.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada meja Fast Poker aktif di grup ini.");
    return true;
  }

  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, "❌ Hanya host yang dapat membatalkan permainan!");
    return true;
  }

  clearSessionTimer(session);
  const refundCount = await refundFastPokerSession(session);
  await db.finishActiveGameSession(db.sesiGameId('fastpoker', jid), 'CANCELLED');
  activeFastPokerGames.delete(jid);

  const refundNote = refundCount > 0 ? `\n💸 Taruhan buy-in dikembalikan ke ${refundCount} pemain.` : '';
  await send(sock, jid, messageObj, `🛑 Meja Fast Poker berhasil dibatalkan.${refundNote}`);
  return true;
}

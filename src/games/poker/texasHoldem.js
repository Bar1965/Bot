// ─── 🤠 TEXAS HOLD'EM POKER ENGINE (STANDAR RESMI WSOP) ──────────
import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { createDeck, shuffleDeck, formatCards, formatHiddenCards } from './deck.js';
import { evaluate7Cards, compareScores } from './evaluator.js';
import { BOT_NAMES, PERSONA, isAiPlayer, decideAction, waktuBerpikir, celetukUntuk } from './pokerAi.js';

export const activeTexasGames = new Map();
// Dealer button terakhir per grup. Objek sesi dibuang tiap ronde selesai, jadi
// `session.dealerIndex = (session.dealerIndex + 1) % n` di akhir ronde selama
// ini kode mati: meja baru selalu mulai dari dealerIndex 0, host selamanya jadi
// Dealer, dan kursi 1 & 2 selamanya membayar SB/BB — padahal teks lobi
// menjanjikan posisinya berputar.
const dealerButtonTerakhir = new Map();

const LOBBY_TIMEOUT_MS = 90 * 1000;
const TURN_TIMEOUT_MS = 25 * 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const DEFAULT_BUYIN = 50;
const MIN_BUYIN = 20;
// Batas meja, disamakan dengan TARUHAN_MAX Blackjack (5.000). Tanpa batas ini
// satu ronde bisa memindahkan saldo sebesar apa pun sekaligus.
const MAX_BUYIN = 5000;

function tag(jid) {
  if (isAiPlayer(jid)) {
    const b = BOT_NAMES.find(bot => bot.id === jid);
    return b ? `*${b.name}*` : `*🤖 AI Bot*`;
  }
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

/**
 * Klaim satu giliran secara SINKRON.
 *
 * Tiga pihak bisa menyelesaikan giliran yang sama: pemain lewat perintah, timer
 * 25 detik, dan timer AI. Ketiganya melakukan `await send(...)` di tengah jalan,
 * dan antrean keluar di bot.js menahan tiap pesan 100-250 ms — jendela yang
 * lebih dari cukup untuk keduanya lolos.
 *
 * Memeriksa nomor giliran saja TIDAK cukup: nomornya baru naik di
 * advanceBettingTurn, yaitu SESUDAH pesan aksi pemain terkirim, sehingga timer
 * yang bangun di tengah jendela itu masih melihat nomor lama dan tetap jalan.
 * Diuji: pemain sempat CALL (chip terpotong) lalu tetap di-FOLD oleh timer,
 * 40 dari 40 percobaan. Kunci ini dipasang sinkron sebelum await mana pun,
 * jadi siapa yang lebih dulu sampai dialah yang menyelesaikan giliran itu.
 */
function klaimGiliran(session, seqDiharapkan) {
  if (!session || session.status !== 'PLAYING') return false;
  if (session.aksiSedangDiproses) return false;
  if (seqDiharapkan !== undefined && (session.turnSeq || 0) !== seqDiharapkan) return false;
  session.aksiSedangDiproses = true;
  return true;
}

function lepasGiliran(session) {
  if (session) session.aksiSedangDiproses = false;
}

async function dm(sock, jid, text) {
  if (isAiPlayer(jid)) return true;
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

/**
 * SATU-SATUNYA jalan chip boleh masuk pot.
 *
 * Dulu `.call` / `.raise` / `.allin` cuma menambah `session.pot` tanpa pernah
 * menyentuh stack, padahal poin nyata hanya dipotong sekali (buy-in) di awal
 * dan pemenang dibayar penuh sebesar pot. Akibatnya pot bisa jauh melampaui
 * total buy-in yang benar-benar dipotong dan selisihnya jadi poin baru —
 * `.poker vsbot 20 1` + `.poker raise 999999` sanggup mengisi saldo sampai
 * batas 1.000.000 poin dalam satu ronde.
 *
 * Sekarang chip yang masuk pot selalu dipotong dari stack, dan stack awal
 * persis sebesar buy-in yang dipotong dari saldo. Pot mustahil melebihi total
 * buy-in di meja.
 */
function commitChips(session, player, amount) {
  const stack = session.playerStacks.get(player) || 0;
  const paid = Math.max(0, Math.min(Math.floor(Number(amount)) || 0, stack));
  if (paid <= 0) {
    if (stack <= 0) session.allInPlayers.add(player);
    return 0;
  }
  session.playerStacks.set(player, stack - paid);
  session.playerBets.set(player, (session.playerBets.get(player) || 0) + paid);
  session.playerTotalContributed.set(player, (session.playerTotalContributed.get(player) || 0) + paid);
  session.pot += paid;
  if ((session.playerStacks.get(player) || 0) <= 0) session.allInPlayers.add(player);
  return paid;
}

/**
 * Susun main pot + semua side pot dari total kontribusi tiap pemain.
 *
 * Komentar lama mengklaim "Mendukung Side Pot" padahal pot dibagi rata begitu
 * saja, sehingga pemain yang all-in dengan 10 chip bisa memenangkan pot 5.000.
 */
function buildSidePots(session) {
  const contrib = new Map();
  for (const p of session.players) {
    const c = session.playerTotalContributed.get(p) || 0;
    if (c > 0) contrib.set(p, c);
  }

  const levels = [...new Set(contrib.values())].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;

  for (const level of levels) {
    let amount = 0;
    const eligible = [];
    for (const [p, c] of contrib) {
      if (c <= prev) continue;
      amount += Math.min(c, level) - prev;
      if (!session.foldedPlayers.has(p)) eligible.push(p);
    }
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }

  return pots;
}

/**
 * Batas poin NYATA yang boleh dikreditkan ke seorang pemenang.
 *
 * Bot AI tidak pernah dipotong poin (lihat startTexasGame), jadi chip mereka
 * di pot tidak ada backing-nya. Kalau dibayar penuh, meja `vsbot` jadi mesin
 * cetak poin: lawan 7 bot dengan buy-in 20 berarti pot 160 padahal cuma 20
 * poin nyata yang masuk.
 *
 * Aturannya: pemenang boleh membawa pulang seluruh uang manusia di pot, plus
 * tambahan dari chip bot maksimal 1:1 terhadap taruhannya sendiri — persis
 * konvensi bayaran Blackjack di bot ini.
 */
function realCreditCap(session, player) {
  let aiPot = 0;
  for (const p of session.players) {
    if (isAiPlayer(p)) aiPot += session.playerTotalContributed.get(p) || 0;
  }
  const humanPot = Math.max(0, session.pot - aiPot);
  const own = session.playerTotalContributed.get(player) || 0;
  return humanPot + Math.min(aiPot, own);
}

/**
 * Kredit hadiah pot ke saldo nyata pemenang, sesudah dipotong batas di atas.
 * Mengembalikan jumlah poin yang benar-benar masuk saldo.
 */
async function payoutToPlayer(session, player, amount) {
  if (isAiPlayer(player) || amount <= 0) return 0;
  const credited = Math.max(0, Math.min(Math.floor(amount), realCreditCap(session, player)));
  if (credited > 0) {
    try { await db.addGamePoints(player, credited); } catch (_) { return 0; }
  }
  return credited;
}

/**
 * Cairkan sisa chip tiap pemain kembali jadi poin di akhir ronde.
 *
 * Buy-in dipotong di awal dan ditukar jadi chip, jadi chip yang tidak jadi
 * dipertaruhkan WAJIB dikembalikan — kalau tidak, pemain yang fold di preflop
 * kehilangan seluruh buy-in padahal cuma menaruh blind.
 */
async function cashOutStacks(session) {
  const dibayar = new Map();
  for (const p of session.players) {
    const sisa = session.playerStacks.get(p) || 0;
    session.playerStacks.set(p, 0);
    if (isAiPlayer(p) || sisa <= 0) continue;
    try {
      await db.addGamePoints(p, sisa);
      dibayar.set(p, sisa);
    } catch (_) {}
  }
  // Kosongkan supaya jalur refund mana pun tidak membayar dua kali.
  session.chargedPlayers?.clear();
  return dibayar;
}

/**
 * Refund poin pemain saat meja dibatalkan.
 *
 * mode 'FULL'  → kembalikan buy-in utuh (dipakai saat ronde belum jalan).
 * mode 'STACK' → kembalikan sisa chip saja (dipakai saat ronde sudah jalan).
 *
 * Mode STACK penting: dulu `.poker batal` di tengah ronde mengembalikan buy-in
 * utuh, jadi host bisa mengintip kartunya dulu lalu membatalkan meja kalau
 * jelek — main tanpa pernah bisa rugi.
 */
async function refundTexasSession(session, mode = 'FULL') {
  if (!session) return { refunded: 0, points: 0 };
  let refunded = 0;
  let points = 0;
  if (session.chargedPlayers && session.chargedPlayers.size > 0) {
    for (const p of session.chargedPlayers) {
      if (isAiPlayer(p)) continue;
      const amount = mode === 'STACK'
        ? (session.playerStacks.get(p) || 0)
        : session.buyIn;
      if (mode === 'STACK') session.playerStacks.set(p, 0);
      if (amount <= 0) continue;
      try {
        await db.addGamePoints(p, amount);
        refunded++;
        points += amount;
      } catch (_) {}
    }
    session.chargedPlayers.clear();
  }
  await db.finishActiveGameSession(db.sesiGameId('texas', session.jid), 'CANCELLED');
  return { refunded, points };
}

/**
 * Pasang ulang timer kedaluwarsa lobi.
 *
 * Wajib dipanggil setiap kali sesi dikembalikan ke status LOBBY: `startTexasGame`
 * memanggil clearSessionTimer di awal, jadi lobi yang gagal start dulu berhenti
 * punya timer sama sekali dan mengunci grup sampai host mengetik `.poker batal`.
 */
function armLobbyTimer(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'LOBBY') return;
  clearSessionTimer(session);
  session.timeout = setTimeout(async () => {
    const cur = activeTexasGames.get(jid);
    if (!cur || cur.status !== 'LOBBY') return;
    const { refunded } = await refundTexasSession(cur, 'FULL');
    activeTexasGames.delete(jid);
    const refundNote = refunded > 0 ? `\n💸 Taruhan dikembalikan ke ${refunded} pemain.` : '';
    await send(sock, jid, null, `⌛ *LOBI TEXAS POKER KEDALUWARSA!* Meja dibatalkan karena tidak dimulai dalam ${LOBBY_TIMEOUT_MS / 1000} detik.${refundNote}`);
  }, LOBBY_TIMEOUT_MS);
}

/**
 * Entry point perintah Texas Hold'em
 */
export async function handleTexasHoldem(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Permainan Texas Hold'em Poker hanya dapat dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  // Mode Instan vs Bot (.poker vsbot [taruhan] [jumlah_bot])
  if (['vsbot', 'botvs', 'playbot'].includes(subCmd) || command === 'pokervsbot') {
    const buyIn = normalizeBuyIn(args[2]);
    const botCount = Math.min(MAX_PLAYERS - 1, Math.max(1, parseInt(args[3], 10) || 1));
    return await startInstantVsBot(sock, jid, senderNumber, messageObj, buyIn, botCount);
  }

  // Tambah Bot ke Lobi (.poker addbot [jumlah])
  if (['addbot', 'bot', 'tambahbot'].includes(subCmd)) {
    const count = parseInt(args[2], 10) || 1;
    return await addBotToTexasLobby(sock, jid, senderNumber, messageObj, count);
  }

  if (['join', 'ikut', 'masuk'].includes(subCmd) || command === 'joinpoker') {
    return await joinTexasLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'gas'].includes(subCmd) || command === 'startpoker') {
    return await startTexasGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd) || command === 'batalpoker') {
    return await cancelTexasGame(sock, jid, senderNumber, messageObj);
  }

  if (['check', 'cek', 'pass'].includes(subCmd) || command === 'check') {
    return await handlePlayerBetAction(sock, jid, senderNumber, messageObj, 'CHECK');
  }

  if (['call', 'ikutbet'].includes(subCmd) || command === 'call') {
    return await handlePlayerBetAction(sock, jid, senderNumber, messageObj, 'CALL');
  }

  if (['raise', 'tambah', 'naik'].includes(subCmd) || command === 'raise') {
    // `.poker raise 100` menaruh nominal di args[2], tapi `.raise 100` —
    // sintaks yang diiklankan bot sendiri — menaruhnya di args[1]. Dulu hanya
    // args[2] yang dibaca, jadi `.raise 100` selalu ditolak "nominal tidak valid".
    const isSubForm = ['raise', 'tambah', 'naik'].includes(subCmd);
    const amount = parseInt(isSubForm ? args[2] : args[1], 10);
    return await handlePlayerBetAction(sock, jid, senderNumber, messageObj, 'RAISE', amount);
  }

  if (['allin', 'all-in', 'habiskan'].includes(subCmd) || command === 'allin') {
    return await handlePlayerBetAction(sock, jid, senderNumber, messageObj, 'ALLIN');
  }

  if (['fold', 'tutup', 'mundur'].includes(subCmd) || command === 'fold') {
    return await handlePlayerBetAction(sock, jid, senderNumber, messageObj, 'FOLD');
  }

  if (['kartu', 'hand', 'mycards', 'cekkartu', 'kartuku'].includes(subCmd) || ['kartu', 'hand', 'mycards', 'cekkartu', 'kartuku'].includes(command)) {
    return await checkPlayerHand(sock, jid, senderNumber, messageObj);
  }

  if (['meja', 'status', 'board', 'info'].includes(subCmd)) {
    return await showTexasTable(sock, jid, messageObj);
  }

  // Buka Lobi Baru
  if (activeTexasGames.has(jid)) {
    const s = activeTexasGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Texas Poker aktif di grup ini!\n👑 Host: ${tag(s.host)}\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.playerLabels.join(', ')}\n💰 Taruhan: *${s.buyIn} Poin*\n\nKetik \`.poker join\` untuk ikut, \`.poker addbot\` untuk tambah bot, atau \`.poker start\` untuk mulai!`, { mentions: s.players.filter(p => !isAiPlayer(p)) });
    } else {
      await showTexasTable(sock, jid, messageObj);
    }
    return true;
  }

  const buyIn = normalizeBuyIn(args[1]);
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka meja Texas Poker.`);
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
    playerStacks: new Map([[senderNumber, buyIn]]),
    playerBets: new Map([[senderNumber, 0]]),
    playerTotalContributed: new Map([[senderNumber, 0]]),
    playerHoleCards: new Map(),
    foldedPlayers: new Set(),
    allInPlayers: new Set(),
    chargedPlayers: new Set(),
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    lastRaiseDiff: Math.max(10, Math.floor(buyIn * 0.2)),
    // Blind = 1/50 dan 1/25 buy-in, jadi stack awal sekitar 25 big blind.
    //
    // Rumus lama (10% dan 20% buy-in) menghasilkan TEPAT 5 big blind untuk
    // setiap buy-in, dan cuma 2 big blind di buy-in minimum. Pada kedalaman
    // itu tidak ada poker yang bisa dimainkan: satu taruhan seukuran pot sudah
    // all-in, sehingga hampir semua ronde berakhir sebagai lempar koin preflop
    // dan kartu meja cuma dibuka sebagai formalitas. Terukur: FLOP, TURN, dan
    // RIVER tercapai pada persentase ronde yang PERSIS SAMA — tanda semuanya
    // datang dari auto-runout all-in, bukan dari ronde taruhan sungguhan.
    smallBlind: Math.max(1, Math.floor(Math.max(2, Math.round(buyIn / 25)) / 2)),
    bigBlind: Math.max(2, Math.round(buyIn / 25)),
    dealerIndex: dealerButtonTerakhir.get(jid) || 0,
    sbIndex: 0,
    bbIndex: 0,
    activePlayerIndex: 0,
    // Nomor generasi giliran. clearTimeout TIDAK bisa membatalkan callback
    // setTimeout yang sudah terlanjur menyala, jadi timer basi butuh token ini
    // untuk membatalkan dirinya sendiri.
    turnSeq: 0,
    // Kunci aksi per meja, dipakai handlePlayerBetAction.
    aksiSedangDiproses: false,
    roundPhase: 'PREFLOP',
    actedThisRound: new Set(),
    bbHasOption: false,
    timeout: null
  };

  activeTexasGames.set(jid, session);
  armLobbyTimer(sock, jid);

  const lobbyMsg =
`🤠 *LOBBY TEXAS HOLD'EM POKER (STANDAR RESMI)* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host Meja:* ${hostLabel}
👥 *Pemain (1/${MAX_PLAYERS}):* ${hostLabel}
💰 *Buy-in Modal:* *${buyIn} Poin* / orang
🔹 *Blind:* SB *${session.smallBlind} Poin* | BB *${session.bigBlind} Poin*

🃏 *CARA BERMAIN:*
1. Setiap pemain menerima *2 Kartu Tangan Rahasia* via DM WhatsApp!
2. Kartu komunitas (Flop, Turn, River) & taruhan dibuka di grup.
3. Posisi Dealer Button (D), SB, & BB berputar secara resmi.
4. Gunakan command \`.check\`, \`.call\`, \`.raise <nominal>\`, \`.allin\`, atau \`.fold\`.
5. Pemenang kombinasi kartu terbaik membawa pulang seluruh Pot!

👉 Ketik \`.poker join\` untuk duduk di meja!
🤖 Ketik \`.poker addbot [jumlah]\` untuk menambah lawan AI Bot!
🚀 Host ketik \`.poker start\` jika sudah siap (Minimal ${MIN_PLAYERS} pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

/**
 * Mode Instan vs Bot (.poker vsbot [taruhan] [jumlah_bot])
 */
async function startInstantVsBot(sock, jid, senderNumber, messageObj, buyIn, botCount) {
  if (activeTexasGames.has(jid)) {
    await send(sock, jid, messageObj, "⚠️ Masih ada sesi Texas Poker aktif di grup ini. Selesaikan atau batalkan dulu dengan `.poker batal`.");
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk bermain.`);
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
    playerStacks: new Map([[senderNumber, buyIn]]),
    playerBets: new Map([[senderNumber, 0]]),
    playerTotalContributed: new Map([[senderNumber, 0]]),
    playerHoleCards: new Map(),
    foldedPlayers: new Set(),
    allInPlayers: new Set(),
    chargedPlayers: new Set(),
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    lastRaiseDiff: Math.max(10, Math.floor(buyIn * 0.2)),
    // Blind = 1/50 dan 1/25 buy-in, jadi stack awal sekitar 25 big blind.
    //
    // Rumus lama (10% dan 20% buy-in) menghasilkan TEPAT 5 big blind untuk
    // setiap buy-in, dan cuma 2 big blind di buy-in minimum. Pada kedalaman
    // itu tidak ada poker yang bisa dimainkan: satu taruhan seukuran pot sudah
    // all-in, sehingga hampir semua ronde berakhir sebagai lempar koin preflop
    // dan kartu meja cuma dibuka sebagai formalitas. Terukur: FLOP, TURN, dan
    // RIVER tercapai pada persentase ronde yang PERSIS SAMA — tanda semuanya
    // datang dari auto-runout all-in, bukan dari ronde taruhan sungguhan.
    smallBlind: Math.max(1, Math.floor(Math.max(2, Math.round(buyIn / 25)) / 2)),
    bigBlind: Math.max(2, Math.round(buyIn / 25)),
    dealerIndex: dealerButtonTerakhir.get(jid) || 0,
    sbIndex: 0,
    bbIndex: 0,
    activePlayerIndex: 0,
    // Nomor generasi giliran. clearTimeout TIDAK bisa membatalkan callback
    // setTimeout yang sudah terlanjur menyala, jadi timer basi butuh token ini
    // untuk membatalkan dirinya sendiri.
    turnSeq: 0,
    // Kunci aksi per meja, dipakai handlePlayerBetAction.
    aksiSedangDiproses: false,
    roundPhase: 'PREFLOP',
    actedThisRound: new Set(),
    bbHasOption: false,
    timeout: null
  };

  // Indeks awal diacak. Dulu selalu BOT_NAMES[0], jadi `.poker vsbot` tanpa
  // argumen SELALU melawan Bot Akbar — pemain tidak pernah bertemu enam
  // kepribadian lainnya, dan lawan defaultnya selalu itu-itu saja.
  const mulai = Math.floor(Math.random() * BOT_NAMES.length);
  for (let i = 0; i < botCount && i < BOT_NAMES.length; i++) {
    const bot = BOT_NAMES[(mulai + i) % BOT_NAMES.length];
    session.players.push(bot.id);
    session.playerLabels.push(`*${bot.name}* _(${bot.julukan})_`);
    session.playerStacks.set(bot.id, buyIn);
    session.playerBets.set(bot.id, 0);
    session.playerTotalContributed.set(bot.id, 0);
  }

  activeTexasGames.set(jid, session);
  return await startTexasGame(sock, jid, senderNumber, messageObj);
}

/**
 * Tambah AI Bot ke lobi
 */
async function addBotToTexasLobby(sock, jid, senderNumber, messageObj, count = 1) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Texas Poker aktif. Buka lobi dulu dengan `.poker [taruhan]`!");
    return true;
  }

  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host meja (${tag(session.host)}) yang boleh menambahkan AI Bot!`, { mentions: [session.host].filter(p => !isAiPlayer(p)) });
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Meja sudah penuh (${MAX_PLAYERS}/${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const availableBots = BOT_NAMES.filter(b => !session.players.includes(b.id));
  if (availableBots.length === 0) {
    await send(sock, jid, messageObj, "❌ Semua AI Bot sudah berada di meja!");
    return true;
  }

  const num = Math.min(MAX_PLAYERS - session.players.length, Math.max(1, count));
  const addedBots = [];
  for (let i = 0; i < num && i < availableBots.length; i++) {
    const bot = availableBots[i];
    session.players.push(bot.id);
    session.playerLabels.push(`*${bot.name}* _(${bot.julukan})_`);
    session.playerStacks.set(bot.id, session.buyIn);
    session.playerBets.set(bot.id, 0);
    session.playerTotalContributed.set(bot.id, 0);
    addedBots.push(`${bot.name} — _${bot.gaya}_`);
  }

  await send(sock, jid, messageObj, `🤖 Berhasil menambahkan AI Bot: ${addedBots.join(', ')} ke meja!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.poker start\` untuk mulai!`, { mentions: session.players.filter(p => !isAiPlayer(p)) });
  return true;
}

/**
 * Bergabung ke lobi Texas Poker
 */
async function joinTexasLobby(sock, jid, senderNumber, messageObj) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Texas Poker aktif. Ketik `.poker [taruhan]` untuk membuka meja baru!");
    return true;
  }

  if (session.players.some(p => samePlayer(p, senderNumber))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah duduk di meja Texas Poker ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Meja sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Butuh *${session.buyIn} Poin* untuk masuk meja.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  session.players.push(senderNumber);
  session.playerLabels.push(userLabel);
  session.playerStacks.set(senderNumber, session.buyIn);
  session.playerBets.set(senderNumber, 0);
  session.playerTotalContributed.set(senderNumber, 0);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil duduk di meja Texas Poker!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.poker start\` untuk mulai!`, { mentions: session.players.filter(p => !isAiPlayer(p)) });
  return true;
}

/**
 * Memulai permainan Texas Hold'em dengan aturan posisi resmi WSOP
 */
async function startTexasGame(sock, jid, senderNumber, messageObj) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  // Hanya host yang boleh menekan tombol start. Tanpa cek ini anggota grup mana
  // pun bisa mengetik `.poker start` dan memaksa buy-in semua orang terpotong.
  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host meja (${tag(session.host)}) yang boleh memulai permainan!`, { mentions: [session.host].filter(p => !isAiPlayer(p)) });
    return true;
  }

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai Texas Hold'em Poker! Tambah bot dengan \`.poker addbot\`.`);
    return true;
  }

  clearSessionTimer(session);

  // Potong buy-in dari saldo pemain manusia
  const failed = [];
  for (const p of session.players) {
    if (isAiPlayer(p)) {
      session.chargedPlayers.add(p);
      continue;
    }
    const deduct = await db.deductGamePoints(p, session.buyIn);
    if (deduct?.success) {
      session.chargedPlayers.add(p);
    } else {
      failed.push(p);
    }
  }

  if (failed.length > 0) {
    await refundTexasSession(session, 'FULL');
    session.status = 'LOBBY';
    armLobbyTimer(sock, jid);
    await send(sock, jid, messageObj, `❌ Gagal memulai: Ada pemain yang poinnya tidak cukup untuk buy-in *${session.buyIn} Poin*!\nPemain: ${failed.map(f => tag(f)).join(', ')}`, { mentions: failed });
    return true;
  }

  // 🛡️ REKAM SESI KE DATABASE UNTUK PROTEKSI CRASH / RESTART
  await db.createActiveGameSession({
    id: db.sesiGameId('texas', jid),
    gameType: "Texas Hold'em Poker",
    jid,
    host: session.host,
    buyIn: session.buyIn,
    pot: session.buyIn * session.players.length,
    players: session.players.map(p => ({ jid: p, points: session.buyIn }))
  });

  // Buat & Kocok Deck
  session.deck = shuffleDeck(createDeck());
  session.communityCards = [];
  session.status = 'PLAYING';
  session.roundPhase = 'PREFLOP';
  session.pot = 0;
  session.currentBet = 0;
  session.lastRaiseDiff = session.bigBlind;
  session.foldedPlayers = new Set();
  session.allInPlayers = new Set();
  session.actedThisRound = new Set();
  session.aggressor = null;
  session.aggressorLalu = null;
  session.adaRaisePreflop = false;
  session.aiPending = null;
  session.celetukPending = null;

  // Bagikan 2 kartu hole ke masing-masing pemain
  for (const p of session.players) {
    const card1 = session.deck.pop();
    const card2 = session.deck.pop();
    session.playerHoleCards.set(p, [card1, card2]);
    session.playerBets.set(p, 0);
    session.playerTotalContributed.set(p, 0);
    // Stack = chip yang benar-benar dibeli. Ini plafon taruhan pemain untuk
    // seluruh ronde, dan sekaligus plafon pot meja.
    session.playerStacks.set(p, session.buyIn);

    if (!isAiPlayer(p)) {
      const dmText =
`🃏 *KARTU TANGAN TEXAS POKER ANDA* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kartu Rahasia: ${formatCards([card1, card2])}

📍 *Meja Grup:* ${jid}
💰 *Buy-in:* ${session.buyIn} Poin

⚠️ _Jaga kerahasiaan kartu Anda dari pemain lain! Lihat kartu komunitas dan giliran taruhan di grup._`;

      await dm(sock, p, dmText);
    }
  }

  // ─── 📐 PERHITUNGAN POSISI RESMI WSOP ───
  const n = session.players.length;
  const dIdx = session.dealerIndex % n;
  const dealerPlayer = session.players[dIdx];

  let sbIdx, bbIdx, utgIdx;

  if (n === 2) {
    // Heads-Up: Dealer adalah Small Blind dan jalan pertama di pre-flop
    sbIdx = dIdx;
    bbIdx = (dIdx + 1) % 2;
    utgIdx = sbIdx; // Pre-flop start: SB
  } else {
    // Multiplayer (3-8 pemain)
    sbIdx = (dIdx + 1) % n;
    bbIdx = (dIdx + 2) % n;
    utgIdx = (dIdx + 3) % n; // Pre-flop start: UTG
  }

  session.sbIndex = sbIdx;
  session.bbIndex = bbIdx;
  session.activePlayerIndex = utgIdx;
  session.turnSeq = (session.turnSeq || 0) + 1;
  session.bbHasOption = true;

  const sbPlayer = session.players[sbIdx];
  const bbPlayer = session.players[bbIdx];

  // Blind ikut dipotong dari stack lewat commitChips, bukan ditulis langsung ke
  // pot — supaya invarian "pot == total chip yang keluar dari stack" tetap utuh.
  const sbAmount = commitChips(session, sbPlayer, session.smallBlind);
  const bbAmount = commitChips(session, bbPlayer, session.bigBlind);
  session.currentBet = Math.max(sbAmount, bbAmount);

  const activeP = session.players[session.activePlayerIndex];
  const startMsg =
`🃏 *GAME TEXAS HOLD'EM DIMULAI (STANDAR RESMI)* 🚀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Dealer Button (D):* ${tag(dealerPlayer)}
🔹 *Small Blind (SB):* ${tag(sbPlayer)} (*${sbAmount} Poin*)
🔸 *Big Blind (BB):* ${tag(bbPlayer)} (*${bbAmount} Poin*)
💰 *Total Pot:* *${session.pot} Poin*

🤫 *2 Kartu Tangan* telah dikirim ke DM pemain manusia!
Meja Komunitas: ${formatHiddenCards(5)}

🔔 *GILIRAN PERTAMA (UTG):* ${tag(activeP)} (*Taruhan aktif: ${session.currentBet} Poin*)
_Ketik \`.call\`, \`.raise <nominal>\`, \`.allin\`, atau \`.fold\` (Waktu: ${TURN_TIMEOUT_MS / 1000}s)_`;

  // Semua nama yang ditulis pakai tag() WAJIB ikut di array mentions. Dulu
  // hanya UTG yang masuk, sehingga Dealer/SB/BB tampil sebagai deretan digit
  // @lid mentah — tidak bisa diklik, tidak menotifikasi, dan pemain tidak tahu
  // dirinya kena blind. Kursi AI sengaja dikecualikan: tag() mengembalikan
  // *NamaBot* yang memang tidak butuh mention.
  const mention = [...new Set([dealerPlayer, sbPlayer, bbPlayer, activeP])].filter(p => !isAiPlayer(p));
  await send(sock, jid, messageObj, startMsg, { mentions: mention });
  armTurnTimer(sock, jid);
  return true;
}

/**
 * Timer giliran aksi pemain (Human: 25s, AI: 1.5s - 2.5s)
 */
function armTurnTimer(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  const activeP = session.players[session.activePlayerIndex];
  // Kunci generasi giliran SAAT timer dipasang. clearTimeout tidak bisa
  // membatalkan callback setTimeout yang sudah terlanjur menyala, jadi kalau
  // saat callback jalan nomornya sudah berubah berarti pemain keburu bertindak
  // sendiri di detik-detik terakhir dan giliran sudah pindah — callback ini
  // wajib bunuh diri. Tanpa ini, callback basi memproses aksi untuk orang yang
  // gilirannya sudah lewat lalu memajukan giliran untuk KEDUA kalinya,
  // sehingga pemain berikutnya di-tag "GILIRANMU" lalu langsung dilangkahi.
  // Terbukti terjadi 40 dari 40 percobaan saat diuji dengan timer dipercepat.
  const mySeq = session.turnSeq || 0;

  // Giliran AI Bot
  if (isAiPlayer(activeP)) {
    // Keputusan dihitung SEKARANG, sebelum jeda, supaya lama berpikirnya bisa
    // mengikuti sulitnya keputusan. Dulu semua bot menunggu 1500-2500 ms acak
    // seragam apa pun yang mereka lakukan — tanda robot paling telanjang di
    // sistem ini. Manusia melipat sampah dalam sekejap dan menyiksa diri lama
    // di river.
    const ctx = bangunKonteksAi(session, activeP);
    const decision = decideAction(ctx);
    session.aiPending = { player: activeP, decision, ctx };
    const gaya = PERSONA[ctx.persona];
    const banyakBot = session.players.filter(isAiPlayer).length >= 4;
    const thinkDelay = waktuBerpikir({
      tipis: decision.action === 'FOLD' ? 0.1 : 0.6,
      aksi: decision.action,
      fase: ctx.fase,
      tempo: gaya ? gaya.tempo : 1,
      banyakBot
    });
    session.timeout = setTimeout(async () => {
      const cur = activeTexasGames.get(jid);
      if (!cur || cur !== session) return;
      if (!klaimGiliran(cur, mySeq)) return;
      try {
        await handleAiTurn(sock, jid, activeP);
      } finally {
        lepasGiliran(cur);
      }
    }, thinkDelay);
    return;
  }

  // Giliran Human
  session.timeout = setTimeout(async () => {
    const cur = activeTexasGames.get(jid);
    if (!cur || cur !== session) return;
    // Klaim SEBELUM await apa pun. Kalau pemain sudah lebih dulu memegang
    // giliran ini, timer diam — pemain sempat bertindak, jadi tidak boleh
    // dianggap kehabisan waktu.
    if (!klaimGiliran(cur, mySeq)) return;
    try {
      const currentActiveP = cur.players[cur.activePlayerIndex];
      const playerBet = cur.playerBets.get(currentActiveP) || 0;
      const otomatis = playerBet >= cur.currentBet ? 'CHECK' : 'FOLD';

      await send(sock, jid, null, `⏰ Waktu habis! ${tag(currentActiveP)} otomatis *${otomatis}*.`, {
        mentions: isAiPlayer(currentActiveP) ? [] : [currentActiveP]
      });
      await processBetAction(sock, jid, currentActiveP, otomatis, 0);
    } finally {
      lepasGiliran(cur);
    }
  }, TURN_TIMEOUT_MS);
}

/**
 * Proses keputusan AI Bot saat gilirannya
 */
/**
 * Berapa pemain yang masih akan bicara SESUDAH kita di ronde taruhan ini.
 *
 * Ini satu-satunya angka posisi yang dipakai AI, dan otomatis benar untuk meja
 * 2..8 tanpa cabang khusus. Pembicara terakhir pre-flop adalah BB, post-flop
 * adalah Dealer Button. Bot lama nol tahu soal posisi, jadi bot di button main
 * seketat bot di UTG — padahal keduanya menghadapi situasi yang sama sekali
 * berbeda.
 */
function hitungPemainDiBelakang(session, myIdx) {
  const n = session.players.length;
  const hidup = i => {
    const p = session.players[i];
    return !session.foldedPlayers.has(p) && !session.allInPlayers.has(p);
  };
  const akhir = session.roundPhase === 'PREFLOP'
    ? session.bbIndex
    : (session.dealerIndex % n);
  if (myIdx === akhir) return 0;
  let c = 0;
  for (let i = 1; i <= n; i++) {
    const idx = (myIdx + i) % n;
    if (hidup(idx)) c++;
    if (idx === akhir) break;
  }
  return c;
}

/**
 * Rakit semua yang boleh diketahui AI.
 *
 * LARANGAN KERAS: jangan pernah memasukkan session.deck atau kartu pemain lain.
 * Itu curang, dan sekali bocor pemain akan merasakannya lewat call-call mustahil.
 */
function bangunKonteksAi(session, botId) {
  const n = session.players.length;
  const myIdx = session.players.indexOf(botId);
  const hidup = session.players.filter(p => !session.foldedPlayers.has(p));
  const bisaBet = hidup.filter(p => !session.allInPlayers.has(p) && p !== botId);
  const myStack = session.playerStacks.get(botId) || 0;
  const lawanMax = bisaBet.reduce((m, p) => Math.max(m, session.playerStacks.get(p) || 0), 0);
  const playerBet = session.playerBets.get(botId) || 0;
  const pb = hitungPemainDiBelakang(session, myIdx);
  const cfg = BOT_NAMES.find(b => b.id === botId);
  return {
    persona: (cfg && cfg.persona) || 'PROFESOR',
    fase: session.roundPhase,
    hole: session.playerHoleCards.get(botId) || [],
    board: session.communityCards || [],
    pot: session.pot,
    toCall: Math.max(0, session.currentBet - playerBet),
    minRaise: session.lastRaiseDiff,
    bigBlind: session.bigBlind,
    myStack,
    effStack: Math.min(myStack, lawanMax || myStack),
    nOpp: Math.max(1, hidup.length - 1),
    playersBehind: pb,
    inPosition: pb === 0,
    isSmallBlind: myIdx === session.sbIndex,
    adaRaise: session.currentBet > session.bigBlind,
    adaRaisePreflop: !!session.adaRaisePreflop,
    akuAgresor: session.aggressorLalu === botId
  };
}

async function handleAiTurn(sock, jid, aiPlayer) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  // Keputusan biasanya sudah dihitung di armTurnTimer supaya lama berpikirnya
  // bisa mengikuti sulitnya keputusan. Kalau tidak ada, hitung sekarang.
  const ctx = (session.aiPending && session.aiPending.player === aiPlayer)
    ? session.aiPending.ctx
    : bangunKonteksAi(session, aiPlayer);
  const decision = (session.aiPending && session.aiPending.player === aiPlayer)
    ? session.aiPending.decision
    : decideAction(ctx);
  session.aiPending = null;

  // Celetuk disalurkan lewat field session, BUKAN parameter: processBetAction
  // memanggil dirinya sendiri (CHECK->CALL, RAISE->ALLIN) tanpa meneruskan
  // argumen tambahan.
  const gaya = PERSONA[ctx.persona];
  session.celetukPending = celetukUntuk(
    ctx.persona,
    ctx.toCall > ctx.pot * 0.6 ? 'ditekan'
      : decision.action === 'ALLIN' ? 'shove'
      : ctx.nOpp >= 3 ? 'ramai' : 'biasa',
    gaya ? gaya.mulut : 0.2
  );

  await processBetAction(sock, jid, aiPlayer, decision.action, decision.amount);
}

/**
 * Handle aksi betting pemain (.check, .call, .raise, .allin, .fold)
 */
async function handlePlayerBetAction(sock, jid, senderNumber, messageObj, action, amount = 0) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi taruhan Texas Poker aktif di grup ini.");
    return true;
  }

  const activeP = session.players[session.activePlayerIndex];
  if (!samePlayer(activeP, senderNumber)) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(activeP)} untuk bertindak.`, { mentions: [activeP].filter(p => !isAiPlayer(p)) });
    return true;
  }

  // Kunci aksi per meja, dipakai bersama timer 25 detik dan timer AI.
  //
  // Handler `messages.upsert` di bot.js tidak menyerialkan pesan antar-event,
  // jadi dua `.call` beruntun (kebiasaan pemain saat bot terasa lambat) bisa
  // berjalan bersamaan: keduanya lolos gerbang di atas karena activePlayerIndex
  // belum bergeser, keduanya sampai ke advanceBettingTurn, dan giliran melompat
  // DUA orang sekaligus — pemain di tengah di-tag "GILIRANMU" lalu langsung
  // dilewati. Kunci dipasang di titik masuk, bukan di processBetAction, supaya
  // rekursi CHECK->CALL tidak mengunci dirinya sendiri.
  if (!klaimGiliran(session)) return true;
  try {
    return await processBetAction(sock, jid, activeP, action, amount, messageObj);
  } finally {
    lepasGiliran(session);
  }
}

/**
 * Proses logika taruhan pemain (Human & AI) sesuai WSOP
 */
async function processBetAction(sock, jid, player, action, amount = 0, messageObj = null) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  // Gerbang identitas giliran. handlePlayerBetAction memang sudah mengeceknya,
  // tapi tiga pemanggil lain (timer 25 detik, timer AI, rekursi CHECK->CALL)
  // TIDAK lewat sana. Tanpa cek ini, aksi dari rantai yang sudah basi tetap
  // diterima, lalu advanceBettingTurn di bawah memajukan giliran dari
  // activePlayerIndex yang SUDAH pindah — pemain berikutnya di-tag "GILIRANMU"
  // lalu langsung dilangkahi tanpa pernah bisa bertindak.
  if (session.players[session.activePlayerIndex] !== player) return false;
  // Pemain yang sudah fold/all-in tidak punya aksi lagi. Ini menutup "ronde
  // taruhan hantu" saat papan sudah lengkap dan jeda showdown 1,8 detik keburu
  // dibunuh oleh aksi susulan.
  if (session.foldedPlayers.has(player) || session.allInPlayers.has(player)) return false;

  clearSessionTimer(session);

  const currentBet = session.currentBet;
  const playerBet = session.playerBets.get(player) || 0;
  const toCall = currentBet - playerBet;
  const mention = isAiPlayer(player) ? [] : [player];

  // Celetuk kepribadian ditempel ke pesan aksi yang SUDAH pasti terkirim, jadi
  // biayanya nol pesan tambahan. Digerbangi isAiPlayer supaya celetuk sisa
  // giliran bot tidak pernah menempel ke aksi manusia.
  const bumbu = (isAiPlayer(player) && session.celetukPending)
    ? `  _"${session.celetukPending}"_` : '';
  session.celetukPending = null;

  if (action === 'FOLD') {
    // Fold dua kali tidak boleh memicu penyelesaian ronde dua kali.
    if (session.foldedPlayers.has(player)) return true;
    session.foldedPlayers.add(player);
    await send(sock, jid, messageObj, `🏳️ ${tag(player)} melakukan *FOLD* (menyerah).${bumbu}`, { mentions: mention });

    const alive = session.players.filter(p => !session.foldedPlayers.has(p));
    if (alive.length === 1) {
      await finishTexasByFold(sock, jid, alive[0]);
      return true;
    }
  } else if (action === 'CHECK') {
    if (toCall > 0) {
      if (isAiPlayer(player)) {
        return await processBetAction(sock, jid, player, 'CALL', 0);
      }
      await send(sock, jid, messageObj, `❌ Tidak bisa *CHECK* karena ada taruhan aktif sebesar *${currentBet} Poin*! Gunakan \`.call\` (${toCall} Poin) atau \`.fold\`.`);
      armTurnTimer(sock, jid);
      return true;
    }
    await send(sock, jid, messageObj, `👌 ${tag(player)} melakukan *CHECK*.${bumbu}`, { mentions: mention });
  } else if (action === 'CALL') {
    if (toCall <= 0) {
      await send(sock, jid, messageObj, `👌 ${tag(player)} melakukan *CHECK*.${bumbu}`, { mentions: mention });
    } else {
      // commitChips otomatis memotong ke sisa stack: kalau chip tidak cukup
      // untuk menyamai taruhan, pemain jadi all-in dengan sisa chipnya (call
      // pendek) — bukan diam-diam menyetor chip yang tidak dia punya.
      const paid = commitChips(session, player, toCall);
      const shortAllIn = paid < toCall;
      const note = shortAllIn ? ` — *ALL-IN* dengan sisa chip!` : '';
      await send(sock, jid, messageObj, `📞 ${tag(player)} melakukan *CALL* (+${paid} Poin)${note}${bumbu}\n💰 Total Pot: *${session.pot} Poin* | Sisa chip: *${session.playerStacks.get(player) || 0}*`, { mentions: mention });
    }
  } else if (action === 'RAISE') {
    const raiseVal = Math.floor(Number(amount));
    const minRequiredRaise = session.lastRaiseDiff;
    const stack = session.playerStacks.get(player) || 0;
    const maxRaise = Math.max(0, stack - toCall); // sisa chip sesudah menyamai taruhan

    if (isNaN(raiseVal) || raiseVal < minRequiredRaise) {
      if (isAiPlayer(player)) {
        return await processBetAction(sock, jid, player, 'CALL', 0);
      }
      await send(sock, jid, messageObj, `❌ Nilai raise minimal adalah *+${minRequiredRaise} Poin* di atas taruhan saat ini! Contoh: \`.raise ${minRequiredRaise}\``);
      armTurnTimer(sock, jid);
      return true;
    }

    // Raise yang melebihi sisa chip = all-in, bukan taruhan fiktif. Dulu tidak
    // ada cek ini sama sekali sehingga `.raise 999999` dengan stack 20 tetap
    // diterima dan menggelembungkan pot jadi poin nyata di akhir ronde.
    if (raiseVal > maxRaise) {
      if (isAiPlayer(player)) {
        return await processBetAction(sock, jid, player, 'ALLIN', 0);
      }
      await send(sock, jid, messageObj, `❌ Chipmu tidak cukup! Sisa chip *${stack} Poin*, untuk menyamai taruhan butuh *${toCall} Poin*.\n➔ Raise maksimal kamu: *+${maxRaise} Poin*. Ketik \`.allin\` kalau mau menaruh seluruh sisa chip.`);
      armTurnTimer(sock, jid);
      return true;
    }

    const added = commitChips(session, player, toCall + raiseVal);
    const newBet = session.playerBets.get(player) || 0;
    session.lastRaiseDiff = raiseVal; // Update min-raise delta
    // Siapa penyerang terakhir di street ini. Dipakai AI untuk memutuskan
    // continuation bet di street berikutnya.
    session.aggressor = player;
    if (session.roundPhase === 'PREFLOP') session.adaRaisePreflop = true;
    session.currentBet = newBet;
    session.actedThisRound.clear();
    session.bbHasOption = false; // Option hilang begitu ada raise

    await send(sock, jid, messageObj, `🔥 ${tag(player)} melakukan *RAISE* sebesar *+${raiseVal} Poin* (setor ${added})! Taruhan sekarang: *${newBet} Poin*.${bumbu}\n💰 Total Pot: *${session.pot} Poin* | Sisa chip: *${session.playerStacks.get(player) || 0}*`, { mentions: mention });
  } else if (action === 'ALLIN') {
    // ALL-IN = seluruh sisa chip. Rumus lama (currentBet + max(lastRaiseDiff*2, 50))
    // tidak ada hubungannya dengan stack pemain: buy-in 20 bisa "all-in" 60.
    const stack = session.playerStacks.get(player) || 0;
    if (stack <= 0) {
      session.allInPlayers.add(player);
      await send(sock, jid, messageObj, `💥 ${tag(player)} sudah *ALL-IN* (chip habis).`, { mentions: mention });
    } else {
      const added = commitChips(session, player, stack);
      const newBet = session.playerBets.get(player) || 0;

      if (newBet > currentBet) {
        // All-in yang membuka taruhan baru → ronde taruhan dibuka ulang.
        session.lastRaiseDiff = Math.max(session.bigBlind, newBet - currentBet);
        session.currentBet = newBet;
        session.aggressor = player;
        if (session.roundPhase === 'PREFLOP') session.adaRaisePreflop = true;
        session.actedThisRound.clear();
        session.bbHasOption = false;
        await send(sock, jid, messageObj, `💥 ${tag(player)} menyatakan *ALL-IN* dengan *${added} Poin*! Taruhan naik jadi *${newBet} Poin*.${bumbu}\n💰 Total Pot: *${session.pot} Poin*.`, { mentions: mention });
      } else {
        // All-in pendek: tidak menyamai taruhan, jadi tidak membuka ronde baru.
        await send(sock, jid, messageObj, `💥 ${tag(player)} *ALL-IN pendek* dengan sisa *${added} Poin* (di bawah taruhan ${currentBet}).${bumbu}\n💰 Total Pot: *${session.pot} Poin* — sisanya masuk side pot.`, { mentions: mention });
      }
    }
  }

  session.actedThisRound.add(player);
  await db.updateActiveGameSession(db.sesiGameId('texas', jid), { pot: session.pot });
  await advanceBettingTurn(sock, jid);
  return true;
}

/**
 * Pindah giliran pemain atau maju ke ronde kartu berikutnya (Flop/Turn/River/Showdown)
 */
async function advanceBettingTurn(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  const nonFolded = session.players.filter(p => !session.foldedPlayers.has(p));

  const allBetsEqual = nonFolded.every(p => (session.playerBets.get(p) || 0) === session.currentBet || session.allInPlayers.has(p));
  const allActed = nonFolded.every(p => session.actedThisRound.has(p) || session.allInPlayers.has(p));

  // Opsi Big Blind di Pre-flop: menurut WSOP, BB berhak bicara PALING AKHIR
  // setelah semua orang menyamai — itulah gunanya "option".
  //
  // Syarat `allBetsEqual` + "semua non-BB sudah bertindak" WAJIB ada. Dulu blok
  // ini hanya memeriksa BB sendiri, jadi ia menyala pada aksi pre-flop PERTAMA:
  // giliran langsung dilempar ke BB sementara Dealer/SB/MP/CO belum pernah
  // ditanya (mereka lalu ditolak "Bukan giliranmu"), UTG mendapat giliran dua
  // kali, dan option BB yang sesungguhnya hangus karena bbHasOption sudah
  // dikonsumsi terlalu cepat. Pesan "Semua pemain telah menyamai Big Blind"
  // juga bohong pada momen itu. Di meja 8 pemain, 6 kursi dilangkahi.
  if (session.roundPhase === 'PREFLOP' && session.bbHasOption) {
    const bbPlayer = session.players[session.bbIndex];
    const semuaNonBbSudahAksi = nonFolded.every(p =>
      p === bbPlayer || session.actedThisRound.has(p) || session.allInPlayers.has(p)
    );
    if (
      allBetsEqual &&
      semuaNonBbSudahAksi &&
      !session.actedThisRound.has(bbPlayer) &&
      !session.foldedPlayers.has(bbPlayer) &&
      !session.allInPlayers.has(bbPlayer)
    ) {
      session.activePlayerIndex = session.bbIndex;
      session.turnSeq = (session.turnSeq || 0) + 1;
      session.bbHasOption = false; // Gunakan option sekali
      const turnMsg =
`👉 *Option Big Blind:* ${tag(bbPlayer)}
💰 Semua pemain telah menyamai Big Blind (${session.currentBet} Poin).
_Kamu berhak \`.check\` (gratis lanjut ke Flop) atau \`.raise <nominal>\`! (Waktu: ${TURN_TIMEOUT_MS / 1000}s)_`;

      const mention = isAiPlayer(bbPlayer) ? [] : [bbPlayer];
      await send(sock, jid, null, turnMsg, { mentions: mention });
      armTurnTimer(sock, jid);
      return;
    }
  }

  if (allBetsEqual && allActed) {
    await nextStreetPhase(sock, jid);
    return;
  }

  // Lewati pemain yang fold/all-in, DAN yang sudah bertindak sementara
  // taruhannya sudah menyamai currentBet. Tanpa syarat kedua, giliran bisa
  // kembali ke orang yang barusan bertindak (mis. UTG sesudah option BB) dan
  // dia boleh me-raise taruhannya SENDIRI tanpa ada raise perantara — ilegal
  // di poker, dan raise itu meng-clear actedThisRound sehingga seluruh meja
  // yang belum pernah ditanya langsung dipaksa membayar lagi.
  let nextIdx = (session.activePlayerIndex + 1) % session.players.length;
  let attempts = 0;
  let ketemu = false;
  while (attempts < session.players.length) {
    const candidate = session.players[nextIdx];
    const sudahSelesai =
      session.actedThisRound.has(candidate) &&
      (session.playerBets.get(candidate) || 0) === session.currentBet;
    if (!session.foldedPlayers.has(candidate) && !session.allInPlayers.has(candidate) && !sudahSelesai) {
      ketemu = true;
      break;
    }
    nextIdx = (nextIdx + 1) % session.players.length;
    attempts++;
  }

  // Sudah tidak ada yang perlu bicara → tutup ronde taruhan, jangan
  // mengembalikan giliran ke orang yang sudah selesai.
  if (!ketemu) {
    await nextStreetPhase(sock, jid);
    return;
  }

  session.activePlayerIndex = nextIdx;
  session.turnSeq = (session.turnSeq || 0) + 1;
  const nextPlayer = session.players[nextIdx];
  const toCall = session.currentBet - (session.playerBets.get(nextPlayer) || 0);

  const stackNext = session.playerStacks.get(nextPlayer) || 0;
  const turnMsg =
`🔔 *GILIRANMU:* ${tag(nextPlayer)}
💰 *Taruhan Saat Ini:* ${session.currentBet} Poin (Kurang: *${toCall} Poin*) | Total Pot: *${session.pot} Poin*
🎟️ *Sisa chipmu:* *${stackNext} Poin* (raise maksimal +${Math.max(0, stackNext - toCall)})
_Ketik \`.check\`, \`.call\`, \`.raise <nominal>\`, \`.allin\`, atau \`.fold\` (Waktu: ${TURN_TIMEOUT_MS / 1000}s)_`;

  // Bot tidak perlu disuruh mengetik `.call`. Di meja `vsbot` hampir semua
  // giliran adalah giliran bot, jadi pesan ini murni derau — dan ruang yang
  // dihematnya persis yang dibutuhkan sekarang setelah bot jauh lebih sering
  // ikut main (aksi per ronde naik banyak).
  if (!isAiPlayer(nextPlayer)) {
    await send(sock, jid, null, turnMsg, { mentions: [nextPlayer] });
  }
  armTurnTimer(sock, jid);
}

/**
 * Transisi ronde kartu komunitas: Preflop -> Flop -> Turn -> River -> Showdown
 */
async function nextStreetPhase(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  // Agresor street yang baru saja tutup jadi "agresor lalu" — itu yang berhak
  // melakukan continuation bet. Kalau reset ini salah, bot akan c-bet setelah
  // MEMANGGIL taruhan orang lain dan engine tidak akan mengeluh.
  session.aggressorLalu = session.aggressor;
  session.aggressor = null;

  session.actedThisRound.clear();
  session.currentBet = 0;
  for (const p of session.players) {
    session.playerBets.set(p, 0);
  }

  // Minimum raise kembali ke big blind tiap street. Tanpa baris ini, raise
  // besar di FLOP tetap jadi patokan minimum di TURN/RIVER padahal currentBet
  // sudah nol — taruhan pembuka yang sah ikut ditolak, dan kalau angkanya
  // melebihi sisa chip, pesan "raise minimal" dan "chip tidak cukup" saling
  // bertentangan sehingga `.raise` mustahil di nominal berapa pun.
  session.lastRaiseDiff = session.bigBlind;

  const nonFolded = session.players.filter(p => !session.foldedPlayers.has(p));
  const canBetPlayers = nonFolded.filter(p => !session.allInPlayers.has(p));

  // JIKA SEMUA PEMAIN ATAU SISA 1 PEMAIN SAJA YANG PUNYA CHIP (ALL-IN AUTO RUNOUT):
  if (canBetPlayers.length <= 1) {
    await autoRunRemainingStreetsToShowdown(sock, jid);
    return;
  }

  // 📐 Post-Flop Action Order: pemain aktif pertama di sebelah kiri Dealer Button.
  //
  // KENAPA DIHITUNG DI SINI, SEBELUM kartu diumumkan: dulu blok ini ada di BAWAH
  // rantai if/else, sehingga announceCommunityCards() masih membaca
  // activePlayerIndex milik ronde SEBELUMNYA. Akibatnya setiap pembukaan
  // Flop/Turn/River men-tag "Giliran Taruhan Pertama" ke pemain yang salah,
  // sementara pemain yang benar-benar giliran tidak pernah disebut sama sekali
  // lalu dipaksa auto-CHECK setelah 25 detik. Itu dua keluhan sekaligus:
  // "salah tag" dan "giliran ke-skip".
  const n = session.players.length;
  let firstPostFlopIdx = (session.dealerIndex + 1) % n;
  // Penghitung `cari` WAJIB: tanpa batas, kalau semua pemain sempat masuk
  // foldedPlayers/allInPlayers, while ini berputar selamanya dan membekukan
  // SELURUH proses Node — bot berhenti membalas dan port 3000 mati.
  let cari = 0;
  while (
    cari < n &&
    (session.foldedPlayers.has(session.players[firstPostFlopIdx]) ||
     session.allInPlayers.has(session.players[firstPostFlopIdx]))
  ) {
    firstPostFlopIdx = (firstPostFlopIdx + 1) % n;
    cari++;
  }
  if (cari >= n) {
    await autoRunRemainingStreetsToShowdown(sock, jid);
    return;
  }
  session.activePlayerIndex = firstPostFlopIdx;
  session.turnSeq = (session.turnSeq || 0) + 1;

  if (session.roundPhase === 'PREFLOP') {
    session.roundPhase = 'FLOP';
    session.communityCards.push(session.deck.pop(), session.deck.pop(), session.deck.pop());
    await announceCommunityCards(sock, jid, '🌊 *FLOP DIBUKA!* (3 Kartu Meja)');
    await sendDmHandUpdates(sock, session, 'FLOP (3 Kartu Meja)');
  } else if (session.roundPhase === 'FLOP') {
    session.roundPhase = 'TURN';
    session.communityCards.push(session.deck.pop());
    await announceCommunityCards(sock, jid, '⚡ *TURN DIBUKA!* (Kartu Meja ke-4)');
    await sendDmHandUpdates(sock, session, 'TURN (4 Kartu Meja)');
  } else if (session.roundPhase === 'TURN') {
    session.roundPhase = 'RIVER';
    session.communityCards.push(session.deck.pop());
    await announceCommunityCards(sock, jid, '🔥 *RIVER DIBUKA!* (Kartu Meja Terakhir)');
    await sendDmHandUpdates(sock, session, 'RIVER (5 Kartu Meja)');
  } else if (session.roundPhase === 'RIVER') {
    await conductTexasShowdown(sock, jid);
    return;
  }

  armTurnTimer(sock, jid);
}

/**
 * Otomatis buka semua sisa kartu meja dan langsung Showdown (Kasus All-In)
 */
async function autoRunRemainingStreetsToShowdown(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  while (session.communityCards.length < 5) {
    session.communityCards.push(session.deck.pop());
  }

  const boardStr = formatCards(session.communityCards);
  await send(sock, jid, null, `💥 *ALL-IN! SEMUA SISA KARTU MEJA DIBUKA!* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🃏 *Meja Komunitas Lengkap:* ${boardStr}\n\n_Menghitung kombinasi kartu terbaik..._`);

  // Jeda dramatis sebelum showdown. WAJIB disimpan di session.timeout dan
  // dicek identitas sesinya: dulu ini setTimeout telanjang yang tidak bisa
  // dibatalkan, jadi kalau meja keburu dibatalkan/selesai lalu grup membuka
  // meja baru dalam 1,8 detik, timer lama menembak sesi BARU yang kartu
  // mejanya masih kosong dan bot crash di evaluate7Cards.
  session.timeout = setTimeout(async () => {
    const cur = activeTexasGames.get(jid);
    if (!cur || cur !== session || cur.status !== 'PLAYING') return;
    await conductTexasShowdown(sock, jid);
  }, 1800);
}

/**
 * Umumkan kartu komunitas baru di grup
 */
async function announceCommunityCards(sock, jid, title) {
  const session = activeTexasGames.get(jid);
  if (!session) return;

  const hiddenCount = 5 - session.communityCards.length;
  const boardStr = formatCards(session.communityCards) + (hiddenCount > 0 ? ' ' + formatHiddenCards(hiddenCount) : '');

  const activeP = session.players[session.activePlayerIndex];
  const msg =
`${title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🃏 *Meja Komunitas:*
${boardStr}

💰 *Total Pot:* *${session.pot} Poin*
👉 Giliran Taruhan Pertama: ${tag(activeP)}
_Ketik \`.check\`, \`.call\`, \`.raise <nominal>\`, \`.allin\`, atau \`.fold\`_`;

  const mention = isAiPlayer(activeP) ? [] : [activeP];
  await send(sock, jid, null, msg, { mentions: mention });
}

/**
 * Showdown: Buka semua kartu dan bagikan hadiah Pot (Mendukung Side Pot)
 */
async function conductTexasShowdown(sock, jid) {
  const session = activeTexasGames.get(jid);
  if (!session || session.status === 'SHOWDOWN') return;

  clearSessionTimer(session);
  session.status = 'SHOWDOWN';

  // Jaring pengaman: evaluate7Cards melempar kalau kartunya kurang dari 5.
  // Showdown tidak boleh pernah jalan dengan meja belum lengkap.
  while (session.communityCards.length < 5 && session.deck.length > 0) {
    session.communityCards.push(session.deck.pop());
  }

  const nonFolded = session.players.filter(p => !session.foldedPlayers.has(p));
  const results = [];

  for (const p of nonFolded) {
    const hole = session.playerHoleCards.get(p) || [];
    const all7 = [...hole, ...session.communityCards];
    const evaluated = evaluate7Cards(all7);
    results.push({
      player: p,
      hole,
      evaluated,
      contributed: session.playerTotalContributed.get(p) || session.buyIn
    });
  }

  results.sort((a, b) => compareScores(b.evaluated.score, a.evaluated.score));

  const scoreOf = new Map(results.map(r => [r.player, r.evaluated.score]));

  // ─── 💰 PEMBAGIAN MAIN POT + SIDE POT ───
  // Tiap lapisan pot hanya diperebutkan pemain yang ikut menyetor sampai
  // lapisan itu. Pemain all-in 10 chip tidak lagi bisa memborong pot 5.000.
  const pots = buildSidePots(session);
  const gross = new Map();   // hadiah chip sebelum batas kredit
  const potLines = [];

  pots.forEach((pot, idx) => {
    const contenders = pot.eligible.filter(p => scoreOf.has(p));
    if (contenders.length === 0) return;

    let best = [contenders[0]];
    for (let i = 1; i < contenders.length; i++) {
      const cmp = compareScores(scoreOf.get(contenders[i]), scoreOf.get(best[0]));
      if (cmp === 0) best.push(contenders[i]);
      else if (cmp > 0) best = [contenders[i]];
    }

    const share = Math.floor(pot.amount / best.length);
    let sisa = pot.amount - share * best.length; // chip ganjil untuk pemenang pertama
    for (const p of best) {
      const extra = sisa > 0 ? 1 : 0;
      if (extra) sisa--;
      gross.set(p, (gross.get(p) || 0) + share + extra);
    }

    const label = idx === 0 ? 'Main Pot' : `Side Pot ${idx}`;
    potLines.push(`• *${label}* (${pot.amount} Poin) ➔ ${best.map(tag).join(' & ')}`);
  });

  // Kredit ke saldo nyata, dibatasi realCreditCap (chip bot tidak berbacking).
  const paidOut = new Map();
  for (const [p, amount] of gross) {
    const credited = await payoutToPlayer(session, p, amount);
    paidOut.set(p, credited);
  }

  // Sisa chip yang tidak jadi dipertaruhkan dicairkan balik ke saldo.
  const sisaChip = await cashOutStacks(session);

  const winners = [...gross.keys()]
    .map(p => results.find(r => r.player === p))
    .filter(Boolean);

  let resultLines = results.map((r, idx) => {
    const isWin = gross.has(r.player);
    const medal = isWin ? '🏆' : `${idx + 1}.`;
    let bayar = '';
    if (!isAiPlayer(r.player)) {
      const masuk = (paidOut.get(r.player) || 0) + (sisaChip.get(r.player) || 0);
      const selisih = masuk - session.buyIn;
      bayar = `\n   💵 Masuk saldo: *+${masuk} Poin* (${selisih >= 0 ? '+' : ''}${selisih} dari buy-in)`;
    }
    return `${medal} ${tag(r.player)}: ${formatCards(r.hole)}\n   ➔ *${r.evaluated.name}* (${r.evaluated.description})${bayar}`;
  }).join('\n\n');

  const winnerTags = winners.length > 0 ? winners.map(w => tag(w.player)).join(' & ') : '_(tidak ada)_';
  const boardStr = formatCards(session.communityCards);
  const adaBot = session.players.some(isAiPlayer);
  const catatanBot = adaBot
    ? '\n\n_ℹ️ Meja berisi AI Bot: chip bot bukan poin nyata, jadi hadiah yang masuk saldo dibatasi maksimal 1:1 dari taruhanmu sendiri._'
    : '';

  const finalMsg =
`🏆 *HASIL SHOWDOWN TEXAS POKER* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🃏 *Kartu Komunitas Lengkap:*
${boardStr}

💰 *Total Pot:* *${session.pot} Poin*
${potLines.join('\n')}
🎉 *PEMENANG:* ${winnerTags}

📊 *Buka Kartu Seluruh Pemain:*
${resultLines}${catatanBot}

_Terima kasih telah bermain! Ketik \`.poker [taruhan]\` atau \`.poker vsbot\` untuk ronde baru._`;

  // Rotasi Dealer Button untuk ronde berikutnya
  // Simpan posisi button untuk ronde berikutnya. Menulis ke session saja
  // percuma: objeknya dibuang beberapa baris di bawah.
  dealerButtonTerakhir.set(jid, (session.dealerIndex + 1) % session.players.length);

  await db.finishActiveGameSession(db.sesiGameId('texas', jid), 'COMPLETED');
  activeTexasGames.delete(jid);

  const humanMentions = session.players.filter(p => !isAiPlayer(p));
  await send(sock, jid, null, finalMsg, { mentions: humanMentions });
}

/**
 * Menang karena semua lawan Fold
 */
async function finishTexasByFold(sock, jid, winner) {
  const session = activeTexasGames.get(jid);
  // Gerbang idempoten + status terminal, disamakan dengan conductTexasShowdown.
  // Tanpa ini, `.fold` dobel atau `.fold` yang bertabrakan dengan timer 25 detik
  // membuat fungsi ini jalan dua kali dan pot dikreditkan DUA KALI ke pemenang —
  // sesi baru dihapus dari Map jauh sesudah tiga await pembayaran.
  if (!session || session.status !== 'PLAYING') return;
  session.status = 'SETTLING';

  clearSessionTimer(session);
  // Pot sekarang mustahil melebihi total buy-in di meja, tapi chip bot tetap
  // tidak berbacking — jadi kredit tetap lewat payoutToPlayer.
  const credited = await payoutToPlayer(session, winner, session.pot);
  // Sisa chip semua pemain (termasuk yang fold) dicairkan balik ke saldo.
  const sisaChip = await cashOutStacks(session);

  const hole = session.playerHoleCards.get(winner) || [];
  const masuk = credited + (sisaChip.get(winner) || 0);
  const selisih = masuk - session.buyIn;
  const barisKredit = isAiPlayer(winner)
    ? ''
    : `\n💵 *Masuk saldo:* *+${masuk} Poin* (${selisih >= 0 ? '+' : ''}${selisih} dari buy-in)`;

  const finalMsg =
`🏆 *PEMENANG TEXAS POKER (LAWAN FOLD)* 🤠
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Semua lawan telah FOLD (menyerah)!
🎉 Pemenang: ${tag(winner)}
💰 *Hadiah Pot:* *${session.pot} Poin*${barisKredit}
🃏 Kartu Pemenang: ${formatCards(hole)}
♻️ _Sisa chip pemain lain sudah dikembalikan ke saldo masing-masing._

_Ketik \`.poker [taruhan]\` atau \`.poker vsbot\` untuk membuka meja baru._`;

  // Simpan posisi button untuk ronde berikutnya. Menulis ke session saja
  // percuma: objeknya dibuang beberapa baris di bawah.
  dealerButtonTerakhir.set(jid, (session.dealerIndex + 1) % session.players.length);
  await db.finishActiveGameSession(db.sesiGameId('texas', jid), 'COMPLETED');
  activeTexasGames.delete(jid);

  const mention = isAiPlayer(winner) ? [] : [winner];
  await send(sock, jid, null, finalMsg, { mentions: mention });
}

/**
 * Batalkan sesi poker
 */
async function cancelTexasGame(sock, jid, senderNumber, messageObj) {
  const session = activeTexasGames.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada meja Texas Poker aktif di grup ini.");
    return true;
  }

  if (session.host && !samePlayer(session.host, senderNumber)) {
    await send(sock, jid, messageObj, "❌ Hanya host pembuat meja yang dapat membatalkan permainan!");
    return true;
  }

  clearSessionTimer(session);

  // Ronde yang sudah jalan hanya mengembalikan SISA CHIP, bukan buy-in utuh.
  // Dulu pembatalan di tengah ronde mengembalikan buy-in penuh, jadi host bisa
  // mengintip kartunya lalu membatalkan meja setiap kali kartunya jelek.
  const sudahMain = session.status !== 'LOBBY';
  const { refunded, points } = await refundTexasSession(session, sudahMain ? 'STACK' : 'FULL');
  activeTexasGames.delete(jid);

  const refundNote = refunded > 0
    ? (sudahMain
      ? `\n💸 *${points} Poin* sisa chip dikembalikan ke ${refunded} pemain.\n⚠️ _Chip yang sudah masuk pot (${session.pot} Poin) hangus — ronde tidak bisa dibatalkan tanpa konsekuensi._`
      : `\n💸 Taruhan buy-in dikembalikan utuh ke ${refunded} pemain (*${points} Poin*).`)
    : '';
  await send(sock, jid, messageObj, `🛑 Meja Texas Poker berhasil dibatalkan.${refundNote}`);
  return true;
}

/**
 * Tampilkan status meja poker saat ini
 */
async function showTexasTable(sock, jid, messageObj) {
  const session = activeTexasGames.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada meja Texas Poker aktif di grup ini.");
    return true;
  }

  if (session.status === 'LOBBY') {
    await send(sock, jid, messageObj, `🤠 *LOBI TEXAS POKER* (${session.players.length}/${MAX_PLAYERS})\nHost: ${tag(session.host)}\nBuy-in: *${session.buyIn} Poin*\nPemain: ${session.playerLabels.join(', ')}\n\nKetik \`.poker join\` untuk ikut, \`.poker addbot\` untuk tambah bot, atau \`.poker start\` untuk mulai!`, { mentions: session.players.filter(p => !isAiPlayer(p)) });
    return true;
  }

  const hiddenCount = 5 - session.communityCards.length;
  const boardStr = session.communityCards.length > 0 ? formatCards(session.communityCards) + (hiddenCount > 0 ? ' ' + formatHiddenCards(hiddenCount) : '') : formatHiddenCards(5);
  const activeP = session.players[session.activePlayerIndex];

  const tableMsg =
`🤠 *STATUS MEJA TEXAS POKER* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🃏 *Kartu Meja:* ${boardStr}
💰 *Total Pot:* *${session.pot} Poin*
📍 *Ronde:* ${session.roundPhase}
👉 *Giliran Sekarang:* ${tag(activeP)} (Taruhan: ${session.currentBet} Poin)

👥 *Pemain Aktif:*
${session.players.map(p => {
  const isFold = session.foldedPlayers.has(p) ? '❌ _Fold_' : '✅ _In_';
  const isAllIn = session.allInPlayers.has(p) ? ' (💥 All-In)' : '';
  return `• ${tag(p)}: ${isFold}${isAllIn} [Bet: ${session.playerBets.get(p) || 0} | Chip: ${session.playerStacks.get(p) || 0}]`;
}).join('\n')}`;

  await send(sock, jid, messageObj, tableMsg, { mentions: session.players.filter(p => !isAiPlayer(p)) });
  return true;
}

/**
 * Kirim pembaruan evaluasi kartu tangan & kombinasi meja ke DM masing-masing pemain
 */
async function sendDmHandUpdates(sock, session, streetName) {
  const nonFolded = session.players.filter(p => !session.foldedPlayers.has(p) && !isAiPlayer(p));
  const boardStr = formatCards(session.communityCards);

  for (const p of nonFolded) {
    const hole = session.playerHoleCards.get(p) || [];
    if (hole.length === 0) continue;

    const allCards = [...hole, ...session.communityCards];
    const evaluated = evaluate7Cards(allCards);

    const dmText =
`🃏 *UPDATE MEJA & KARTU POKER ANDA* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 *Ronde:* ${streetName}
🎴 *Kartu Meja:* ${boardStr}
🤫 *Kartu Tangan:* ${formatCards(hole)}

📊 *Kombinasi Terbaikmu Saat Ini:*
➔ 👑 *${evaluated.name}* (${evaluated.description})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 _Pantau giliran taruhan di grup!_`;

    await dm(sock, p, dmText);
  }
}

/**
 * Cek kartu tangan & kombinasi saat ini lewat command .kartu / .hand
 */
export async function checkPlayerHand(sock, jid, senderNumber, messageObj) {
  let session = activeTexasGames.get(jid);
  if (!session) {
    for (const [_, s] of activeTexasGames) {
      if (s.players.some(p => samePlayer(p, senderNumber))) {
        session = s;
        break;
      }
    }
  }

  if (!session || session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, "❌ Kamu tidak sedang bermain di meja Texas Poker yang aktif.");
    return true;
  }

  const hole = session.playerHoleCards.get(senderNumber) || [];
  if (hole.length === 0) {
    await send(sock, jid, messageObj, "❌ Kartu tangan tidak ditemukan.");
    return true;
  }

  let evalText = '';
  if (session.communityCards.length >= 3) {
    const evaluated = evaluate7Cards([...hole, ...session.communityCards]);
    evalText = `\n🎴 *Kartu Meja:* ${formatCards(session.communityCards)}\n📊 *Kombinasi Terbaik:* *${evaluated.name}* (${evaluated.description})`;
  } else {
    evalText = `\n🎴 *Kartu Meja:* _(Belum dibuka / Masih Pre-Flop)_`;
  }

  const dmText =
`🃏 *KARTU TANGAN POKER ANDA* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kartu Tangan:* ${formatCards(hole)}${evalText}
💰 *Total Pot Meja:* *${session.pot} Poin*
📍 *Ronde:* ${session.roundPhase}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 _Gunakan \`.check\`, \`.call\`, \`.raise\`, \`.allin\`, atau \`.fold\` saat giliranmu di grup._`;

  await dm(sock, senderNumber, dmText);
  if (jid.endsWith('@g.us')) {
    await send(sock, jid, messageObj, `🤫 ${tag(senderNumber)}, kartu tangan dan kombinasi terbaikmu telah dikirim ke DM WhatsApp!`, { mentions: [senderNumber] });
  }
  return true;
}

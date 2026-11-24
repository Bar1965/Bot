/**
 * 🎲 LIAR'S DICE / PERUDO (DADU BAJAK LAUT)
 * Game Deduksi, Gertak & Psikologi (2-6 Pemain)
 *
 * Aturan:
 * - Setiap pemain mulai dengan 5 dadu rahasia (dikirim via DM setiap ronde).
 * - Dadu 1 (⚀) adalah WILD / Joker yang dihitung ke angka apa pun.
 * - Pemain bergiliran membuat klaim tebakan (.tebak <jumlah> <angka>, misal: .tebak 4 3).
 * - Pemain berikutnya wajib menaikkan tebakan (.tebak) atau menuduh bohong (.dudo / .liar / .bohong).
 * - Jika dituduh, seluruh dadu dibuka. Yang salah kehilangan 1 dadu hingga tersisa 1 pemenang!
 */

import * as db from '../../database.js';
import { send, catatJejak, perbaruiPapan, lepasPapan } from './helpers.js';

export const activeLiarsDice = new Map();

const MIN_BET = 20;
const DEFAULT_BET = 50;
const MAX_BET = 100_000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const LOBBY_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 45_000;
const STARTING_DICE_COUNT = 5;

const DICE_EMOJIS = {
  1: '⚀',
  2: '⚁',
  3: '⚂',
  4: '⚃',
  5: '⚄',
  6: '⚅'
};

function tag(jid) {
  return `@${jid.split('@')[0]}`;
}

/** Kunci baris crash-recovery. Wajib berprefiks jenis game — lihat `sesiGameId`. */
function sesiId(jid) {
  return db.sesiGameId('liarsdice', jid);
}

function clearSessionTimer(session) {
  if (session && session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function clearRoundTimer(session) {
  if (session && session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }
}

/**
 * Kocok N buah dadu (nilai 1-6)
 */
export function rollDice(count) {
  const dice = [];
  for (let i = 0; i < count; i++) {
    dice.push(Math.floor(Math.random() * 6) + 1);
  }
  return dice.sort((a, b) => a - b);
}

/**
 * Format string representasi dadu
 */
export function formatDice(diceArray) {
  return diceArray.map(d => `${DICE_EMOJIS[d]} (${d})`).join(' ');
}

/**
 * Hitung berapa dadu bernilai `face` di meja, termasuk dadu 1 sebagai Wild.
 * Dadu 1 TIDAK menjadi wild untuk dirinya sendiri — kalau tebakannya angka 1,
 * yang dihitung hanya dadu 1 yang asli, kalau tidak jumlahnya dobel.
 *
 * Dipisah sebagai fungsi murni supaya bisa diuji tanpa socket WhatsApp
 * (scripts/liarsDiceSmokeTest.mjs) dan supaya hanya ada SATU rumus perhitungan
 * di kode ini.
 */
export function hitungDaduDiMeja(daftarDadu, face) {
  let asli = 0;
  let wild = 0;
  for (const dadu of daftarDadu) {
    for (const d of (dadu || [])) {
      if (d === face) asli++;
      else if (d === 1 && face !== 1) wild++;
    }
  }
  return { asli, wild, total: asli + wild };
}

/**
 * Aturan kenaikan Perudo: jumlah harus naik, ATAU jumlah sama dengan angka dadu
 * yang lebih tinggi. Selain itu tebakan ditolak.
 */
export function bidLebihTinggi(prev, next) {
  if (!prev) return true;
  if (next.quantity > prev.quantity) return true;
  return next.quantity === prev.quantity && next.face > prev.face;
}

/**
 * Kirim dadu rahasia ke DM pemain
 */
async function sendSecretDiceToPlayer(sock, playerJid, session) {
  const dice = session.playerDice.get(playerJid) || [];
  if (dice.length === 0) return;

  // Hitung total dadu aktif di meja
  let totalTableDice = 0;
  for (const p of session.alivePlayers) {
    totalTableDice += (session.playerDice.get(p) || []).length;
  }

  const text =
`🎲 *DADU RAHASIA ANDA (LIAR'S DICE)* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 *Meja Grup:* ${session.jid}
🎲 *Dadu Milikmu (${dice.length} Dadu):*
   ${formatDice(dice)}

👥 *Total Dadu di Seluruh Meja:* *${totalTableDice} Dadu* (${session.alivePlayers.length} Pemain)
🌟 *Aturan Dadu 1 (⚀):* Berperan sebagai *WILD / Joker* yang ikut terhitung untuk angka apa pun!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Cara Bermain di Grup:*
• Naikkan tebakan: \`.tebak <jumlah> <angka>\` (Contoh: \`.tebak 3 4\` ➔ Ada min. tiga dadu angka 4)
• Atau tuduh bohong pemain sebelumnya: \`.dudo\` / \`.liar\` / \`.bohong\``;

  try {
    await sock.sendMessage(playerJid, { text });
  } catch (err) {
    console.warn('[LIARS_DICE_DM_WARN]', err.message);
  }
}

/**
 * Refund seluruh taruhan jika lobi dibatalkan / timeout
 */
async function refundLiarsSession(session) {
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
  await db.finishActiveGameSession(sesiId(session.jid), 'CANCELLED');
  return refunded;
}

/**
 * Render meja — dipadatkan.
 *
 * Papan ini muncul di setiap tebakan. Bentuk lamanya 14 baris penuh garis
 * pemisah DITAMBAH satu pesan narasi terpisah, jadi satu ronde 20 giliran
 * membanjiri grup dengan 40 pesan panjang. Sekarang: satu papan hidup yang
 * diedit di tempat, dan tiap tebakan cuma menambah satu baris jejak.
 */
function renderLiarsBoard(session) {
  const currentP = session.alivePlayers[session.activeTurnIndex];
  let totalDiceInGame = 0;

  const barisPemain = session.alivePlayers.map(p => {
    const count = (session.playerDice.get(p) || []).length;
    totalDiceInGame += count;
    return `${p === currentP ? '👉' : ''}${tag(p)}${'🎲'.repeat(count)}`;
  }).join(' · ');

  const bid = session.currentBid;
  const bidStr = bid
    ? `*${bid.quantity}× ${DICE_EMOJIS[bid.face]}${bid.face}* oleh ${tag(bid.bidder)}`
    : '_bebas — pasang tebakan pertama_';

  const jejak = (session.jejak || []).length
    ? `\n${session.jejak.map(r => `▸ ${r}`).join('\n')}`
    : '';

  return (
`🎲 *LIAR'S DICE* · 💰 *${session.pot} Poin* · 🎲 ${totalDiceInGame} dadu di meja
🎯 Tebakan tertinggi: ${bidStr}
👥 ${barisPemain}${jejak}
👉 Giliran ${tag(currentP)} — \`.tebak 3 4\` atau \`.dudo\` _(${TURN_TIMEOUT_MS / 1000}s)_ · \`.kartu\` untuk lihat dadumu`
  );
}

/** Papan meja hidup: satu pesan yang diedit, bukan dua pesan tiap tebakan. */
async function perbaruiMeja(sock, jid, session, opsi = {}) {
  return await perbaruiPapan(sock, jid, session, renderLiarsBoard, {
    mentions: session.alivePlayers,
    ...opsi
  });
}

/**
 * Pasang timer giliran per pemain (45s)
 */
function armLiarsTurnTimer(sock, jid) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  session.timer = setTimeout(async () => {
    try {
      const live = activeLiarsDice.get(jid);
      if (!live || live.status !== 'PLAYING' || live.resolving) return;

      const currentP = live.alivePlayers[live.activeTurnIndex];
      if (live.currentBid) {
        catatJejak(live, `⏰ Waktu ${tag(currentP)} habis — otomatis *DUDO*`);
        await executeDudoAction(sock, jid, currentP);
      } else {
        // Jika belum ada bid, pasang bid default 1 buah 2
        live.currentBid = { quantity: 1, face: 2, bidder: currentP };
        live.activeTurnIndex = (live.activeTurnIndex + 1) % live.alivePlayers.length;
        catatJejak(live, `⏰ Waktu ${tag(currentP)} habis — tebakan awal otomatis *1× ⚁2*`);
        await perbaruiMeja(sock, jid, live);
        armLiarsTurnTimer(sock, jid);
      }
    } catch (e) {
      console.error('[LIARS_DICE_TIMEOUT_ERR]', e);
    }
  }, TURN_TIMEOUT_MS);
}

/**
 * Handler utama Liar's Dice (.liarsdice / .dadu / .tebak / .dudo / .liar)
 */
export async function handleLiarsDiceCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Permainan Liar's Dice hanya dapat dimainkan di dalam grup!");
    return true;
  }

  // Aksi membuat tebakan (.tebak <jumlah> <angka>)
  if (['tebak', 'bid', 'pasangdadu', 'klaim'].includes(command)) {
    const qty = parseInt(args[1], 10);
    const face = parseInt(args[2], 10);
    return await bidAction(sock, jid, senderNumber, messageObj, qty, face);
  }

  // Aksi menuduh bohong (.dudo / .liar / .bohong / .buka)
  if (['dudo', 'liar', 'bohong', 'bukadadu', 'call'].includes(command)) {
    return await dudoAction(sock, jid, senderNumber, messageObj);
  }

  // Cek dadu tangan (.kartu / .cekkartu / .cekdadu / .daduku)
  if (['kartu', 'kartuku', 'cekdadu', 'daduku', 'mycards'].includes(command)) {
    return await checkSecretDice(sock, jid, senderNumber, messageObj);
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['join', 'ikut', 'masuk'].includes(subCmd) || command === 'joinliar') {
    return await joinLiarsLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'gas'].includes(subCmd) || command === 'gasliar') {
    return await startLiarsGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd) || command === 'batalliar') {
    return await cancelLiarsGame(sock, jid, senderNumber, messageObj);
  }

  if (['nyerah', 'menyerah'].includes(subCmd) || command === 'nyerahliar') {
    return await surrenderLiarsGame(sock, jid, senderNumber, messageObj);
  }

  if (['tebak', 'bid'].includes(subCmd)) {
    const qty = parseInt(args[2], 10);
    const face = parseInt(args[3], 10);
    return await bidAction(sock, jid, senderNumber, messageObj, qty, face);
  }

  if (['dudo', 'liar', 'bohong'].includes(subCmd)) {
    return await dudoAction(sock, jid, senderNumber, messageObj);
  }

  // Buka Lobi Baru (.liarsdice [taruhan])
  const betArg = parseInt(args[1], 10);
  const buyIn = Math.min(MAX_BET, Math.max(MIN_BET, isNaN(betArg) ? DEFAULT_BET : betArg));

  return await createLiarsLobby(sock, jid, senderNumber, messageObj, buyIn);
}

/**
 * 1. Buka Lobi Liar's Dice
 */
async function createLiarsLobby(sock, jid, senderNumber, messageObj, buyIn) {
  if (activeLiarsDice.has(jid)) {
    const existing = activeLiarsDice.get(jid);
    if (existing.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Masih ada lobi Liar's Dice aktif!\nKetik \`.liarsdice join\` untuk gabung atau \`.liarsdice start\` untuk mulai.`);
      return true;
    }
    await send(sock, jid, messageObj, `⚠️ Permainan Liar's Dice sedang berlangsung di grup ini! Tunggu hingga selesai.`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  const userPoints = prof?.points || 0;
  if (userPoints < buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membuka lobi dengan taruhan *${buyIn} Poin*! (Poinmu: ${userPoints})`);
    return true;
  }

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    players: [senderNumber],
    alivePlayers: [senderNumber],
    playerDice: new Map(), // jid -> Array of dice numbers
    diceCount: new Map(),  // jid -> integer (sisa dadu)
    chargedPlayers: new Set(),
    currentBid: null, // { quantity, face, bidder }
    activeTurnIndex: 0,
    pot: 0,
    timer: null,
    roundTimer: null,
    // Gerbang anti-dobel. Selama pembukaan dadu sedang diproses dan selama jeda
    // 3 detik menuju ronde baru, `status` masih 'PLAYING' tapi tidak ada giliran
    // siapa pun. Tanpa gerbang ini pemain bisa mengetik `.dudo` lagi di celah
    // itu: dadu terpotong dua kali dan `finishLiarsGame` bisa jalan ganda.
    resolving: false,
    createdAt: Date.now()
  };

  activeLiarsDice.set(jid, session);

  session.timer = setTimeout(async () => {
    try {
      const s = activeLiarsDice.get(jid);
      if (s && s.status === 'LOBBY') {
        activeLiarsDice.delete(jid);
        await refundLiarsSession(s);
        await send(sock, jid, null, `⏰ *Lobi Liar's Dice Dibatalkan* karena tidak dimulai dalam 60 detik.`);
      }
    } catch (_) {}
  }, LOBBY_TIMEOUT_MS);

  const text =
`🎲 ─── *LOBI DADU BAJAK LAUT (LIAR'S DICE)* ─── 🎲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Host:* ${tag(senderNumber)}
💰 *Taruhan Masuk:* *${buyIn} Poin* / pemain
👥 *Pemain Terdaftar (1/${MAX_PLAYERS}):*
  1. ${tag(senderNumber)} (Host)

📦 *Aturan Permainan:*
  • Masing-masing pemain dibagikan 5 dadu rahasia via DM
  • Dadu 1 (⚀) adalah Wild/Joker (dihitung untuk angka apa pun)
  • Gertak lawanmu dan tuduh bohong (\`.dudo\`) jika tebakannya palsu!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 Ketik \`.liarsdice join\` untuk bergabung (Min. ${MIN_PLAYERS} pemain)
👉 Ketik \`.liarsdice start\` untuk memulai permainan!
_⏳ Lobi otomatis batal dalam 60 detik jika tidak dimulai._`;

  await send(sock, jid, messageObj, text, { mentions: [senderNumber] });
  return true;
}

/**
 * 2. Gabung Lobi Liar's Dice
 */
async function joinLiarsLobby(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Liar's Dice aktif. Ketik `.liarsdice [taruhan]` untuk membuka lobi baru!");
    return true;
  }

  if (session.players.includes(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah terdaftar di lobi Liar's Dice ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `⚠️ Lobi sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  const userPoints = prof?.points || 0;
  if (userPoints < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk bergabung! Dibutuhkan *${session.buyIn} Poin* (Poinmu: ${userPoints}).`);
    return true;
  }

  session.players.push(senderNumber);
  session.alivePlayers.push(senderNumber);

  const playerList = session.players.map((p, idx) => `  ${idx + 1}. ${tag(p)}${p === session.host ? ' (Host)' : ''}`).join('\n');
  const msg =
`✅ ${tag(senderNumber)} bergabung ke lobi Liar's Dice!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *Daftar Pemain (${session.players.length}/${MAX_PLAYERS}):*
${playerList}

👉 Ketik \`.liarsdice start\` untuk memulai permainan!`;

  await send(sock, jid, messageObj, msg, { mentions: session.players });

  if (session.players.length === MAX_PLAYERS) {
    await startLiarsGame(sock, jid, session.host, messageObj);
  }
  return true;
}

/**
 * 3. Memulai Permainan Liar's Dice
 */
async function startLiarsGame(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Tidak ada lobi yang siap dimulai.');
    return true;
  }

  if (senderNumber !== session.host && session.players.length < MAX_PLAYERS) {
    await send(sock, jid, messageObj, `⚠️ Hanya Host (${tag(session.host)}) yang dapat memulai permainan!`, { mentions: [session.host] });
    return true;
  }

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai permainan!`);
    return true;
  }

  clearSessionTimer(session);

  // Potong saldo poin setiap pemain
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
    await refundLiarsSession(session);
    activeLiarsDice.delete(jid);
    await send(sock, jid, messageObj, `❌ Gagal memulai: Ada pemain yang poinnya tidak cukup saat start!\nPemain: ${failed.map(f => tag(f)).join(', ')}`, { mentions: failed });
    return true;
  }

  await db.createActiveGameSession({
    id: sesiId(jid),
    gameType: "Liar's Dice",
    jid,
    host: session.host,
    buyIn: session.buyIn,
    pot: session.buyIn * session.players.length,
    players: session.players.map(p => ({ jid: p, points: session.buyIn }))
  });

  session.status = 'PLAYING';
  session.pot = session.buyIn * session.players.length;
  session.activeTurnIndex = Math.floor(Math.random() * session.alivePlayers.length);

  // Set 5 dadu awal untuk setiap pemain
  for (const p of session.alivePlayers) {
    session.diceCount.set(p, STARTING_DICE_COUNT);
  }

  await startNewDiceRound(sock, jid, session);
  return true;
}

/**
 * Mulai ronde kocok dadu baru
 */
async function startNewDiceRound(sock, jid, session) {
  session.currentBid = null;
  // Meja dibuka lagi: mulai titik ini `.tebak` / `.dudo` boleh masuk.
  session.resolving = false;

  // Kocok dadu baru untuk semua pemain hidup
  for (const p of session.alivePlayers) {
    const count = session.diceCount.get(p) || STARTING_DICE_COUNT;
    const rolled = rollDice(count);
    session.playerDice.set(p, rolled);
    await sendSecretDiceToPlayer(sock, p, session);
  }

  // Ronde baru = papan baru. Dadu rahasia sudah masuk DM setiap pemain, dan
  // itulah notifikasi yang sesungguhnya — grup cukup mendapat satu papan segar
  // yang sesudah ini diedit di tempat sepanjang ronde.
  lepasPapan(session);
  catatJejak(session, '🎲 Ronde baru — dadu dikocok & dikirim ke DM');
  await perbaruiMeja(sock, jid, session);
  armLiarsTurnTimer(sock, jid);
}

/**
 * 4. Aksi Membuat Tebakan (.tebak <jumlah> <angka>)
 */
async function bidAction(sock, jid, senderNumber, messageObj, quantity, face) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  if (session.resolving) {
    await send(sock, jid, messageObj, '⏳ Dadu sedang dibuka & dihitung. Tunggu ronde berikutnya dikocok dulu ya!');
    return true;
  }

  const currentP = session.alivePlayers[session.activeTurnIndex];
  if (senderNumber !== currentP) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(currentP)} untuk bertindak.`, { mentions: [currentP] });
    return true;
  }

  if (isNaN(quantity) || isNaN(face) || quantity <= 0 || face < 1 || face > 6) {
    await send(sock, jid, messageObj, `❌ Format tebakan salah! Gunakan: \`.tebak <jumlah> <angka 1-6>\`\nContoh: \`.tebak 3 4\` (Ada minimal 3 dadu angka 4).`);
    return true;
  }

  // Hitung total dadu aktif di meja
  let totalTableDice = 0;
  for (const p of session.alivePlayers) {
    totalTableDice += (session.playerDice.get(p) || []).length;
  }

  if (quantity > totalTableDice) {
    await send(sock, jid, messageObj, `❌ Jumlah tebakan (${quantity}) melebihi total seluruh dadu di meja (${totalTableDice} Dadu)!`);
    return true;
  }

  // Validasi aturan kenaikan (Raise)
  if (!bidLebihTinggi(session.currentBid, { quantity, face })) {
    const prev = session.currentBid;
    await send(sock, jid, messageObj, `❌ Tebakanmu harus lebih tinggi dari tebakan sebelumnya (*${prev.quantity}x Dadu ${prev.face}*)!\nNaikkan jumlahnya atau pilih angka dadu yang lebih tinggi.`);
    return true;
  }

  clearSessionTimer(session);

  session.currentBid = {
    quantity,
    face,
    bidder: senderNumber
  };

  catatJejak(session, `🗣️ ${tag(senderNumber)} tebak *${quantity}× ${DICE_EMOJIS[face]}${face}*`);

  // Pindah giliran ke pemain berikutnya
  session.activeTurnIndex = (session.activeTurnIndex + 1) % session.alivePlayers.length;

  await perbaruiMeja(sock, jid, session);
  armLiarsTurnTimer(sock, jid);
  return true;
}

/**
 * 5. Aksi Menuduh Bohong (.dudo / .liar / .bohong)
 */
async function dudoAction(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada meja Liar's Dice di grup ini.\nKetik `.liarsdice [taruhan]` untuk membuka meja baru!");
    return true;
  }
  if (session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, "⏳ Permainan belum dimulai. Ketik `.liarsdice start` dulu (minimal 2 pemain).");
    return true;
  }

  if (session.resolving) {
    await send(sock, jid, messageObj, '⏳ Dadu sedang dibuka & dihitung. Tunggu ronde berikutnya dikocok dulu ya!');
    return true;
  }

  const currentP = session.alivePlayers[session.activeTurnIndex];
  if (senderNumber !== currentP) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(currentP)}.`, { mentions: [currentP] });
    return true;
  }

  if (!session.currentBid) {
    await send(sock, jid, messageObj, `❌ Belum ada tebakan yang bisa dituduh bohong! Pasang tebakan awal dengan \`.tebak <jumlah> <angka>\`.`);
    return true;
  }

  clearSessionTimer(session);
  return await executeDudoAction(sock, jid, senderNumber, messageObj);
}

/**
 * 6. Eksekusi Pembukaan Dadu & Evaluasi Tuduhan Bohong
 */
async function executeDudoAction(sock, jid, challenger, messageObj = null) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'PLAYING' || session.resolving) return false;
  if (!session.currentBid) return false;

  // Kunci meja: mulai detik ini sampai ronde baru dikocok, tidak ada aksi
  // pemain yang boleh masuk.
  session.resolving = true;
  clearSessionTimer(session);

  const { quantity, face, bidder } = session.currentBid;

  const revealList = [];
  const semuaDadu = [];

  for (const p of session.alivePlayers) {
    const dice = session.playerDice.get(p) || [];
    semuaDadu.push(dice);
    revealList.push(`  • ${tag(p)}: ${formatDice(dice)}`);
  }

  const { wild: wildCount, total: actualCount } = hitungDaduDiMeja(semuaDadu, face);

  let loser = null;
  let resultSummary = '';

  if (actualCount >= quantity) {
    // Penebak BENAR! Penuduh (Challenger) kalah 1 dadu!
    loser = challenger;
    resultSummary = `✅ *TEBAKAN BENAR!* ${tag(bidder)} tidak berbohong.\n💔 ${tag(challenger)} salah menuduh — *KEHILANGAN 1 DADU!*`;
  } else {
    // Penebak BOHONG (Bluffing gagal)! Penebak (Bidder) kalah 1 dadu!
    loser = bidder;
    resultSummary = `❌ *TERBUKTI BOHONG!* Dadu tidak mencukupi.\n💔 ${tag(bidder)} tertangkap basah — *KEHILANGAN 1 DADU!*`;
  }

  // Kurangi dadu yang kalah
  const currentCount = (session.diceCount.get(loser) || STARTING_DICE_COUNT) - 1;
  session.diceCount.set(loser, currentCount);

  // Posisi si kalah dicatat SEBELUM daftar disaring. Kalau dia tereliminasi,
  // giliran jatuh ke pemain yang duduk sesudahnya — bukan selalu balik ke
  // pemain nomor satu.
  const loserIdxSebelum = session.alivePlayers.indexOf(loser);

  // Cek jika pemain tereliminasi (0 dadu)
  let barisEliminasi = '';
  if (currentCount <= 0) {
    session.alivePlayers = session.alivePlayers.filter(p => p !== loser);
    // Dadu milik yang tereliminasi harus ikut dibuang, kalau tidak sisanya
    // menumpuk di Map sampai sesi berakhir.
    session.playerDice.delete(loser);
    session.diceCount.delete(loser);
    barisEliminasi = `\n\n💀 *${tag(loser)} KEHABISAN DADU DAN TERELIMINASI DARI MEJA!*`;
  }

  // Pembukaan dadu adalah puncak satu ronde: seluruh tangan terbuka, seseorang
  // kehilangan dadu, kadang tersingkir. Ini salah satu dari sedikit momen yang
  // memang layak berdering — jadi tetap satu pesan baru, tapi SATU, bukan tiga
  // pesan berturut-turut seperti sebelumnya.
  await send(sock, jid, messageObj,
`📢 *${tag(challenger)} BERSERU: D U D O !* 📢
🎯 Tebakan ${tag(bidder)}: minimal *${quantity}× ${DICE_EMOJIS[face]}${face}*

🔍 *Dadu di meja dibuka:*
${revealList.join('\n')}

📊 Angka ${face}: *${actualCount - wildCount}* + Wild ⚀: *${wildCount}* = *${actualCount}* (tebakan ${quantity})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${resultSummary}${barisEliminasi}`,
    { mentions: [challenger, bidder, loser] });

  // Cek apakah tersisa 1 pemenang
  if (currentCount <= 0 && session.alivePlayers.length === 1) {
    await finishLiarsGame(sock, jid, session.alivePlayers[0]);
    return true;
  }

  // Ronde baru dimulai oleh pemain yang kalah (atau jika tereliminasi, pemain berikutnya)
  const loserIdx = session.alivePlayers.indexOf(loser);
  session.activeTurnIndex = loserIdx !== -1
    ? loserIdx
    : (loserIdxSebelum >= 0 ? loserIdxSebelum % session.alivePlayers.length : 0);

  // Jeda 3 detik lalu mulai ronde baru
  clearRoundTimer(session);
  session.roundTimer = setTimeout(async () => {
    try {
      const s = activeLiarsDice.get(jid);
      if (s && s.status === 'PLAYING') {
        s.roundTimer = null;
        await startNewDiceRound(sock, jid, s);
      }
    } catch (e) {
      console.error('[LIARS_DICE_ROUND_ERR]', e);
    }
  }, 3000);

  return true;
}

/**
 * 7. Cek Dadu Rahasia (.kartu)
 */
async function checkSecretDice(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Liar's Dice yang sedang berjalan.");
    return true;
  }

  if (!session.alivePlayers.includes(senderNumber)) {
    await send(sock, jid, messageObj, '⚠️ Kamu tidak sedang bermain di meja ini.');
    return true;
  }

  await sendSecretDiceToPlayer(sock, senderNumber, session);
  await send(sock, jid, messageObj, `📩 Dadu rahasia telah dikirimkan ulang ke DM kamu, ${tag(senderNumber)}!`, { mentions: [senderNumber] });
  return true;
}

/**
 * 8. Selesaikan Permainan & Berikan Pot Poin ke Pemenang
 */
async function finishLiarsGame(sock, jid, winnerJid) {
  const session = activeLiarsDice.get(jid);
  if (!session) return;

  clearSessionTimer(session);
  clearRoundTimer(session);
  lepasPapan(session);
  activeLiarsDice.delete(jid);

  await db.addGamePoints(winnerJid, session.pot);
  await db.finishActiveGameSession(sesiId(jid), 'FINISHED');

  const victoryAnnouncement =
`👑🏆 *PENGUASA DADU BAJAK LAUT!* 🏆👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 Selamat kepada ${tag(winnerJid)} yang berhasil bertahan dan menjadi pemenang tunggal di meja Liar's Dice!
💰 *Total Hadiah Pot Kemenangan:* *+${session.pot} Poin*
✨ Poin kemenangan telah langsung masuk ke rekening pemenang!

Terima kasih telah bermain Liar's Dice! Ketik \`.liarsdice [taruhan]\` untuk membuka ronde baru!`;

  await send(sock, jid, null, victoryAnnouncement, { mentions: [winnerJid] });
}

/**
 * 9. Batalkan Lobi Permainan
 */
async function cancelLiarsGame(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Liar's Dice aktif di grup ini.");
    return true;
  }

  if (session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Permainan Liar's Dice sudah berjalan dan tidak dapat dibatalkan!");
    return true;
  }

  if (senderNumber !== session.host) {
    await send(sock, jid, messageObj, `⚠️ Hanya Host (${tag(session.host)}) yang dapat membatalkan lobi!`, { mentions: [session.host] });
    return true;
  }

  clearSessionTimer(session);
  activeLiarsDice.delete(jid);
  await refundLiarsSession(session);

  await send(sock, jid, messageObj, `🛑 Lobi Liar's Dice telah dibatalkan oleh Host. Seluruh poin pemain telah dikembalikan 100%.`);
  return true;
}

/**
 * 10. Menyerah di Tengah Permainan (.nyerahliar)
 *
 * Tanpa ini satu pemain yang menghilang menyandera meja: timer 45 detik memang
 * memaksa dia auto-DUDO, tapi butuh berkali-kali ronde sampai dadunya habis.
 * Taruhan yang menyerah tetap hangus ke pot — itu konsekuensi mundur.
 */
async function surrenderLiarsGame(sock, jid, senderNumber, messageObj) {
  const session = activeLiarsDice.get(jid);
  if (!session || session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, "❌ Tidak ada permainan Liar's Dice yang sedang berjalan di grup ini.");
    return true;
  }

  if (!session.alivePlayers.includes(senderNumber)) {
    await send(sock, jid, messageObj, '⚠️ Kamu tidak sedang bermain di meja ini.');
    return true;
  }

  if (session.resolving) {
    await send(sock, jid, messageObj, '⏳ Dadu sedang dibuka & dihitung. Coba lagi setelah ronde baru dikocok.');
    return true;
  }

  const idxSebelum = session.alivePlayers.indexOf(senderNumber);
  session.alivePlayers = session.alivePlayers.filter(p => p !== senderNumber);
  session.playerDice.delete(senderNumber);
  session.diceCount.delete(senderNumber);

  await send(sock, jid, messageObj, `🏳️ ${tag(senderNumber)} *MENYERAH* dan meninggalkan meja Liar's Dice!\n💸 Taruhannya hangus dan tetap tertinggal di pot.`, { mentions: [senderNumber] });

  if (session.alivePlayers.length === 1) {
    await finishLiarsGame(sock, jid, session.alivePlayers[0]);
    return true;
  }

  // Tebakan milik yang menyerah tidak boleh mengunci ronde: langsung kocok ulang.
  clearSessionTimer(session);
  clearRoundTimer(session);
  session.resolving = true;
  session.activeTurnIndex = idxSebelum >= 0 ? idxSebelum % session.alivePlayers.length : 0;

  session.roundTimer = setTimeout(async () => {
    try {
      const s = activeLiarsDice.get(jid);
      if (s && s.status === 'PLAYING') {
        s.roundTimer = null;
        await startNewDiceRound(sock, jid, s);
      }
    } catch (e) {
      console.error('[LIARS_DICE_SURRENDER_ERR]', e);
    }
  }, 3000);

  return true;
}

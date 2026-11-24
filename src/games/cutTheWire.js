/**
 * 💣 CUT THE WIRE (JINAKKAN BOM WAKTU)
 * Game Party Cepat & Ketegangan Tinggi (2-6 Pemain)
 *
 * Aturan:
 * - Koper bom memiliki 6 kabel berwarna (Merah, Biru, Kuning, Hijau, Ungu, Putih).
 * - 1 Kabel DETONATOR: Meledak seketika, pemain meledak & gugur, taruhan hangus ke Pot.
 * - 1 Kabel DEFUSAL: Menjinakkan bom seketika, pemain tersebut langsung menang 100% Pot!
 * - 4 Kabel SAFE: Pemain selamat, Pot mendapat multiplier +25%, giliran oper ke pemain berikutnya.
 */

import * as db from '../../database.js';
import { send, catatJejak, perbaruiPapan, lepasPapan } from './helpers.js';

export const activeWireGames = new Map();

const MIN_BET = 20;
const DEFAULT_BET = 50;
const MAX_BET = 100_000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const LOBBY_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 30_000;

export const WIRE_COLORS = [
  { id: '1', key: 'merah', name: 'Merah', emoji: '🔴', aliases: ['merah', 'red', '1'] },
  { id: '2', key: 'biru', name: 'Biru', emoji: '🔵', aliases: ['biru', 'blue', '2'] },
  { id: '3', key: 'kuning', name: 'Kuning', emoji: '🟡', aliases: ['kuning', 'yellow', '3'] },
  { id: '4', key: 'hijau', name: 'Hijau', emoji: '🟢', aliases: ['hijau', 'green', '4'] },
  { id: '5', key: 'ungu', name: 'Ungu', emoji: '🟣', aliases: ['ungu', 'purple', '5'] },
  { id: '6', key: 'putih', name: 'Putih', emoji: '⚪', aliases: ['putih', 'white', '6'] }
];

function tag(jid) {
  return `@${jid.split('@')[0]}`;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clearSessionTimer(session) {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

/**
 * Refund seluruh taruhan jika lobi dibatalkan / timeout
 */
async function refundWireSession(session) {
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
  await db.finishActiveGameSession(db.sesiGameId('cutthewire', session.jid), 'CANCELLED');
  return refunded;
}

/**
 * Render koper bom — dipadatkan.
 *
 * Papan ini muncul di setiap potongan kabel, jadi bentuk lamanya (10 baris
 * penuh garis pemisah + pesan narasi terpisah) berarti dua pesan panjang per
 * giliran. Sekarang satu papan hidup, dan narasi tiap potongan turun jadi satu
 * baris jejak di dalamnya.
 */
function renderBombVisual(session) {
  const kabel = WIRE_COLORS.map(w => (
    session.cutWires.has(w.key) ? `~${w.name}~` : `${w.emoji}[${w.id}]${w.name}`
  )).join(' · ');

  const multiplierText = session.multiplier > 1.0 ? ` ×${session.multiplier.toFixed(2)}` : '';
  const sisaKabel = WIRE_COLORS.filter(w => !session.cutWires.has(w.key)).length;

  const jejak = (session.jejak || []).length
    ? `\n${session.jejak.map(r => `▸ ${r}`).join('\n')}`
    : '';

  return (
`💣 *KOPER BOM WAKTU* · 💰 *${session.pot} Poin*${multiplierText} · 🧵 ${sisaKabel} kabel utuh
${kabel}
👥 ${session.alivePlayers.map(p => tag(p)).join(' · ')}${jejak}
👉 Giliran ${tag(session.alivePlayers[session.activeTurnIndex])} — ketik \`.potong merah\` _(${TURN_TIMEOUT_MS / 1000}s)_`
  );
}

/** Papan koper hidup: satu pesan yang diedit, bukan dua pesan tiap potongan. */
async function perbaruiKoper(sock, jid, session, opsi = {}) {
  return await perbaruiPapan(sock, jid, session, renderBombVisual, {
    mentions: session.alivePlayers,
    ...opsi
  });
}

/**
 * Pasang timer giliran per pemain (30s)
 */
function armWireTurnTimer(sock, jid) {
  const session = activeWireGames.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  session.timer = setTimeout(async () => {
    try {
      const live = activeWireGames.get(jid);
      if (!live || live.status !== 'PLAYING') return;

      const currentP = live.alivePlayers[live.activeTurnIndex];
      // Cari kabel yang masih utuh secara acak untuk dipotong otomatis
      const remainingWires = WIRE_COLORS.filter(w => !live.cutWires.has(w.key));
      if (remainingWires.length === 0) return;

      const randomWire = remainingWires[Math.floor(Math.random() * remainingWires.length)];
      // Cukup satu baris jejak; `executeCutWire` yang menuliskan hasilnya.
      catatJejak(live, `⏰ Waktu ${tag(currentP)} habis — potong acak ${randomWire.emoji} ${randomWire.name}`);
      await executeCutWire(sock, jid, currentP, randomWire.key);
    } catch (e) {
      console.error('[WIRE_TIMEOUT_ERR]', e);
    }
  }, TURN_TIMEOUT_MS);
}

/**
 * Handler utama perintah Cut The Wire (.bom / .potong)
 */
export async function handleCutTheWire(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Permainan Cut The Wire (Jinakkan Bom) hanya dapat dimainkan di grup!');
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  // Alias potong kabel langsung (.potong <warna>)
  if (['potong', 'cut', 'kabel'].includes(command)) {
    const wireInput = (args[1] || '').toLowerCase();
    return await cutWireAction(sock, jid, senderNumber, messageObj, wireInput);
  }

  if (['join', 'ikut', 'masuk'].includes(subCmd) || command === 'joinbom') {
    return await joinWireLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'gas'].includes(subCmd) || command === 'gasbom') {
    return await startWireGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd) || command === 'batalbom') {
    return await cancelWireGame(sock, jid, senderNumber, messageObj);
  }

  if (['potong', 'cut', 'pilih'].includes(subCmd)) {
    const wireInput = (args[2] || '').toLowerCase();
    return await cutWireAction(sock, jid, senderNumber, messageObj, wireInput);
  }

  // Buka Lobi Baru (.bom [taruhan])
  const betArg = parseInt(args[1], 10);
  const buyIn = Math.min(MAX_BET, Math.max(MIN_BET, isNaN(betArg) ? DEFAULT_BET : betArg));

  return await createWireLobby(sock, jid, senderNumber, messageObj, buyIn);
}

/**
 * 1. Buka Lobi Permainan
 */
async function createWireLobby(sock, jid, senderNumber, messageObj, buyIn) {
  if (activeWireGames.has(jid)) {
    const existing = activeWireGames.get(jid);
    if (existing.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Masih ada lobi Bom Waktu aktif!\nKetik \`.bom join\` untuk gabung atau \`.bom start\` untuk mulai.`);
      return true;
    }
    await send(sock, jid, messageObj, `⚠️ Permainan Bom Waktu sedang berlangsung di grup ini! Tunggu hingga selesai.`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  const userPoints = prof?.points || 0;
  if (userPoints < buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membuat lobi dengan taruhan *${buyIn} Poin*! (Poinmu: ${userPoints})`);
    return true;
  }

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    players: [senderNumber],
    alivePlayers: [],
    chargedPlayers: new Set(),
    wireRoles: new Map(), // key -> 'DETONATOR' | 'DEFUSAL' | 'SAFE'
    cutWires: new Set(),
    activeTurnIndex: 0,
    multiplier: 1.0,
    pot: 0,
    timer: null,
    createdAt: Date.now()
  };

  activeWireGames.set(jid, session);

  // Pasang timer lobi 60 detik
  session.timer = setTimeout(async () => {
    try {
      const s = activeWireGames.get(jid);
      if (s && s.status === 'LOBBY') {
        activeWireGames.delete(jid);
        await refundWireSession(s);
        await send(sock, jid, null, `⏰ *Lobi Bom Waktu Dibatalkan* karena tidak dimulai dalam 60 detik.`);
      }
    } catch (_) {}
  }, LOBBY_TIMEOUT_MS);

  const text =
`💣 ─── *LOBI JINAKKAN BOM (CUT THE WIRE)* ─── 💣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Host:* ${tag(senderNumber)}
💰 *Taruhan Masuk:* *${buyIn} Poin* / pemain
👥 *Pemain Terdaftar (1/${MAX_PLAYERS}):*
  1. ${tag(senderNumber)} (Host)

✂️ *Kabel Koper:* 6 Kabel (1 Meledak 💥, 1 Jinak Menang Instan ✂️, 4 Aman Multiplier ⏳)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 Ketik \`.bom join\` untuk bergabung (Min. ${MIN_PLAYERS} pemain)
👉 Ketik \`.bom start\` untuk memulai permainan!
_⏳ Lobi otomatis batal dalam 60 detik jika tidak dimulai._`;

  await send(sock, jid, messageObj, text, { mentions: [senderNumber] });
  return true;
}

/**
 * 2. Gabung Lobi Permainan
 */
async function joinWireLobby(sock, jid, senderNumber, messageObj) {
  const session = activeWireGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Tidak ada lobi Bom Waktu aktif. Ketik `.bom [taruhan]` untuk membuka lobi baru!');
    return true;
  }

  if (session.players.includes(senderNumber)) {
    await send(sock, jid, messageObj, '⚠️ Kamu sudah terdaftar di lobi ini!');
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

  const playerList = session.players.map((p, idx) => `  ${idx + 1}. ${tag(p)}${p === session.host ? ' (Host)' : ''}`).join('\n');
  const msg =
`✅ ${tag(senderNumber)} bergabung ke lobi Bom Waktu!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *Daftar Pemain (${session.players.length}/${MAX_PLAYERS}):*
${playerList}

👉 Ketik \`.bom start\` untuk memulai permainan!`;

  await send(sock, jid, messageObj, msg, { mentions: session.players });

  if (session.players.length === MAX_PLAYERS) {
    await startWireGame(sock, jid, session.host, messageObj);
  }
  return true;
}

/**
 * 3. Memulai Permainan
 */
async function startWireGame(sock, jid, senderNumber, messageObj) {
  const session = activeWireGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Tidak ada lobi yang siap dimulai.');
    return true;
  }

  if (senderNumber !== session.host && session.players.length < MAX_PLAYERS) {
    await send(sock, jid, messageObj, `⚠️ Hanya Host (${tag(session.host)}) yang dapat memulai permainan!`, { mentions: [session.host] });
    return true;
  }

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai permainan! (Saat ini: ${session.players.length} pemain)`);
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
    await refundWireSession(session);
    activeWireGames.delete(jid);
    await send(sock, jid, messageObj, `❌ Gagal memulai: Ada pemain yang poinnya tidak cukup saat start!\nPemain: ${failed.map(f => tag(f)).join(', ')}`, { mentions: failed });
    return true;
  }

  // Catat sesi aktif ke SQLite untuk proteksi crash
  await db.createActiveGameSession({
    id: db.sesiGameId('cutthewire', jid),
    gameType: 'Cut The Wire',
    jid,
    host: session.host,
    buyIn: session.buyIn,
    pot: session.buyIn * session.players.length,
    players: session.players.map(p => ({ jid: p, points: session.buyIn }))
  });

  session.status = 'PLAYING';
  session.alivePlayers = shuffle(session.players);
  session.activeTurnIndex = 0;
  session.pot = session.buyIn * session.players.length;
  session.multiplier = 1.0;
  session.cutWires = new Set();

  // Acak peran 6 kabel
  const shuffledKeys = shuffle(WIRE_COLORS.map(w => w.key));
  session.wireRoles.set(shuffledKeys[0], 'DETONATOR'); // 💥 Meledak
  session.wireRoles.set(shuffledKeys[1], 'DEFUSAL');   // ✂️ Jinakkan & Menang Instan
  session.wireRoles.set(shuffledKeys[2], 'SAFE');      // ⏳ Aman
  session.wireRoles.set(shuffledKeys[3], 'SAFE');      // ⏳ Aman
  session.wireRoles.set(shuffledKeys[4], 'SAFE');      // ⏳ Aman
  session.wireRoles.set(shuffledKeys[5], 'SAFE');      // ⏳ Aman

  // Pembuka boleh berdering sekali. Sesudah itu seluruh permainan berjalan di
  // dalam satu papan koper yang diedit di tempat.
  await send(sock, jid, messageObj,
`🚨 *JINAKKAN BOM DIMULAI!* 🚨
Koper bom aktif di tengah meja. Detonator berdetik cepat...
💰 *Pot Taruhan:* *${session.pot} Poin*
🎯 *Urutan:* ${session.alivePlayers.map(p => tag(p)).join(' ➔ ')}

👉 Ketik \`.potong <warna>\` saat giliranmu. Papan koper di bawah diperbarui otomatis — tidak perlu di-scroll ulang.`,
    { mentions: session.alivePlayers });

  lepasPapan(session);
  catatJejak(session, '🚩 Koper dibuka — 6 kabel masih utuh');
  await perbaruiKoper(sock, jid, session);
  armWireTurnTimer(sock, jid);
  return true;
}

/**
 * 4. Aksi Pemain Memotong Kabel (.potong <warna/nomor>)
 */
async function cutWireAction(sock, jid, senderNumber, messageObj, wireInput) {
  const session = activeWireGames.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  const currentP = session.alivePlayers[session.activeTurnIndex];
  if (senderNumber !== currentP) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(currentP)} untuk memotong kabel.`, { mentions: [currentP] });
    return true;
  }

  if (!wireInput) {
    await send(sock, jid, messageObj, `❌ Sebutkan kabel yang ingin dipotong!\nContoh: \`.potong merah\` atau \`.potong 1\``);
    return true;
  }

  const targetWire = WIRE_COLORS.find(w => w.aliases.includes(wireInput.toLowerCase()));
  if (!targetWire) {
    await send(sock, jid, messageObj, `❌ Kabel tidak dikenali! Pilihan: Merah (1), Biru (2), Kuning (3), Hijau (4), Ungu (5), Putih (6).`);
    return true;
  }

  if (session.cutWires.has(targetWire.key)) {
    await send(sock, jid, messageObj, `⚠️ Kabel *${targetWire.name}* sudah pernah dipotong! Pilih kabel lain yang masih tersambung.`);
    return true;
  }

  clearSessionTimer(session);
  return await executeCutWire(sock, jid, currentP, targetWire.key, messageObj);
}

/**
 * 5. Eksekusi Logika Pemotongan Kabel
 */
async function executeCutWire(sock, jid, player, wireKey, messageObj = null) {
  const session = activeWireGames.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  session.cutWires.add(wireKey);
  const wireInfo = WIRE_COLORS.find(w => w.key === wireKey);
  const role = session.wireRoles.get(wireKey);

  // 💥 KASUS A: KABEL DETONATOR (MELEDAK)
  if (role === 'DETONATOR') {
    session.alivePlayers = session.alivePlayers.filter(p => p !== player);

    // Ledakan memang pantas berdering — seseorang baru saja tersingkir dan
    // kehilangan taruhannya. Ini salah satu dari sedikit momen yang tetap
    // dikirim sebagai pesan baru, bukan diselipkan ke papan.
    await send(sock, jid, messageObj,
`💥 *BOOOOM!* ${tag(player)} memotong *${wireInfo.emoji} ${wireInfo.name}* — itu DETONATOR!
💀 ${tag(player)} tereliminasi, taruhannya hangus ke Pot.`,
      { mentions: [player] });

    // Cek sisa pemain hidup
    if (session.alivePlayers.length === 1) {
      const winner = session.alivePlayers[0];
      await finishWireGame(sock, jid, winner, `🏆 *SEMUA LAWAN TELAH MELEDAK!*`);
      return true;
    }

    if (session.alivePlayers.length === 0) {
      activeWireGames.delete(jid);
      await db.finishActiveGameSession(db.sesiGameId('cutthewire', jid), 'FINISHED');
      await send(sock, jid, null, `💀 *SEMUA PEMAIN TELAH GUGUR!* Tidak ada yang selamat.`);
      return true;
    }

    // Sesuaikan activeTurnIndex jika keluar index batas
    if (session.activeTurnIndex >= session.alivePlayers.length) {
      session.activeTurnIndex = 0;
    }

    catatJejak(session, `💥 ${tag(player)} meledak di kabel ${wireInfo.emoji} ${wireInfo.name}`);
    await perbaruiKoper(sock, jid, session);
    armWireTurnTimer(sock, jid);
    return true;
  }

  // ✂️ KASUS B: KABEL DEFUSAL (JINAK & MENANG INSTAN)
  if (role === 'DEFUSAL') {
    await send(sock, jid, messageObj,
`🎉 *KLIK! BOM BERHASIL DIJINAKKAN!* ✂️
${tag(player)} memotong *${wireInfo.emoji} ${wireInfo.name}* dan layar bom padam seketika!`,
      { mentions: [player] });
    await finishWireGame(sock, jid, player, `🏆 *PAHLAWAN PENJINAK BOM!*`);
    return true;
  }

  // ⏳ KASUS C: KABEL SAFE (AMAN & MULTIPLIER NAIK)
  session.multiplier += 0.25;
  const addedBonus = Math.floor(session.buyIn * 0.25);
  session.pot += addedBonus;
  await db.updateActiveGameSession(db.sesiGameId('cutthewire', jid), { pot: session.pot });

  catatJejak(session, `✂️ ${tag(player)} potong ${wireInfo.emoji} ${wireInfo.name} — *AMAN*, pot +${addedBonus}`);

  // Pindah giliran ke pemain berikutnya
  session.activeTurnIndex = (session.activeTurnIndex + 1) % session.alivePlayers.length;

  // Cek apakah seluruh kabel aman habis sehingga tersisa 1 detonator & 1 defusal
  const remainingWires = WIRE_COLORS.filter(w => !session.cutWires.has(w.key));
  if (remainingWires.length === 2) {
    catatJejak(session, '🔥 *50:50!* Sisa 1 kabel meledak & 1 kabel jinak');
  }

  await perbaruiKoper(sock, jid, session);
  armWireTurnTimer(sock, jid);
  return true;
}

/**
 * 6. Selesaikan Game & Berikan Hadiah Pot ke Pemenang
 */
async function finishWireGame(sock, jid, winner, headerTitle) {
  const session = activeWireGames.get(jid);
  if (!session) return;

  clearSessionTimer(session);

  // Keadaan akhir koper diperbarui sekali lagi sebelum papannya dilepas.
  await perbaruiKoper(sock, jid, session).catch(() => {});
  lepasPapan(session);
  activeWireGames.delete(jid);

  await db.addGamePoints(winner, session.pot);
  await db.finishActiveGameSession(db.sesiGameId('cutthewire', jid), 'FINISHED');

  const winAnnouncement =
`${headerTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *PEMENANG UTAMA:* ${tag(winner)}
💰 *Hadiah Kemenangan:* *+${session.pot} Poin*
✨ Poin telah langsung dikirimkan ke dompet pemenang!

Terima kasih telah bermain Cut The Wire! Ketik \`.bom [taruhan]\` untuk membuka ronde baru!`;

  await send(sock, jid, null, winAnnouncement, { mentions: [winner] });
}

/**
 * 7. Batalkan Lobi Permainan
 */
async function cancelWireGame(sock, jid, senderNumber, messageObj) {
  const session = activeWireGames.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, '❌ Tidak ada sesi Bom Waktu aktif di grup ini.');
    return true;
  }

  if (session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Permainan sudah berjalan dan tidak dapat dibatalkan di tengah jalan!');
    return true;
  }

  if (senderNumber !== session.host) {
    await send(sock, jid, messageObj, `⚠️ Hanya Host (${tag(session.host)}) yang dapat membatalkan lobi!`, { mentions: [session.host] });
    return true;
  }

  clearSessionTimer(session);
  activeWireGames.delete(jid);
  await refundWireSession(session);

  await send(sock, jid, messageObj, `🛑 Lobi Bom Waktu telah dibatalkan oleh Host. Semua poin pemain telah dikembalikan 100%.`);
  return true;
}

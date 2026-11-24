/**
 * 🚢 BATTLESHIP 1V1 (PERANG ARMADA KAPAL LAUT)
 * Game Duel Taktis Grid 5x5 antar 2 Pemain
 *
 * Aturan:
 * - Grid 5x5 (Kolom A-E, Baris 1-5).
 * - 3 Armada Kapal:
 *   1. 🚢 Kapal Induk (3 petak)
 *   2. 🛥️ Destroyer (2 petak)
 *   3. 🚤 Kapal Selam (1 petak)
 * - Pemain bergantian menembak koordinat (.tembak B3).
 * - Efek: 🌊 Meleset (ganti giliran), 🔥 HIT! (bonus nembak lagi), 💥 SUNK! (kapal tenggelam).
 * - Pemain pertama yang menenggelamkan seluruh armada musuh menang!
 */

import * as db from '../../database.js';
import { send, catatJejak, perbaruiPapan, lepasPapan } from './helpers.js';

export const activeBattleships = new Map();
export const pendingBattleships = new Map();

const MIN_BET = 20;
const DEFAULT_BET = 50;
const MAX_BET = 100_000;
const CHALLENGE_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 45_000;
const GRID_SIZE = 5; // 5x5 (A-E, 1-5)
const COLS = ['A', 'B', 'C', 'D', 'E'];

function tag(jid) {
  return `@${jid.split('@')[0]}`;
}

function clearSessionTimer(session) {
  if (session && session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

/**
 * Generate posisi kapal acak yang sah di grid 5x5
 * Kapal: 3 petak (Carrier), 2 petak (Destroyer), 1 petak (Submarine)
 */
export function generateRandomFleet() {
  const occupied = new Set();
  const fleet = {
    carrier: { name: 'Kapal Induk', size: 3, coords: [], hits: 0, sunk: false, icon: '🚢' },
    destroyer: { name: 'Destroyer', size: 2, coords: [], hits: 0, sunk: false, icon: '🛥️' },
    submarine: { name: 'Kapal Selam', size: 1, coords: [], hits: 0, sunk: false, icon: '🚤' }
  };

  const shipsToPlace = [
    { key: 'carrier', size: 3 },
    { key: 'destroyer', size: 2 },
    { key: 'submarine', size: 1 }
  ];

  for (const ship of shipsToPlace) {
    let placed = false;
    let attempts = 0;

    while (!placed && attempts < 100) {
      attempts++;
      const isHorizontal = Math.random() < 0.5;
      const maxCol = isHorizontal ? GRID_SIZE - ship.size : GRID_SIZE - 1;
      const maxRow = isHorizontal ? GRID_SIZE - 1 : GRID_SIZE - ship.size;

      const colIdx = Math.floor(Math.random() * (maxCol + 1));
      const rowIdx = Math.floor(Math.random() * (maxRow + 1));

      const coords = [];
      let collision = false;

      for (let i = 0; i < ship.size; i++) {
        const c = isHorizontal ? colIdx + i : colIdx;
        const r = isHorizontal ? rowIdx : rowIdx + i;
        const coordKey = `${COLS[c]}${r + 1}`;

        if (occupied.has(coordKey)) {
          collision = true;
          break;
        }
        coords.push(coordKey);
      }

      if (!collision) {
        coords.forEach(coord => occupied.add(coord));
        fleet[ship.key].coords = coords;
        placed = true;
      }
    }
  }

  return fleet;
}

/**
 * Render radar — sengaja dipadatkan.
 *
 * Papan ini muncul di setiap tembakan, jadi setiap baris hiasan terbayar
 * puluhan kali per pertandingan. Yang disisakan hanya yang benar-benar dipakai
 * pemain untuk memilih koordinat berikutnya: grid, sisa armada musuh, jejak
 * tiga langkah terakhir, dan giliran siapa sekarang.
 */
function renderRadarVisual(session, shooterJid) {
  const isP1 = shooterJid === session.player1;
  const enemyJid = isP1 ? session.player2 : session.player1;
  const shots = isP1 ? session.p1Shots : session.p2Shots;
  const enemyFleet = isP1 ? session.p2Fleet : session.p1Fleet;

  const IKON = { MISS: '🌊', HIT: '🔥', SUNK: '💥' };

  let radarGrid = '   A  B  C  D  E\n';
  for (let r = 1; r <= GRID_SIZE; r++) {
    radarGrid += `${r} `;
    for (let c = 0; c < GRID_SIZE; c++) {
      radarGrid += `${IKON[shots.get(`${COLS[c]}${r}`)] || '⬛'} `;
    }
    radarGrid += '\n';
  }

  const armada = Object.values(enemyFleet)
    .map(s => (s.sunk ? `~${s.icon}~` : `${s.icon}${s.size - s.hits}/${s.size}`))
    .join(' · ');

  const jejak = (session.jejak || []).length
    ? `\n${session.jejak.map(r => `▸ ${r}`).join('\n')}`
    : '';

  return (
`🚢 *BATTLESHIP* · 🎯 ${tag(shooterJid)} ➔ ${tag(enemyJid)}
${radarGrid}🛡️ Armada musuh: ${armada}
_⬛ kosong · 🌊 meleset · 🔥 kena · 💥 tenggelam_${jejak}
👉 Giliran ${tag(session.activeTurn)} — ketik \`.tembak B3\` _(${TURN_TIMEOUT_MS / 1000}s)_`
  );
}

/** Papan radar hidup: satu pesan yang diedit, bukan dua pesan tiap tembakan. */
async function perbaruiRadar(sock, jid, session, opsi = {}) {
  return await perbaruiPapan(
    sock, jid, session,
    s => renderRadarVisual(s, s.activeTurn),
    { mentions: [session.player1, session.player2], ...opsi }
  );
}

/**
 * Pasang timer giliran tembak (45s)
 */
function armBattleshipTurnTimer(sock, jid) {
  const session = activeBattleships.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  session.timer = setTimeout(async () => {
    try {
      const live = activeBattleships.get(jid);
      if (!live || live.status !== 'PLAYING') return;

      const currentP = live.activeTurn;
      const isP1 = currentP === live.player1;
      const shots = isP1 ? live.p1Shots : live.p2Shots;

      // Cari koordinat yang belum pernah ditembak secara acak
      const unshot = [];
      for (let r = 1; r <= GRID_SIZE; r++) {
        for (let c = 0; c < GRID_SIZE; c++) {
          const coord = `${COLS[c]}${r}`;
          if (!shots.has(coord)) unshot.push(coord);
        }
      }

      if (unshot.length === 0) return;
      const randomCoord = unshot[Math.floor(Math.random() * unshot.length)];

      // Tidak perlu pesan sendiri: `executeShot` sudah menuliskan hasilnya
      // sebagai baris jejak, dan baris ini menandai bahwa tembakannya otomatis.
      catatJejak(live, `⏰ Waktu ${tag(currentP)} habis — tembakan acak ke *${randomCoord}*`);
      await executeShot(sock, jid, currentP, randomCoord);
    } catch (e) {
      console.error('[BATTLESHIP_TIMEOUT_ERR]', e);
    }
  }, TURN_TIMEOUT_MS);
}

/**
 * Handler utama Battleship (.battleship / .kapal / .tembak)
 */
export async function handleBattleshipCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Permainan Battleship hanya dapat dimainkan di dalam grup!');
    return true;
  }

  // Aksi menembak rudal (.tembak <koordinat> / .rudal <koordinat>)
  if (['tembak', 'shoot', 'rudal', 'fire', 'bomkapal'].includes(command)) {
    const coord = (args[1] || '').toUpperCase();
    return await shootCoordinateAction(sock, jid, senderNumber, messageObj, coord);
  }

  const subCmd = (args[1] || '').toLowerCase();

  // Terima Tantangan (.battleship gas / .terimakapal)
  if (['terima', 'gas', 'ikut', 'join', 'acc', 'accept'].includes(subCmd) || command === 'terimakapal' || command === 'gaskapal') {
    return await acceptBattleshipChallenge(sock, jid, senderNumber, messageObj);
  }

  // Tolak Tantangan (.battleship tolak / .tolakkapal)
  if (['tolak', 'cancel', 'batal', 'reject'].includes(subCmd) || command === 'tolakkapal' || command === 'batalkapal') {
    return await rejectBattleshipChallenge(sock, jid, senderNumber, messageObj);
  }

  // Tantang Lawan (.battleship @member [taruhan])
  return await createBattleshipChallenge(sock, jid, senderNumber, messageObj, args);
}

/**
 * 1. Buat Tantangan Duel Battleship
 */
async function createBattleshipChallenge(sock, jid, senderNumber, messageObj, args) {
  if (activeBattleships.has(jid)) {
    await send(sock, jid, messageObj, '⚠️ Masih ada duel Battleship yang sedang berlangsung di grup ini! Tunggu hingga selesai.');
    return true;
  }

  if (pendingBattleships.has(jid)) {
    await send(sock, jid, messageObj, '⚠️ Masih ada tantangan Battleship yang menunggu konfirmasi!');
    return true;
  }

  const mentioned = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  let targetNumber = mentioned[0];

  // Fallback target dari args jika nomor diketik
  if (!targetNumber && args[1] && args[1].includes('@')) {
    targetNumber = args[1].replace(/[@]/g, '') + '@s.whatsapp.net';
  }

  if (!targetNumber) {
    await send(sock, jid, messageObj, '❌ Tag lawan yang ingin kamu tantang!\nContoh: `.battleship @member 50`');
    return true;
  }

  if (targetNumber === senderNumber) {
    await send(sock, jid, messageObj, '❌ Kamu tidak bisa menantang dirimu sendiri!');
    return true;
  }

  const betIdx = args.findIndex((arg, i) => i > 0 && !isNaN(parseInt(arg, 10)));
  const betArg = betIdx !== -1 ? parseInt(args[betIdx], 10) : DEFAULT_BET;
  const buyIn = Math.min(MAX_BET, Math.max(MIN_BET, isNaN(betArg) ? DEFAULT_BET : betArg));

  // Cek saldo penantang
  const p1Prof = await db.getGameProfile(senderNumber);
  if ((p1Prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk menantang duel sebesar *${buyIn} Poin*! (Poinmu: ${p1Prof?.points || 0})`);
    return true;
  }

  // Cek saldo tertantang
  const p2Prof = await db.getGameProfile(targetNumber);
  if ((p2Prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Lawan (${tag(targetNumber)}) tidak memiliki cukup poin untuk taruhan *${buyIn} Poin*!`, { mentions: [targetNumber] });
    return true;
  }

  const challenge = {
    jid,
    challenger: senderNumber,
    target: targetNumber,
    buyIn,
    timer: setTimeout(async () => {
      if (pendingBattleships.has(jid)) {
        pendingBattleships.delete(jid);
        await send(sock, jid, null, `⏰ *Tantangan Battleship Kedaluwarsa* karena tidak dijawab dalam 60 detik.`);
      }
    }, CHALLENGE_TIMEOUT_MS)
  };

  pendingBattleships.set(jid, challenge);

  const text =
`🚢 ─── *TANTANGAN PERANG KAPAL (BATTLESHIP)* ─── 🚢
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚔️ ${tag(senderNumber)} menantang ${tag(targetNumber)} dalam duel Battleship 1v1!
💰 *Taruhan Tarung:* *${buyIn} Poin* / pemain (Total Pot: *${buyIn * 2} Poin*)

📦 *Armada Siap Tempur:*
  • 🚢 1x Kapal Induk (3 Petak)
  • 🛥️ 1x Destroyer (2 Petak)
  • 🚤 1x Kapal Selam (1 Petak)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 ${tag(targetNumber)}, ketik \`.battleship gas\` untuk menerima tantangan!
👉 Ketik \`.battleship tolak\` untuk menolak.
_⏳ Waktu konfirmasi: 60 detik_`;

  await send(sock, jid, messageObj, text, { mentions: [senderNumber, targetNumber] });
  return true;
}

/**
 * 2. Terima Tantangan Battleship
 */
async function acceptBattleshipChallenge(sock, jid, senderNumber, messageObj) {
  const challenge = pendingBattleships.get(jid);
  if (!challenge) {
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan Battleship yang menunggu konfirmasi.');
    return true;
  }

  if (senderNumber !== challenge.target) {
    await send(sock, jid, messageObj, `⚠️ Hanya ${tag(challenge.target)} yang berhak menerima tantangan ini!`, { mentions: [challenge.target] });
    return true;
  }

  clearSessionTimer(challenge);
  pendingBattleships.delete(jid);

  // Potong saldo kedua pemain
  const p1Deduct = await db.deductGamePoints(challenge.challenger, challenge.buyIn);
  const p2Deduct = await db.deductGamePoints(challenge.target, challenge.buyIn);

  if (!p1Deduct?.success || !p2Deduct?.success) {
    if (p1Deduct?.success) await db.addGamePoints(challenge.challenger, challenge.buyIn);
    if (p2Deduct?.success) await db.addGamePoints(challenge.target, challenge.buyIn);
    await send(sock, jid, messageObj, '❌ Gagal memulai: Salah satu pemain kehabisan poin saat konfirmasi!');
    return true;
  }

  // Buat formasi kapal acak rahasia untuk kedua pemain
  const p1Fleet = generateRandomFleet();
  const p2Fleet = generateRandomFleet();

  const session = {
    jid,
    player1: challenge.challenger,
    player2: challenge.target,
    buyIn: challenge.buyIn,
    pot: challenge.buyIn * 2,
    p1Fleet,
    p2Fleet,
    p1Shots: new Map(), // coord -> 'MISS' | 'HIT' | 'SUNK'
    p2Shots: new Map(),
    activeTurn: Math.random() < 0.5 ? challenge.challenger : challenge.target,
    status: 'PLAYING',
    timer: null,
    createdAt: Date.now()
  };

  activeBattleships.set(jid, session);

  // Rekam ke active_game_sessions untuk proteksi restart
  await db.createActiveGameSession({
    id: db.sesiGameId('battleship', jid),
    gameType: 'Battleship',
    jid,
    host: challenge.challenger,
    buyIn: challenge.buyIn,
    pot: session.pot,
    players: [{ jid: challenge.challenger, points: challenge.buyIn }, { jid: challenge.target, points: challenge.buyIn }]
  });

  // Pengumuman pembuka memang layak berdering sekali. Sesudah ini seluruh
  // pertandingan berjalan di dalam satu papan radar yang diedit di tempat.
  await send(sock, jid, messageObj,
`🌊🚀 *PERANG LAUT DIMULAI!* 🚀🌊
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${tag(session.player1)} vs ${tag(session.player2)}
💰 *Pot Pertempuran:* *${session.pot} Poin*

👉 Ketik \`.tembak B3\` saat giliranmu. Papan radar di bawah diperbarui otomatis — tidak perlu di-scroll ulang.`,
    { mentions: [session.player1, session.player2] });

  lepasPapan(session);
  catatJejak(session, '🚩 Pertempuran dimulai — armada sudah menempati posisi');
  await perbaruiRadar(sock, jid, session);
  armBattleshipTurnTimer(sock, jid);
  return true;
}

/**
 * 3. Tolak Tantangan Battleship
 */
async function rejectBattleshipChallenge(sock, jid, senderNumber, messageObj) {
  const challenge = pendingBattleships.get(jid);
  if (!challenge) {
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan Battleship yang aktif.');
    return true;
  }

  if (senderNumber !== challenge.target && senderNumber !== challenge.challenger) {
    await send(sock, jid, messageObj, '⚠️ Kamu bukan pemain yang terlibat dalam tantangan ini!');
    return true;
  }

  clearSessionTimer(challenge);
  pendingBattleships.delete(jid);

  await send(sock, jid, messageObj, `🛑 Tantangan Battleship telah ditolak/dibatalkan.`);
  return true;
}

/**
 * 4. Aksi Tembak Koordinat (.tembak <koordinat>)
 */
async function shootCoordinateAction(sock, jid, senderNumber, messageObj, coord) {
  const session = activeBattleships.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  if (senderNumber !== session.activeTurn) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(session.activeTurn)} untuk menembak.`, { mentions: [session.activeTurn] });
    return true;
  }

  const validCoordRegex = /^[A-E][1-5]$/i;
  if (!coord || !validCoordRegex.test(coord)) {
    await send(sock, jid, messageObj, `❌ Format koordinat salah! Gunakan kolom A-E dan baris 1-5 (Contoh: \`.tembak B3\`).`);
    return true;
  }

  const targetCoord = coord.toUpperCase();
  const isP1 = senderNumber === session.player1;
  const shots = isP1 ? session.p1Shots : session.p2Shots;

  if (shots.has(targetCoord)) {
    await send(sock, jid, messageObj, `⚠️ Koordinat *${targetCoord}* sudah pernah kamu tembak! Pilih koordinat lain.`);
    return true;
  }

  clearSessionTimer(session);
  return await executeShot(sock, jid, senderNumber, targetCoord, messageObj);
}

/**
 * 5. Eksekusi Hasil Tembakan
 */
async function executeShot(sock, jid, shooterJid, coord, messageObj = null) {
  const session = activeBattleships.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  const isP1 = shooterJid === session.player1;
  const enemyJid = isP1 ? session.player2 : session.player1;
  const shots = isP1 ? session.p1Shots : session.p2Shots;
  const enemyFleet = isP1 ? session.p2Fleet : session.p1Fleet;

  // Cek apakah koordinat mengenai kapal musuh
  let hitShipKey = null;
  for (const [key, ship] of Object.entries(enemyFleet)) {
    if (ship.coords.includes(coord)) {
      hitShipKey = key;
      break;
    }
  }

  // Setiap hasil tembakan dulu jadi pesan panjangnya sendiri, DITAMBAH papan
  // radar penuh — dua pesan per tembakan, dan satu pertandingan bisa 40
  // tembakan. Sekarang hasilnya cuma satu baris jejak di dalam papan hidup.
  if (!hitShipKey) {
    // 🌊 MISSED (Meleset ke Air)
    shots.set(coord, 'MISS');
    session.activeTurn = enemyJid;

    catatJejak(session, `🌊 ${tag(shooterJid)} tembak *${coord}* — meleset, giliran pindah`);
    await perbaruiRadar(sock, jid, session);
    armBattleshipTurnTimer(sock, jid);
    return true;
  }

  // 🔥 HIT! (Mengenai Kapal)
  const ship = enemyFleet[hitShipKey];
  ship.hits++;
  shots.set(coord, 'HIT');

  // Cek apakah kapal tenggelam
  if (ship.hits >= ship.size) {
    ship.sunk = true;
    // Perbarui semua koordinat kapal ini jadi 'SUNK'
    ship.coords.forEach(c => shots.set(c, 'SUNK'));
    catatJejak(session, `💥 ${tag(shooterJid)} tembak *${coord}* — *${ship.icon} ${ship.name}* TENGGELAM!`);
  } else {
    catatJejak(session, `🔥 ${tag(shooterJid)} tembak *${coord}* — kena ${ship.icon} ${ship.name}, nembak lagi!`);
  }

  // Cek apakah seluruh armada musuh sudah tenggelam (Menang)
  const allSunk = Object.values(enemyFleet).every(s => s.sunk);
  if (allSunk) {
    await finishBattleshipGame(sock, jid, shooterJid, enemyJid);
    return true;
  }

  // Jika HIT dan belum menang, giliran TETAP milik shooter (Streak Tembak)
  await perbaruiRadar(sock, jid, session);
  armBattleshipTurnTimer(sock, jid);
  return true;
}

/**
 * 6. Selesaikan Pertempuran & Berikan Hadiah Pot
 */
async function finishBattleshipGame(sock, jid, winnerJid, loserJid) {
  const session = activeBattleships.get(jid);
  if (!session) return;

  clearSessionTimer(session);

  // Papan terakhir diperbarui sekali lagi supaya keadaan akhir radar tetap
  // terbaca di atas pengumuman kemenangan, lalu dilepas.
  await perbaruiRadar(sock, jid, session).catch(() => {});
  lepasPapan(session);
  activeBattleships.delete(jid);

  await db.addGamePoints(winnerJid, session.pot);
  await db.finishActiveGameSession(db.sesiGameId('battleship', jid), 'FINISHED');

  const victoryAnnouncement =
`👑🏆 *KEMENANGAN MUTLAK DI LAUTAN!* 🏆👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚓ Laksamana ${tag(winnerJid)} telah menenggelamkan SELURUH armada kapal milik ${tag(loserJid)}!
💰 *Hadiah Kemenangan:* *+${session.pot} Poin*
✨ Poin telah langsung ditransfer ke dompet pemenang!

Terima kasih telah bertempur di Battleship! Ketik \`.battleship @member [taruhan]\` untuk duel baru!`;

  await send(sock, jid, null, victoryAnnouncement, { mentions: [winnerJid, loserJid] });
}

/**
 * 💥 BUCKSHOT ROULETTE (SHOTGUN TAKTIS 1V1)
 * Game Duel Adrenalin & Taktik Item antar 2 Pemain
 *
 * Mekanik:
 * - Shotgun 12-gauge diisi urutan acak Peluru Asli (🔴 LIVE) dan Peluru Kosong (⚪ BLANK).
 * - Masing-masing pemain memiliki HP (💖 4) & Item spesial:
 *   🚬 Rokok (+1 HP)
 *   🔍 Kaca Pembesar (Intip peluru saat ini via DM)
 *   🪚 Gergaji Besi (2x Damage tembakan berikutnya)
 *   🍺 Bir (Keluarkan/buang peluru saat ini)
 *   🔗 Borgol (Kunci lawan agar kehilangan 1 giliran)
 * - Tembak Diri: Jika Blank, giliran TETAP milik pemain!
 * - Tembak Lawan: Peluru live mengurangi HP lawan.
 * - Menyerah: `.buckshot nyerah` menyerahkan pot ke lawan (jalan keluar kalau
 *   duel terlanjur macet — poin taruhan tidak boleh tersandera).
 */

import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeBuckshots = new Map();
export const pendingBuckshots = new Map();

const MIN_BET = 20;
const DEFAULT_BET = 50;
const MAX_BET = 100_000;
const CHALLENGE_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 45_000;
const MAX_HP = 4;

export const ITEMS = [
  { key: 'rokok', name: 'Rokok', icon: '🚬', desc: '+1 HP', aliases: ['rokok', 'cig', 'cigarette'] },
  { key: 'kaca', name: 'Kaca Pembesar', icon: '🔍', desc: 'Intip peluru saat ini (DM)', aliases: ['kaca', 'kacapembesar', 'magnifier', 'lens'] },
  { key: 'gergaji', name: 'Gergaji Besi', icon: '🪚', desc: '2x Damage tembakan ini', aliases: ['gergaji', 'saw', 'gergajibesi'] },
  { key: 'bir', name: 'Kaleng Bir', icon: '🍺', desc: 'Buang peluru saat ini', aliases: ['bir', 'beer', 'minum'] },
  { key: 'borgol', name: 'Borgol', icon: '🔗', desc: 'Lewati 1 giliran lawan', aliases: ['borgol', 'handcuff', 'cuffs'] }
];

function tag(jid) {
  return `@${String(jid || '').split('@')[0]}`;
}

/**
 * Pembanding identitas pemain yang tahan grup ber-LID.
 *
 * `player1` diambil dari pengirim pesan, `player2` dari `contextInfo.mentionedJid`
 * — dua sumber yang formatnya bisa berbeda. Di grup ber-LID (Baileys 6.7.x)
 * pengirim datang sebagai `@lid` sementara mention masih `@s.whatsapp.net`,
 * sehingga `===` selalu gagal: `.buckshot gas` ditolak permanen, dan kalau duel
 * sempat jalan, pemain kedua tidak pernah lolos cek giliran sehingga tiap
 * gilirannya dipaksa auto-tembak oleh timer padahal poinnya sudah dipotong.
 * duelRoulette.js sudah lama memakai pengaman yang sama.
 */
export function samaJid(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  // Buang domain & sufiks perangkat lebih dulu. `db.isPhoneMatch` menyaring
  // karakter non-digit, jadi `628xxx:12@s.whatsapp.net` berubah jadi
  // `628xxx12` dan tidak pernah cocok dengan `628xxx` — padahal itu orang
  // yang sama, cuma dari perangkat tertaut (WhatsApp Web / HP kedua).
  const ua = String(a).split('@')[0].split(':')[0];
  const ub = String(b).split('@')[0].split(':')[0];
  if (ua === ub) return true;

  try { return db.isPhoneMatch(ua, ub); } catch (_) { return false; }
}

/**
 * Pengirim pesan yang tidak boleh membekukan duel.
 *
 * Dulu satu `send()` gagal (koneksi WhatsApp ngadat sesaat) cukup untuk
 * mematikan permainan selamanya: exception-nya melompati `armBuckshotTurnTimer`
 * sehingga tidak ada lagi timer yang menjalankan giliran, sesi menggantung di
 * `activeBuckshots`, dan poin taruhan dua pemain tertahan sampai bot di-restart.
 */
async function kirimAman(sock, jid, messageObj, text, options = {}) {
  try {
    return await send(sock, jid, messageObj, text, options);
  } catch (e) {
    console.error('[BUCKSHOT_SEND_ERR]', e?.message || e);
    return null;
  }
}

function clearSessionTimer(session) {
  if (session && session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Generate magazen peluru shotgun baru (3-6 peluru)
 */
export function generateMagazine() {
  const totalShells = Math.floor(Math.random() * 4) + 3; // 3 - 6 peluru
  const liveCount = Math.max(1, Math.floor(totalShells / 2) + (Math.random() < 0.5 ? 1 : 0));
  const blankCount = totalShells - liveCount;

  const shells = [];
  for (let i = 0; i < liveCount; i++) shells.push('LIVE');
  for (let i = 0; i < blankCount; i++) shells.push('BLANK');

  return {
    shells: shuffle(shells),
    liveCount,
    blankCount,
    total: totalShells
  };
}

/**
 * Berikan 2 item acak ke pemain (maksimal simpan 4 item)
 */
function giveRandomItems(currentItems) {
  const newItems = [...currentItems];
  for (let i = 0; i < 2; i++) {
    if (newItems.length < 4) {
      const randItem = ITEMS[Math.floor(Math.random() * ITEMS.length)];
      newItems.push(randItem.key);
    }
  }
  return newItems;
}

/**
 * Tentukan pemegang giliran setelah sebuah tembakan.
 *
 * Dipisah jadi fungsi murni supaya bisa diuji tanpa socket & tanpa menyentuh
 * database: di sinilah dulu bug paling parah bersarang. Blok reload magazen
 * `return` duluan sebelum baris ganti giliran, jadi penembak peluru TERAKHIR
 * menahan gilirannya sekaligus memanen 2 item baru dari ronde berikutnya —
 * pemain yang menghitung peluru bisa memilih menembak lawan tepat di shell
 * penghabisan untuk mendapat serangan gratis berulang kali.
 *
 * @param {object} session   Sesi duel yang sedang berjalan (dimutasi di tempat).
 * @param {string} shooterJid JID penembak (harus JID kanonik milik sesi).
 * @param {string} enemyJid   JID lawan.
 * @param {boolean} keepTurn  True hanya untuk `.tembak diri` yang meletus BLANK.
 * @returns {{turnPassed: boolean, handcuffConsumed: boolean}}
 */
export function resolveTurnAfterShot(session, shooterJid, enemyJid, keepTurn = false) {
  if (keepTurn) {
    session.activeTurn = shooterJid;
    return { turnPassed: false, handcuffConsumed: false };
  }

  if (samaJid(session.handcuffedPlayer, enemyJid)) {
    session.handcuffedPlayer = null; // Lepas borgol setelah 1x skip
    session.activeTurn = shooterJid;
    return { turnPassed: false, handcuffConsumed: true };
  }

  session.activeTurn = enemyJid;
  return { turnPassed: true, handcuffConsumed: false };
}

/**
 * Render visual status permainan Buckshot Roulette
 */
function renderBuckshotVisual(session) {
  const p1Tag = tag(session.player1);
  const p2Tag = tag(session.player2);

  const p1HpBar = '💖'.repeat(session.p1Hp) + '🖤'.repeat(MAX_HP - session.p1Hp);
  const p2HpBar = '💖'.repeat(session.p2Hp) + '🖤'.repeat(MAX_HP - session.p2Hp);

  const p1ItemsStr = session.p1Items.map(k => {
    const it = ITEMS.find(item => item.key === k);
    return `${it.icon} ${it.name}`;
  }).join(', ') || '_Tidak ada item_';

  const p2ItemsStr = session.p2Items.map(k => {
    const it = ITEMS.find(item => item.key === k);
    return `${it.icon} ${it.name}`;
  }).join(', ') || '_Tidak ada item_';

  const sawStatus = session.sawActive ? '🪚 *GERGAJI AKTIF (2x DAMAGE)!*' : 'Normal (1x Damage)';
  const handcuffsStatus = session.handcuffedPlayer ? `🔗 ${tag(session.handcuffedPlayer)} sedang terborgol!` : '';

  return (
`💥 ─── *BUCKSHOT ROULETTE (SHOTGUN 1V1)* ─── 💥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Pemain 1:* ${p1Tag}
   HP: [ ${p1HpBar} ] (${session.p1Hp}/${MAX_HP})
   🎒 Item: ${p1ItemsStr}

👤 *Pemain 2:* ${p2Tag}
   HP: [ ${p2HpBar} ] (${session.p2Hp}/${MAX_HP})
   🎒 Item: ${p2ItemsStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔫 *Status Shotgun:* Sisa *${session.shells.length} Peluru* di Laras
⚙️ *Mode Laras:* ${sawStatus}
${handcuffsStatus ? `${handcuffsStatus}\n` : ''}👉 *Giliran Bertindak:* ${tag(session.activeTurn)}
_Ketik: \`.tembak diri\` | \`.tembak lawan\` | \`.pakai <item>\`_
_⏳ Waktu Giliran: ${TURN_TIMEOUT_MS / 1000} detik_`
  );
}

/**
 * Pasang timer giliran tembak (45s)
 */
function armBuckshotTurnTimer(sock, jid) {
  const session = activeBuckshots.get(jid);
  if (!session || session.status !== 'PLAYING') return;

  clearSessionTimer(session);

  session.timer = setTimeout(async () => {
    try {
      const live = activeBuckshots.get(jid);
      if (!live || live.status !== 'PLAYING') return;

      const currentP = live.activeTurn;
      await kirimAman(sock, jid, null, `⏰ *Waktu giliran habis!* ${tag(currentP)} otomatis menembak ke lawan!`, { mentions: [currentP] });
      await executeShootAction(sock, jid, currentP, 'lawan');
    } catch (e) {
      console.error('[BUCKSHOT_TIMEOUT_ERR]', e);
    }
  }, TURN_TIMEOUT_MS);
}

/**
 * Cari identitas pemain di dalam sesi, sekaligus mengembalikan JID KANONIK
 * milik sesi. Penting: mention & DM harus memakai JID yang tersimpan di sesi
 * (bentuk yang WhatsApp sendiri hasilkan), bukan bentuk `@lid` mentah dari
 * pengirim, supaya tag-nya tidak patah di grup ber-LID.
 */
function kenaliPemain(session, jidPengirim) {
  if (samaJid(jidPengirim, session.player1)) {
    return { isP1: true, actorJid: session.player1, enemyJid: session.player2 };
  }
  if (samaJid(jidPengirim, session.player2)) {
    return { isP1: false, actorJid: session.player2, enemyJid: session.player1 };
  }
  return null;
}

/**
 * Handler utama Buckshot Roulette (.buckshot / .shotgun / .pakai / .tembak)
 */
export async function handleBuckshotCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Permainan Buckshot Roulette hanya dapat dimainkan di grup!');
    return true;
  }

  // Tembak (.tembak diri / .tembak lawan)
  if (['tembak', 'shoot', 'dor', 'fire'].includes(command)) {
    const target = (args[1] || '').toLowerCase();
    return await shootAction(sock, jid, senderNumber, messageObj, target);
  }

  // Pakai Item (.pakai <item> / .rokok / .kaca / .gergaji / .bir / .borgol)
  if (['pakai', 'use', 'item'].includes(command)) {
    const itemKey = (args[1] || '').toLowerCase();
    return await useItemAction(sock, jid, senderNumber, messageObj, itemKey);
  }

  const directItem = ITEMS.find(it => it.aliases.includes(command));
  if (directItem) {
    return await useItemAction(sock, jid, senderNumber, messageObj, directItem.key);
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['terima', 'gas', 'ikut', 'join', 'acc', 'accept'].includes(subCmd) || command === 'gasbuckshot') {
    return await acceptBuckshotChallenge(sock, jid, senderNumber, messageObj);
  }

  // Jalan keluar untuk duel yang SUDAH berjalan. Tanpa ini, sesi yang macet
  // menyandera poin taruhan dua pemain sampai bot di-restart.
  if (['nyerah', 'surrender', 'menyerah', 'kabur'].includes(subCmd) || command === 'nyerahbuckshot') {
    return await surrenderBuckshot(sock, jid, senderNumber, messageObj);
  }

  if (['tolak', 'cancel', 'batal', 'reject'].includes(subCmd) || command === 'tolakbuckshot' || command === 'batalbuckshot') {
    return await rejectBuckshotChallenge(sock, jid, senderNumber, messageObj);
  }

  return await createBuckshotChallenge(sock, jid, senderNumber, messageObj, args);
}

/**
 * 1. Buat Tantangan Duel Buckshot Roulette
 */
async function createBuckshotChallenge(sock, jid, senderNumber, messageObj, args) {
  if (activeBuckshots.has(jid)) {
    await send(sock, jid, messageObj, '⚠️ Masih ada duel Buckshot Roulette yang sedang berlangsung di grup ini! Tunggu hingga selesai.\n_Peserta duel bisa mengetik_ `.buckshot nyerah` _untuk mengakhirinya._');
    return true;
  }

  if (pendingBuckshots.has(jid)) {
    await send(sock, jid, messageObj, '⚠️ Masih ada tantangan Buckshot Roulette yang menunggu konfirmasi!');
    return true;
  }

  const mentioned = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  let targetNumber = mentioned[0];

  if (!targetNumber && args[1] && args[1].includes('@')) {
    targetNumber = args[1].replace(/[@]/g, '') + '@s.whatsapp.net';
  }

  if (!targetNumber) {
    await send(sock, jid, messageObj, '❌ Tag lawan yang ingin kamu tantang!\nContoh: `.buckshot @member 50`');
    return true;
  }

  if (samaJid(targetNumber, senderNumber)) {
    await send(sock, jid, messageObj, '❌ Kamu tidak bisa menantang dirimu sendiri!');
    return true;
  }

  const betIdx = args.findIndex((arg, i) => i > 0 && !isNaN(parseInt(arg, 10)));
  const betArg = betIdx !== -1 ? parseInt(args[betIdx], 10) : DEFAULT_BET;
  const buyIn = Math.min(MAX_BET, Math.max(MIN_BET, isNaN(betArg) ? DEFAULT_BET : betArg));

  const p1Prof = await db.getGameProfile(senderNumber);
  if ((p1Prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk taruhan duel *${buyIn} Poin*! (Poinmu: ${p1Prof?.points || 0})`);
    return true;
  }

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
      if (pendingBuckshots.has(jid)) {
        pendingBuckshots.delete(jid);
        await kirimAman(sock, jid, null, `⏰ *Tantangan Buckshot Roulette Kedaluwarsa* karena tidak dijawab dalam 60 detik.`);
      }
    }, CHALLENGE_TIMEOUT_MS)
  };

  pendingBuckshots.set(jid, challenge);

  const text =
`💥 ─── *TANTANGAN BUCKSHOT ROULETTE* ─── 💥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔫 ${tag(senderNumber)} menantang ${tag(targetNumber)} dalam duel maut shotgun 12-gauge!
💰 *Taruhan Masuk:* *${buyIn} Poin* / pemain (Total Pot: *${buyIn * 2} Poin*)

📦 *Ketentuan Pertarungan:*
  • 💖 Masing-masing memiliki 4 Nyawa (HP)
  • 🔴 Peluru Asli (Live) & ⚪ Peluru Kosong (Blank) acak
  • 🎒 Dilengkapi item taktis: 🚬 Rokok, 🔍 Kaca, 🪚 Gergaji, 🍺 Bir, 🔗 Borgol
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 ${tag(targetNumber)}, ketik \`.buckshot gas\` untuk menerima duel!
👉 Ketik \`.buckshot tolak\` untuk menolak.
_⏳ Waktu konfirmasi: 60 detik_`;

  await send(sock, jid, messageObj, text, { mentions: [senderNumber, targetNumber] });
  return true;
}

/**
 * 2. Terima Tantangan Buckshot
 */
async function acceptBuckshotChallenge(sock, jid, senderNumber, messageObj) {
  const challenge = pendingBuckshots.get(jid);
  if (!challenge) {
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan Buckshot Roulette yang menunggu konfirmasi.');
    return true;
  }

  if (!samaJid(senderNumber, challenge.target)) {
    await send(sock, jid, messageObj, `⚠️ Hanya ${tag(challenge.target)} yang berhak menerima tantangan ini!`, { mentions: [challenge.target] });
    return true;
  }

  clearSessionTimer(challenge);
  pendingBuckshots.delete(jid);

  const p1Deduct = await db.deductGamePoints(challenge.challenger, challenge.buyIn);
  const p2Deduct = await db.deductGamePoints(challenge.target, challenge.buyIn);

  if (!p1Deduct?.success || !p2Deduct?.success) {
    if (p1Deduct?.success) await db.addGamePoints(challenge.challenger, challenge.buyIn);
    if (p2Deduct?.success) await db.addGamePoints(challenge.target, challenge.buyIn);
    await send(sock, jid, messageObj, '❌ Gagal memulai: Salah satu pemain kehabisan poin saat konfirmasi!');
    return true;
  }

  const mag = generateMagazine();

  const session = {
    jid,
    player1: challenge.challenger,
    player2: challenge.target,
    buyIn: challenge.buyIn,
    pot: challenge.buyIn * 2,
    p1Hp: MAX_HP,
    p2Hp: MAX_HP,
    p1Items: giveRandomItems([]),
    p2Items: giveRandomItems([]),
    shells: mag.shells,
    activeTurn: Math.random() < 0.5 ? challenge.challenger : challenge.target,
    sawActive: false,
    handcuffedPlayer: null,
    status: 'PLAYING',
    // Kunci re-entrancy: satu aksi diproses sampai tuntas sebelum aksi
    // berikutnya diterima. Tanpa ini, dua pesan `.tembak lawan` beruntun
    // sama-sama lolos cek giliran (giliran baru berpindah setelah beberapa
    // `await send`) dan MELETUSKAN DUA PELURU dalam satu giliran.
    busy: false,
    timer: null,
    createdAt: Date.now()
  };

  activeBuckshots.set(jid, session);

  await db.createActiveGameSession({
    id: db.sesiGameId('buckshot', jid),
    gameType: 'Buckshot Roulette',
    jid,
    host: challenge.challenger,
    buyIn: challenge.buyIn,
    pot: session.pot,
    players: [{ jid: challenge.challenger, points: challenge.buyIn }, { jid: challenge.target, points: challenge.buyIn }]
  });

  const startAnnouncement =
`🚨 *DUEL BUCKSHOT ROULETTE DIMULAI!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dealer memasukkan *${mag.total} Peluru* ke dalam senapan:
🔴 *${mag.liveCount} Peluru Asli (Live)* & ⚪ *${mag.blankCount} Peluru Kosong (Blank)*!
_Peluru telah dikocok secara acak di dalam laras._

${renderBuckshotVisual(session)}`;

  await kirimAman(sock, jid, messageObj, startAnnouncement, { mentions: [session.player1, session.player2] });
  armBuckshotTurnTimer(sock, jid);
  return true;
}

/**
 * 3. Tolak Tantangan Buckshot
 */
async function rejectBuckshotChallenge(sock, jid, senderNumber, messageObj) {
  const challenge = pendingBuckshots.get(jid);
  if (!challenge) {
    // Duel yang sudah berjalan tidak bisa "ditolak" — poinnya sudah di pot.
    // Arahkan ke menyerah supaya pemain tidak merasa terkunci.
    if (activeBuckshots.has(jid)) {
      await send(sock, jid, messageObj, '⚠️ Duel Buckshot Roulette sudah berjalan dan poin taruhan sudah masuk pot.\nKetik `.buckshot nyerah` kalau kamu ingin mengundurkan diri (pot jatuh ke lawan).');
      return true;
    }
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan Buckshot Roulette yang aktif.');
    return true;
  }

  if (!samaJid(senderNumber, challenge.target) && !samaJid(senderNumber, challenge.challenger)) {
    await send(sock, jid, messageObj, '⚠️ Kamu bukan pemain yang terlibat dalam tantangan ini!');
    return true;
  }

  clearSessionTimer(challenge);
  pendingBuckshots.delete(jid);

  await send(sock, jid, messageObj, `🛑 Tantangan Buckshot Roulette telah ditolak/dibatalkan.`);
  return true;
}

/**
 * 3b. Menyerah dari duel yang sedang berjalan
 */
async function surrenderBuckshot(sock, jid, senderNumber, messageObj) {
  const session = activeBuckshots.get(jid);
  if (!session || session.status !== 'PLAYING') {
    await send(sock, jid, messageObj, '❌ Tidak ada duel Buckshot Roulette yang sedang berjalan di grup ini.');
    return true;
  }

  const peran = kenaliPemain(session, senderNumber);
  if (!peran) {
    await send(sock, jid, messageObj, '⚠️ Kamu bukan peserta duel Buckshot Roulette ini!');
    return true;
  }

  if (session.busy) {
    await send(sock, jid, messageObj, '⏳ Tembakan sedang diproses, coba lagi sebentar.');
    return true;
  }

  const loser = peran.actorJid;
  const winner = peran.enemyJid;

  clearSessionTimer(session);
  await kirimAman(sock, jid, messageObj, `🏳️ ${tag(loser)} melempar handuk dan mundur dari duel maut ini!`, { mentions: [loser] });
  await finishBuckshotGame(sock, jid, winner, loser, { menyerah: true });
  return true;
}

/**
 * 4. Penggunaan Item (.pakai <item>)
 */
async function useItemAction(sock, jid, senderNumber, messageObj, itemInput) {
  const session = activeBuckshots.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  // Bukan peserta duel: diam saja dan lepas ke handler lain. Kata `.bir`,
  // `.kaca`, `.pakai` terlalu umum untuk membalas semua orang di grup.
  const peran = kenaliPemain(session, senderNumber);
  if (!peran) return false;

  if (session.busy) {
    await send(sock, jid, messageObj, '⏳ Aksi sebelumnya masih diproses, tunggu sebentar.');
    return true;
  }

  const { isP1, actorJid, enemyJid } = peran;

  if (!samaJid(actorJid, session.activeTurn)) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(session.activeTurn)} untuk bertindak.`, { mentions: [session.activeTurn] });
    return true;
  }

  const targetItem = ITEMS.find(it => it.aliases.includes(itemInput));
  if (!targetItem) {
    await send(sock, jid, messageObj, `❌ Item tidak dikenali! Pilihan: Rokok, Kaca, Gergaji, Bir, Borgol.\nContoh: \`.pakai rokok\` atau \`.rokok\``);
    return true;
  }

  const userItems = isP1 ? session.p1Items : session.p2Items;
  const itemIdx = userItems.indexOf(targetItem.key);

  if (itemIdx === -1) {
    await send(sock, jid, messageObj, `❌ Kamu tidak memiliki item *${targetItem.name}* di dalam ranselmu!`);
    return true;
  }

  // Timer giliran dimatikan SEBELUM item diproses. Kalau tidak, item yang
  // dipakai di detik ke-44 bisa berbenturan dengan auto-tembak yang meletus
  // di tengah proses.
  clearSessionTimer(session);
  session.busy = true;

  try {
    // Gunakan item
    userItems.splice(itemIdx, 1);

    if (targetItem.key === 'rokok') {
      if (isP1) session.p1Hp = Math.min(MAX_HP, session.p1Hp + 1);
      else session.p2Hp = Math.min(MAX_HP, session.p2Hp + 1);

      await kirimAman(sock, jid, messageObj, `🚬 ${tag(actorJid)} menyalakan rokok dan bersantai... *+1 HP dipulihkan!*`, { mentions: [actorJid] });
    } else if (targetItem.key === 'kaca') {
      const nextShell = session.shells[0];
      const shellText = nextShell === 'LIVE' ? '🔴 *PELURU ASLI (LIVE)*' : '⚪ *PELURU KOSONG (BLANK)*';
      const isiDm = { text: `🔍 *KACA PEMBESAR BUCKSHOT*\n\nPeluru yang ada di dalam laras saat ini adalah: ${shellText}!` };

      // Coba JID pengirim dulu, lalu JID kanonik sesi. Di grup ber-LID kedua
      // bentuk itu bisa berbeda dan hanya salah satunya yang bisa di-DM.
      let dmTerkirim = false;
      for (const tujuan of [senderNumber, actorJid]) {
        if (!tujuan || dmTerkirim) continue;
        try {
          await sock.sendMessage(tujuan, isiDm);
          dmTerkirim = true;
        } catch (_) { /* coba tujuan berikutnya */ }
      }

      await kirimAman(sock, jid, messageObj,
        dmTerkirim
          ? `🔍 ${tag(actorJid)} mengintip ke dalam laras senapan menggunakan *Kaca Pembesar*! (Informasi dikirim via DM)`
          : `🔍 ${tag(actorJid)} mengintip ke dalam laras senapan menggunakan *Kaca Pembesar*!\n⚠️ _DM gagal terkirim — pastikan chat pribadi dengan bot sudah pernah dibuka._`,
        { mentions: [actorJid] });
    } else if (targetItem.key === 'gergaji') {
      if (session.sawActive) {
        // Item sudah terlanjur diambil dari ransel, kembalikan supaya tidak hangus.
        userItems.push(targetItem.key);
        await kirimAman(sock, jid, messageObj, `⚠️ Laras senapan sudah digergaji! (2x Damage aktif)`);
        armBuckshotTurnTimer(sock, jid);
        return true;
      }
      session.sawActive = true;
      await kirimAman(sock, jid, messageObj, `🪚 *KREKKK!* ${tag(actorJid)} memotong laras senapan! *Tembakan berikutnya bernilai 2x DAMAGE!*`, { mentions: [actorJid] });
    } else if (targetItem.key === 'bir') {
      const ejected = session.shells.shift();
      const ejectedText = ejected === 'LIVE' ? '🔴 *PELURU ASLI (LIVE)*' : '⚪ *PELURU KOSONG (BLANK)*';

      await kirimAman(sock, jid, messageObj, `🍺 *KLANG!* ${tag(actorJid)} menenggak kaleng bir dan membuang 1 peluru: ${ejectedText} terlontar keluar dari laras!`, { mentions: [actorJid] });

      if (session.shells.length === 0) {
        // Membuang peluru bukan menembak: giliran memang tetap milik pemakai.
        await reloadNewRound(sock, jid, session);
        return true;
      }
    } else if (targetItem.key === 'borgol') {
      if (session.handcuffedPlayer) {
        userItems.push(targetItem.key);
        await kirimAman(sock, jid, messageObj, `⚠️ Lawan sudah terborgol!`);
        armBuckshotTurnTimer(sock, jid);
        return true;
      }
      session.handcuffedPlayer = enemyJid;
      await kirimAman(sock, jid, messageObj, `🔗 *KLIK!* ${tag(actorJid)} memasangkan borgol ke tangan ${tag(enemyJid)}! Lawan akan kehilangan 1x giliran berikutnya!`, { mentions: [actorJid, enemyJid] });
    }

    await kirimAman(sock, jid, null, renderBuckshotVisual(session), { mentions: [session.player1, session.player2] });
    armBuckshotTurnTimer(sock, jid);
    return true;
  } finally {
    session.busy = false;
  }
}

/**
 * 5. Aksi Menembak (.tembak diri / .tembak lawan)
 */
async function shootAction(sock, jid, senderNumber, messageObj, target) {
  const session = activeBuckshots.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  // Bukan peserta duel: lepas ke handler lain (`.tembak` juga milik Undercover
  // & Duel Roulette).
  const peran = kenaliPemain(session, senderNumber);
  if (!peran) return false;

  if (!samaJid(peran.actorJid, session.activeTurn)) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Saat ini giliran ${tag(session.activeTurn)} untuk bertindak.`, { mentions: [session.activeTurn] });
    return true;
  }

  const validTarget = ['diri', 'self', 'me', 'lawan', 'musuh', 'enemy', 'opponent'];
  if (!validTarget.includes(target)) {
    await send(sock, jid, messageObj, `❌ Pilih sasaran tembak:\n• \`.tembak diri\` (Jika kosong, giliran tetap milikmu!)\n• \`.tembak lawan\` (Tembak musuh)`);
    return true;
  }

  const isSelf = ['diri', 'self', 'me'].includes(target);
  return await executeShootAction(sock, jid, peran.actorJid, isSelf ? 'diri' : 'lawan', messageObj);
}

/**
 * 6. Eksekusi Tembakan Shotgun
 *
 * Pembungkus kunci re-entrancy. Semua mutasi peluru & HP terjadi di
 * `jalankanTembakan`, dan hanya satu tembakan yang boleh berjalan pada satu
 * waktu supaya dua pesan `.tembak` beruntun tidak meletuskan dua peluru.
 *
 * Diekspor supaya smoke test bisa menjalankan tembakan sungguhan (bukan menulis
 * ulang logikanya) tanpa perlu socket WhatsApp atau tulisan ke database.
 */
export async function executeShootAction(sock, jid, shooterJid, targetType, messageObj = null) {
  const session = activeBuckshots.get(jid);
  if (!session || session.status !== 'PLAYING') return false;

  if (session.busy) return true;

  clearSessionTimer(session);
  session.busy = true;
  try {
    return await jalankanTembakan(sock, jid, session, shooterJid, targetType, messageObj);
  } finally {
    session.busy = false;
  }
}

async function jalankanTembakan(sock, jid, session, shooterJid, targetType, messageObj) {
  const peran = kenaliPemain(session, shooterJid);
  if (!peran) return false;

  const { isP1, actorJid, enemyJid } = peran;
  const isSelf = targetType === 'diri';

  const shell = session.shells.shift();
  const damage = session.sawActive ? 2 : 1;
  session.sawActive = false; // Reset saw setelah tembakan

  // Hanya `.tembak diri` yang meletus BLANK yang mempertahankan giliran.
  let pertahankanGiliran = false;

  if (isSelf) {
    // 🎯 TEMBAK DIRI SENDIRI
    if (shell === 'BLANK') {
      // ⚪ Blank pada diri sendiri: GILIRAN TETAP MILIKNYA!
      pertahankanGiliran = true;

      const blankSelfMsg =
`⚪ *KLIK! PELURU KOSONG (BLANK)!* ⚪
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
😮‍💨 ${tag(actorJid)} mengarahkan senapan ke kepala sendiri dan menarik pelatuk...
Hanya terdengar bunyi *KLIK!* Peluru tersebut kosong!
🎁 *Keberanian Berbuah Manis:* Giliran tetap milik ${tag(actorJid)}!`;

      await kirimAman(sock, jid, messageObj, blankSelfMsg, { mentions: [actorJid] });
    } else {
      // 🔴 Live pada diri sendiri: Kena Damage!
      if (isP1) session.p1Hp = Math.max(0, session.p1Hp - damage);
      else session.p2Hp = Math.max(0, session.p2Hp - damage);

      const liveSelfMsg =
`🔴💥 *DORRRR! PELURU ASLI (LIVE)!* 💥🔴
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💀 ${tag(actorJid)} menembak diri sendiri dengan *Peluru Asli*!
💔 Terkena *${damage} Damage*! Sisa HP: *${isP1 ? session.p1Hp : session.p2Hp}/${MAX_HP}*`;

      await kirimAman(sock, jid, messageObj, liveSelfMsg, { mentions: [actorJid] });

      if (session.p1Hp <= 0 || session.p2Hp <= 0) {
        const winner = session.p1Hp > 0 ? session.player1 : session.player2;
        const loser = session.p1Hp <= 0 ? session.player1 : session.player2;
        await finishBuckshotGame(sock, jid, winner, loser);
        return true;
      }
    }
  } else {
    // 🎯 TEMBAK LAWAN
    if (shell === 'BLANK') {
      const blankEnemyMsg =
`⚪ *KLIK! PELURU KOSONG (BLANK)!* ⚪
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💨 ${tag(actorJid)} menembak ke arah ${tag(enemyJid)}...
*KLIK!* Peluru kosong! ${tag(enemyJid)} selamat dari maut!`;

      await kirimAman(sock, jid, messageObj, blankEnemyMsg, { mentions: [actorJid, enemyJid] });
    } else {
      // 🔴 Live pada lawan: Kena Damage!
      if (isP1) session.p2Hp = Math.max(0, session.p2Hp - damage);
      else session.p1Hp = Math.max(0, session.p1Hp - damage);

      const liveEnemyMsg =
`🔴💥 *BOOMMMM! PELURU ASLI (LIVE)!* 💥🔴
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Tembakan telak ${tag(actorJid)} menghantam ${tag(enemyJid)}!
💔 ${tag(enemyJid)} menderita *${damage} Damage*! Sisa HP: *${isP1 ? session.p2Hp : session.p1Hp}/${MAX_HP}*`;

      await kirimAman(sock, jid, messageObj, liveEnemyMsg, { mentions: [actorJid, enemyJid] });

      if (session.p1Hp <= 0 || session.p2Hp <= 0) {
        const winner = session.p1Hp > 0 ? session.player1 : session.player2;
        const loser = session.p1Hp <= 0 ? session.player1 : session.player2;
        await finishBuckshotGame(sock, jid, winner, loser);
        return true;
      }
    }
  }

  // Giliran diselesaikan DULU, baru magazen diisi ulang. Urutan sebaliknya
  // membuat penembak peluru terakhir menahan giliran sekaligus memanen item
  // ronde baru.
  const hasilGiliran = resolveTurnAfterShot(session, actorJid, enemyJid, pertahankanGiliran);

  if (hasilGiliran.handcuffConsumed) {
    await kirimAman(sock, jid, null, `🔗 ${tag(enemyJid)} terborgol dan kehilangan gilirannya! Giliran kembali ke ${tag(actorJid)}!`, { mentions: [actorJid, enemyJid] });
  }

  // Cek apakah peluru di laras habis
  if (session.shells.length === 0) {
    await reloadNewRound(sock, jid, session);
    return true;
  }

  await kirimAman(sock, jid, null, renderBuckshotVisual(session), { mentions: [session.player1, session.player2] });
  armBuckshotTurnTimer(sock, jid);
  return true;
}

/**
 * 7. Reload Ronde Peluru & Bagikan Item Baru
 *
 * Borgol sengaja TIDAK direset di sini: kalau lawan diborgol tepat sebelum
 * magazen habis, borgolnya jadi hangus percuma. Borgol tetap dilepas saat
 * benar-benar memakan satu giliran (lihat resolveTurnAfterShot).
 */
async function reloadNewRound(sock, jid, session) {
  const mag = generateMagazine();
  session.shells = mag.shells;
  session.sawActive = false;

  session.p1Items = giveRandomItems(session.p1Items);
  session.p2Items = giveRandomItems(session.p2Items);

  const reloadAnnouncement =
`🔄 *SHOTGUN DIISI ULANG & ITEM BARU DIBAGIKAN!* 🔄
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dealer memasukkan *${mag.total} Peluru Baru*:
🔴 *${mag.liveCount} Peluru Asli (Live)* & ⚪ *${mag.blankCount} Peluru Kosong (Blank)*!
🎁 Masing-masing pemain mendapatkan 2 item baru di ransel!

${renderBuckshotVisual(session)}`;

  await kirimAman(sock, jid, null, reloadAnnouncement, { mentions: [session.player1, session.player2] });
  armBuckshotTurnTimer(sock, jid);
}

/**
 * 8. Selesaikan Duel & Berikan Hadiah Pot
 */
async function finishBuckshotGame(sock, jid, winnerJid, loserJid, opsi = {}) {
  const session = activeBuckshots.get(jid);
  if (!session) return;

  clearSessionTimer(session);
  // Dihapus sebelum `await` pertama supaya pemanggilan ganda (mis. tembakan &
  // menyerah beradu) tidak pernah membayar pot dua kali.
  activeBuckshots.delete(jid);

  await db.addGamePoints(winnerJid, session.pot);
  await db.finishActiveGameSession(db.sesiGameId('buckshot', jid), 'FINISHED');

  const barisKekalahan = opsi.menyerah
    ? `🏳️ ${tag(loserJid)} menyerah dan meninggalkan meja duel!`
    : `💀 Detak jantung ${tag(loserJid)} telah berhenti (Flatline)!`;

  const victoryAnnouncement =
`👑🏆 *SURVIVOR BUCKSHOT ROULETTE!* 🏆👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${barisKekalahan}
🎉 ${tag(winnerJid)} berhasil bertahan hidup dari duel maut shotgun!
💰 *Hadiah Kemenangan:* *+${session.pot} Poin*
✨ Poin telah langsung masuk ke rekening pemenang!

Terima kasih telah bermain Buckshot Roulette! Ketik \`.buckshot @member [taruhan]\` untuk duel baru!`;

  await kirimAman(sock, jid, null, victoryAnnouncement, { mentions: [winnerJid, loserJid] });
}

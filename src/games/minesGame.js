import * as db from '../../database.js';
import { send, isOnCooldown } from './helpers.js';

export const activeMinesGames = new Map();
const GAME_TIMEOUT_MS = 60 * 1000;
const TOTAL_TILES = 25;

/**
 * Hitung Kombinasi nCr
 */
function combination(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 1; i <= k; i++) {
    c = (c * (n - (k - i))) / i;
  }
  return c;
}

/**
 * Hitung Multiplier Fair Probabilitas Real (dengan house edge ~3-4%)
 */
export function calculateMinesMultiplier(bombs, diamondsFound) {
  if (diamondsFound <= 0) return 1.0;
  const safeTiles = TOTAL_TILES - bombs;
  if (diamondsFound > safeTiles) return 1.0;

  const totalComb = combination(TOTAL_TILES, diamondsFound);
  const safeComb = combination(safeTiles, diamondsFound);
  if (safeComb === 0) return 1.0;

  const rawMultiplier = (totalComb / safeComb) * 0.97;
  return Math.max(1.01, Math.round(rawMultiplier * 100) / 100);
}

/**
 * Generate Ringkasan Roadmap Multiplier untuk Tampilan Game
 */
function getMultiplierRoadmap(bombs) {
  const safeTiles = TOTAL_TILES - bombs;
  const sampleSteps = [];
  const maxDisplay = Math.min(4, safeTiles);

  for (let i = 1; i <= maxDisplay; i++) {
    const mult = calculateMinesMultiplier(bombs, i);
    sampleSteps.push(`*${i}💎:* \`${mult}x\``);
  }

  if (safeTiles > maxDisplay) {
    const maxMult = calculateMinesMultiplier(bombs, safeTiles);
    sampleSteps.push(`*Max (${safeTiles}💎):* \`${maxMult.toLocaleString('id-ID')}x\``);
  }

  return sampleSteps.join(' ➔ ');
}

/**
 * Parse input koordinat ke nomor kotak 1 - 25
 * Format yang didukung:
 * - Angka: 1 s/d 25
 * - Koordinat Baris-Kolom: A1-A5, B1-B5, C1-C5, D1-D5, E1-E5 (misal: B2 -> 7, C4 -> 14)
 */
function parseTileCoordinate(input) {
  if (!input) return null;
  const clean = String(input).trim().toUpperCase();

  // 1. Cek jika input angka langsung (1 - 25)
  const num = parseInt(clean, 10);
  if (!isNaN(num) && num >= 1 && num <= TOTAL_TILES && String(num) === clean) {
    return num;
  }

  // 2. Cek jika input format Grid (A1 - E5)
  const match = clean.match(/^([A-E])([1-5])$/);
  if (match) {
    const rowChar = match[1];
    const colNum = parseInt(match[2], 10);
    const rowMap = { A: 0, B: 1, C: 2, D: 3, E: 4 };
    const rowIndex = rowMap[rowChar];
    return rowIndex * 5 + colNum;
  }

  return null;
}

/**
 * Render Papan Grid Visual 5x5 dengan Emoji
 */
function renderMinesBoard(session, gameOver = false, hitBombIndex = -1) {
  const rows = [];
  const rowLabels = ['A', 'B', 'C', 'D', 'E'];

  for (let r = 0; r < 5; r++) {
    let rowStr = '';
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c + 1; // 1-25
      if (gameOver) {
        if (session.bombs.includes(idx)) {
          if (idx === hitBombIndex) {
            rowStr += '💥 '; // Bom yang meledak terkena pemain
          } else {
            rowStr += '💣 '; // Bom tersembunyi lainnya
          }
        } else {
          if (session.revealed.has(idx)) {
            rowStr += '💎 '; // Berlian yang dibuka pemain
          } else {
            rowStr += '✨ '; // Berlian yang belum sempat dibuka
          }
        }
      } else {
        if (session.revealed.has(idx)) {
          rowStr += '💎 ';
        } else {
          rowStr += '⬛ ';
        }
      }
    }
    const startNum = r * 5 + 1;
    const endNum = r * 5 + 5;
    rowStr += `  (${rowLabels[r]}: ${startNum}-${endNum})`;
    rows.push(rowStr);
  }
  return rows.join('\n');
}

/**
 * Handle Command Utama Ranjau Poin / Mines
 */
export async function handleMinesCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  // 1. INFO / TABEL MULTIPLIER (.infomines / .tabelmines / .minesinfo)
  if (['infomines', 'tabelmines', 'minesinfo'].includes(command) || (['mines', 'ranjau'].includes(command) && ['info', 'tabel', 'table', 'bantuan', 'help'].includes(args[1]?.toLowerCase()))) {
    const bombParam = args[1] && !isNaN(parseInt(args[1], 10)) ? parseInt(args[1], 10) : (args[2] && !isNaN(parseInt(args[2], 10)) ? parseInt(args[2], 10) : null);
    return await showMinesInfo(sock, jid, messageObj, bombParam);
  }

  // 2. MEMBUKA KOTAK (.buka <nomor> / .pick <nomor>)
  if (['buka', 'pick'].includes(command)) {
    return await pickTile(sock, jid, senderNumber, messageObj, args);
  }

  // 3. CASHOUT / KLAIM KEUNTUNGAN (.cashout / .tarikdana / .claim)
  if (['cashout', 'tarikdana', 'claim'].includes(command)) {
    return await cashoutGame(sock, jid, senderNumber, messageObj);
  }

  // 4. MENYERAH / BATAL (.batalmines)
  if (['batalmines', 'surrender'].includes(command)) {
    return await cancelMinesGame(sock, jid, senderNumber, messageObj);
  }

  // 5. MEMULAI GAME BARU (.mines <taruhan> [bom] / .ranjau <taruhan> [bom])
  if (['mines', 'ranjau'].includes(command)) {
    return await startMinesGame(sock, jid, senderNumber, messageObj, args, isFromGroup);
  }

  return false;
}

/**
 * Menampilkan Tabel Spesifikasi Multiplier Lengkap per Jumlah Bom
 */
async function showMinesInfo(sock, jid, messageObj, specificBombs = null) {
  if (specificBombs && specificBombs >= 1 && specificBombs <= 24) {
    const safeTiles = TOTAL_TILES - specificBombs;
    const lines = [
      `📊 *SPESIFIKASI MULTIPLIER MINES — ${specificBombs} BOM* 💣`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎲 Total Kotak: *25 Kotak*`,
      `💣 Jumlah Bom: *${specificBombs} Bom*`,
      `💎 Total Berlian Aman: *${safeTiles} Kotak*\n`,
      `📈 *Daftar Multiplier Langkah per Langkah:*`
    ];

    for (let i = 1; i <= safeTiles; i++) {
      const mult = calculateMinesMultiplier(specificBombs, i);
      const estWin100 = Math.floor(100 * mult);
      lines.push(`• *Langkah ${i}💎:* \`${mult.toLocaleString('id-ID')}x\` (Taruhan 100 ➔ *${estWin100.toLocaleString('id-ID')} Poin*)`);
    }

    lines.push(`\n💡 _Ketik \`.mines <taruhan> ${specificBombs}\` untuk mulai bermain dengan ${specificBombs} bom!_`);
    await send(sock, jid, messageObj, lines.join('\n'));
    return true;
  }

  const tableSummary = 
`📊 *TABEL ESTIMASI MULTIPLIER MINES (1 - 24 BOM)* 💣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pilihan bom menentukan risiko & multiplier kemenangan:

💣 *1 BOM (24 Berlian):*
▫️ 1💎: \`1.01x\` | 2💎: \`1.05x\` | 5💎: \`1.21x\` | 10💎: \`1.62x\` | Max: \`24.25x\`

💣 *3 BOM (22 Berlian - Standar):*
▫️ 1💎: \`1.10x\` | 2💎: \`1.26x\` | 3💎: \`1.45x\` | 5💎: \`1.96x\` | Max: \`2.231x\`

💣 *5 BOM (20 Berlian):*
▫️ 1💎: \`1.21x\` | 2💎: \`1.53x\` | 3💎: \`1.96x\` | 5💎: \`3.32x\` | Max: \`51.536x\`

💣 *10 BOM (15 Berlian - High Risk):*
▫️ 1💎: \`1.62x\` | 2💎: \`2.77x\` | 3💎: \`4.90x\` | 5💎: \`17.16x\` | Max: \`3.170.697x\`

💣 *15 BOM (10 Berlian - Extreme):*
▫️ 1💎: \`2.42x\` | 2💎: \`6.47x\` | 3💎: \`18.59x\` | 5💎: \`204.51x\` | Max: \`3.170.697x\`

💣 *20 BOM (5 Berlian - Insane):*
▫️ 1💎: \`4.85x\` | 2💎: \`29.10x\` | 3💎: \`223.10x\` | 4💎: \`2.454x\` | Max: \`51.536x\`

💣 *24 BOM (1 Berlian - Impossible 1 Hit):*
▫️ 1💎 (Max): \`24.25x\` (Hanya 1 berlian di antara 24 bom!)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *Contoh Main:*
• \`.mines 100 1\` (Main aman 1 bom)
• \`.mines 100 5\` (Main 5 bom)
• \`.mines 100 15\` (Main extreme 15 bom)
• \`.infomines <1-24>\` (Cek detail multiplier spesifik)`;

  await send(sock, jid, messageObj, tableSummary, {
    title: '📊 TABEL MINES',
    buttons: [
      { type: 'reply', text: '💣 Main 3 Bom (Standar)', id: '.mines 100 3' },
      { type: 'reply', text: '🔥 Main 5 Bom', id: '.mines 100 5' },
      { type: 'reply', text: '⚡ Main 15 Bom (Extreme)', id: '.mines 100 15' }
    ]
  });

  return true;
}

/**
 * Memulai Sesi Game Mines Baru
 */
async function startMinesGame(sock, jid, senderNumber, messageObj, args, isFromGroup) {
  if (activeMinesGames.has(senderNumber)) {
    const active = activeMinesGames.get(senderNumber);
    const boardVisual = renderMinesBoard(active);
    await send(sock, jid, messageObj, 
      `⚠️ *KAMU MASIH MEMILIKI SESI MINES YANG AKTIF!* 💣\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Taruhan: *${active.bet.toLocaleString('id-ID')} Poin*\n` +
      `💣 Jumlah Bom: *${active.bombCount} Bom* (Sisa Berlian: *${TOTAL_TILES - active.bombCount} Kotak*)\n` +
      `📈 Multiplier Saat Ini: *${active.multiplier}x* (Nilai: *${active.currentWin.toLocaleString('id-ID')} Poin*)\n` +
      `💎 Berlian Terbuka: *${active.revealed.size}/${TOTAL_TILES - active.bombCount}*\n\n` +
      `${boardVisual}\n\n` +
      `👉 Ketik \`.buka <1-25>\` untuk lanjut membuka kotak\n` +
      `👉 Atau ketik \`.cashout\` / \`.batalmines\` untuk mengakhiri sesi ini terlebih dahulu!`,
      {
        title: '⚠️ SESI AKTIF',
        buttons: [
          { type: 'reply', text: `💰 Cashout (${active.currentWin} Poin)`, id: '.cashout' },
          { type: 'reply', text: '❌ Batalkan Sesi Ini', id: '.batalmines' }
        ],
        mentions: [senderNumber]
      }
    );
    return true;
  }

  // Robust argument parser for Bet & BombCount
  let bet = 0;
  let bombCount = 3;
  const cleanTokens = args.slice(1).map(a => a.toLowerCase().trim()).filter(Boolean);
  let betToken = null;
  let bombToken = null;

  for (let i = 0; i < cleanTokens.length; i++) {
    const tok = cleanTokens[i];
    if (tok.startsWith('bom') && tok.length > 3 && !isNaN(parseInt(tok.replace(/[^0-9]/g, ''), 10))) {
      const num = parseInt(tok.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(num)) { bombToken = num; continue; }
    }
    if (tok === 'bom' || tok === '-b' || tok === 'b') {
      if (i + 1 < cleanTokens.length) {
        const nextNum = parseInt(cleanTokens[i + 1].replace(/[^0-9]/g, ''), 10);
        if (!isNaN(nextNum)) { bombToken = nextNum; i++; continue; }
      }
    }
    if (tok.endsWith('bom') && !isNaN(parseInt(tok.replace(/[^0-9]/g, ''), 10))) {
      const num = parseInt(tok.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(num)) { bombToken = num; continue; }
    }
    const pureNum = parseInt(tok.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(pureNum) && String(pureNum) === tok) {
      if (betToken === null) {
        betToken = pureNum;
      } else if (bombToken === null) {
        bombToken = pureNum;
      }
    }
  }

  if (betToken !== null) bet = betToken;
  if (bombToken !== null) {
    if (bombToken >= 1 && bombToken <= 24) {
      bombCount = bombToken;
    } else {
      await send(sock, jid, messageObj, `⚠️ *PILIHAN BOM TIDAK VALID!* 💣\nJumlah bom harus berada di antara *1 s/d 24 bom* (Total grid: 25 kotak).\n\n_Contoh:_ \`.mines ${bet || 100} 5\` atau \`.mines ${bet || 100} 15\``);
      return true;
    }
  }

  if (!bet || isNaN(bet) || bet < 10) {
    await send(sock, jid, messageObj, 
      `⚠️ *FORMAT PERINTAH MINES SALAH!* 💣\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Format: \`.mines <taruhan> [jumlah_bom]\`\n\n` +
      `📌 *Contoh Penggunaan:*\n` +
      `• \`.mines 100\` (Taruhan 100 Poin, default 3 bom)\n` +
      `• \`.mines 100 5\` (Taruhan 100 Poin, 5 bom)\n` +
      `• \`.mines 300 15\` (Taruhan 300 Poin, 15 bom multiplier extreme!)\n\n` +
      `_Minimal taruhan: 10 Poin. Pilihan bom: 1 s/d 24 bom._\n` +
      `_Ketik \`.infomines\` untuk melihat tabel multiplier semua level bom!_`
    );
    return true;
  }

  // Cek saldo dompet user
  const prof = await db.getGameProfile(senderNumber);
  const currentWallet = prof?.points || 0;
  if (currentWallet < bet) {
    await send(sock, jid, messageObj, `❌ Poin dompetmu tidak mencukupi untuk taruhan *${bet.toLocaleString('id-ID')} Poin*!\n💰 Poin Dompet: *${currentWallet.toLocaleString('id-ID')} Poin*`);
    return true;
  }

  // Potong taruhan secara atomik
  const deduct = await db.deductGamePoints(senderNumber, bet);
  if (!deduct.success) {
    await send(sock, jid, messageObj, `❌ Gagal memproses taruhan poin.`);
    return true;
  }

  // Generate posisi bom unik acak (1 s/d 25)
  const allIndices = Array.from({ length: TOTAL_TILES }, (_, i) => i + 1);
  const bombs = [];
  while (bombs.length < bombCount) {
    const randIdx = Math.floor(Math.random() * allIndices.length);
    const chosen = allIndices.splice(randIdx, 1)[0];
    bombs.push(chosen);
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const senderName = cust?.nama ? cust.nama : `@${senderNumber.split('@')[0]}`;

  const session = {
    senderNumber,
    senderName,
    jid,
    bet,
    bombCount,
    bombs,
    revealed: new Set(),
    multiplier: 1.0,
    currentWin: bet,
    isFromGroup,
    timer: null,
    createdAt: Date.now()
  };

  // Setup timer 60 detik
  scheduleMinesTimeout(sock, session);
  activeMinesGames.set(senderNumber, session);

  const initialBoard = renderMinesBoard(session);
  const nextMultiplier = calculateMinesMultiplier(bombCount, 1);
  const nextEstWin = Math.floor(bet * nextMultiplier);
  const roadmap = getMultiplierRoadmap(bombCount);
  const safeTotal = TOTAL_TILES - bombCount;

  const startMsg = 
`💣 *RANJAU POIN (MINES & CASHOUT)* 💎
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Pemain: *${senderName}*
💰 Modal Taruhan: *${bet.toLocaleString('id-ID')} Poin*
💣 Jumlah Bom: *${bombCount} Bom* (Berlian Aman: *${safeTotal} Kotak*)
📈 Multiplier Kotak Ke-1: *${nextMultiplier}x* (~${nextEstWin.toLocaleString('id-ID')} Poin)

📊 *Roadmap Multiplier:*
${roadmap}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${initialBoard}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Cara Bermain:*
• Ketik \`.buka <1-25>\` atau \`.buka <A1-E5>\` (Contoh: \`.buka 7\` / \`.buka B2\`)
• Ketik \`.cashout\` kapan saja setelah membuka berlian!`;

  await send(sock, jid, messageObj, startMsg, {
    title: '💣 MINES GAME',
    buttons: [
      { type: 'reply', text: '💎 Buka Kotak 13 (Tengah)', id: '.buka 13' },
      { type: 'reply', text: '💎 Buka Kotak 7', id: '.buka 7' },
      { type: 'reply', text: '❌ Batalkan Game', id: '.batalmines' }
    ],
    mentions: [senderNumber]
  });

  return true;
}

/**
 * Handle Membuka Kotak (Pick Tile)
 */
async function pickTile(sock, jid, senderNumber, messageObj, args) {
  const session = activeMinesGames.get(senderNumber);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Kamu tidak memiliki sesi game Mines yang aktif.\nKetik *.mines <taruhan>* untuk mulai bermain!");
    return true;
  }

  const targetTile = parseTileCoordinate(args[1]);
  if (!targetTile) {
    await send(sock, jid, messageObj, `⚠️ Masukkan nomor kotak yang valid antara *1 s/d 25* atau koordinat *A1 s/d E5*.\n*Contoh:* \`.buka 7\` atau \`.buka B2\``);
    return true;
  }

  if (session.revealed.has(targetTile)) {
    await send(sock, jid, messageObj, `⚠️ Kotak nomor *${targetTile}* sudah kamu buka sebelumnya! Pilih kotak lain yang masih tertutup (⬛).`);
    return true;
  }

  // Reset timer timeout 60 detik
  scheduleMinesTimeout(sock, session);

  // KONDISI 1: KENA BOM MELEDAK (GAME OVER)
  if (session.bombs.includes(targetTile)) {
    if (session.timer) clearTimeout(session.timer);
    activeMinesGames.delete(senderNumber);

    const loseBoard = renderMinesBoard(session, true, targetTile);
    const loseMsg = 
`💥 *BOOOOM! KOTAK MELEDAK!* 💣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kamu membuka kotak nomor *${targetTile}* yang ternyata berisi BOM RANJAU!

${loseBoard}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💀 *Status:* Kena Bom & Hangus
💣 *Total Bom di Papan:* ${session.bombCount} Bom
💸 *Kerugian:* -${session.bet.toLocaleString('id-ID')} Poin
💎 *Berlian yang Sempat Dibuka:* ${session.revealed.size} Kotak

_Jangan patah semangat! Ketik \`.mines ${session.bet} ${session.bombCount}\` untuk mencoba lagi._`;

    await send(sock, jid, messageObj, loseMsg, {
      title: '💥 MINES MELEDAK',
      buttons: [
        { type: 'reply', text: `🔄 Main Lagi (${session.bet} Poin)`, id: `.mines ${session.bet} ${session.bombCount}` },
        { type: 'reply', text: '👤 Cek Saldo Poin', id: '.poin' },
        { type: 'reply', text: '🎮 Menu Game', id: '.menu game' }
      ],
      mentions: [senderNumber]
    });
    return true;
  }

  // KONDISI 2: AMAN / MENEMUKAN BERLIAN (DIAMOND)
  session.revealed.add(targetTile);
  const diamondsCount = session.revealed.size;
  const maxSafeTiles = TOTAL_TILES - session.bombCount;

  session.multiplier = calculateMinesMultiplier(session.bombCount, diamondsCount);
  session.currentWin = Math.floor(session.bet * session.multiplier);

  // Cek apakah pemain berhasil membuka SEMUA berlian aman (MAX WIN JACKPOT)
  if (diamondsCount === maxSafeTiles) {
    if (session.timer) clearTimeout(session.timer);
    activeMinesGames.delete(senderNumber);

    await db.awardGamePoints(senderNumber, session.currentWin, true);
    await db.grantXp(senderNumber, Math.floor(session.currentWin / 3));

    const winBoard = renderMinesBoard(session, true);
    const maxWinMsg = 
`🏆 *MAX WIN JACKPOT! SELURUH BERLIAN TERBUKA!* 💎
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selamat! Kamu berhasil membuka seluruh *${diamondsCount} Berlian* tanpa menyentuh satu pun dari *${session.bombCount} Bom*!

${winBoard}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Modal Taruhan:* ${session.bet.toLocaleString('id-ID')} Poin
📈 *Multiplier Akhir:* *${session.multiplier.toLocaleString('id-ID')}x*
🎁 *TOTAL JACKPOT:* *+${session.currentWin.toLocaleString('id-ID')} Poin* & *+${Math.floor(session.currentWin / 3)} XP*!`;

    await send(sock, jid, messageObj, maxWinMsg, {
      title: '🏆 MAX WIN MINES',
      buttons: [
        { type: 'reply', text: '📦 Main Lagi', id: `.mines ${session.bet} ${session.bombCount}` },
        { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
      ],
      mentions: [senderNumber]
    });
    return true;
  }

  // Masih berlanjut: render board dan tampilkan multiplier saat ini
  const nextMultiplier = calculateMinesMultiplier(session.bombCount, diamondsCount + 1);
  const nextEstWin = Math.floor(session.bet * nextMultiplier);
  const currentBoard = renderMinesBoard(session);
  const profit = session.currentWin - session.bet;

  const safeMsg = 
`💎 *BERLIAN DITEMUKAN!* (+${session.multiplier}x) ✨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Pemain: *${session.senderName}*
💰 Modal: *${session.bet.toLocaleString('id-ID')} Poin*
💣 Bom: *${session.bombCount} Bom* | 💎 Berlian Terbuka: *${diamondsCount}/${maxSafeTiles} Kotak*
📈 Multiplier Saat Ini: *${session.multiplier}x*
💵 Nilai Tarik Tunai (*.cashout*): *${session.currentWin.toLocaleString('id-ID')} Poin* (Profit +${profit.toLocaleString('id-ID')})

${currentBoard}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Pilihan Aksi:*
• Ketik \`.buka <1-25>\` untuk kotak berikutnya (*${nextMultiplier}x* / ~${nextEstWin.toLocaleString('id-ID')} Poin)
• Atau ketik \`.cashout\` untuk amankan *${session.currentWin.toLocaleString('id-ID')} Poin* sekarang!`;

  await send(sock, jid, messageObj, safeMsg, {
    title: '💎 KOTAK AMAN',
    buttons: [
      { type: 'reply', text: `💰 Ambil ${session.currentWin.toLocaleString('id-ID')} Poin`, id: '.cashout' },
      { type: 'reply', text: '💣 Batalkan', id: '.batalmines' }
    ],
    mentions: [senderNumber]
  });

  return true;
}

/**
 * Handle Cashout (Mencairkan Kemenangan Poin)
 */
async function cashoutGame(sock, jid, senderNumber, messageObj) {
  const session = activeMinesGames.get(senderNumber);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Kamu tidak memiliki sesi game Mines yang aktif.");
    return true;
  }

  if (session.revealed.size === 0) {
    await send(sock, jid, messageObj, "⚠️ Kamu belum membuka satu pun kotak berlian! Buka minimal 1 kotak dengan `.buka <1-25>` sebelum cashout.");
    return true;
  }

  if (session.timer) clearTimeout(session.timer);
  activeMinesGames.delete(senderNumber);

  // Berikan kemenangan poin & XP
  const winAmount = session.currentWin;
  const xpReward = Math.max(10, Math.floor(winAmount / 5));
  await db.awardGamePoints(senderNumber, winAmount, true);
  await db.grantXp(senderNumber, xpReward);

  const finalProfile = await db.getGameProfile(senderNumber);
  const fullBoard = renderMinesBoard(session, true);
  const profit = winAmount - session.bet;

  const cashoutMsg = 
`💰 *CASHOUT BERHASIL DICAIRKAN!* 💎
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selamat! Kamu berhasil mengamankan kemenangan dari arena ranjau!

${fullBoard}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💵 *Modal Awal:* ${session.bet.toLocaleString('id-ID')} Poin
💣 *Jumlah Bom:* ${session.bombCount} Bom (Buka: ${session.revealed.size} Kotak)
📈 *Multiplier Tercapai:* *${session.multiplier}x*
🎁 *Total Kemenangan:* *+${winAmount.toLocaleString('id-ID')} Poin* (+${profit.toLocaleString('id-ID')} Profit & +${xpReward} XP)
💰 *Saldo Dompet Sekarang:* *${(finalProfile?.points || 0).toLocaleString('id-ID')} Poin*

_Ketik \`.mines ${session.bet} ${session.bombCount}\` untuk bermain ronde baru._`;

  await send(sock, jid, messageObj, cashoutMsg, {
    title: '💰 CASHOUT SUKSES',
    buttons: [
      { type: 'reply', text: `🔄 Main Lagi (${session.bet} Poin)`, id: `.mines ${session.bet} ${session.bombCount}` },
      { type: 'reply', text: '👤 Cek Profil Poin', id: '.poin' },
      { type: 'reply', text: '🎮 Menu Game', id: '.menu game' }
    ],
    mentions: [senderNumber]
  });

  return true;
}

/**
 * Handle Batalkan / Menyerah
 */
async function cancelMinesGame(sock, jid, senderNumber, messageObj) {
  const session = activeMinesGames.get(senderNumber);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Mines aktif untuk dibatalkan.");
    return true;
  }

  if (session.revealed.size > 0) {
    // Jika sudah buka berlian, langsung cashout
    return await cashoutGame(sock, jid, senderNumber, messageObj);
  }

  // Jika belum buka apapun, refund modal taruhan
  if (session.timer) clearTimeout(session.timer);
  activeMinesGames.delete(senderNumber);

  // addGamePoints: ini pengembalian modal, bukan hadiah. awardGamePoints ikut
  // mencetak XP senilai poin, sehingga `.mines 37000` -> `.batalmines` dulu
  // memberi +37.000 XP gratis dan bisa diulang tanpa batas.
  await db.addGamePoints(senderNumber, session.bet);
  await send(sock, jid, messageObj, `✅ Sesi game Mines dibatalkan. Modal taruhan *${session.bet.toLocaleString('id-ID')} Poin* telah dikembalikan utuh ke dompetmu.`);
  return true;
}

/**
 * Penanganan Timeout (60 Detik)
 */
function scheduleMinesTimeout(sock, session) {
  if (session.timer) clearTimeout(session.timer);

  session.timer = setTimeout(async () => {
    try {
      if (!activeMinesGames.has(session.senderNumber)) return;

      if (session.revealed.size > 0) {
        // Auto-cashout otomatis agar user tidak rugi
        activeMinesGames.delete(session.senderNumber);
        await db.awardGamePoints(session.senderNumber, session.currentWin, true);
        await send(sock, session.jid, null, 
          `⏳ *WAKTU MINES HABIS — AUTO CASHOUT!* 💰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Sesi @${session.senderNumber.split('@')[0]} telah kedaluwarsa karena tidak ada input selama 60 detik.\n` +
          `🎁 Kemenangan sebesar *+${session.currentWin.toLocaleString('id-ID')} Poin* (${session.multiplier}x) otomatis dicairkan ke dompet!`,
          { mentions: [session.senderNumber] }
        );
      } else {
        // Belum buka apapun -> refund
        activeMinesGames.delete(session.senderNumber);
        // Sama seperti `.batalmines`: pengembalian modal, tanpa XP.
        await db.addGamePoints(session.senderNumber, session.bet);
        await send(sock, session.jid, null, 
          `⏳ *SESI MINES KEDALUWARSA!* Modal taruhan *${session.bet} Poin* telah dikembalikan ke dompet @${session.senderNumber.split('@')[0]}.`,
          { mentions: [session.senderNumber] }
        );
      }
    } catch (err) {
      console.error('[MINES TIMEOUT ERROR]', err);
    }
  }, GAME_TIMEOUT_MS);
}

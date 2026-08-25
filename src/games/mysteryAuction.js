import * as db from '../../database.js';
import { send, isOnCooldown, randomItem } from './helpers.js';
import { victimImmunity } from './rpgSystem.js';

export const activeAuctions = new Map();
export const auctionCooldowns = new Map();

const AUCTION_DURATION_MS = 45 * 1000;
const SNIP_THRESHOLD_MS = 10 * 1000;
const SNIP_EXTENSION_MS = 10 * 1000;
const MAX_SNIP_EXTENSIONS = 3;

// Definisi Rarity dan Karakteristik Kotak Misteri
export const BOX_TYPES = {
  bronze: {
    id: 'bronze',
    name: 'Kotak Perunggu',
    emoji: '🥉',
    openBid: 30,
    minInc: 10,
    desc: 'Kotak kayu berlapis perunggu kuno. Murah dan ramah pemula!',
    lootPool: [
      { type: 'points', weight: 35, min: 50, max: 120, label: '💰 Kantong Poin Perunggu' },
      { type: 'xp', weight: 25, amount: 80, label: '⭐ Kristal XP (+80 XP)' },
      { type: 'zonk', weight: 20, comp: 10, label: '📜 Surat Pantun Bot (Zonk Lucu +10 Poin)' },
      { type: 'free_jail', weight: 10, label: '🎫 Kartu Pengampunan (Bebas Penjara)' },
      { type: 'slip_trap', weight: 10, penalty: 25, label: '🍌 Trap Kulit Pisang (-25 Poin Dompet)' }
    ]
  },
  silver: {
    id: 'silver',
    name: 'Kotak Perak Saudagar',
    emoji: '🥈',
    openBid: 100,
    minInc: 25,
    desc: 'Peti perak mengkilap dari gudang saudagar kaya. Berisi hadiah berharga!',
    lootPool: [
      { type: 'points', weight: 30, min: 180, max: 350, label: '💰 Kantong Poin Perak Menengah' },
      { type: 'xp_points', weight: 25, xp: 200, points: 60, label: '⭐ Paket Booster XP (+200 XP & +60 Poin)' },
      { type: 'shield', weight: 15, durationHours: 6, label: '🛡️ Shield Anti-Maling (Kebal Maling 6 Jam)' },
      { type: 'free_jail_bonus', weight: 15, points: 100, label: '🎫 Tiket Bebas Penjara + 100 Poin' },
      { type: 'jail_trap', weight: 10, minutes: 10, label: '🚨 Trap Gas Air Mata (Masuk Penjara 10 Menit)' },
      { type: 'zonk', weight: 5, comp: 25, label: '💌 Surat Cinta Bot (Zonk Lucu +25 Poin)' }
    ]
  },
  gold: {
    id: 'gold',
    name: 'Peti Emas Kerajaan',
    emoji: '🥇',
    openBid: 300,
    minInc: 50,
    desc: 'Peti emas berukir mewah milik keluarga kerajaan. Hadiah berlimpah!',
    lootPool: [
      { type: 'jackpot_points', weight: 30, min: 600, max: 1200, label: '💎 JACKPOT EMAS KERAJAAN' },
      { type: 'shield_points', weight: 25, durationHours: 12, points: 200, label: '🛡️ Mega Shield (Kebal Maling 12 Jam + 200 Poin)' },
      { type: 'xp_points', weight: 20, xp: 500, points: 300, label: '⭐ Mega XP Booster (+500 XP & +300 Poin)' },
      { type: 'jail_trap', weight: 15, minutes: 20, label: '💣 Trap Bom Asap Penjara (Masuk Penjara 20 Menit)' },
      { type: 'curse_points', weight: 10, penalty: 150, label: '⚡ Kutukan Siluman (-150 Poin Dompet)' }
    ]
  },
  diamond: {
    id: 'diamond',
    name: 'Peti Keramat Diamond',
    emoji: '💎',
    openBid: 800,
    minInc: 100,
    desc: 'Peti permata legendaris langka! Penuh risiko tinggi dengan jackpot ekstrem!',
    lootPool: [
      { type: 'mega_jackpot', weight: 35, min: 1800, max: 3000, label: '👑 ULTRA MEGA JACKPOT POIN' },
      { type: 'ultra_shield', weight: 25, durationHours: 24, points: 500, xp: 500, label: '🛡️ Ultra Aegis Shield (Immunity 24 Jam + 500 Poin + 500 XP)' },
      { type: 'cashback_voucher', weight: 20, points: 800, xp: 400, label: '🛍️ Voucher Sultan (+800 Poin & +400 XP)' },
      { type: 'curse_percent', weight: 10, percent: 15, label: '💀 Kutukan Raja Kegelapan (Sita 15% Dompet)' },
      { type: 'jail_trap', weight: 10, minutes: 30, label: '⛓️ Jebakan Borgol Besi (Masuk Penjara 30 Menit)' }
    ]
  }
};

/**
 * Memilih loot secara acak berbobot
 */
function pickWeightedLoot(lootPool) {
  const totalWeight = lootPool.reduce((acc, item) => acc + item.weight, 0);
  let randomVal = Math.random() * totalWeight;

  for (const item of lootPool) {
    if (randomVal < item.weight) {
      return item;
    }
    randomVal -= item.weight;
  }
  return lootPool[0];
}

/**
 * Handle Command Utama Lelang (.lelang, .auction, .bid, .tawar, .cancellelang, .infolelang)
 */
export async function handleAuctionCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin = false, isOwner = false) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ *Game Lelang Kotak Misteri* hanya bisa dimainkan di dalam grup WhatsApp!");
    return true;
  }

  // 1. MEMBATALKAN LELANG (.cancellelang / .batallelang)
  if (['cancellelang', 'batallelang'].includes(command)) {
    return await cancelAuction(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  // 2. CEK INFORMASI LELANG AKTIF (.infolelang / .lelanginfo)
  if (['infolelang', 'lelanginfo'].includes(command)) {
    return await showAuctionInfo(sock, jid, messageObj);
  }

  // 3. MENGAJUKAN TAWARAN BID (.bid / .tawar / .bidup)
  if (['bid', 'tawar', 'bidup'].includes(command)) {
    return await placeBid(sock, jid, senderNumber, messageObj, args, command);
  }

  // 4. MEMULAI LELANG BARU (.lelang / .auction / .lelangkotak)
  if (['lelang', 'auction', 'lelangkotak'].includes(command)) {
    return await startAuction(sock, jid, senderNumber, messageObj, args);
  }

  return false;
}

/**
 * Memulai Sesi Lelang Baru di Grup
 */
async function startAuction(sock, jid, senderNumber, messageObj, args) {
  if (activeAuctions.has(jid)) {
    const active = activeAuctions.get(jid);
    const sisaDetik = Math.max(1, Math.ceil((active.endTime - Date.now()) / 1000));
    const highestBidderText = active.currentHighestBidder 
      ? `@${active.currentHighestBidder.split('@')[0]} (*${active.currentHighestBid.toLocaleString('id-ID')} Poin*)` 
      : `_Belum ada penawar (Open Bid: ${active.box.openBid} Poin)_`;

    await send(sock, jid, messageObj, 
      `⚠️ *LELANG SEDANG BERLANGSUNG DI GRUP INI!* 📦\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📦 *Kotak:* ${active.box.emoji} *${active.box.name}*\n` +
      `👑 *Penawar Tertinggi:* ${highestBidderText}\n` +
      `⏳ *Sisa Waktu:* *${sisaDetik} detik*\n\n` +
      `👉 Ketik \`.bid [jumlah]\` atau \`.bidup\` untuk menaikkan tawaran!`,
      { mentions: active.currentHighestBidder ? [active.currentHighestBidder] : [] }
    );
    return true;
  }

  // Cooldown grup untuk mencegah spam lelang
  const now = Date.now();
  const lastAuction = auctionCooldowns.get(jid) || 0;
  if (now - lastAuction < 15 * 1000) {
    const sisa = Math.ceil((15 * 1000 - (now - lastAuction)) / 1000);
    await send(sock, jid, messageObj, `⏳ Mohon tunggu *${sisa} detik* sebelum membuka lelang kotak misteri berikutnya.`);
    return true;
  }

  // Cek profile host
  const hostCust = await db.getCustomerByPhone(senderNumber);
  const hostName = hostCust?.nama ? hostCust.nama : `@${senderNumber.split('@')[0]}`;

  // Pilih tipe kotak berdasarkan argumen user atau acak
  let chosenType = 'silver';
  const param = (args[1] || '').toLowerCase();
  if (['perunggu', 'bronze', '1'].includes(param)) chosenType = 'bronze';
  else if (['perak', 'silver', '2'].includes(param)) chosenType = 'silver';
  else if (['emas', 'gold', '3'].includes(param)) chosenType = 'gold';
  else if (['diamond', 'keramat', 'mitik', 'mythic', '4'].includes(param)) chosenType = 'diamond';
  else {
    // Acak berbobot: bronze (30%), silver (40%), gold (20%), diamond (10%)
    const roll = Math.random() * 100;
    if (roll < 30) chosenType = 'bronze';
    else if (roll < 70) chosenType = 'silver';
    else if (roll < 90) chosenType = 'gold';
    else chosenType = 'diamond';
  }

  const box = BOX_TYPES[chosenType];
  const endTime = Date.now() + AUCTION_DURATION_MS;

  const session = {
    jid,
    hostJid: senderNumber,
    hostName,
    box,
    currentHighestBid: box.openBid,
    currentHighestBidder: null,
    currentHighestBidderName: null,
    bidHistory: [],
    endTime,
    snipCount: 0,
    timer: null
  };

  // Jadwalkan penutupan lelang
  scheduleAuctionTimeout(sock, session);
  activeAuctions.set(jid, session);

  const auctionCard = 
`📦 *LELANG KOTAK MISTERI DIMULAI!* 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sebuah kotak misteri langka telah dibawa ke pasar lelang!

${box.emoji} *Kategori Kotak:* *${box.name}*
📝 *Deskripsi:* _${box.desc}_

💵 *Harga Buka (Open Bid):* *${box.openBid.toLocaleString('id-ID')} Poin*
📈 *Minimal Kenaikan:* *+${box.minInc.toLocaleString('id-ID')} Poin*
⏳ *Durasi Lelang:* *45 Detik*

💡 *Isi Kemungkinan:*
• 💎 Jackpot Poin Berlipat Ganda
• ⭐ Bonus XP Booster & Level Up
• 🛡️ Shield Perlindungan Anti-Maling
• 🎫 Tiket Bebas Penjara / Pengampunan
• 💣 Trap Penjara & Bom Zonk Kocak

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Cara Ikut Tawar:*
Ketik: \`.bid <jumlah_poin>\` (Contoh: \`.bid ${box.openBid}\`)
Atau ketik: \`.bidup\` (Otomatis naik minimal +${box.minInc} Poin)`;

  await send(sock, jid, messageObj, auctionCard, {
    title: '📦 LELANG MISTERI',
    buttons: [
      { type: 'reply', text: `💰 Tawar Open Bid (${box.openBid} Poin)`, id: `.bid ${box.openBid}` },
      { type: 'reply', text: `📈 Naikkan Bid (+${box.minInc} Poin)`, id: `.bidup` },
      { type: 'reply', text: 'ℹ️ Cek Status Lelang', id: '.infolelang' }
    ]
  });

  return true;
}

/**
 * Handle Menawar / Bidding
 */
async function placeBid(sock, jid, senderNumber, messageObj, args, command) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang yang sedang aktif di grup ini.\nKetik *.lelang* untuk membuka lelang kotak baru!");
    return true;
  }

  const senderDigits = senderNumber.split('@')[0];
  const cust = await db.getCustomerByPhone(senderNumber);
  const senderName = cust?.nama ? cust.nama : `@${senderDigits}`;

  // Cek apakah pemain sudah jadi penawar tertinggi saat ini
  if (session.currentHighestBidder === senderNumber) {
    await send(sock, jid, messageObj, `⚠️ @${senderDigits}, kamu sudah memegang tawaran tertinggi saat ini (*${session.currentHighestBid.toLocaleString('id-ID')} Poin*)! Tunggu penawar lain menaikkan harga.`, { mentions: [senderNumber] });
    return true;
  }

  // Tentukan jumlah bid
  let bidAmount = 0;
  if (command === 'bidup') {
    if (!session.currentHighestBidder) {
      bidAmount = session.box.openBid;
    } else {
      bidAmount = session.currentHighestBid + session.box.minInc;
    }
  } else {
    const rawVal = args[1] ? args[1].replace(/[^0-9]/g, '') : '';
    bidAmount = parseInt(rawVal, 10);
  }

  if (!bidAmount || isNaN(bidAmount) || bidAmount <= 0) {
    const minTarget = session.currentHighestBidder 
      ? session.currentHighestBid + session.box.minInc 
      : session.box.openBid;
    await send(sock, jid, messageObj, `⚠️ *Format Bid Salah!*\nMasukkan nominal angka tawaran yang valid.\n\n*Contoh:* \`.bid ${minTarget}\` atau ketik \`.bidup\``);
    return true;
  }

  // Validasi batas minimal penawaran
  if (!session.currentHighestBidder) {
    if (bidAmount < session.box.openBid) {
      await send(sock, jid, messageObj, `⚠️ Tawaran pembuka minimal adalah *${session.box.openBid.toLocaleString('id-ID')} Poin*!`);
      return true;
    }
  } else {
    const minRequired = session.currentHighestBid + session.box.minInc;
    if (bidAmount < minRequired) {
      await send(sock, jid, messageObj, `⚠️ Tawaran harus lebih tinggi minimal *+${session.box.minInc.toLocaleString('id-ID')} Poin* dari tawaran saat ini!\n👉 Tawaran minimal berikutnya: *${minRequired.toLocaleString('id-ID')} Poin*.`);
      return true;
    }
  }

  // Validasi saldo dompet penawar
  const prof = await db.getGameProfile(senderNumber);
  const currentWallet = prof?.points || 0;
  if (currentWallet < bidAmount) {
    await send(sock, jid, messageObj, `❌ Poin dompetmu tidak mencukupi untuk tawaran *${bidAmount.toLocaleString('id-ID')} Poin*!\n💰 Poin Dompetmu: *${currentWallet.toLocaleString('id-ID')} Poin*`);
    return true;
  }

  // Update State Tawaran Tertinggi
  session.currentHighestBid = bidAmount;
  session.currentHighestBidder = senderNumber;
  session.currentHighestBidderName = senderName;
  session.bidHistory.push({
    bidder: senderNumber,
    bidderName: senderName,
    amount: bidAmount,
    time: Date.now()
  });

  // Anti-Sniping Protection: Jika ada bid di < 10 detik terakhir, perpanjang timer +10 detik (max 3x)
  const now = Date.now();
  let remainingMs = session.endTime - now;
  let sniped = false;

  if (remainingMs < SNIP_THRESHOLD_MS && session.snipCount < MAX_SNIP_EXTENSIONS) {
    session.endTime += SNIP_EXTENSION_MS;
    session.snipCount += 1;
    sniped = true;
    // Reschedule timer
    scheduleAuctionTimeout(sock, session);
  }

  const sisaDetikBaru = Math.max(1, Math.ceil((session.endTime - Date.now()) / 1000));
  const nextMinBid = bidAmount + session.box.minInc;

  let snipNotice = '';
  if (sniped) {
    snipNotice = `\n🔥 *ANTI-SNIPING AKTIF!* Waktu lelang diperpanjang *+10 detik*!`;
  }

  const bidSuccessMsg = 
`🔥 *PENAWARAN BARU DITERIMA!* 📈
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Penawar: *${senderName}* (@${senderDigits})
💰 Jumlah Bid: *${bidAmount.toLocaleString('id-ID')} Poin*
📦 Kotak: ${session.box.emoji} *${session.box.name}*
⏳ Sisa Waktu: *${sisaDetikBaru} detik*${snipNotice}

👉 Penawar berikutnya: minimal \`.bid ${nextMinBid}\` atau \`.bidup\`!`;

  await send(sock, jid, messageObj, bidSuccessMsg, {
    title: '📈 BID TERTINGGI BARU',
    buttons: [
      { type: 'reply', text: `🔥 Tawar ${nextMinBid} Poin`, id: `.bid ${nextMinBid}` },
      { type: 'reply', text: 'ℹ️ Cek Status', id: '.infolelang' }
    ],
    mentions: [senderNumber]
  });

  return true;
}

/**
 * Menjadwalkan / Memperbarui Timer Penutupan Lelang
 */
function scheduleAuctionTimeout(sock, session) {
  if (session.timer) clearTimeout(session.timer);

  const delay = Math.max(1000, session.endTime - Date.now());
  session.timer = setTimeout(async () => {
    try {
      await resolveAuction(sock, session);
    } catch (err) {
      console.error('[MYSTERY AUCTION ERROR]', err);
    }
  }, delay);
}

/**
 * Menyelesaikan Lelang dan Membuka Kotak Misteri (Unboxing)
 */
async function resolveAuction(sock, session) {
  const { jid, box, currentHighestBid, currentHighestBidder, currentHighestBidderName } = session;

  activeAuctions.delete(jid);
  auctionCooldowns.set(jid, Date.now());

  // KONDISI 1: Tidak ada penawar sama sekali
  if (!currentHighestBidder) {
    const noBidMsg = 
`⌛ *LELANG BERAKHIR — TIDAK ADA PENAWAR* 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Waktu lelang untuk ${box.emoji} *${box.name}* telah habis tanpa ada penawaran.
Kotak misteri telah disimpan kembali ke gudang brankas bot.

_Ketik \`.lelang\` kapan saja untuk mencoba membuka lelang baru._`;
    await send(sock, jid, null, noBidMsg);
    return;
  }

  const winnerDigits = currentHighestBidder.split('@')[0];

  // Potong poin penawar tertinggi secara atomik
  const deductResult = await db.deductGamePoints(currentHighestBidder, currentHighestBid);
  if (!deductResult.success) {
    // Jika ternyata poin user sengaja dihabiskan sebelum lelang selesai
    await db.setGameJail(currentHighestBidder, 15);
    const fraudMsg = 
`🚨 *LELANG GAGAL — SANKSI KECURANGAN!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pemenang @${winnerDigits} tidak memiliki saldo poin yang cukup (*${currentHighestBid.toLocaleString('id-ID')} Poin*) saat pembayaran lelang diselesaikan!

⚖️ *Sanksi:* @${winnerDigits} dijebloskan ke dalam penjara selama *15 menit* karena penipuan lelang!`;
    await send(sock, jid, null, fraudMsg, { mentions: [currentHighestBidder] });
    return;
  }

  // Roll hadiah dari loot pool kotak misteri
  const loot = pickWeightedLoot(box.lootPool);
  let rewardTitle = '';
  let rewardDetail = '';

  // Eksekusi Efek Hadiah / Hukuman
  if (loot.type === 'points' || loot.type === 'jackpot_points' || loot.type === 'mega_jackpot') {
    const wonPoints = Math.floor(Math.random() * (loot.max - loot.min + 1)) + loot.min;
    await db.awardGamePoints(currentHighestBidder, Math.min(1000, wonPoints), true);
    if (wonPoints > 1000) {
      await db.awardGamePoints(currentHighestBidder, wonPoints - 1000, false);
    }
    await db.addMessageXp(currentHighestBidder, Math.floor(wonPoints / 2));

    const isProfit = wonPoints >= currentHighestBid;
    rewardTitle = isProfit ? '🎉 *JACKPOT POIN BERHASIL DIBAWA PULANG!* 💰' : '📦 *HADIAH POIN DITEMUKAN!* 💰';
    rewardDetail = 
`🎁 *Isi Kotak:* *+${wonPoints.toLocaleString('id-ID')} Akbar Poin* & *+${Math.floor(wonPoints / 2)} XP*\n` +
`📊 *Statistik:* Modal Bid: *${currentHighestBid.toLocaleString('id-ID')} Poin* | Hadiah: *${wonPoints.toLocaleString('id-ID')} Poin*\n` +
`💡 *Hasil:* ${isProfit ? `🟢 *PROFIT +${(wonPoints - currentHighestBid).toLocaleString('id-ID')} Poin!*` : `🔴 *Rugi ${(currentHighestBid - wonPoints).toLocaleString('id-ID')} Poin*`}`;

  } else if (loot.type === 'xp') {
    await db.addMessageXp(currentHighestBidder, loot.amount);
    rewardTitle = '⭐ *KRISTAL XP DITEMUKAN!* ⭐';
    rewardDetail = `🎁 *Isi Kotak:* *+${loot.amount} XP Karakter*\nPengalaman bertambah pesat untuk menaikkan level rank bot!`;

  } else if (loot.type === 'xp_points' || loot.type === 'cashback_voucher') {
    await db.awardGamePoints(currentHighestBidder, loot.points, true);
    await db.addMessageXp(currentHighestBidder, loot.xp);
    rewardTitle = '✨ *PAKET KOMBO SULTAN!* ✨';
    rewardDetail = `🎁 *Isi Kotak:* *+${loot.points.toLocaleString('id-ID')} Poin* & *+${loot.xp} XP Booster*!`;

  } else if (loot.type === 'shield' || loot.type === 'shield_points' || loot.type === 'ultra_shield') {
    const hours = loot.durationHours || 12;
    const durationMs = hours * 60 * 60 * 1000;
    victimImmunity.set(currentHighestBidder, Date.now() + durationMs);

    if (loot.points) await db.awardGamePoints(currentHighestBidder, loot.points, true);
    if (loot.xp) await db.addMessageXp(currentHighestBidder, loot.xp);

    rewardTitle = '🛡️ *AEGIS SECURITY SHIELD AKTIF!* 🛡️';
    rewardDetail = 
`🎁 *Isi Kotak:* *Perlindungan Kebal Maling (.steal / .maling) selama ${hours} Jam!*` +
(loot.points ? `\n💰 *Bonus Tambahan:* +${loot.points} Poin & +${loot.xp || 0} XP` : '') +
`\n_Dompetmu 100% aman dari aksi pencopetan member lain selama periode ini._`;

  } else if (loot.type === 'free_jail' || loot.type === 'free_jail_bonus') {
    await db.clearGameJail(currentHighestBidder);
    if (loot.points) await db.awardGamePoints(currentHighestBidder, loot.points, true);

    rewardTitle = '🎫 *KARTU PENGAMPUNAN KEPOLISIAN!* 🎫';
    rewardDetail = 
`🎁 *Isi Kotak:* *Tiket Bebas Penjara Instan!*` +
(loot.points ? `\n💰 *Bonus Poin:* +${loot.points} Poin` : '') +
`\n_Jika kamu sedang atau nanti masuk penjara, catatan kriminalmu langsung diputihkan._`;

  } else if (loot.type === 'jail_trap') {
    const mins = loot.minutes || 15;
    await db.setGameJail(currentHighestBidder, mins);

    rewardTitle = '🚨 *JEBAKAN GAS AIR MATA MELEDAK!* 💥';
    rewardDetail = 
`💣 *Isi Kotak:* Kotak meledak mengeluarkan gas air mata! Polisi datang dan menangkap @${winnerDigits}.\n` +
`⛓️ *Hukuman:* Masuk Penjara selama *${mins} Menit*!\n` +
`_Gunakan \`.jailbreak\` untuk mencoba kabur atau minta teman mengetik \`.tebus @${winnerDigits}\`!_`;

  } else if (loot.type === 'slip_trap' || loot.type === 'curse_points') {
    const pen = loot.penalty || 50;
    await db.deductGamePoints(currentHighestBidder, pen);

    rewardTitle = '💀 *KUTUKAN KOTAK KERAMAT!* ⚡';
    rewardDetail = `💣 *Isi Kotak:* Kutukan kuno menyedot *-${pen} Poin* tambahan dari dompetmu!`;

  } else if (loot.type === 'curse_percent') {
    const updatedProf = await db.getGameProfile(currentHighestBidder);
    const cutAmount = Math.floor((updatedProf?.points || 0) * (loot.percent / 100));
    if (cutAmount > 0) {
      await db.deductGamePoints(currentHighestBidder, cutAmount);
    }

    rewardTitle = '💀 *KUTUKAN RAJA KEGELAPAN!* 💀';
    rewardDetail = `💣 *Isi Kotak:* Badai kegelapan menyita *${loot.percent}% Saldo Dompetmu (-${cutAmount.toLocaleString('id-ID')} Poin)*!`;

  } else {
    // Zonk Kocak
    const comp = loot.comp || 15;
    await db.awardGamePoints(currentHighestBidder, comp, false);

    const funnyJokes = [
      "Isi kotak: Hanya ada selembar tisu bekas dan surat bertuliskan: 'Terima kasih atas donasi poinnya!' 🤣",
      "Isi kotak: Sarung bantal bekas dan foto selfie bot yang sedang tersenyum lebar. 😜",
      "Isi kotak: Sebungkus angin surga dan secarik kertas bertuliskan: 'Coba lagi lain kali ya!' 💨",
      "Isi kotak: Rekaman suara tawa bot: 'Wkwkwkwk kena zonk kan!' 🤖"
    ];
    const pickedJoke = randomItem(funnyJokes);

    rewardTitle = '🤡 *ZONK LUCU DITEMUKAN!* 🤡';
    rewardDetail = `🎁 *Isi Kotak:* ${pickedJoke}\n🪙 *Kompensasi Hiburan:* +${comp} Poin`;
  }

  const finalProfile = await db.getGameProfile(currentHighestBidder);

  const unboxMessage = 
`📦 *HASIL LELANG KOTAK MISTERI* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Pemenang:* @${winnerDigits} (${currentHighestBidderName})
💰 *Tawaran Terakhir:* *${currentHighestBid.toLocaleString('id-ID')} Poin*
📦 *Tipe Kotak:* ${box.emoji} *${box.name}*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rewardTitle}
${rewardDetail}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *Sisa Poin Dompetmu:* *${(finalProfile?.points || 0).toLocaleString('id-ID')} Poin*
⭐ *Level Karakter:* *Lv.${finalProfile?.level || 1}* (${finalProfile?.xp || 0} XP)

_Terima kasih telah berpartisipasi dalam Lelang Misteri! Ketik \`.lelang\` untuk ronde berikutnya._`;

  await send(sock, jid, null, unboxMessage, {
    title: '📦 HASIL UNBOXING LELANG',
    buttons: [
      { type: 'reply', text: '📦 Buka Lelang Baru', id: '.lelang' },
      { type: 'reply', text: '👤 Cek Profil & Poin', id: '.poin' },
      { type: 'reply', text: '🎮 Menu Hiburan', id: '.menu hiburan' }
    ],
    mentions: [currentHighestBidder]
  });
}

/**
 * Cek Info Sesi Lelang Aktif
 */
async function showAuctionInfo(sock, jid, messageObj) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang yang sedang aktif di grup ini.\nKetik *.lelang* untuk membuka lelang kotak misteri baru!");
    return true;
  }

  const sisaDetik = Math.max(1, Math.ceil((session.endTime - Date.now()) / 1000));
  const highestBidderText = session.currentHighestBidder 
    ? `@${session.currentHighestBidder.split('@')[0]} (*${session.currentHighestBid.toLocaleString('id-ID')} Poin*)` 
    : `_Belum ada penawar (Open Bid: ${session.box.openBid} Poin)_`;

  const minNextBid = session.currentHighestBidder 
    ? session.currentHighestBid + session.box.minInc 
    : session.box.openBid;

  const infoMsg = 
`📦 *STATUS LELANG KOTAK MISTERI AKTIF* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 *Kotak:* ${session.box.emoji} *${session.box.name}*
📝 *Deskripsi:* _${session.box.desc}_
👤 *Host:* ${session.hostName}

💰 *Tawaran Tertinggi:* ${highestBidderText}
📈 *Tawaran Minimal Berikutnya:* *${minNextBid.toLocaleString('id-ID')} Poin*
⏳ *Sisa Waktu:* *${sisaDetik} detik* (Anti-snip: ${session.snipCount}/${MAX_SNIP_EXTENSIONS})

👉 Ketik \`.bid ${minNextBid}\` atau \`.bidup\` untuk memasang tawaran!`;

  await send(sock, jid, messageObj, infoMsg, {
    title: '📊 STATUS LELANG',
    buttons: [
      { type: 'reply', text: `🔥 Tawar ${minNextBid} Poin`, id: `.bid ${minNextBid}` },
      { type: 'reply', text: '📈 Bid Naik (+min)', id: '.bidup' }
    ],
    mentions: session.currentHighestBidder ? [session.currentHighestBidder] : []
  });

  return true;
}

/**
 * Membatalkan Sesi Lelang Aktif
 */
async function cancelAuction(sock, jid, senderNumber, messageObj, isAdmin, isOwner) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang aktif di grup ini untuk dibatalkan.");
    return true;
  }

  // Hanya Host lelang atau Admin/Owner grup yang boleh membatalkan
  const isHost = session.hostJid === senderNumber;
  if (!isHost && !isAdmin && !isOwner) {
    await send(sock, jid, messageObj, "⚠️ Hanya Host yang membuka lelang atau Admin grup yang dapat membatalkan lelang ini!");
    return true;
  }

  if (session.timer) clearTimeout(session.timer);
  activeAuctions.delete(jid);

  await send(sock, jid, messageObj, `🛑 *LELANG DIBATALKAN!* Sesi lelang ${session.box.emoji} *${session.box.name}* telah dibatalkan oleh @${senderNumber.split('@')[0]}.`, {
    mentions: [senderNumber]
  });

  return true;
}

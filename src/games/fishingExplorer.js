/**
 * 🎣 FISHING & RELIC EXPLORER (MANCING & HARTA KARUN)
 * Game Santai, Koleksi Ikan & Perburuan Peti Harta Karun
 *
 * Fitur:
 * - .mancing [danau/laut/palung] ➔ Lempar kail & tangkap ikan/relic (Cooldown 15s)
 * - .ikan / .tangkapan ➔ Lihat isi ember tangkapan (Maks. 20 ikan)
 * - .jualikan ➔ Jual ikan ke Pasar Ikan untuk poin
 * - .bukapeti ➔ Buka peti karun misterius dari dasar laut
 * - .topmancing / .rankmancing ➔ Papan rekor ikan terberat
 * - .tokopancing ➔ Toko umpan & panduan spot
 */

import * as db from '../../database.js';
import { send } from './helpers.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export const activeFishers = new Map(); // normalizedJid -> cooldownTimestamp

const COOLDOWN_MS = 15_000;
const MAX_BASKET_CAPACITY = 20;

const SPOTS = {
  danau: {
    key: 'danau',
    name: 'Danau Tenang',
    icon: '🏞️',
    cost: 0,
    minWeight: 0.5,
    maxWeight: 8.0,
    aliases: ['danau', 'lake', 'freshwater', 'kolam', 'airtawar'],
    fishPool: [
      { name: 'Ikan Lele', icon: '🐟', rarity: 'Common', baseVal: 15, weightBonus: 2 },
      { name: 'Ikan Nila', icon: '🐟', rarity: 'Common', baseVal: 20, weightBonus: 3 },
      { name: 'Ikan Gurame', icon: '🐠', rarity: 'Uncommon', baseVal: 35, weightBonus: 5 },
      { name: 'Ikan Bawal', icon: '🐠', rarity: 'Uncommon', baseVal: 45, weightBonus: 6 },
      { name: 'Ikan Arwana Silver', icon: '✨', rarity: 'Rare', baseVal: 120, weightBonus: 15 },
      { name: 'Sepatu Butut', icon: '👞', rarity: 'Trash', baseVal: 1, weightBonus: 0 },
      { name: 'Botol Plastik Bekas', icon: '🧴', rarity: 'Trash', baseVal: 1, weightBonus: 0 }
    ]
  },
  laut: {
    key: 'laut',
    name: 'Laut Dalam',
    icon: '🌊',
    cost: 20,
    minWeight: 2.0,
    maxWeight: 35.0,
    aliases: ['laut', 'lautan', 'ocean', 'sea', 'pantai'],
    fishPool: [
      { name: 'Ikan Tongkol', icon: '🐟', rarity: 'Common', baseVal: 30, weightBonus: 3 },
      { name: 'Kakap Merah', icon: '🐠', rarity: 'Uncommon', baseVal: 60, weightBonus: 6 },
      { name: 'Ikan Salmon', icon: '🍣', rarity: 'Uncommon', baseVal: 75, weightBonus: 8 },
      { name: 'Cumi-Cumi Raksasa', icon: '🦑', rarity: 'Rare', baseVal: 150, weightBonus: 12 },
      { name: 'Ikan Pari Karang', icon: '🐡', rarity: 'Rare', baseVal: 180, weightBonus: 14 },
      { name: 'Ikan Tuna Sirip Biru', icon: '🦈', rarity: 'Epic', baseVal: 350, weightBonus: 25 },
      { name: 'Peti Kayu Bajak Laut', icon: '📦', rarity: 'Treasure', baseVal: 250, weightBonus: 0 }
    ]
  },
  palung: {
    key: 'palung',
    name: 'Palung Atlantis',
    icon: '🌋',
    cost: 50,
    minWeight: 5.0,
    maxWeight: 150.0,
    aliases: ['palung', 'atlantis', 'abyss', 'deep', 'palunglaut'],
    fishPool: [
      { name: 'Ikan Oarfish Legenda', icon: '🐉', rarity: 'Rare', baseVal: 200, weightBonus: 15 },
      { name: 'Coelacanth Purba', icon: '🦖', rarity: 'Epic', baseVal: 450, weightBonus: 30 },
      { name: 'Hiu Martil Megalodon', icon: '🦈', rarity: 'Legendary', baseVal: 850, weightBonus: 50 },
      { name: 'Monster Kraken Gurita', icon: '🐙', rarity: 'Legendary', baseVal: 1200, weightBonus: 70 },
      { name: 'Putri Duyung Atlantis', icon: '🧜‍♀️', rarity: 'Mythic', baseVal: 2500, weightBonus: 100 },
      { name: 'Peti Emas Karun Atlantis', icon: '👑', rarity: 'Treasure', baseVal: 1000, weightBonus: 0 }
    ]
  }
};

function tag(jid) {
  return `@${String(jid || '').split('@')[0]}`;
}

function resolveUserJid(senderNumber) {
  try {
    return jidNormalizedUser(senderNumber);
  } catch (_) {
    return String(senderNumber || '');
  }
}

/**
 * Handler Utama Fishing & Relic Explorer
 */
export async function handleFishingCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  const normUser = resolveUserJid(senderNumber);

  if (['mancing', 'fish', 'fishing', 'joran', 'strike'].includes(command)) {
    const spotKey = (args[1] || 'danau').toLowerCase();
    return await goFishing(sock, jid, normUser, messageObj, spotKey);
  }

  if (['ikan', 'tangkapan', 'ember', 'keranjang', 'fishbasket'].includes(command)) {
    return await showFishBasket(sock, jid, normUser, messageObj);
  }

  if (['jualikan', 'sellfish', 'pasarikan'].includes(command)) {
    return await sellFishBasket(sock, jid, normUser, messageObj);
  }

  if (['bukapeti', 'chest', 'openbox', 'peti'].includes(command)) {
    return await openTreasureChest(sock, jid, normUser, messageObj);
  }

  if (['tokopancing', 'tokoumpan', 'alatpancing', 'infomancing'].includes(command)) {
    return await showFishingShop(sock, jid, normUser, messageObj);
  }

  if (['topmancing', 'rankmancing', 'leaderboardmancing', 'lbmancing'].includes(command)) {
    return await showFishingLeaderboard(sock, jid, normUser, messageObj);
  }

  return false;
}

/**
 * 1. Lempar Kail & Mancing Ikan (.mancing [spot])
 */
async function goFishing(sock, jid, userJid, messageObj, spotInput) {
  // 1. Cek Cooldown Mancing (15 Detik Anti-Spam)
  const now = Date.now();
  const nextAllowed = activeFishers.get(userJid) || 0;
  if (now < nextAllowed) {
    const sisaDetik = Math.ceil((nextAllowed - now) / 1000);
    await send(sock, jid, messageObj, `⏳ *Santai dulu!* Kailmu baru saja ditarik. Tunggu *${sisaDetik} detik* lagi sebelum melempar kail kembali!`);
    return true;
  }

  // 2. Validasi Spot Mancing
  let targetSpot = null;
  for (const s of Object.values(SPOTS)) {
    if (s.aliases.includes(spotInput)) {
      targetSpot = s;
      break;
    }
  }

  if (!targetSpot) {
    const spotList = Object.values(SPOTS).map(s => `  • \`.mancing ${s.key}\` — *${s.name}* (${s.cost > 0 ? `${s.cost} Poin` : 'Gratis'})`).join('\n');
    await send(sock, jid, messageObj, `❌ *Spot pancing tidak dikenal!* Pilihan spot yang tersedia:\n${spotList}`);
    return true;
  }

  // 3. Cek Kapasitas Ember (Maksimal 20 Ikan)
  const currentBasket = await db.getFishingBasket(userJid);
  if (currentBasket.length >= MAX_BASKET_CAPACITY) {
    await send(sock, jid, messageObj, `🧺 *Ember pancingmu sudah penuh (${currentBasket.length}/${MAX_BASKET_CAPACITY} ikan)!*\nJual hasil tangkapanmu dengan mengetik \`.jualikan\` ke Pasar Ikan.`);
    return true;
  }

  // 4. Cek & Potong Biaya Umpan Spot (Jika bukan gratis)
  if (targetSpot.cost > 0) {
    const prof = await db.getGameProfile(userJid);
    const userPts = Number(prof?.points) || 0;
    if (userPts < targetSpot.cost) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk menyewa kapal & umpan di *${targetSpot.name}*! Dibutuhkan *${targetSpot.cost} Poin* (Poinmu: ${userPts}).`);
      return true;
    }
    const deduct = await db.deductGamePoints(userJid, targetSpot.cost);
    if (!deduct?.success) {
      await send(sock, jid, messageObj, `❌ Gagal memproses pemotongan poin umpan.`);
      return true;
    }
  }

  // Pasang Cooldown 15 Detik
  activeFishers.set(userJid, now + COOLDOWN_MS);

  // 5. Undi Ikan / Barang dari Pool
  const pool = targetSpot.fishPool;
  const caughtFish = pool[Math.floor(Math.random() * pool.length)];

  // Hitung bobot acak (Kg) & Harga Jual Pasar
  const rawWeight = Math.random() * (targetSpot.maxWeight - targetSpot.minWeight) + targetSpot.minWeight;
  const weight = parseFloat(rawWeight.toFixed(2));
  const rawPrice = caughtFish.rarity === 'Trash' ? 1 : Math.floor(caughtFish.baseVal + (weight * caughtFish.weightBonus));
  const totalPrice = Math.max(1, Math.floor(Number(rawPrice) || 1));

  const itemRecord = {
    name: caughtFish.name,
    icon: caughtFish.icon,
    rarity: caughtFish.rarity,
    weight,
    price: totalPrice,
    spotName: targetSpot.name,
    isChest: caughtFish.rarity === 'Treasure'
  };

  // Simpan permanen ke SQLite Database
  await db.addFishToBasket(userJid, itemRecord);

  // Update statistik pemancing (Total tangkapan & rekor terberat)
  const statsRes = await db.updateFishingStats(userJid, {
    fishName: caughtFish.name,
    weight,
    earned: 0,
    isChest: itemRecord.isChest
  });

  let rarityBadge = '⚪ [Biasa]';
  if (caughtFish.rarity === 'Uncommon') rarityBadge = '🟢 [Bagus]';
  if (caughtFish.rarity === 'Rare') rarityBadge = '🔵 [Langka]';
  if (caughtFish.rarity === 'Epic') rarityBadge = '🟣 [Epik]';
  if (caughtFish.rarity === 'Legendary') rarityBadge = '🟡 [Legendaris]';
  if (caughtFish.rarity === 'Mythic') rarityBadge = '👑 [MITOLOGI KUNO]';
  if (caughtFish.rarity === 'Treasure') rarityBadge = '✨ [PETI HARTA KARUN]';

  const newRecordAlert = statsRes?.isNewRecord ? `\n🏆 *REKOR PRIBADI BARU!* Ikan terberat yang pernah kamu tangkap!` : '';

  const strikeMsg =
`🎣 ─── *STRIKE! TANGKAPAN BERHASIL!* ─── 🎣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 *Spot Mancing:* ${targetSpot.icon} *${targetSpot.name}*
👤 *Pemancing:* ${tag(userJid)}

${caughtFish.icon} *${caughtFish.name}*
⭐ *Tingkat Kelangkaan:* ${rarityBadge}
⚖️ *Bobot Tangkapan:* *${weight} Kg*
💰 *Taksiran Harga Pasar:* *${totalPrice} Poin*${newRecordAlert}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${itemRecord.isChest ? '🎁 *PETI HARTA KARUN DITEMUKAN!* Ketik `.bukapeti` untuk membuka jackpot!' : `📥 Ikan disimpan ke ember (${currentBasket.length + 1}/${MAX_BASKET_CAPACITY})! Ketik \`.ikan\` atau \`.jualikan\`.`}`;

  await send(sock, jid, messageObj, strikeMsg, { mentions: [userJid] });
  return true;
}

/**
 * 2. Cek Isi Ember Ikan (.ikan / .tangkapan)
 */
async function showFishBasket(sock, jid, userJid, messageObj) {
  const basket = await db.getFishingBasket(userJid);
  if (!basket || basket.length === 0) {
    await send(sock, jid, messageObj, `🎣 Ember pancingmu masih kosong, ${tag(userJid)}!\nKetik \`.mancing\` di Danau, Laut, atau Palung untuk mulai menangkap ikan.`);
    return true;
  }

  let totalValue = 0;
  const listStr = basket.map((item, i) => {
    const itemPrice = Math.floor(Number(item.price)) || 0;
    totalValue += itemPrice;
    return `  ${i + 1}. ${item.icon} *${item.fish_name || item.name}* (${item.weight} Kg) ➔ *${itemPrice} Poin*`;
  }).join('\n');

  const hasChest = basket.some(b => Number(b.is_chest) === 1);

  const msg =
`🐟 ─── *EMBER HASIL TANGKAPAN IKAN* ─── 🐟
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Pemilik:* ${tag(userJid)}
📦 *Jumlah Tangkapan:* ${basket.length}/${MAX_BASKET_CAPACITY} Ekor / Barang
💰 *Total Nilai Pasar:* *${totalValue} Poin*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${listStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 Ketik \`.jualikan\` untuk menjual seluruh tangkapanmu ke Pasar Ikan!
${hasChest ? '👉 Ada Peti Harta Karun di embermu! Ketik `.bukapeti` untuk membuka jackpot!' : ''}`;

  await send(sock, jid, messageObj, msg, { mentions: [userJid] });
  return true;
}

/**
 * 3. Jual Ikan ke Pasar Ikan (.jualikan)
 */
async function sellFishBasket(sock, jid, userJid, messageObj) {
  const basket = await db.getFishingBasket(userJid);
  if (!basket || basket.length === 0) {
    await send(sock, jid, messageObj, `❌ Kamu tidak memiliki ikan di ember untuk dijual! Ketik \`.mancing\` terlebih dahulu.`);
    return true;
  }

  // Pisahkan peti karun (hanya jual ikan biasa)
  const fishToSell = basket.filter(item => Number(item.is_chest) !== 1);

  if (fishToSell.length === 0) {
    await send(sock, jid, messageObj, `⚠️ Di embermu hanya tersisa Peti Harta Karun! Buka dengan perintah \`.bukapeti\`.`);
    return true;
  }

  let totalEarned = 0;
  for (const f of fishToSell) {
    totalEarned += Math.max(0, Math.floor(Number(f.price) || 0));
  }

  // Hapus ikan dari DB
  await db.clearFishFromBasket(userJid);

  // Tambah poin ke saldo pemain & update total earned
  await db.addGamePoints(userJid, totalEarned);
  await db.updateFishingStats(userJid, { earned: totalEarned });

  const receiptMsg =
`💰 ─── *NOTA PENJUALAN PASAR IKAN* ─── 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Penjual:* ${tag(userJid)}
🐟 *Jumlah Ikan Terjual:* ${fishToSell.length} Ekor
💵 *Uang Hasil Tangkapan:* *+${totalEarned} Poin*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Poin hasil penjualan ikan telah langsung ditransfer ke rekeningmu!
Ketik \`.mancing\` untuk berburu ikan lagi! 🎣🌊`;

  await send(sock, jid, messageObj, receiptMsg, { mentions: [userJid] });
  return true;
}

/**
 * 4. Buka Peti Harta Karun (.bukapeti)
 */
async function openTreasureChest(sock, jid, userJid, messageObj) {
  const chest = await db.removeChestFromBasket(userJid);

  if (!chest) {
    await send(sock, jid, messageObj, `❌ Kamu tidak memiliki Peti Harta Karun di embermu! Mancinglah di Laut atau Palung untuk menemukannya.`);
    return true;
  }

  // Hadiah Jackpot Peti
  const chestName = chest.fish_name || chest.name || 'Peti Karun';
  const isGoldChest = chestName.includes('Emas') || chestName.includes('Atlantis');
  const jackpotPoints = isGoldChest ? Math.floor(Math.random() * 1500) + 1000 : Math.floor(Math.random() * 500) + 250;

  await db.addGamePoints(userJid, jackpotPoints);
  await db.updateFishingStats(userJid, { isChest: true, earned: jackpotPoints });

  const chestMsg =
`👑✨ *JACKPOT! PETI HARTA KARUN TERBUKA!* ✨👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Penemu Harta:* ${tag(userJid)}
📦 *Peti Dibuka:* ${chest.icon || '📦'} *${chestName}*

Di dalam peti kuno berkarat tersebut, tersimpan tumpukan koin emas murni!
💰 *Hadiah Harta Karun:* *+${jackpotPoints} Poin*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Poin jackpot telah langsung ditambahkan ke saldo akunmu! 🎉`;

  await send(sock, jid, messageObj, chestMsg, { mentions: [userJid] });
  return true;
}

/**
 * 5. Toko & Info Spot Mancing (.tokopancing)
 */
async function showFishingShop(sock, jid, userJid, messageObj) {
  const shopMsg =
`🎣 ─── *PANDUAN & TOKO MANCING NUSANTARA* ─── 🎣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏞️ *1. Danau Tenang* (\`.mancing danau\`)
   • Biaya Sewa: *GRATIS (0 Poin)*
   • Ikan: Lele, Nila, Gurame, Bawal, Arwana Silver

🌊 *2. Laut Dalam* (\`.mancing laut\`)
   • Biaya Sewa Kapal & Umpan: *20 Poin*
   • Ikan: Tongkol, Kakap, Cumi Raksasa, Tuna Sirip Biru, Peti Kayu

🌋 *3. Palung Atlantis* (\`.mancing palung\`)
   • Biaya Sewa Kapal & Umpan Emas: *50 Poin*
   • Ikan Mitos: Coelacanth, Hiu Megalodon, Kraken, Putri Duyung, Peti Emas Karun
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Perintah Pemancing:*
• \`.mancing [spot]\` ➔ Lempar kail (Cooldown 15 detik)
• \`.ikan\` ➔ Cek ember hasil tangkapan (Maks. 20)
• \`.jualikan\` ➔ Jual ikan ke Pasar Ikan
• \`.bukapeti\` ➔ Buka Peti Harta Karun
• \`.topmancing\` ➔ Papan rekor pemancing terbaik`;

  await send(sock, jid, messageObj, shopMsg);
  return true;
}

/**
 * 6. Papan Rekor Pemancing (.topmancing)
 */
async function showFishingLeaderboard(sock, jid, userJid, messageObj) {
  const topList = await db.getFishingLeaderboard();
  if (!topList || topList.length === 0) {
    await send(sock, jid, messageObj, `🎣 Belum ada rekor pemancing yang tercatat! Jadilah yang pertama dengan mengetik \`.mancing\`.`);
    return true;
  }

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const rows = topList.map((row, i) => {
    const m = medals[i] || `${i + 1}.`;
    return `${m} ${tag(row.user_jid)}
   ⚖️ Terberat: *${row.heaviest_weight} Kg* (${row.heaviest_fish || 'Ikan'}) | 🎣 Total: *${row.total_caught} Ekor*`;
  }).join('\n');

  const mentions = topList.map(r => r.user_jid);

  const msg =
`🏆 ─── *PAPAN REKOR MASTER PEMANCING* ─── 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rows}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ketik \`.mancing\` untuk memecahkan rekor tangkapan terbesar! 🎣🌊`;

  await send(sock, jid, messageObj, msg, { mentions });
  return true;
}

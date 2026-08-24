import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeGroupHeists = new Map();
export const activeBankHeists = activeGroupHeists;
export const activeHeistMiniGames = new Map();
const bankCooldowns = new Map(); // key: `${jid}_${bankId}` -> timestamp ms

export const BANK_TARGETS = [
  {
    id: 1,
    name: '🏪 ATM Minimarket / Koperasi Lokal',
    shortName: 'ATM Minimarket',
    difficulty: '⭐ Mudah (Easy)',
    modal: 35,
    minCrew: 2,
    maxCrew: 4,
    baseWinRate: 0.60,
    winRatePerCrew: 0.05,
    maxWinRate: 0.80,
    baseLoot: 150,
    lootPerCrew: 60,
    lootRandom: 80,
    baseXp: 35,
    dendaFlat: 35,
    dendaPercent: 0.10,
    jailMinutes: 10,
    cooldownMs: 10 * 60 * 1000 // 10 Menit
  },
  {
    id: 2,
    name: '🏦 Bank Akbar Cabang Kota',
    shortName: 'Bank Cabang Kota',
    difficulty: '⭐⭐ Sedang (Medium)',
    modal: 80,
    minCrew: 2,
    maxCrew: 5,
    baseWinRate: 0.45,
    winRatePerCrew: 0.05,
    maxWinRate: 0.65,
    baseLoot: 450,
    lootPerCrew: 150,
    lootRandom: 200,
    baseXp: 60,
    dendaFlat: 80,
    dendaPercent: 0.20,
    jailMinutes: 20,
    cooldownMs: 20 * 60 * 1000 // 20 Menit
  },
  {
    id: 3,
    name: '🏛️ Gedung Bank Sentral Akbar',
    shortName: 'Bank Sentral',
    difficulty: '⭐⭐⭐ Sulit (Hard)',
    modal: 160,
    minCrew: 3,
    maxCrew: 6,
    baseWinRate: 0.30,
    winRatePerCrew: 0.04,
    maxWinRate: 0.50,
    baseLoot: 1000,
    lootPerCrew: 300,
    lootRandom: 500,
    baseXp: 100,
    dendaFlat: 180,
    dendaPercent: 0.30,
    jailMinutes: 35,
    cooldownMs: 35 * 60 * 1000 // 35 Menit
  },
  {
    id: 4,
    name: '💎 Brankas Bawah Tanah Royal Vault',
    shortName: 'Royal Vault (Ekstrem)',
    difficulty: '💀💀💀 EKSTREM (Master Heist)',
    modal: 300,
    minCrew: 3,
    maxCrew: 6,
    baseWinRate: 0.20,
    winRatePerCrew: 0.04,
    maxWinRate: 0.40,
    baseLoot: 2500,
    lootPerCrew: 600,
    lootRandom: 1200,
    baseXp: 180,
    dendaFlat: 350,
    dendaPercent: 0.40,
    jailMinutes: 50,
    cooldownMs: 60 * 60 * 1000 // 60 Menit (1 Jam)
  }
];

// ─── 5. RAMPOK BANK AKBAR (MULTI-TIER GROUP HEIST) ───────────────────────
async function handleBankHeist(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Misi Rampok Bank Akbar hanya bisa dimainkan secara tim di dalam grup!");
    return true;
  }

  const rawArg1 = (args[1] || '').toLowerCase();

  if (['join', 'ikut'].includes(rawArg1) || command === 'joinheist') {
    return await joinBankHeist(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'startgame'].includes(rawArg1) || command === 'startheist') {
    return await startBankHeistExecution(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(rawArg1)) {
    const session = activeGroupHeists.get(jid);
    if (!session) {
      await send(sock, jid, messageObj, "❌ Tidak ada lobi Rampok Bank aktif di grup ini.");
      return true;
    }
    if (session.host !== senderNumber) {
      await send(sock, jid, messageObj, "❌ Hanya ketua tim yang dapat membatalkan misi!");
      return true;
    }
    if (session.timeout) clearTimeout(session.timeout);
    activeGroupHeists.delete(jid);
    await send(sock, jid, messageObj, "🛑 Operasi Rampok Bank berhasil dibatalkan.");
    return true;
  }

  // Jika sedang ada lobi aktif di grup
  if (activeGroupHeists.has(jid)) {
    const h = activeGroupHeists.get(jid);
    await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Rampok *${h.target.shortName}* aktif di grup ini!\nAnggota Kru (${h.crew.length}/${h.target.maxCrew}): ${h.crewLabels.join(', ')}\n\nKetik \`.joinheist\` untuk bergabung atau \`.startheist\` untuk memulai!`);
    return true;
  }

  // Cek apakah user memilih nomor bank: .heist 1, .heist 2, dst.
  const chosenBankId = parseInt(rawArg1, 10);
  const targetBank = BANK_TARGETS.find(b => b.id === chosenBankId);

  // Jika tidak memilih nomor bank atau salah -> Tampilkan DAFTAR BANK & STATUS COOLDOWN
  if (!targetBank) {
    const now = Date.now();
    let listText = 
`🏦 *DAFTAR TARGET PEMBOBOLAN BANK AKBAR* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pilih sasaran bank yang ingin dibobol bersama kru tongkronganmu! Tiap bank memiliki tingkat keamanan, modal, cooldown, dan jarahan berbeda.

`;

    for (const b of BANK_TARGETS) {
      const lastHeist = bankCooldowns.get(`${jid}_${b.id}`) || 0;
      const isCooldown = (now - lastHeist) < b.cooldownMs;
      const sisaMnt = isCooldown ? Math.ceil((b.cooldownMs - (now - lastHeist)) / (60 * 1000)) : 0;
      const statusStr = isCooldown ? `⏳ *Polisi Siaga* (Sisa ${sisaMnt} mnt)` : `🟢 *SIAP DIRAMPOK*`;

      const minLootEst = b.baseLoot + (b.minCrew * b.lootPerCrew);
      const maxLootEst = b.baseLoot + (b.maxCrew * b.lootPerCrew) + b.lootRandom;

      listText += 
`${b.id}. ${b.name}
   • 📊 *Tingkat Kesulitan:* ${b.difficulty}
   • 💰 *Modal Jaminan:* *${b.modal} Poin* / orang (Min ${b.minCrew} - Max ${b.maxCrew} Kru)
   • 🎁 *Estimasi Jarahan:* *${minLootEst.toLocaleString('id-ID')} - ${maxLootEst.toLocaleString('id-ID')} Poin*
   • ⏱️ *Status Bank:* ${statusStr}
   👉 *Buka Misi:* Ketik \`.heist ${b.id}\`\n\n`;
    }

    listText += `💡 *Cara Main:* Ketik \`.heist [1-4]\` untuk membuka lobi bank pilihanmu!\n_Contoh:_ \`.heist 2\``;

    await send(sock, jid, messageObj, listText);
    return true;
  }

  // Cek Cooldown untuk Bank Terpilih
  const lastHeistTime = bankCooldowns.get(`${jid}_${targetBank.id}`) || 0;
  const now = Date.now();
  if (now - lastHeistTime < targetBank.cooldownMs) {
    const sisaMnt = Math.ceil((targetBank.cooldownMs - (now - lastHeistTime)) / (60 * 1000));
    await send(sock, jid, messageObj, `⏳ *ALARM ${targetBank.shortName.toUpperCase()} MASIH SIAGA KETAT!* Pasukan kepolisian masih berpatroli di area sekitar bank. Harap tunggu *${sisaMnt} menit lagi* atau pilih bank target lain yang sedang hijau!`);
    return true;
  }

  // Cek Poin Host
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < targetBank.modal) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${targetBank.modal} Poin* sebagai modal jaminan denda jika tertangkap di ${targetBank.shortName}.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  const heistSession = {
    jid,
    host: senderNumber,
    target: targetBank,
    crew: [senderNumber],
    crewLabels: [hostLabel],
    timeout: null
  };

  heistSession.timeout = setTimeout(async () => {
    if (!activeGroupHeists.has(jid)) return;
    activeGroupHeists.delete(jid);
    await send(sock, jid, messageObj, `⌛ *LOBI RAMPOK BANK KEDALUWARSA!* Misi ${targetBank.shortName} dibatalkan karena tidak dimulai dalam 90 detik.`);
  }, 90 * 1000);

  activeGroupHeists.set(jid, heistSession);

  const lobbyMsg = 
`🏦 *OPERASI PEMBOBOLAN: ${targetBank.shortName.toUpperCase()}* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 *Ketua Tim:* ${hostLabel}
🎯 *Sasaran:* ${targetBank.name} (${targetBank.difficulty})
👥 *Anggota Kru (1/${targetBank.maxCrew}):* ${hostLabel}
💰 *Modal Wajib:* *${targetBank.modal} Poin* / orang
👥 *Kebutuhan Kru:* Minimal *${targetBank.minCrew} Orang* (Maksimal ${targetBank.maxCrew} Orang)

📌 *Cara Bergabung Kru:*
Ketik: \`.joinheist\` atau \`.heist join\`

⚠️ *Peringatan Resiko:*
Jika berhasil, jarahan brankas dibagi rata! Jika gagal disergap polisi, seluruh kru **didenda & dipenjara ${targetBank.jailMinutes} menit**!

⏰ Lobi dibuka selama 90 detik (Ketua bisa ketik \`.startheist\` jika sudah siap).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

async function joinBankHeist(sock, jid, senderNumber, messageObj) {
  const session = activeGroupHeists.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Rampok Bank aktif. Ketik `.heist` untuk melihat daftar sasaran bank!");
    return true;
  }

  if (session.crew.includes(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah bergabung di dalam tim ini!");
    return true;
  }

  if (session.crew.length >= session.target.maxCrew) {
    await send(sock, jid, messageObj, `❌ Kru sudah penuh (Maksimal ${session.target.maxCrew} anggota untuk ${session.target.shortName})!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.target.modal) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${session.target.modal} Poin* untuk bergabung membobol ${session.target.shortName}.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  session.crew.push(senderNumber);
  session.crewLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil bergabung ke regu Rampok *${session.target.shortName}*!\n👥 Total Kru (${session.crew.length}/${session.target.maxCrew}): ${session.crewLabels.join(', ')}\n\nKetik \`.startheist\` jika ingin langsung memulai misi!`, { mentions: session.crew });
  return true;
}

async function startBankHeistExecution(sock, jid, senderNumber, messageObj) {
  const session = activeGroupHeists.get(jid);
  if (!session) return false;

  if (session.crew.length < session.target.minCrew) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${session.target.minCrew} anggota kru* untuk memulai misi pembobolan ${session.target.shortName}! (Saat ini: ${session.crew.length} orang).`);
    return true;
  }

  if (senderNumber !== session.host && !session.crew.includes(senderNumber)) {
    await send(sock, jid, messageObj, "❌ Hanya anggota regu perampok yang dapat mengonfirmasi penyerbuan!");
    return true;
  }

  if (session.timeout) clearTimeout(session.timeout);
  activeGroupHeists.delete(jid);

  const target = session.target;
  // Catat Cooldown khusus untuk bank yang baru saja diserbu
  bankCooldowns.set(`${jid}_${target.id}`, Date.now());

  const crewCount = session.crew.length;
  // Kalkulasi winrate spesifik tier bank
  const successChance = Math.min(target.maxWinRate, target.baseWinRate + (crewCount * target.winRatePerCrew));
  const isSuccess = Math.random() < successChance;

  await send(sock, jid, messageObj, `🚨 *OPERASI PENYERBUAN ${target.shortName.toUpperCase()} DIMULAI!* 🏦\nKru (${crewCount} orang): ${session.crewLabels.join(', ')}\n\n🔧 Menyusup melewati sistem pengaman ${target.difficulty}...\n🚗 Sopir pelarian bersiap di pintu belakang...`, { mentions: session.crew });

  await new Promise(r => setTimeout(r, 3500));

  if (isSuccess) {
    // Kalkulasi jarahan spesifik tier bank
    const totalLoot = target.baseLoot + (crewCount * target.lootPerCrew) + Math.floor(Math.random() * target.lootRandom);
    const lootPerCrew = Math.floor(totalLoot / crewCount);

    for (const member of session.crew) {
      await db.addGamePoints(member, lootPerCrew);
      await db.addMessageXp(member, target.baseXp);
    }

    const winMsg = 
`💰 *BRANKAS ${target.shortName.toUpperCase()} BERHASIL DIBOBOL!* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 *HASIL MISI SUKSES BESAR!*
🎯 Sasaran: *${target.name}*
💰 Total Jarahan: *+${totalLoot.toLocaleString('id-ID')} Poin*
🎁 Diterima Tiap Kru: *+${lootPerCrew.toLocaleString('id-ID')} Poin* & *+${target.baseXp} XP*!

👥 *Daftar Kru Berjaya:*
${session.crewLabels.map((lbl, i) => `${i + 1}. ${lbl}`).join('\n')}

🚗 Seluruh kru berhasil meloloskan diri dengan selamat membawa seluruh jarahan!`;

    await send(sock, jid, messageObj, winMsg, { mentions: session.crew });
    return true;
  } else {
    let failList = [];
    for (const member of session.crew) {
      const p = await db.getGameProfile(member);
      const denda = Math.max(target.dendaFlat, Math.floor(((p?.points || 0) * target.dendaPercent)));
      await db.deductGamePoints(member, denda);
      await db.setGameJail(member, target.jailMinutes);
      failList.push(`▫️ @${member.split('@')[0]} (Denda -${denda.toLocaleString('id-ID')} Poin & Penjara ${target.jailMinutes} mnt)`);
    }

    const failMsg = 
`🚨 *SIRENE ALARM BERBUNYI — DISERGAP PASUKAN POLISI!* 🚔
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aksi penyusupan terdeteksi sensor ${target.name}! Pasukan elit SWAT mengepung gedung dan menangkap seluruh kru di tempat!

⚖️ *Vonis Hukuman Pengadilan:*
${failList.join('\n')}

🔒 Seluruh kru berstatus **DITAHAN DI PENJARA** selama ${target.jailMinutes} menit (tidak bisa bermain game/transaksi hingga masa tahanan selesai).`;

    await send(sock, jid, messageObj, failMsg, { mentions: session.crew });
    return true;
  }
}

export { handleBankHeist };
import * as db from '../../database.js';
import { send, generateStealChallenge } from './helpers.js';

export const activeGroupHeists = new Map();
export const activeBankHeists = activeGroupHeists;
export const activeHeistMiniGames = new Map();
const heistCooldowns = new Map(); // JID / user -> timestamp
const HEIST_COOLDOWN_MS = 20 * 60 * 1000; // 20 Menit Cooldown

// ─── 5. RAMPOK BANK AKBAR (GROUP HEIST) ───────────────────────
async function handleBankHeist(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Misi Rampok Bank Akbar hanya bisa dimainkan secara tim di dalam grup!");
    return true;
  }

  if (['heist', 'rampokbank'].includes(command)) {
    if (args[1] === 'join' || command === 'joinheist') {
      return await joinBankHeist(sock, jid, senderNumber, messageObj);
    }
    if (args[1] === 'start' || command === 'startheist') {
      return await startBankHeistExecution(sock, jid, senderNumber, messageObj);
    }

    if (activeGroupHeists.has(jid)) {
      const h = activeGroupHeists.get(jid);
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Rampok Bank aktif di grup ini!\nAnggota Kru (${h.crew.length}/6): ${h.crewLabels.join(', ')}\n\nKetik \`.joinheist\` untuk bergabung atau \`.startheist\` untuk memulai!`);
      return true;
    }

    // Cek Cooldown Grup
    const lastHeist = heistCooldowns.get(jid) || 0;
    const now = Date.now();
    if (now - lastHeist < HEIST_COOLDOWN_MS) {
      const sisaMnt = Math.ceil((HEIST_COOLDOWN_MS - (now - lastHeist)) / (60 * 1000));
      await send(sock, jid, messageObj, `⏳ *ALARM BANK MASIH SIAGA KETAT!* Keamanan bank sedang diperketat oleh kepolisian. Harap tunggu *${sisaMnt} menit lagi* sebelum mencoba merampok kembali.`);
      return true;
    }

    const modal = 100;
    const prof = await db.getGameProfile(senderNumber);
    if ((prof?.points || 0) < modal) {
      await send(sock, jid, messageObj, `❌ Modal kamu kurang! Butuh minimal *${modal} Poin* sebagai modal jaminan denda jika tertangkap.`);
      return true;
    }

    const cust = await db.getCustomerByPhone(senderNumber);
    const hostLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

    const heistSession = {
      jid,
      host: senderNumber,
      modal,
      crew: [senderNumber],
      crewLabels: [hostLabel],
      timeout: null
    };

    heistSession.timeout = setTimeout(async () => {
      if (!activeGroupHeists.has(jid)) return;
      activeGroupHeists.delete(jid);
      await send(sock, jid, messageObj, `⌛ *LOBI RAMPOK BANK KEDALUWARSA!* Misi dibatalkan karena tidak dimulai dalam 90 detik.`);
    }, 90 * 1000);

    activeGroupHeists.set(jid, heistSession);

    const lobbyMsg = 
`🏦 *OPERASI PEMBOBOLAN BANK AKBAR (GROUP HEIST)* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 Ketua Tim: ${hostLabel}
👥 Anggota Kru (1/6): ${hostLabel}
💰 Modal Wajib: *${modal} Poin* / orang

📌 *Cara Bergabung Kru:*
Ketik: \`.joinheist\` atau \`.rampokbank join\`

⚠️ *Peringatan:*
Misi butuh minimal *2 anggota*. Jika berhasil, jarahan brankas dibagi rata! Jika gagal, seluruh kru **didenda 30% poin & dipenjara 30 menit**!

⏰ Lobi dibuka selama 90 detik (Ketua bisa ketik \`.startheist\` jika sudah siap).`;

    await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
    return true;
  }

  if (['joinheist'].includes(command)) {
    return await joinBankHeist(sock, jid, senderNumber, messageObj);
  }

  if (['startheist'].includes(command)) {
    return await startBankHeistExecution(sock, jid, senderNumber, messageObj);
  }

  return false;
}

async function joinBankHeist(sock, jid, senderNumber, messageObj) {
  const session = activeGroupHeists.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Rampok Bank aktif. Ketik `.heist` untuk membuka misi!");
    return true;
  }

  if (session.crew.includes(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah bergabung di dalam tim ini!");
    return true;
  }

  if (session.crew.length >= 6) {
    await send(sock, jid, messageObj, "❌ Kru sudah penuh (Maksimal 6 anggota)!");
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.modal) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${session.modal} Poin*.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  session.crew.push(senderNumber);
  session.crewLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil bergabung ke regu Rampok Bank!\n👥 Total Kru (${session.crew.length}/6): ${session.crewLabels.join(', ')}\n\nKetik \`.startheist\` jika ingin langsung memulai misi!`, { mentions: session.crew });
  return true;
}

async function startBankHeistExecution(sock, jid, senderNumber, messageObj) {
  const session = activeGroupHeists.get(jid);
  if (!session) return false;

  if (senderNumber !== session.host && session.crew.length < 2) {
    await send(sock, jid, messageObj, "❌ Butuh minimal 2 anggota kru untuk memulai misi Rampok Bank!");
    return true;
  }

  if (session.timeout) clearTimeout(session.timeout);
  activeGroupHeists.delete(jid);
  heistCooldowns.set(jid, Date.now()); // Set Cooldown

  const crewCount = session.crew.length;
  // Winrate rebalanced: Base 35% + 5% per crew member (Maksimal 60%)
  const successChance = Math.min(0.60, 0.35 + (crewCount * 0.05));
  const isSuccess = Math.random() < successChance;

  await send(sock, jid, messageObj, `🚨 *OPERASI PENYERBUAN DIMULAI!* 🏦\nKru (${crewCount} orang): ${session.crewLabels.join(', ')}\n\n🔧 Memotong kunci laser brankas utama...\n🚗 Sopir pelarian menyalakan mesin...`, { mentions: session.crew });

  await new Promise(r => setTimeout(r, 3000));

  if (isSuccess) {
    // Rebalanced Loot: 400 + (crewCount * 200) + random(300) -> sekitar 150-250 poin per crew
    const totalLoot = 400 + (crewCount * 200) + Math.floor(Math.random() * 300);
    const lootPerCrew = Math.floor(totalLoot / crewCount);

    for (const member of session.crew) {
      await db.addGamePoints(member, lootPerCrew);
      await db.addMessageXp(member, 60);
    }

    const winMsg = 
`💰 *BRANKAS BANK AKBAR BERHASIL DIBOBOL!* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 *HASIL MISI SUKSES BESAR!*
💰 Total Jarahan: *${totalLoot.toLocaleString('id-ID')} Poin*
🎁 Diterima Tiap Kru: *+${lootPerCrew.toLocaleString('id-ID')} Poin* & *+60 XP*!

👥 *Daftar Kru Berjaya:*
${session.crewLabels.map((lbl, i) => `${i + 1}. ${lbl}`).join('\n')}

🚗 Seluruh kru berhasil kabur dengan selamat tanpa meninggalkan jejak!`;

    await send(sock, jid, messageObj, winMsg, { mentions: session.crew });
    return true;
  } else {
    let failList = [];
    for (const member of session.crew) {
      const p = await db.getGameProfile(member);
      const denda = Math.max(100, Math.floor(((p?.points || 0) * 30) / 100));
      await db.deductGamePoints(member, denda);
      await db.setGameJail(member, 30);
      failList.push(`▫️ @${member.split('@')[0]} (Denda -${denda} Poin & Penjara 30 mnt)`);
    }

    const failMsg = 
`🚨 *SIRENE ALARM BERBUNYI — TERTANGKAP POLISI!* 🚔
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aksi penyusupan terdeteksi sensor laser! Tim SWAT mengepung bank dan menangkap seluruh kru di tempat!

⚖️ *Vonis Hukuman Pengadilan:*
${failList.join('\n')}

🔒 Seluruh kru berstatus **DITAHAN DI PENJARA** selama 30 menit (tidak bisa bermain game/transaksi hingga masa hukuman selesai).`;

    await send(sock, jid, messageObj, failMsg, { mentions: session.crew });
    return true;
  }
}

export { handleBankHeist };
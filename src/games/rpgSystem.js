import * as db from '../../database.js';
import { send, generateStealChallenge, normalizeAnswer } from './helpers.js';
import { getPremiumBenefits } from '../../premiumHandler.js';

export const activeStealSessions = new Map();

// Cooldown pelaku dan immunity korban sekarang hidup di tabel user_cooldowns,
// bukan Map memori: restart bot dulu menghapus keduanya, jadi pemain bisa
// sengaja menunggu bot restart untuk membatalkan masa buron atau membuang
// perlindungan korban.
export const COOLDOWN_MALING = 'STEAL';
export const COOLDOWN_IMMUNITY = 'STEAL_IMMUNITY';
const STEAL_TIMEOUT_MS = 35 * 1000;

function profileText(profile, name, premiumTier) {
  const safePlayed = Math.max(0, Math.floor(Number(profile?.games_played) || 0));
  const safeWon = Math.max(0, Math.floor(Number(profile?.games_won) || 0));
  const winRate = safePlayed > 0
    ? Math.round((safeWon / safePlayed) * 100)
    : 0;
  const safePoints = Math.max(0, Math.floor(Number(profile?.points) || 0));
  const safeXp = Math.max(0, Math.floor(Number(profile?.xp) || 0));
  const safeLevel = Math.max(1, Math.floor(Number(profile?.level) || 1));
  const safeStreak = Math.max(0, Math.floor(Number(profile?.daily_streak) || 0));
  const premBadge = { Free: '🎮', Silver: '🥈 Silver', Gold: '🥇 Gold', Diamond: '💎 Diamond' }[premiumTier || 'Free'] || '🎮';
  return `🏆 *PROFIL GAME PEMAIN*\n\n👤 Nick: ${name || 'Pelanggan'} [${premBadge}]\n💰 Akbar Poin: *${safePoints.toLocaleString('id-ID')} Poin*\n⭐ Level: *Lv.${safeLevel}* (${safeXp} XP)\n🎮 Total Game: *${safePlayed}*\n🥇 Menang: *${safeWon}* (${winRate}%)\n🔥 Streak Harian: *${safeStreak} Hari*`;
}

export async function handleStealHeist(sock, jid, m, senderNumber, targetNumber) {
  if (!targetNumber) {
    await send(sock, jid, m, "⚠️ *Format Perintah Salah!*\nBalas (reply) pesan target atau tag orangnya!\n_Contoh:_ `.steal @member` atau `.maling @member`");
    return true;
  }

  if (senderNumber === targetNumber) {
    await send(sock, jid, m, "⚠️ Kamu tidak bisa mencuri/merampok dari dirimu sendiri!");
    return true;
  }

  if (activeStealSessions.has(senderNumber)) {
    await send(sock, jid, m, "⚠️ Kamu sedang memiliki misi pembobolan aktif! Selesaikan tantangan yang ada terlebih dahulu.");
    return true;
  }

  const isTargetReg = await db.isCustomerRegistered(targetNumber);
  if (!isTargetReg) {
    await send(sock, jid, m, "❌ Target belum terdaftar sebagai member di database.");
    return true;
  }

  const now = Date.now();
  const sisaImunMs = await db.getCooldownMs(targetNumber, COOLDOWN_IMMUNITY);
  if (sisaImunMs > 0) {
    const sisaMenit = Math.ceil(sisaImunMs / 60000);
    await send(sock, jid, m, `🛡️ *GAGAL!* Target sedang dilindungi oleh Sistem Keamanan / Polisi (Immunity) selama ${sisaMenit} menit ke depan.`);
    return true;
  }

  const sisaBuronMs = await db.getCooldownMs(senderNumber, COOLDOWN_MALING);
  if (sisaBuronMs > 0) {
    const sisaMenit = Math.ceil(sisaBuronMs / 60000);
    await send(sock, jid, m, `🚨 *BURONAN!* Kamu sedang dalam radar polisi. Bersembunyilah dulu selama ${sisaMenit} menit sebelum melakukan misi pencurian lagi.`);
    return true;
  }

  let resolvedTarget = targetNumber;
  let profileKorban = await db.getGameProfile(resolvedTarget);
  if (!profileKorban || profileKorban.points <= 0) {
    const targetDigits = resolvedTarget.replace(/[^0-9]/g, '');
    if (targetDigits.length > 5) {
      const altProf = await db.getQuery("SELECT * FROM game_profiles WHERE (customer_jid LIKE ? OR customer_jid LIKE ?) AND points > 0 ORDER BY points DESC LIMIT 1", [`%${targetDigits}%`, `${targetDigits}@%`]);
      if (altProf) {
        resolvedTarget = altProf.customer_jid;
        profileKorban = altProf;
      }
    }
  }

  let resolvedSender = senderNumber;
  let profilePerampok = await db.getGameProfile(resolvedSender);
  if (!profilePerampok || profilePerampok.points <= 0) {
    const senderDigits = resolvedSender.replace(/[^0-9]/g, '');
    if (senderDigits.length > 5) {
      const altProf = await db.getQuery("SELECT * FROM game_profiles WHERE (customer_jid LIKE ? OR customer_jid LIKE ?) AND points > 0 ORDER BY points DESC LIMIT 1", [`%${senderDigits}%`, `${senderDigits}@%`]);
      if (altProf) {
        resolvedSender = altProf.customer_jid;
        profilePerampok = altProf;
      }
    }
  }

  // Power-Up Perisai Anti-Maling yang dibeli korban lewat toko poin `.tukar`.
  // Dicek pada dua bentuk JID karena JID hasil mention bisa berbeda dengan JID
  // yang tersimpan di profil game (LID vs nomor).
  const shieldJids = [...new Set([targetNumber, resolvedTarget].filter(Boolean))];
  for (const shieldJid of shieldJids) {
    const shield = await db.getActiveBuff(shieldJid, 'STEAL_SHIELD');
    if (shield) {
      const sisaShield = Math.max(1, Math.ceil((Number(shield.expires_at) - now) / 60000));
      await send(sock, jid, m, `🛡️ *GAGAL!* Target memakai *Perisai Anti-Maling* dari Toko Power-Up.\n\nPerlindungannya masih aktif *${sisaShield} menit* lagi. Cari target lain!`);
      return true;
    }
  }

  if (!profilePerampok || profilePerampok.points < 10) {
    await send(sock, jid, m, "❌ Modal kamu kurang! Kamu butuh minimal *10 Poin* sebagai jaminan denda jika tertangkap polisi.\n\nKetik `.daily` untuk mengambil poin gratis!");
    return true;
  }

  if (!profileKorban || profileKorban.points < 20) {
    await send(sock, jid, m, "❌ Target memiliki poin terlalu sedikit (Poin < 20). Cari target lain yang brankasnya lebih berisi!");
    return true;
  }

  const challenge = generateStealChallenge();
  const expiresAt = now + STEAL_TIMEOUT_MS;

  const senderCust = await db.getCustomerByPhone(resolvedSender);
  const targetCust = await db.getCustomerByPhone(resolvedTarget);
  const senderPhone = resolvedSender.split('@')[0];
  const targetPhone = resolvedTarget.split('@')[0];
  const senderLabel = senderCust?.nama ? `*${senderCust.nama}* (@${senderPhone})` : `@${senderPhone}`;
  const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;

  const session = {
    senderNumber: resolvedSender,
    targetNumber: resolvedTarget,
    senderRaw: senderNumber,
    targetRaw: targetNumber,
    senderLabel,
    targetLabel,
    jid,
    m,
    challenge,
    expiresAt,
    targetPoints: profileKorban.points,
    stealerPoints: profilePerampok.points,
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    if (!activeStealSessions.has(senderNumber)) return;
    activeStealSessions.delete(senderNumber);

    // Timeout penalty: tertangkap polisi
    const curPerampok = await db.getGameProfile(resolvedSender);
    const denda = Math.max(25, Math.floor(((curPerampok?.points || 0) * 20) / 100));
    const kompensasi = Math.floor(denda / 2);

    await db.deductGamePoints(resolvedSender, denda);
    await db.addGamePoints(resolvedTarget, kompensasi);
    await db.setCooldown(resolvedSender, COOLDOWN_MALING, 15 * 60 * 1000);
    await db.setCooldown(resolvedTarget, COOLDOWN_IMMUNITY, 20 * 60 * 1000);

    const failMsg = `🚨 *WAKTU HABIS — ALARM BERBUNYI!* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🦹 Pelaku: ${senderLabel}\n🎯 Target: ${targetLabel}\n\nPolisi tiba di lokasi! Aksi pembobolan brankas gagal total karena waktu habis (35 detik).\n\n💸 *Sanksi Denda:* Pelaku didenda *-${denda} Poin*!\n🎁 *Kompensasi:* ${targetLabel} menerima perlindungan polisi & *+${kompensasi} Poin* ganti rugi.\n⏳ Status: Pelaku buron selama 15 menit.`;

    await send(sock, jid, m, failMsg, { mentions: [resolvedSender, resolvedTarget] });
  }, STEAL_TIMEOUT_MS);

  activeStealSessions.set(senderNumber, session);

  const promptMsg = 
`🥷 *MISI PEMBOBOLAN BRANKAS POIN (.steal)* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 Pelaku: ${senderLabel}
🎯 Target: ${targetLabel}
💰 Brankas Target: *${profileKorban.points.toLocaleString('id-ID')} Poin*

⚠️ *TANTANGAN KEAMANAN BRANKAS:*
_${challenge.title}_

${challenge.instruction}

⌨️ *Cara Eksekusi:*
Ketik: \`.hack <jawaban>\` atau langsung ketik jawabannya di grup!

⏰ *Waktu:* 35 Detik
⚠️ *Risiko:* Jika jawaban salah / waktu habis, kamu akan tertangkap polisi dan didenda *20% poin*!`;

  await send(sock, jid, m, promptMsg, {
    mentions: [senderNumber, targetNumber]
  });
  return true;
}

export async function handleStealAnswer(sock, jid, m, senderNumber, textAnswer) {
  const session = activeStealSessions.get(senderNumber);
  if (!session) return false;

  if (session.timeout) clearTimeout(session.timeout);
  activeStealSessions.delete(senderNumber);

  const cleanSub = normalizeAnswer(textAnswer);
  const cleanAns = normalizeAnswer(session.challenge.answer);
  const isCorrect = cleanSub === cleanAns;

  const now = Date.now();
  if (isCorrect) {
    // Sukses: Curi 10% - 25% dari poin target
    const percentStolen = Math.floor(Math.random() * 16) + 10; // 10% s/d 25%
    // Sasaran pencurian = dompet + setoran bank yang belum mengendap. Sejak
    // pajak tarik dihapus, dana endap inilah rem yang membuat `.steal` tetap
    // hidup: menyetor tepat sebelum dicopet tidak lagi menyelamatkan korban.
    const rawan = await db.getSaldoRawan(session.targetNumber);
    const maxVictimPts = rawan.rawan;
    const amountTarget = Math.max(5, Math.min(5000, Math.floor((maxVictimPts * percentStolen) / 100)));

    const ambil = await db.curiSaldoKorban(session.targetNumber, amountTarget);
    const amountStolen = ambil.diambil || 0;
    const updatedStealer = await db.addGamePoints(session.senderNumber, amountStolen);
    await db.grantXp(session.senderNumber, 40);

    const newVictimProf = await db.getGameProfile(session.targetNumber);

    await db.setCooldown(session.senderNumber, COOLDOWN_MALING, 15 * 60 * 1000);
    await db.setCooldown(session.targetNumber, COOLDOWN_IMMUNITY, 30 * 60 * 1000);

    const successMsg = 
`🥷 *PEMBOBOLAN BRANKAS BERHASIL!* 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 Pelaku: ${session.senderLabel}
🎯 Target: ${session.targetLabel}
🔓 Sandi Terbobol: *${session.challenge.answer}*

🎉 *Hasil Pembobolan:*
💸 Poin Tercuri: *+${amountStolen.toLocaleString('id-ID')} Poin* (${percentStolen}% dari saldo yang bisa dijangkau)${ambil.dariEndap > 0 ? `\n🏦 _Termasuk *${ambil.dariEndap.toLocaleString('id-ID')} Poin* setoran bank yang belum sempat mengendap!_` : ''}
⭐ Bonus EXP: *+40 XP*

💳 *Informasi Saldo Terkini:*
▫️ Sisa Poin Target: *${(newVictimProf?.points || 0).toLocaleString('id-ID')} Poin*
▫️ Total Poin Pelaku: *${updatedStealer.points.toLocaleString('id-ID')} Poin*
⏳ Status: Pelaku buron selama 15 menit.`;

    await send(sock, jid, m, successMsg, { mentions: [session.senderNumber, session.targetNumber] });
    return true;
  } else {
    // Gagal: Salah jawab -> Denda 20%
    const curPerampok = await db.getGameProfile(session.senderNumber);
    const denda = Math.max(25, Math.floor(((curPerampok?.points || 0) * 20) / 100));
    const kompensasi = Math.floor(denda / 2);

    await db.deductGamePoints(session.senderNumber, denda);
    await db.addGamePoints(session.targetNumber, kompensasi);
    await db.setCooldown(session.senderNumber, COOLDOWN_MALING, 15 * 60 * 1000);
    await db.setCooldown(session.targetNumber, COOLDOWN_IMMUNITY, 20 * 60 * 1000);

    const failMsg = 
`🚨 *KODE SALAH — TERTANGKAP POLISI!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 Pelaku: ${session.senderLabel}
🎯 Target: ${session.targetLabel}
❌ Jawabanmu: *${textAnswer}* (Kunci Asli: *${session.challenge.answer}*)

Alarm berbunyi keras! Polisi langsung menyergap pelaku di lokasi.

💸 *Sanksi Denda:* Pelaku disita *-${denda} Poin* (20%)!
🎁 *Kompensasi:* ${session.targetLabel} menerima *+${kompensasi} Poin* ganti rugi & proteksi polisi.
⏳ Status: Pelaku buron selama 15 menit.`;

    await send(sock, jid, m, failMsg, { mentions: [session.senderNumber, session.targetNumber] });
    return true;
  }
}


export { profileText };
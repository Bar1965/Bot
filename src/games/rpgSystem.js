import * as db from '../../database.js';
import { send, generateStealChallenge, normalizeAnswer } from './helpers.js';
import { getPremiumBenefits } from '../../premiumHandler.js';

export const activeStealSessions = new Map();
export const stealCooldowns = new Map();
export const rampokCooldowns = new Map();
export const victimImmunity = new Map();
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
  const immExpires = victimImmunity.get(targetNumber) || 0;
  if (now < immExpires) {
    const sisaMenit = Math.ceil((immExpires - now) / 60000);
    await send(sock, jid, m, `🛡️ *GAGAL!* Target sedang dilindungi oleh Sistem Keamanan / Polisi (Immunity) selama ${sisaMenit} menit ke depan.`);
    return true;
  }

  const cdExpires = stealCooldowns.get(senderNumber) || 0;
  if (now < cdExpires) {
    const sisaMenit = Math.ceil((cdExpires - now) / 60000);
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
    const curPerampok = await db.getGameProfile(senderNumber);
    const denda = Math.max(25, Math.floor(((curPerampok?.points || 0) * 20) / 100));
    const kompensasi = Math.floor(denda / 2);

    await db.deductGamePoints(senderNumber, denda);
    await db.addGamePoints(targetNumber, kompensasi);
    stealCooldowns.set(senderNumber, Date.now() + 15 * 60 * 1000);
    victimImmunity.set(targetNumber, Date.now() + 20 * 60 * 1000);

    const failMsg = `🚨 *WAKTU HABIS — ALARM BERBUNYI!* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🦹 Pelaku: ${senderLabel}\n🎯 Target: ${targetLabel}\n\nPolisi tiba di lokasi! Aksi pembobolan brankas gagal total karena waktu habis (35 detik).\n\n💸 *Sanksi Denda:* Pelaku didenda *-${denda} Poin*!\n🎁 *Kompensasi:* ${targetLabel} menerima perlindungan polisi & *+${kompensasi} Poin* ganti rugi.\n⏳ Status: Pelaku buron selama 15 menit.`;

    await send(sock, jid, m, failMsg, { mentions: [senderNumber, targetNumber] });
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
    const currentVictimProf = await db.getGameProfile(session.targetNumber);
    const maxVictimPts = Math.max(0, currentVictimProf?.points || 0);
    const amountStolen = Math.max(5, Math.min(5000, Math.floor((maxVictimPts * percentStolen) / 100)));

    await db.deductGamePoints(session.targetNumber, amountStolen);
    const updatedStealer = await db.addGamePoints(senderNumber, amountStolen);
    await db.addMessageXp(senderNumber, 40);

    const newVictimProf = await db.getGameProfile(session.targetNumber);

    stealCooldowns.set(senderNumber, now + 15 * 60 * 1000); // 15 menit
    victimImmunity.set(session.targetNumber, now + 30 * 60 * 1000); // 30 menit imun

    const successMsg = 
`🥷 *PEMBOBOLAN BRANKAS BERHASIL!* 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🦹 Pelaku: ${session.senderLabel}
🎯 Target: ${session.targetLabel}
🔓 Sandi Terbobol: *${session.challenge.answer}*

🎉 *Hasil Pembobolan:*
💸 Poin Tercuri: *+${amountStolen.toLocaleString('id-ID')} Poin* (${percentStolen}% dari brankas target)
⭐ Bonus EXP: *+40 XP*

💳 *Informasi Saldo Terkini:*
▫️ Sisa Poin Target: *${(newVictimProf?.points || 0).toLocaleString('id-ID')} Poin*
▫️ Total Poin Pelaku: *${updatedStealer.points.toLocaleString('id-ID')} Poin*
⏳ Status: Pelaku buron selama 15 menit.`;

    await send(sock, jid, m, successMsg, { mentions: [senderNumber, session.targetNumber] });
    return true;
  } else {
    // Gagal: Salah jawab -> Denda 20%
    const curPerampok = await db.getGameProfile(senderNumber);
    const denda = Math.max(25, Math.floor(((curPerampok?.points || 0) * 20) / 100));
    const kompensasi = Math.floor(denda / 2);

    await db.deductGamePoints(senderNumber, denda);
    await db.addGamePoints(session.targetNumber, kompensasi);
    stealCooldowns.set(senderNumber, now + 15 * 60 * 1000);
    victimImmunity.set(session.targetNumber, now + 20 * 60 * 1000);

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

    await send(sock, jid, m, failMsg, { mentions: [senderNumber, session.targetNumber] });
    return true;
  }
}


export { profileText };
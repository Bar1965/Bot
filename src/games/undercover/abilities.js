// ─── 🎯 SKILL PERAN VIA DM (intip, lindung, sembuhkan, fitnah, hack, tembak) ─
// Semua handler di sini dipanggil router `src/games/index.js`, bisa dari grup
// maupun DM, jadi setiap fungsi wajib mencari sesinya sendiri lewat
// findUndercoverSessionAndPlayer dan membalas ke `jid` pengirim.

import * as db from '../../../database.js';
import { send, normalizeAnswer } from '../helpers.js';
import {
  SKILL_PHASES, GHOST_WHISPER_MAX_WORDS, GHOST_WHISPER_PER_ROUND,
  BLACKMARKET_MAX_BUY, BLACKMARKET_MIN_PRICE, MISSION_DEFS
} from './constants.js';
import {
  activeUndercoverGames, saveUndercoverSessions, samePlayer, isAlive,
  clearSessionTimer, tag, dm, plainLabel, getPlayerRoleData, getRoleBadge,
  getPublicRoleBadge, isUndercoverRole, isCivilianRole, isNeutralRole,
  findUndercoverSessionAndPlayer, resolveTargetInSession, buildWordMask,
  revealRandomLetter
} from './state.js';
import {
  killPlayer, resyncAfterDeath, sendDeathIntel, checkUndercoverWinCondition,
  startNextUndercoverRound, finishGame, clueLeaksSecret
} from './flow.js';


// ─── 🤍 TEBAKAN KATA MR. WHITE ───────────────────────────────────────
export async function handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess) {
  const { session: targetSession, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  const allowedStatus = [...SKILL_PHASES, 'MR_WHITE_GUESS'];
  if (!targetSession || !allowedStatus.includes(targetSession.status)) {
    if (activeUndercoverGames.has(jid)) {
      await send(sock, jid, messageObj, "❌ Hanya Mr. White yang dapat menebak kata warga dengan `.tebakwarga <kata>`!");
      return true;
    }
    return false;
  }

  const senderRoleData = getPlayerRoleData(targetSession, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'MRWHITE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Mr. White di game ini!");
    return true;
  }

  const isPendingGuesser = targetSession.mrWhiteGuessPending && samePlayer(targetSession.mrWhiteGuessPending, resolvedSender);
  if (!isAlive(targetSession, resolvedSender) && !isPendingGuesser) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan kesempatan menebak kata telah berakhir!");
    return true;
  }

  const gameJid = targetSession.jid;

  if (!guess) {
    await send(sock, jid, messageObj, "⚠️ Masukkan kata tebakanmu!\n*Contoh:* `.tebakwarga Kopi` atau `.guess Kopi`");
    return true;
  }

  if (targetSession.status === 'MR_WHITE_GUESS') clearSessionTimer(targetSession);

  let cleanGuessText = String(guess || '').trim().replace(/^["']|["']$/g, '');
  if (cleanGuessText.toLowerCase().startsWith('kata ')) cleanGuessText = cleanGuessText.slice(5).trim();
  else if (cleanGuessText.toLowerCase().startsWith('katanya ')) cleanGuessText = cleanGuessText.slice(8).trim();

  const isCorrect = normalizeAnswer(cleanGuessText) === normalizeAnswer(targetSession.pair.civilian);

  if (isCorrect) {
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🎉 Tebakan Anda BENAR (*${cleanGuessText}*)! Anda memenangkan permainan!`);
    }
    try { await db.bumpUndercoverCounter(resolvedSender, 'mrwhite_guess_win'); } catch (e) {}
    return await finishGame(sock, gameJid, {
      headline: `🏆 *MR. WHITE BERHASIL MENEBAK KATA WARGA!* 🤍`,
      detail: `🎉 ${tag(resolvedSender)} menebak: *"${cleanGuessText}"* — TEPAT SASARAN!\n_Mr. White menyapu bersih seluruh pot taruhan permainan!_`,
      winners: [resolvedSender],
      xpEach: 150
    });
  }

  await send(sock, gameJid, null, `❌ *TEBAKAN MR. WHITE GAGAL!* 🤍\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${tag(resolvedSender)} menebak kata warga: *"${cleanGuessText}"* (SALAH!)`, { mentions: [resolvedSender] });
  if (jid !== gameJid) {
    await send(sock, jid, messageObj, `❌ Tebakan Anda (*${cleanGuessText}*) SALAH!`);
  }

  if (targetSession.status === 'MR_WHITE_GUESS') {
    targetSession.mrWhiteGuessPending = null;
    saveUndercoverSessions();
    const isWon = await checkUndercoverWinCondition(sock, gameJid);
    if (!isWon) await startNextUndercoverRound(sock, gameJid, null, false);
    return true;
  }

  // Salah menebak saat masih hidup di tengah permainan ➔ langsung gugur
  const killInfo = killPlayer(targetSession, resolvedSender);
  saveUndercoverSessions();
  await send(sock, gameJid, null, `☠️ Karena salah menebak kata warga di tengah permainan, Mr. White ${tag(resolvedSender)} **TEWAS TERELIMINASI**!`, { mentions: [resolvedSender] });
  await sendDeathIntel(sock, targetSession, resolvedSender, 'gugur akibat salah menebak kata warga');

  const isWon = await checkUndercoverWinCondition(sock, gameJid);
  if (!isWon) await resyncAfterDeath(sock, gameJid, killInfo);
  return true;
}

// ─── 🔍 DETEKTIF INTEL VIA DM (.intip @member) ──────────────────────

export async function handleDetectiveCheck(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'DETECTIVE') {
    await send(sock, jid, messageObj, "❌ Anda bukan Detektif di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan intip!");
    return true;
  }
  if (session.round < 2) {
    await send(sock, jid, messageObj, "⏳ *KEMAMPUAN TERKUNCI!* Detektif baru bisa mengintip peran mulai Ronde 2 ke atas.");
    return true;
  }
  if (senderRoleData.hasUsedIntel) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan intip Anda (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.intip @member\` atau nomor urut \`.intip [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa mengintip diri sendiri!");
    return true;
  }

  senderRoleData.hasUsedIntel = true;
  saveUndercoverSessions();

  const targetRole = getPlayerRoleData(session, resolvedTarget);
  const isFramed = session.framedPlayer && samePlayer(session.framedPlayer, resolvedTarget);
  const isCiv = targetRole && isCivilianRole(targetRole.role) && !isFramed;

  if (!isCiv && !isFramed) {
    try { await db.bumpUndercoverCounter(resolvedSender, 'detective_correct'); } catch (e) {}
  }

  const report = isCiv
    ? `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🟢 Status: *WARGA SIPIL (CIVILIAN)* 🛡️\n\n_Target adalah sekutu warga yang aman!_`
    : `🔍 *LAPORAN INTEL DETEKTIF:*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🔴 Status: *BUKAN WARGA (PENYAMAR / NETRAL)!* 🚨\n\n_Target sangat mencurigakan, arahkan warga untuk mem-votenya!_`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🛡️ GUARDIAN BODYGUARD VIA DM (.lindung @member) ────────────────
export async function handleGuardianProtect(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'GUARDIAN') {
    await send(sock, jid, messageObj, "❌ Anda bukan Guardian/Bodyguard di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan perlindungan!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.lindung @member\` atau nomor urut \`.lindung [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "🚫 *Guardian dilarang melindungi dirinya sendiri!* Pilih pemain lain.");
    return true;
  }
  if (senderRoleData.lastGuarded && samePlayer(senderRoleData.lastGuarded, resolvedTarget)) {
    await send(sock, jid, messageObj, "🚫 *Dilarang melindungi target yang sama dua ronde berturut-turut!* Pilih pemain lain ronde ini.");
    return true;
  }
  if (session.guardedPlayer) {
    await send(sock, jid, messageObj, `⚠️ Anda sudah memasang perlindungan untuk ${tag(session.guardedPlayer)} di ronde ini. Tunggu ronde berikutnya!`, { mentions: [session.guardedPlayer] });
    return true;
  }

  session.guardedPlayer = resolvedTarget;
  senderRoleData.lastGuarded = resolvedTarget;
  saveUndercoverSessions();

  await send(sock, jid, messageObj, `🛡️ *PERLINDUNGAN GUARDIAN AKTIF!* 🔰\nAnda mengawal ketat ${tag(resolvedTarget)} untuk *Ronde ${session.round} saja*. Jika dia diserang/dieksekusi ronde ini, nyawanya terselamatkan!\n💡 _Ronde depan perlindungan hangus dan wajib dipasang ulang ke orang berbeda._`, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🩺 DOKTER LAPANGAN VIA DM (.sembuhkan @member) ─────────────────
/**
 * Apakah pengirim benar-benar Dokter yang masih hidup di sesi Undercover aktif?
 *
 * Dipakai router game untuk memilah alias `.heal` / `.revive` yang dipakai
 * bersama oleh Dokter Undercover dan Healer Raid Boss. Predikat ini tidak
 * mengirim pesan apa pun — murni pengecekan supaya router bisa memutuskan
 * pemilik command tanpa efek samping.
 */
export function isUndercoverDoctorActive(senderNumber) {
  const { session, playerJid } = findUndercoverSessionAndPlayer(senderNumber);
  if (!session || !SKILL_PHASES.includes(session.status)) return false;
  const roleData = getPlayerRoleData(session, playerJid);
  if (!roleData || roleData.role !== 'DOCTOR') return false;
  return isAlive(session, playerJid);
}

export async function handleDoctorRevive(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'DOCTOR') {
    await send(sock, jid, messageObj, "❌ Anda bukan Dokter Lapangan di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan medis!");
    return true;
  }
  if (senderRoleData.hasUsedRevive) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan 1x kemampuan CPR/Revive Anda dalam game ini!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam, true);
  if (!resolvedTarget) {
    await send(sock, jid, messageObj, `⚠️ Target tidak ditemukan!\n👉 *Format:* \`.sembuhkan @member\` atau \`.sembuhkan <nomor>\``);
    return true;
  }
  if (isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, "⚠️ Target tersebut masih hidup dan tidak membutuhkan pertolongan medis!");
    return true;
  }

  const targetRoleData = getPlayerRoleData(session, resolvedTarget);
  if (!targetRoleData) {
    await send(sock, jid, messageObj, "❌ Data target tidak ditemukan di sesi permainan ini!");
    return true;
  }

  const wasShot = targetRoleData.killedByShoot ||
    (Array.isArray(session.shotVictims) && session.shotVictims.some(v => samePlayer(v, resolvedTarget)));
  if (!wasShot) {
    await send(sock, jid, messageObj, "❌ Dokter hanya dapat menghidupkan korban tembakan (Sheriff/Assassin), bukan korban voting grup!");
    return true;
  }

  senderRoleData.hasUsedRevive = true;
  targetRoleData.isAlive = true;
  targetRoleData.killedByShoot = false;
  if (Array.isArray(session.shotVictims)) {
    session.shotVictims = session.shotVictims.filter(v => !samePlayer(v, resolvedTarget));
  }
  session.alivePlayers.push(resolvedTarget);
  saveUndercoverSessions();

  const gameJid = session.jid;
  await send(sock, gameJid, null,
`🩺 *KEAJAIBAN MEDIS! DOKTER BERAKSI!* 💉
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dokter Lapangan ${tag(resolvedSender)} menggunakan jarum adrenalin & CPR darurat!
✨ Nyawa ${tag(resolvedTarget)} yang tewas tertembak berhasil diselamatkan!
${tag(resolvedTarget)} **BANGKIT KEMBALI KE PERMAINAN**! 🛡️`, { mentions: [resolvedSender, resolvedTarget] });

  if (jid !== gameJid) {
    await send(sock, jid, messageObj, `✨ Anda berhasil menghidupkan kembali ${tag(resolvedTarget)}! Pasien telah sadar dan kembali ke grup.`, { mentions: [resolvedTarget] });
  }
  return true;
}

// ─── 🗣️ FRAMER TUKANG FITNAH VIA DM (.fitnah @member) ───────────────
export async function handleFramerFrame(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'FRAMER') {
    await send(sock, jid, messageObj, "❌ Anda bukan Framer di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menggunakan kemampuan fitnah!");
    return true;
  }
  if (senderRoleData.hasFramed) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan kemampuan fitnah (Maksimal 1x per game)!");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.fitnah @member\` atau nomor urut \`.fitnah [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa memfitnah diri sendiri!");
    return true;
  }

  senderRoleData.hasFramed = true;
  session.framedPlayer = resolvedTarget;
  saveUndercoverSessions();

  await send(sock, jid, messageObj,
`🗣️ *AKSI FITNAH BERHASIL DILANCARKAN!* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target ${tag(resolvedTarget)} berhasil Anda jebak!
🎯 *Efek Berjalan (Ronde ${session.round}):*
1. Jika Detektif mengintipnya, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR)**!
2. Pada fase voting ronde ini, target otomatis mendapat **+1 Suara Kutukan Eksekusi**!`, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🦹 SABOTEUR MERETAS STATUS VIA DM (.hack @member) ──────────────
export async function handleSaboteurHack(sock, jid, senderNumber, messageObj, targetParam) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || senderRoleData.role !== 'SABOTEUR') {
    await send(sock, jid, messageObj, "❌ Anda bukan Saboteur di game ini!");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat meretas status!");
    return true;
  }

  if (senderRoleData.lastHackRound === session.round) {
    await send(sock, jid, messageObj, "❌ Anda sudah meretas 1 target di ronde ini! Tunggu ronde berikutnya.");
    return true;
  }

  const resolvedTarget = resolveTargetInSession(session, targetParam);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tidak valid atau sudah mati!\n👉 *Format:* \`.hack @member\` atau nomor urut \`.hack [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa meretas diri sendiri!");
    return true;
  }

  senderRoleData.lastHackRound = session.round;
  saveUndercoverSessions();

  const targetRoleData = getPlayerRoleData(session, resolvedTarget);
  const isVip = ['SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR'].includes(targetRoleData?.role);

  const report = isVip
    ? `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🚨 Status Intel: *WARGA SPESIAL / VIP BERBAHAYA!* (${getPublicRoleBadge(targetRoleData?.role)})\n\n_Target memegang kemampuan khusus, segera habisi dia!_`
    : `🦹 *HASIL RETASAN SABOTEUR:* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${tag(resolvedTarget)}\n🛡️ Status Intel: *${getPublicRoleBadge(targetRoleData?.role)}*\n\n_Target tidak memiliki senjata berbahaya._`;

  await send(sock, jid, messageObj, report, { mentions: [resolvedTarget] });
  return true;
}

// ─── 🤠🔫 TEMBAKAN RAHASIA VIA DM (.tembak @member) ─────────────────
export async function handleUndercoverShoot(sock, jid, senderNumber, messageObj, args = []) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) return false;

  const senderRoleData = getPlayerRoleData(session, resolvedSender);
  if (!senderRoleData || !['SHERIFF', 'ASSASSIN'].includes(senderRoleData.role)) {
    await send(sock, jid, messageObj, "❌ Peran Anda tidak memiliki senjata! Hanya Assassin & Sheriff yang dapat menembak.");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur dan tidak dapat menembak!");
    return true;
  }
  if (!senderRoleData.hasBullet) {
    await send(sock, jid, messageObj, "❌ Anda sudah menggunakan 1 peluru tembakan Anda dalam game ini!");
    return true;
  }

  // Sheriff & Assassin sama-sama terkunci di Ronde 1 agar game kecil tidak
  // selesai sebelum ada informasi apa pun untuk dianalisis.
  if (session.round < 2) {
    await send(sock, jid, messageObj, "⏳ *SENJATA TERKUNCI!* Tembakan baru bisa dilepaskan mulai Ronde 2 ke atas. Analisis petunjuk dulu!");
    return true;
  }

  const rawTarget = args[1] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.participant;

  const resolvedTarget = resolveTargetInSession(session, rawTarget);
  if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
    await send(sock, jid, messageObj, `⚠️ Target tembakan tidak valid atau sudah mati!\n👉 *Format:* \`.tembak @member\` atau nomor urut \`.tembak [1-${session.alivePlayers.length}]\``);
    return true;
  }
  if (samePlayer(resolvedTarget, resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Anda tidak bisa menembak diri sendiri!");
    return true;
  }

  senderRoleData.hasBullet = false;
  const gameJid = session.jid;
  const targetRoleData = getPlayerRoleData(session, resolvedTarget);

  // Perlindungan Guardian menangkis tembakan
  if (session.guardedPlayer && samePlayer(session.guardedPlayer, resolvedTarget)) {
    session.guardedPlayer = null;
    saveUndercoverSessions();
    await send(sock, gameJid, null,
`🛡️ *SERANGAN DIGAGALKAN OLEH GUARDIAN!* 🛡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seseorang melepaskan tembakan ke arah ${tag(resolvedTarget)}, namun Bodyguard berhasil menangkisnya!
${tag(resolvedTarget)} **SELAMAT DARI MAUT**!`, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🛡️ Tembakan Anda ke ${tag(resolvedTarget)} digagalkan oleh perlindungan Guardian!`, { mentions: [resolvedTarget] });
    }
    return true;
  }

  let killInfo = { idx: -1, wasCurrent: false };
  let victim = null;

  if (senderRoleData.role === 'SHERIFF') {
    // 🍺 Si Mabuk adalah jebakan alami buat Sheriff: petunjuknya selalu terlihat
    // seperti penyamar, padahal dia warga. Kalau menembaknya tetap dihitung
    // salah sasaran, satu peran komedi berubah jadi bom yang menghabisi 2 warga
    // sekaligus. Jadi tembakan ke Si Mabuk dianggap SAH — targetnya tewas,
    // Sheriff selamat — tapi tidak dihitung sebagai eksekusi tepat sasaran.
    const isDrunk = targetRoleData?.role === 'DRUNK';
    const isEnemy = targetRoleData
      ? (isUndercoverRole(targetRoleData.role) || isNeutralRole(targetRoleData.role) || isDrunk)
      : false;

    if (isEnemy) {
      victim = resolvedTarget;
      killInfo = killPlayer(session, resolvedTarget, { byShoot: true });
      if (!isDrunk) {
        try { await db.bumpUndercoverCounter(resolvedSender, 'sheriff_kills'); } catch (e) {}
      }
      await send(sock, gameJid, null,
`💥 *DORRR! TEMBAKAN REVOLVER SHERIFF!* 🤠🔫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff ${tag(resolvedSender)} melepaskan tembakan ke arah ${tag(resolvedTarget)}!
☠️ ${tag(resolvedTarget)} **TEWAS DI TEMPAT** tanpa perlu voting!
🎭 Peran Terbuka: *${getPublicRoleBadge(targetRoleData?.role)}*`, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `🎯 Tembakan Anda berhasil! ${tag(resolvedTarget)} (${getPublicRoleBadge(targetRoleData?.role)}) telah tewas!`, { mentions: [resolvedTarget] });
      }
    } else {
      victim = resolvedSender;
      killInfo = killPlayer(session, resolvedSender, { byShoot: true });
      await send(sock, gameJid, null,
`💥 *DORRR! TRAGEDI SALAH TEMBAK!* 🤠💀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sheriff ${tag(resolvedSender)} melepaskan tembakan ke arah Warga ${tag(resolvedTarget)}!
☠️ Menyadari dirinya menembak warga tak bersalah, ${tag(resolvedSender)} **TEWAS DI TEMPAT (SUICIDE)**!
🧑‍🌾 ${tag(resolvedTarget)} selamat tanpa luka!`, { mentions: [resolvedSender, resolvedTarget] });
      if (jid !== gameJid) {
        await send(sock, jid, messageObj, `💀 Anda salah menembak warga sipil! Anda tewas seketika karena rasa bersalah!`);
      }
    }
  } else {
    victim = resolvedTarget;
    killInfo = killPlayer(session, resolvedTarget, { byShoot: true });
    try { await db.bumpUndercoverCounter(resolvedSender, 'assassin_kills'); } catch (e) {}
    await send(sock, gameJid, null,
`🩸 *PEMBUNUHAN RAHASIA DI MALAM HARI!* 🗡️🩸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Terdengar suara letupan sniper senyap di kejauhan...
☠️ ${tag(resolvedTarget)} **DITEMUKAN TEWAS** dibunuh Assassin!
🎭 Peran Terbuka: *${getPublicRoleBadge(targetRoleData?.role)}*`, { mentions: [resolvedTarget] });
    if (jid !== gameJid) {
      await send(sock, jid, messageObj, `🗡️ Target ${tag(resolvedTarget)} (${getPublicRoleBadge(targetRoleData?.role)}) berhasil Anda bunuh!`, { mentions: [resolvedTarget] });
    }
  }

  saveUndercoverSessions();
  if (victim) await sendDeathIntel(sock, session, victim, 'tewas tertembak');

  const isGameOver = await checkUndercoverWinCondition(sock, gameJid);
  if (isGameOver) return true;

  await resyncAfterDeath(sock, gameJid, killInfo);
  return true;
}


// ─── 👻 BISIKAN ARWAH (.bisik) ───────────────────────────────────────
/**
 * Pemain yang sudah gugur boleh menitip 1 bisikan anonim per ronde ke grup.
 *
 * Ini jawaban untuk keluhan klasik "mati ronde 1 langsung nganggur": yang gugur
 * tetap ikut mengaduk permainan, tapi lewat saluran sempit yang tidak bisa
 * dipakai membocorkan hasil dead chat mentah-mentah. Karena itu bisikan dibatasi
 * jumlah kata, dilarang memuat angka/mention/nama pemain, dan dilarang memuat
 * kata rahasia mana pun.
 */
export async function handleGhostWhisper(sock, jid, senderNumber, messageObj, text) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover berjalan yang bisa kamu bisiki.");
    return true;
  }
  if (isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Bisikan Arwah hanya untuk pemain yang sudah GUGUR. Kamu masih hidup — bicara saja langsung di grup!");
    return true;
  }

  if (session.ghostWhisperRound !== session.round) {
    session.ghostWhisperRound = session.round;
    session.ghostWhisperers = new Set();
  }
  if (!session.ghostWhisperers) session.ghostWhisperers = new Set();

  if (Array.from(session.ghostWhisperers).some(g => samePlayer(g, resolvedSender))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah membisikkan sesuatu di ronde ini. Tunggu ronde berikutnya!");
    return true;
  }
  if (session.ghostWhisperers.size >= GHOST_WHISPER_PER_ROUND) {
    await send(sock, jid, messageObj, `⚠️ Kuota bisikan ronde ini sudah habis (maksimal ${GHOST_WHISPER_PER_ROUND} bisikan per ronde). Arwah lain sudah mendahuluimu!`);
    return true;
  }

  const clean = String(text || '').trim();
  if (clean.length < 2) {
    await send(sock, jid, messageObj, `⚠️ Isi bisikanmu!\n*Contoh:* \`.bisik jangan percaya yang pertama\`\n📏 Maksimal *${GHOST_WHISPER_MAX_WORDS} kata*.`);
    return true;
  }

  const jumlahKata = clean.split(/\s+/).filter(Boolean).length;
  if (jumlahKata > GHOST_WHISPER_MAX_WORDS) {
    await send(sock, jid, messageObj, `⚠️ Bisikan terlalu panjang! Maksimal *${GHOST_WHISPER_MAX_WORDS} kata* (bisikanmu: ${jumlahKata} kata).`);
    return true;
  }

  if (/[0-9@]/.test(clean)) {
    await send(sock, jid, messageObj, "🚫 Bisikan tidak boleh memuat angka atau tanda @. Arwah berbicara dalam kiasan, bukan menyebut nomor!");
    return true;
  }

  const norm = normalizeAnswer(clean);

  // Larang menyebut nama pemain mana pun.
  for (const p of session.players) {
    const potongan = String(plainLabel(session, p)).split(/[^A-Za-z0-9]+/);
    for (const seg of potongan) {
      const n = normalizeAnswer(seg);
      if (n.length >= 3 && norm.includes(n)) {
        await send(sock, jid, messageObj, "🚫 Bisikan tidak boleh menyebut nama pemain! Beri kiasan, bukan tuduhan langsung.");
        return true;
      }
    }
  }

  // Larang membocorkan kata rahasia mana pun (warga / penyamar / kata kedua).
  for (const rahasia of [session.pair?.civilian, session.pair?.undercover, session.pair?.undercover2]) {
    if (rahasia && clueLeaksSecret(clean, rahasia)) {
      await send(sock, jid, messageObj, "🚫 Bisikan tidak boleh memuat kata rahasia! Arwah dilarang membocorkan jawaban.");
      return true;
    }
  }

  session.ghostWhisperers.add(resolvedSender);
  saveUndercoverSessions();

  await send(sock, jid, messageObj, `👻 *Bisikanmu melayang ke grup…*\n💬 _"${clean}"_\n\n_Tidak ada yang tahu itu darimu._`);
  await send(sock, session.jid, null,
`👻 *BISIKAN DARI ALAM BAKA…* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💬 _"${clean}"_

_Suara itu datang dari salah satu arwah yang sudah gugur. Percaya atau tidak, terserah kalian._`);
  return true;
}

// ─── 🎯 LIHAT MISI RAHASIA (.misi) ───────────────────────────────────
export async function handleShowMission(sock, jid, senderNumber, messageObj) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session) {
    await send(sock, jid, messageObj, "❌ Kamu tidak sedang berada di sesi Undercover mana pun.");
    return true;
  }

  const rd = getPlayerRoleData(session, resolvedSender);
  const mission = rd?.mission;
  if (!mission) {
    await send(sock, jid, messageObj, "📭 Kamu tidak memegang misi rahasia di game ini.");
    return true;
  }

  const def = MISSION_DEFS.find(m => m.key === mission.key);
  const targetNote = mission.targetJid ? `\n🎯 *Targetmu:* ${plainLabel(session, mission.targetJid)}` : '';

  await send(sock, jid, messageObj,
`🎯 *MISI RAHASIA PERSONALMU* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *${def?.name || mission.key}*
📝 ${def?.desc || '-'}${targetNote}

🎁 Bonus dibayar di akhir game, di luar pot taruhan.
🤫 _Jangan bocorkan misimu — tidak ada yang tahu isinya._`);
  return true;
}

// ─── 💸 PASAR GELAP MR. WHITE (.belihuruf) ───────────────────────────
/**
 * Mr. White boleh menebus 1 huruf kata warga dengan poin miliknya sendiri.
 *
 * Huruf yang dibeli disimpan TERPISAH dari `session.revealedLetters` (bocoran
 * Zona Merah yang tampil ke seluruh grup) — kalau digabung, pembelian pribadi
 * Mr. White malah ikut membocorkan huruf ke semua orang.
 */
export async function handleBlackMarket(sock, jid, senderNumber, messageObj) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);

  if (!session || !SKILL_PHASES.includes(session.status)) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi game Undercover aktif yang Anda ikuti!");
    return true;
  }

  const rd = getPlayerRoleData(session, resolvedSender);
  if (!rd || rd.role !== 'MRWHITE') {
    await send(sock, jid, messageObj, "❌ Pasar Gelap hanya melayani Mr. White. Peranmu tidak punya akses ke sana.");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Anda sudah gugur — pedagang pasar gelap tidak melayani arwah.");
    return true;
  }

  session.blackMarketBuys = session.blackMarketBuys || 0;
  if (session.blackMarketBuys >= BLACKMARKET_MAX_BUY) {
    await send(sock, jid, messageObj, `❌ Jatah Pasar Gelap habis! Maksimal *${BLACKMARKET_MAX_BUY} huruf* per game.`);
    return true;
  }

  const price = Math.max(BLACKMARKET_MIN_PRICE, Math.round(session.buyIn || 30));
  const prof = await db.getGameProfile(resolvedSender);
  if ((prof?.points || 0) < price) {
    await send(sock, jid, messageObj, `❌ Poin tidak cukup! Satu huruf dihargai *${price} Poin*, poinmu sekarang *${(prof?.points || 0).toLocaleString('id-ID')}*.`);
    return true;
  }

  const word = String(session.pair?.civilian || '');
  if (!Array.isArray(rd.boughtLetters)) rd.boughtLetters = [];
  const sudah = new Set([...(session.revealedLetters || []), ...rd.boughtLetters]);
  const kandidat = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ' ' && !sudah.has(i)) kandidat.push(i);
  }
  if (kandidat.length === 0) {
    await send(sock, jid, messageObj, "🤷 Seluruh huruf kata warga sudah terbuka untukmu. Tinggal ketik `.tebakwarga <kata>`!");
    return true;
  }

  const deduct = await db.deductGamePoints(resolvedSender, price);
  if (!deduct?.success) {
    await send(sock, jid, messageObj, `❌ Gagal memotong *${price} Poin* untuk pembelian huruf.`);
    return true;
  }

  const picked = kandidat[Math.floor(Math.random() * kandidat.length)];
  rd.boughtLetters.push(picked);
  session.blackMarketBuys += 1;
  saveUndercoverSessions();

  const terbuka = new Set([...(session.revealedLetters || []), ...rd.boughtLetters]);
  const mask = word
    .split('')
    .map((ch, i) => (ch === ' ' ? ' ' : (terbuka.has(i) ? ch.toUpperCase() : '_')))
    .join(' ')
    .trim();

  await send(sock, jid, messageObj,
`💸 *TRANSAKSI PASAR GELAP BERHASIL!* 🕶️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔠 Huruf ke-${picked + 1} dibuka: *${word[picked].toUpperCase()}*
📋 Kata warga sejauh ini: \`${mask}\`
💰 Biaya: *-${price} Poin* (dari saldomu sendiri, bukan dari pot)
🎟️ Sisa jatah: *${BLACKMARKET_MAX_BUY - session.blackMarketBuys} huruf*

🤍 _Kalau sudah yakin, langsung sikat:_ \`.tebakwarga <kata>\``);
  return true;
}

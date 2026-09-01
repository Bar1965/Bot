// ─── 🎭 VOTING KATEGORI, PEMBAGIAN PERAN & PANDUAN UNDERCOVER ────────
// Membentuk import cycle yang disengaja dengan `flow.js`; semua pemanggilan
// silang terjadi di dalam badan fungsi (AGENTS.md §16).

import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { THEMES, THEME_KEYS, WORD_PAIRS } from '../undercoverWords.js';
import {
  CLUE_TIMEOUT_MS, CLUE_TIMEOUT_FAST_MS, VOTE_TIMEOUT_MS, DISCUSSION_TIMEOUT_MS,
  CATEGORY_VOTE_MS, MAX_ROUNDS, MAX_SKIPS, MAX_PLAYERS, MIN_PLAYERS,
  MISSION_DEFS, GHOST_WHISPER_MAX_WORDS, BLACKMARKET_MAX_BUY
} from './constants.js';
import {
  activeUndercoverGames, saveUndercoverSessions, samePlayer, shuffleArray,
  clearSessionTimer, tag, dm, plainLabel, getPlayerRoleData
} from './state.js';
import { startNextUndercoverRound } from './flow.js';

export async function startUndercoverGame(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal *${MIN_PLAYERS} pemain* untuk memulai game Undercover!`);
    return true;
  }

  clearSessionTimer(session);

  session.status = 'CATEGORY_VOTE';
  session.categoryVotes = new Map();
  session.themeOptions = shuffleArray(THEME_KEYS);

  const optionLines = session.themeOptions
    .map((key, i) => `*${i + 1}.* ${THEMES[key].label}\n     _${THEMES[key].desc}_`)
    .join('\n');
  const randomIndex = session.themeOptions.length + 1;

  const voteMsg =
`🗳️ *VOTING KATEGORI KATA — PILIH TEMA PERMAINAN!* 🎲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sebelum peran dibagikan, tentukan dulu tema kata yang akan dipakai ronde ini!

${optionLines}
*${randomIndex}.* 🎲 *ACAK TOTAL* — Serahkan pada nasib!

👉 *Cara Vote:* Ketik \`.vote [1-${randomIndex}]\` atau \`.undercover kategori [1-${randomIndex}]\`
⏳ *Waktu:* ${Math.round(CATEGORY_VOTE_MS / 1000)} detik — tema dengan suara terbanyak yang dipakai.
💡 _Suara seri atau tidak ada yang vote ➔ tema dipilih acak._

👥 Pemilih (${session.players.length}): ${session.players.map(p => tag(p)).join(', ')}`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'CATEGORY_VOTE') return;
    await resolveCategoryVote(sock, jid, null);
  }, CATEGORY_VOTE_MS);

  await send(sock, jid, messageObj, voteMsg, { mentions: session.players });
  return true;
}

export async function handleCategoryVote(sock, jid, senderNumber, messageObj, rawChoice) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CATEGORY_VOTE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting kategori kata Undercover.");
    return true;
  }

  const voter = session.players.find(p => samePlayer(p, senderNumber));
  if (!voter) {
    await send(sock, jid, messageObj, "❌ Kamu tidak terdaftar sebagai pemain di sesi ini!");
    return true;
  }

  const totalOptions = session.themeOptions.length + 1;
  const choice = parseInt(String(rawChoice || '').trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > totalOptions) {
    await send(sock, jid, messageObj, `⚠️ Pilihan tidak valid! Ketik \`.vote [1-${totalOptions}]\` untuk memilih kategori kata.`);
    return true;
  }

  const picked = choice === totalOptions ? 'RANDOM' : session.themeOptions[choice - 1];
  session.categoryVotes.set(voter, picked);

  const pickedLabel = picked === 'RANDOM' ? '🎲 ACAK TOTAL' : THEMES[picked].label;
  await send(sock, jid, messageObj, `🗳️ ${tag(voter)} memilih *${pickedLabel}*! (${session.categoryVotes.size}/${session.players.length} suara)`, { mentions: [voter] });

  if (session.categoryVotes.size >= session.players.length) {
    clearSessionTimer(session);
    await resolveCategoryVote(sock, jid, messageObj);
  }
  return true;
}

export async function resolveCategoryVote(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CATEGORY_VOTE') return;
  clearSessionTimer(session);

  const tally = new Map();
  for (const picked of session.categoryVotes.values()) {
    if (picked === 'RANDOM') continue;
    tally.set(picked, (tally.get(picked) || 0) + 1);
  }

  let winners = [];
  let best = 0;
  for (const [theme, count] of tally.entries()) {
    if (count > best) { best = count; winners = [theme]; }
    else if (count === best) winners.push(theme);
  }

  let chosenTheme;
  let reason;
  if (winners.length === 1) {
    chosenTheme = winners[0];
    reason = `Menang voting dengan *${best} suara*`;
  } else if (winners.length > 1) {
    chosenTheme = winners[Math.floor(Math.random() * winners.length)];
    reason = `Suara seri (${best} suara) ➔ dipilih acak dari kandidat teratas`;
  } else {
    chosenTheme = THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
    reason = 'Tidak ada suara tema ➔ dipilih acak total';
  }

  session.theme = chosenTheme;
  await send(sock, jid, messageObj, `🎯 *KATEGORI KATA TERPILIH!* 🎲\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 Tema: *${THEMES[chosenTheme].label}*\n📝 ${reason}.\n\n_Membagikan peran rahasia ke DM masing-masing pemain..._`);

  await assignRolesAndStart(sock, jid, messageObj);
}


// ─── 🎭 PEMBAGIAN PERAN & MULAI RONDE 1 ──────────────────────────────
export async function assignRolesAndStart(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  if (!session.chargedPlayers) session.chargedPlayers = new Set();
  if (session.buyIn > 0 && !session.buyInCharged) {
    const failedPlayers = [];
    for (const p of session.players) {
      if (!session.chargedPlayers.has(p)) {
        const deduct = await db.deductGamePoints(p, session.buyIn);
        if (deduct?.success) {
          session.chargedPlayers.add(p);
        } else {
          failedPlayers.push(p);
        }
      }
    }
    if (failedPlayers.length > 0) {
      for (const p of session.chargedPlayers) {
        await db.addGamePoints(p, session.buyIn);
      }
      session.chargedPlayers.clear();
      session.buyInCharged = false;
      session.status = 'LOBBY';
      await send(sock, jid, messageObj, `❌ Gagal memulai game: Ada pemain yang poinnya tidak mencukupi untuk taruhan *${session.buyIn} Poin*!\nPemain: ${failedPlayers.map(f => tag(f)).join(', ')}`, { mentions: failedPlayers });
      return;
    }
    session.buyInCharged = true;
  }

  const themePool = WORD_PAIRS.filter(w => w.theme === session.theme);
  const pool = themePool.length > 0 ? themePool : WORD_PAIRS;
  const pair = pool[Math.floor(Math.random() * pool.length)];

  const shuffled = shuffleArray(session.players);
  session.alivePlayers = [...shuffled];

  const count = shuffled.length;

  // Kata cadangan dari pasangan LAIN di kategori/tema yang sama. Dipakai dua
  // fitur: kata kedua penyamar (Split Word) dan kata palsu Si Mabuk.
  const decoyPair = pickDecoyPair(pool, pair);

  // 🎭 Split Word: sesekali kedua penyamar dikasih kata BERBEDA. Mereka tetap
  // saling kenal sebagai rekan, tapi tidak bisa saling menyandarkan petunjuk —
  // variansi besar dengan perubahan aturan yang minim.
  const isSplitWord = count >= 6 && !!decoyPair && Math.random() < 0.25;
  session.pair = { ...pair, undercover2: isSplitWord ? decoyPair.undercover : null };

  // Pool peran Impostor. Assassin & Saboteur dikunci di game kecil supaya
  // 1 tembakan Ronde 1 tidak langsung menutup permainan (parity instan).
  let underPool;
  if (count >= 6) underPool = shuffleArray(['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR']);
  else if (count === 5) underPool = shuffleArray(['UNDERCOVER', 'ASSASSIN', 'FRAMER']);
  else if (count === 4) underPool = shuffleArray(['UNDERCOVER', 'FRAMER']);
  else underPool = ['UNDERCOVER'];

  const underRole1 = underPool[0];
  const underRole2 = underPool[1] || 'UNDERCOVER';

  // Pool peran Netral. Mr. White butuh minimal 5 pemain agar tidak
  // menghabisi game 4 orang lewat satu kali salah vote.
  const neutralPool = count >= 5 ? ['MRWHITE', 'JESTER', 'BUNGLON'] : ['JESTER', 'BUNGLON'];
  const neutralRole = neutralPool[Math.floor(Math.random() * neutralPool.length)];

  const specialCivPool = shuffleArray(['SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR']);

  const assignedRoles = [];
  if (count === 3) {
    assignedRoles.push(underRole1, 'CIVILIAN', 'CIVILIAN');
  } else if (count === 4) {
    assignedRoles.push(underRole1, neutralRole, specialCivPool[0], 'CIVILIAN');
  } else if (count === 5) {
    assignedRoles.push(underRole1, neutralRole, specialCivPool[0], 'CIVILIAN', 'CIVILIAN');
  } else if (count === 6) {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], 'CIVILIAN', 'CIVILIAN');
  } else if (count === 7) {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], specialCivPool[1], 'CIVILIAN', 'CIVILIAN');
  } else {
    assignedRoles.push(underRole1, underRole2, neutralRole, specialCivPool[0], specialCivPool[1], 'CIVILIAN', 'CIVILIAN', 'CIVILIAN');
  }

  // 🍺 Si Mabuk: satu kursi Warga Sipil diam-diam dikasih kata yang SALAH.
  // Dikunci di 7+ pemain (di bawah itu satu warga "rusak" langsung mematikan
  // kubu warga) dan tidak selalu muncul supaya tetap jadi kejutan.
  const adaSiMabuk = count >= 7 && !!decoyPair && Math.random() < 0.5;
  if (adaSiMabuk) {
    const slot = assignedRoles.lastIndexOf('CIVILIAN');
    if (slot !== -1) assignedRoles[slot] = 'DRUNK';
  }

  const themeLabel = THEMES[session.theme]?.label || 'Acak';

  for (let i = 0; i < count; i++) {
    const p = shuffled[i];
    const role = assignedRoles[i];
    const partnerJid = (count >= 6 && (i === 0 || i === 1)) ? (i === 0 ? shuffled[1] : shuffled[0]) : null;
    const partnerNote = isSplitWord
      ? '(Kalian satu kubu, tapi ronde ini kata kalian BERBEDA — jangan saling ikut-ikutan!)'
      : '(Kalian satu kubu dan memegang kata yang sama!)';
    const partnerMsg = partnerJid ? `\n🤝 *Rekan Penyamar Anda:* ${tag(partnerJid)} ${partnerNote}` : '';
    const mentions = partnerJid ? [partnerJid] : [];
    const headInfo = `🏷️ Kategori: ${pair.category}\n📚 Tema Terpilih: ${themeLabel}`;

    // Penyamar kedua memegang kata alternatif saat mode Split Word aktif.
    const kataPenyamar = (isSplitWord && i === 1) ? session.pair.undercover2 : pair.undercover;

    const base = { isAlive: true, clue: '', clueLog: [], cards: new Set() };

    if (role === 'ASSASSIN') {
      session.playerRoles.set(p, { ...base, role: 'ASSASSIN', word: kataPenyamar, hasBullet: true });
      await dm(sock, p, `🗡️ *PERAN ANDA: ASSASSIN (PEMBUNUH BAYARAN)* 🩸\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${kataPenyamar}*\n${headInfo}${partnerMsg}\n\n⚠️ *Misi Khusus:* Anda adalah eksekutor rahasia kubu penyamar!\n🎯 *Sniper Senyap (1x Pakai — Mulai Ronde 2):*\nKirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`) untuk mengeksekusi musuh tanpa perlu voting!\n💡 _Senjata terkunci di Ronde 1, sama seperti Sheriff._`, mentions);
    } else if (role === 'FRAMER') {
      session.playerRoles.set(p, { ...base, role: 'FRAMER', word: kataPenyamar, hasFramed: false });
      await dm(sock, p, `🗣️ *PERAN ANDA: FRAMER (TUKANG FITNAH)* 🎭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${kataPenyamar}*\n${headInfo}${partnerMsg}\n\n⚠️ *Skill Fitnah (1x Pakai via DM):*\nKirim DM ke bot: \`.fitnah @member\` (atau \`.fitnah <nomor>\`)\n\n🎯 *Efek Fitnah:*\n1. Memanipulasi laporan Detektif: Jika target diintip Detektif, dia akan terlihat sebagai **BUKAN WARGA (PENYAMAR/IMPOSTOR)**!\n2. Di fase voting ronde ini, target otomatis mendapatkan **+1 Suara Kutukan Tambahan**!`, mentions);
    } else if (role === 'SABOTEUR') {
      session.playerRoles.set(p, { ...base, role: 'SABOTEUR', word: kataPenyamar });
      await dm(sock, p, `🦹 *PERAN ANDA: SABOTEUR (PENYABOT INTEL)* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${kataPenyamar}*\n${headInfo}${partnerMsg}\n\n⚠️ *Skill Sabotase:* Tiap ronde Anda bisa meretas peran pemain via DM:\n👉 Ketik: \`.hack @member\` (atau \`.sabotase <nomor>\`) untuk mengintip peran target!`, mentions);
    } else if (role === 'UNDERCOVER') {
      session.playerRoles.set(p, { ...base, role: 'UNDERCOVER', word: kataPenyamar, hasSwap: true });
      await dm(sock, p, `🎭 *PERAN ANDA: UNDERCOVER (PENYAMAR)* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${kataPenyamar}*\n${headInfo}${partnerMsg}\n\n⚠️ *Misi Penyamaran:* Berikan petunjuk yang mengecoh agar dikira warga sipil!\n🔀 *Skill Tukar Giliran (1x Pakai):* Kirim DM \`.tukargiliran\` saat giliranmu untuk melempar giliran bicara ke pemain berikutnya dan bicara paling akhir!`, mentions);
    } else if (role === 'MRWHITE') {
      session.playerRoles.set(p, { ...base, role: 'MRWHITE', word: '' });
      await dm(sock, p, `🤍 *PERAN ANDA: MR. WHITE (BLANK)* 👻\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *TIDAK ADA KATA (BLANK)*\n${headInfo}\n\n⚠️ *Misi Anda:* Anda tidak punya kata! Dengarkan petunjuk orang lain, pura-pura tahu!\n💡 *Skill Tebak Kata:* Tebak kata warga kapan saja via DM/grup dengan \`.tebakwarga <kata>\` untuk MENANG SOLO INSTAN! Atau bertahan hidup hingga akhir bersama kubu pemenang.`);
    } else if (role === 'JESTER') {
      session.playerRoles.set(p, { ...base, role: 'JESTER', word: pair.civilian });
      await dm(sock, p, `🤡 *PERAN ANDA: SI BADUT (JESTER)* 🃏\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Gila Anda:* Buat diri Anda DICURIGAI dan DI-VOTE KELUAR oleh grup! Jika berhasil di-vote keluar, Anda MENANG SOLO dan mencuri seluruh pot taruhan!\n💡 _Jika gagal tapi berhasil bertahan hidup sampai game usai, taruhan Anda dikembalikan utuh._`);
    } else if (role === 'BUNGLON') {
      session.playerRoles.set(p, { ...base, role: 'BUNGLON', word: pair.civilian });
      await dm(sock, p, `🦎 *PERAN ANDA: BUNGLON (NETRAL BEBAS)* 🤝\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Bertahan Hidup:* Anda adalah pihak netral yang fleksibel. Triknya jangan sampai tereliminasi/tertembak! Jika kubu mana pun (Warga atau Undercover) menang saat Anda masih HIDUP, Anda IKUT MENANG dan mendapat bagian hadiah pot!`);
    } else if (role === 'SHERIFF') {
      session.playerRoles.set(p, { ...base, role: 'SHERIFF', word: pair.civilian, hasBullet: true });
      await dm(sock, p, `🤠 *PERAN ANDA: KOBOI / SHERIFF (PENEMBAK)* 🔫\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi & Senjata Revolver (1x Pakai — Mulai Ronde 2):*\n👉 Kirim DM ke bot ini: \`.tembak @member\` (atau \`.tembak <nomor>\`)\n\n🎯 *HUKUM TEMBAKAN:*\n• Tembakan baru aktif mulai **Ronde 2 ke atas**!\n• Jika sasaran adalah **Penyamar**, **Mr. White**, atau **Si Badut** ➔ Target **TEWAS SEKETIKA**!\n• 💀 **JIKA SALAH SASARAN** menembak Warga Sipil/Sekutu ➔ **ANDA SENDIRI YANG TEWAS DI TEMPAT (Suicide)**!`);
    } else if (role === 'DETECTIVE') {
      session.playerRoles.set(p, { ...base, role: 'DETECTIVE', word: pair.civilian, hasUsedIntel: false });
      await dm(sock, p, `🔍 *PERAN ANDA: DETEKTIF INTEL (DETECTIVE)* 🕵️‍♂️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Intel (1x Pakai — Mulai Ronde 2):*\nKirim pesan DM ke bot: \`.intip @member\` (atau \`.intip <nomor>\`) untuk mengetahui apakah target Warga Asli atau Bukan Warga!\n💡 _Skill baru terbuka setelah melewati Ronde 1._`);
    } else if (role === 'GUARDIAN') {
      session.playerRoles.set(p, { ...base, role: 'GUARDIAN', word: pair.civilian, lastGuarded: null });
      await dm(sock, p, `🛡️ *PERAN ANDA: GUARDIAN (BODYGUARD PELINDUNG)* 🔰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Perlindungan (tiap ronde, 1 target):*\nKirim DM ke bot: \`.lindung @member\` (atau \`.guard <nomor>\`).\n🎯 Jika target yang Anda lindungi ditembak atau dieksekusi vote, nyawanya SELAMAT!\n🚫 *Aturan:* Perlindungan **hanya berlaku 1 ronde** (harus dipasang ulang tiap ronde), **tidak boleh melindungi diri sendiri**, dan **tidak boleh target yang sama 2 ronde berturut-turut**.`);
    } else if (role === 'DOCTOR') {
      session.playerRoles.set(p, { ...base, role: 'DOCTOR', word: pair.civilian, hasUsedRevive: false });
      await dm(sock, p, `🩺 *PERAN ANDA: DOKTER LAPANGAN (MEDIC)* 💉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Skill Medis (1x Pakai via DM):*\nKirim pesan DM ke bot: \`.sembuhkan @member\` (atau \`.revive <nomor>\`)\n\n🎯 *Efek Medis:* Menghidupkan kembali rekan pemain yang tewas akibat tembakan (Sheriff / Assassin)!\n💡 _Dokter tidak dapat menghidupkan korban eksekusi voting grup._`);
    } else if (role === 'DRUNK') {
      // 🍺 DM Si Mabuk WAJIB identik dengan DM Warga Sipil biasa — dia tidak
      // boleh punya satu pun petunjuk bahwa katanya salah. Yang berbeda cuma
      // isi `word`-nya, dan itu baru dibongkar di rekap akhir game.
      session.playerRoles.set(p, { ...base, role: 'DRUNK', word: decoyPair.civilian });
      await dm(sock, p, `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${decoyPair.civilian}*\n${headInfo}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat bagi sesama warga, temukan sang penyamar, dan jangan sampai salah vote!`);
    } else {
      session.playerRoles.set(p, { ...base, role: 'CIVILIAN', word: pair.civilian });
      await dm(sock, p, `🧑‍🌾 *PERAN ANDA: WARGA SIPIL (CIVILIAN)* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🤫 Kata Rahasia Anda: *${pair.civilian}*\n${headInfo}\n\n⚠️ *Misi Anda:* Berikan petunjuk yang akurat bagi sesama warga, temukan sang penyamar, dan jangan sampai salah vote!`);
    }
  }

  await assignSecretMissions(sock, session, shuffled);

  saveUndercoverSessions();
  await startNextUndercoverRound(sock, jid, messageObj, true);
}

/**
 * Ambil satu pasangan kata LAIN dari pool yang sama untuk dipakai sebagai kata
 * pengecoh (kata kedua penyamar & kata palsu Si Mabuk). Dicari yang benar-benar
 * beda kata warga maupun kata penyamarnya, supaya pengecohnya tidak kebetulan
 * sama dengan kata asli.
 */
function pickDecoyPair(pool, pair) {
  const kandidat = pool.filter(w =>
    w.civilian !== pair.civilian &&
    w.civilian !== pair.undercover &&
    w.undercover !== pair.civilian &&
    w.undercover !== pair.undercover
  );
  if (kandidat.length === 0) return null;
  return kandidat[Math.floor(Math.random() * kandidat.length)];
}

/**
 * Bagikan 1 misi rahasia personal ke tiap pemain lewat DM.
 *
 * Misi TIDAK mengubah win condition kubu mana pun — hanya bonus poin personal
 * yang dibayar di luar pot (lihat `resolveMissions` di stats.js). Misi bertarget
 * (PELINDUNG) selalu menunjuk pemain lain, tidak pernah diri sendiri.
 */
async function assignSecretMissions(sock, session, urutan) {
  for (const p of urutan) {
    const rd = getPlayerRoleData(session, p);
    if (!rd) continue;

    const def = MISSION_DEFS[Math.floor(Math.random() * MISSION_DEFS.length)];
    let targetJid = null;
    let targetNote = '';

    if (def.needsTarget) {
      const kandidat = session.players.filter(o => !samePlayer(o, p));
      if (kandidat.length === 0) continue;
      targetJid = kandidat[Math.floor(Math.random() * kandidat.length)];
      targetNote = `\n🎯 *Targetmu:* ${plainLabel(session, targetJid)}`;
    }

    rd.mission = { key: def.key, targetJid };

    await dm(sock, p,
`🎯 *MISI RAHASIA PERSONAL* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selain peranmu, kamu memegang satu misi pribadi yang TIDAK diketahui siapa pun.

📌 *${def.name}*
📝 ${def.desc}${targetNote}

🎁 *Hadiah:* bonus poin ekstra di akhir game, dibayar DI LUAR pot taruhan.
⚖️ Misi ini tidak mengubah kemenangan kubumu — kubu tetap prioritas utama.
💡 _Lupa misimu? Ketik \`.misi\` lewat DM kapan saja._`);
  }
}


// ─── 📖 PANDUAN PERAN ────────────────────────────────────────────────
export async function showUndercoverRoleGuide(sock, jid, messageObj) {
  const guide =
`🎭 *PANDUAN LENGKAP PERAN & ATURAN UNDERCOVER 4.0* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Game deduksi sosial berbasis kata rahasia via DM WhatsApp & diskusi grup (${MIN_PLAYERS}–${MAX_PLAYERS} pemain).

🆕 *YANG BARU DI VERSI 4.0:*
⚖️ *Sidang Terakhir:* Tersangka dengan suara terbanyak dapat waktu membela diri, lalu juri menjatuhkan vonis \`.bersalah\` / \`.bebas\`. Vonis seri atau mayoritas bebas ➔ eksekusi BATAL.
👤 *Ronde Anonim:* Sesekali satu ronde mengumpulkan petunjuk lewat DM (\`.anon <teks>\`), lalu menayangkannya *teracak tanpa nama*.
👻 *Bisikan Arwah:* Pemain yang gugur boleh menitip *1 bisikan anonim* per ronde ke grup lewat DM \`.bisik <maks ${GHOST_WHISPER_MAX_WORDS} kata>\`. Dilarang menyebut nama, angka, atau kata rahasia.
🎯 *Misi Rahasia Personal:* Semua pemain dapat 1 misi pribadi via DM. Berhasil = bonus poin *di luar pot taruhan*. Cek ulang dengan \`.misi\`.
🍺 *Si Mabuk:* Di game 7+ pemain, satu "warga" bisa diam-diam memegang *kata yang salah* — dia sendiri tidak tahu, dan baru kebongkar di rekap akhir.
🎭 *Split Word:* Sesekali kedua penyamar dikasih kata BERBEDA — mereka pun tidak bisa saling menyandarkan petunjuk.
🔠 *Bocoran Zona Merah:* Mulai Ronde 4, satu huruf kata warga dibuka tiap ronde supaya permainan tidak mentok.
💸 *Pasar Gelap:* Mr. White boleh menebus huruf kata warga dengan poinnya sendiri (\`.belihuruf\`, maks ${BLACKMARKET_MAX_BUY}x).
📊 *Trust Score & Petunjuk Mematikan:* Papan penilaian iseng di akhir game — tidak mempengaruhi hadiah.

📜 *SISTEM RONDE:*
👥 *Komposisi:* 1 Penyamar (${MIN_PLAYERS}–5 Pemain) | 2 Penyamar (6–${MAX_PLAYERS} Pemain).
⏱️ *Durasi:* ${Math.round(CLUE_TIMEOUT_MS / 1000)}s Petunjuk (putaran ke-2 & Zona Merah ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s), ${Math.round(DISCUSSION_TIMEOUT_MS / 1000)}s Diskusi, ${Math.round(VOTE_TIMEOUT_MS / 1000)}s Voting.
🔁 *Ronde 1 = 2 Putaran Petunjuk:* Semua bicara 2x sebelum voting pertama dibuka.
🎲 *Tantangan Ronde:* Tiap ronde diundi aturan unik — 3 Kata, Sumpah Bisu (1 kata), Estafet (wajib menyambung kata pemain sebelumnya), Urutan Terbalik, Speed Clue, Ronde Anonim, dll.
🚫 *Batas Vote Skip:* Maksimal ${MAX_SKIPS}x per game.
💀 *Zona Merah:* Mulai Ronde 4+ (waktu dipercepat, vote skip dikunci, Sidang Terakhir dilewati, huruf kata warga mulai bocor).
⏳ *Batas Ronde:* Maksimal ${MAX_ROUNDS} Ronde.
🏁 *Menang Penyamar:* Jumlah penyamar hidup ≥ jumlah warga hidup. (Mr. White dihitung terpisah!)

👥 *DAFTAR LENGKAP PERAN:*

🛡️ *1. KUBU WARGA:*
▫️ 🧑‍🌾 *Civilian:* Kata asli, cari penyamar lewat analisis petunjuk.
▫️ 🤠 *Koboi / Sheriff:* 1x peluru (\`.tembak\` via DM, *Ronde 2+*). Kena musuh/netral = target mati; salah tembak warga = *kamu* yang mati.
▫️ 🔍 *Detektif Intel:* 1x intip (\`.intip\` via DM, *Ronde 2+*) untuk cek Warga Asli / Bukan Warga.
▫️ 🛡️ *Guardian:* \`.lindung\` via DM tiap ronde. *Tidak boleh diri sendiri*, *tidak boleh target sama 2 ronde beruntun*, dan hangus tiap ganti ronde.
▫️ 🩺 *Dokter Lapangan:* 1x \`.sembuhkan\` via DM untuk menghidupkan korban tembakan (bukan korban voting).
▫️ 🍺 *Si Mabuk* (7+ pemain, tidak selalu ada): Warga sipil yang menerima *kata salah* tanpa pernah diberi tahu. Dia bukan pengkhianat — cuma korban keadaan. Menembaknya *tidak* membuat Sheriff bunuh diri, tapi juga tidak dihitung tembakan tepat sasaran.

🕵️ *2. KUBU PENYAMAR:*
▫️ 🕵️ *Undercover:* Kata mirip. Punya 1x \`.tukargiliran\` via DM untuk melempar gilirannya ke urutan terakhir.
▫️ 🗡️ *Assassin:* 1x peluru sniper (\`.tembak\` via DM, *Ronde 2+*, khusus 5+ pemain).
▫️ 🗣️ *Framer:* 1x \`.fitnah\` via DM — memanipulasi hasil intip Detektif & +1 suara kutukan.
▫️ 🦹 *Saboteur:* \`.hack\` via DM 1x per ronde (khusus 6+ pemain) untuk mengintip peran target.

🎭 *3. KUBU NETRAL:*
▫️ 🤍 *Mr. White* (5+ pemain): Tanpa kata. \`.tebakwarga <kata>\` kapan saja untuk MENANG SOLO. Salah tebak saat masih hidup = langsung gugur. Boleh menebus huruf lewat \`.belihuruf\`.
▫️ 🤡 *Si Badut (Jester):* Menang solo jika di-vote keluar oleh grup. Jika gagal tapi selamat sampai akhir, taruhan dikembalikan.
▫️ 🦎 *Bunglon:* Ikut menang bersama kubu mana pun asal masih hidup saat game usai.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *PERINTAH UTAMA:*
• \`.undercover [taruhan]\` — Buka lobi (Default 30 Poin)
• \`.joinundercover\` / \`.startundercover\` — Gabung / mulai
• \`.vote [1-5]\` — Vote kategori kata (saat fase pemilihan tema)
• \`.vote [nomor/@member]\` / \`.vote skip\` — Vote eliminasi / abstain
• \`.bersalah\` / \`.bebas\` — Vonis juri saat Sidang Terakhir
• \`.anon <teks>\` — Setor petunjuk lewat DM saat Ronde Anonim
• \`.bisik <pesan>\` — Bisikan anonim khusus pemain yang sudah gugur
• \`.misi\` — Baca ulang misi rahasia personalmu
• \`.lanjut\` — Tutup diskusi lebih cepat, buka voting
• \`.skip\` — Lewati giliran petunjuk / abstain
• \`.tembak\`, \`.intip\`, \`.lindung\`, \`.sembuhkan\`, \`.fitnah\`, \`.hack\`, \`.tukargiliran\` — Skill peran via DM
• \`.tebakwarga <kata>\` / \`.belihuruf\` — Khusus Mr. White
• \`.undercover card\` — Toko Kartu Aksi
• \`.undercover stats\` / \`.undercover top\` — Statistik & peringkat
• \`.undercover cancel\` — Batalkan sesi (khusus host)`;

  await send(sock, jid, messageObj, guide);
  return true;
}

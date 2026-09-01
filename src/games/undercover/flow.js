// ─── 🔄 MESIN FASE UNDERCOVER (ronde → petunjuk → diskusi → voting) ───
// AGENTS.md §12a: JANGAN pernah meng-inline transisi fase. Semua jalur wajib
// lewat announceTurn → advanceTurn → finishCluePass → startDiscussionPhase →
// startVotingPhase → processUndercoverVotes → startNextUndercoverRound.
//
// Modul ini membentuk import cycle yang disengaja dengan `roles.js`
// (roles memanggil startNextUndercoverRound, flow memanggil handleCategoryVote).
// Aman karena SEMUA referensi silang dipanggil di dalam badan fungsi, tidak di
// level modul (AGENTS.md §16).

import * as db from '../../../database.js';
import { send, normalizeAnswer } from '../helpers.js';
import { THEMES } from '../undercoverWords.js';
import {
  CLUE_TIMEOUT_MS, CLUE_TIMEOUT_FAST_MS, VOTE_TIMEOUT_MS, DISCUSSION_TIMEOUT_MS,
  MRWHITE_GUESS_MS, ANON_CLUE_MS, TRIAL_MS, MAX_ROUNDS, MAX_SKIPS,
  ROUND_MODIFIERS, MODIFIER_MIN_ROUND, MODIFIER_MIN_ALIVE,
  GHOST_WHISPER_MAX_WORDS, GHOST_WHISPER_PER_ROUND
} from './constants.js';
import {
  activeUndercoverGames, saveUndercoverSessions, samePlayer, shuffleArray,
  clearSessionTimer, findAliveIndex, isAlive, plainLabel, tag, dm,
  getPlayerRoleData, getRoleBadge, getPublicRoleBadge, isUndercoverRole,
  isCivilianRole, isNeutralRole, resolveTargetInSession, buildWordMask,
  revealRandomLetter, findUndercoverSessionAndPlayer
} from './state.js';
import {
  buildFinalRecap, buildTrustBoard, buildDeadliestClue,
  recordMatchStats, resolveMissions
} from './stats.js';
import { handleCategoryVote } from './roles.js';


// ─── 🔄 MESIN RONDE & GILIRAN PETUNJUK ───────────────────────────────
export function computeTurnTimeout(session) {
  if (session.round >= 4) return CLUE_TIMEOUT_FAST_MS;
  if ((session.cluePass || 1) >= 2) return CLUE_TIMEOUT_FAST_MS;
  if (session.modifier?.key === 'SPEED') return CLUE_TIMEOUT_FAST_MS;
  return CLUE_TIMEOUT_MS;
}

// Undian modifier dengan pagar: Ronde Anonim & Estafet tidak boleh keluar di
// ronde perkenalan (Ronde 1 memakai 2 putaran petunjuk) atau saat pemain sudah
// tinggal sedikit — di sana keduanya cuma memperlambat tanpa menambah deduksi.
export function pickRoundModifier(session) {
  const alive = session.alivePlayers.length;
  const pool = ROUND_MODIFIERS.filter(m => {
    const minRound = MODIFIER_MIN_ROUND[m.key] || 0;
    const minAlive = MODIFIER_MIN_ALIVE[m.key] || 0;
    return session.round >= minRound && alive >= minAlive;
  });
  const source = pool.length > 0 ? pool : ROUND_MODIFIERS;
  return source[Math.floor(Math.random() * source.length)];
}

export function clueOf(session, p) {
  const rd = getPlayerRoleData(session, p);
  if (!rd) return '-';
  if (session.round === 1 && Array.isArray(rd.clueLog)) {
    const r1 = rd.clueLog.filter(c => c.round === 1);
    if (r1.length >= 2) return `${r1[0].text} → ${r1[1].text}`;
  }
  return rd.clue || '-';
}

export function buildClueBoard(session) {
  // Ronde Anonim: papan ditayangkan tanpa nama & sudah teracak, jadi diskusi
  // dan voting benar-benar buta siapa mengatakan apa.
  if (session.anonRound === session.round && Array.isArray(session.anonBoard) && session.anonBoard.length > 0) {
    const body = session.anonBoard.map((c, i) => `${String.fromCharCode(65 + i)}. _"${c}"_`).join('\n');
    return `👤 *PAPAN PETUNJUK ANONIM (urutan diacak):*\n${body}\n\n👥 *Pemain hidup:* ${session.alivePlayers.map(p => tag(p)).join(', ')}`;
  }
  return session.alivePlayers
    .map((p, i) => `${i + 1}. ${tag(p)}: _"${clueOf(session, p)}"_`)
    .join('\n');
}

export async function startNextUndercoverRound(sock, jid, messageObj, isFirstRound = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  if (isFirstRound) {
    session.round = 1;
    session.skipCount = 0;
  } else {
    session.round++;
  }

  if (session.round > MAX_ROUNDS) {
    return await resolveMaxRoundLimit(sock, jid);
  }

  // Reset efek per-ronde
  session.status = 'CLUE_PHASE';
  session.cluePass = 1;
  session.turnIndex = 0;
  session.votes.clear();
  session.skipVotes = new Set();
  session.discussionSkips = new Set();
  session.guardedPlayer = null; // perlindungan Guardian hanya berlaku 1 ronde
  session.silencedPlayers = new Set(session.pendingSilence || []);
  session.pendingSilence = new Set();
  session.trialAccused = null;
  session.trialVotes = new Map();
  session.trialMaxVotes = 0;
  session.ghostWhisperRound = session.round;
  session.ghostWhisperers = new Set();

  // Rotasi urutan bicara supaya pemain pertama tidak selalu dirugikan
  if (!isFirstRound && session.alivePlayers.length > 1) {
    session.alivePlayers.push(session.alivePlayers.shift());
  }

  session.modifier = pickRoundModifier(session);

  // Urutan Terbalik: dibalik SETELAH rotasi normal supaya pembukanya benar-benar
  // orang yang tadinya kebagian giliran terakhir.
  if (session.modifier?.key === 'TERBALIK' && session.alivePlayers.length > 1) {
    session.alivePlayers.reverse();
  }

  // Anti-stall Zona Merah: mulai Ronde 4 satu huruf kata warga dibuka tiap ronde
  // supaya permainan memaksa konvergen sebelum mentok di batas ronde — sekaligus
  // memberi Mr. White peluang nyata untuk `.tebakwarga`.
  let hintNote = '';
  if (session.round >= 4) {
    revealRandomLetter(session);
    hintNote = `\n\n🔠 *BOCORAN ZONA MERAH — KATA WARGA:*\n\`${buildWordMask(session)}\`\n_Satu huruf baru dibuka tiap ronde mulai Ronde 4._`;
  }

  const mod = session.modifier;
  const totalPot = session.buyIn * session.players.length;
  const isSuddenDeath = session.round >= 4;
  const turnSeconds = Math.round(computeTurnTimeout(session) / 1000);
  const themeLabel = THEMES[session.theme]?.label || 'Acak';

  let roundHeader = '';
  if (isFirstRound) {
    const roleCounts = {};
    for (const [, r] of session.playerRoles.entries()) {
      roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
    }
    const roleSummary = [
      roleCounts.CIVILIAN ? `🧑‍🌾 ${roleCounts.CIVILIAN} Warga` : null,
      roleCounts.SHERIFF ? `🤠 ${roleCounts.SHERIFF} Koboi` : null,
      roleCounts.DETECTIVE ? `🔍 ${roleCounts.DETECTIVE} Detektif` : null,
      roleCounts.GUARDIAN ? `🛡️ ${roleCounts.GUARDIAN} Guardian` : null,
      roleCounts.DOCTOR ? `🩺 ${roleCounts.DOCTOR} Dokter` : null,
      roleCounts.UNDERCOVER ? `🕵️ ${roleCounts.UNDERCOVER} Undercover` : null,
      roleCounts.ASSASSIN ? `🗡️ ${roleCounts.ASSASSIN} Assassin` : null,
      roleCounts.FRAMER ? `🗣️ ${roleCounts.FRAMER} Framer` : null,
      roleCounts.SABOTEUR ? `🦹 ${roleCounts.SABOTEUR} Saboteur` : null,
      roleCounts.MRWHITE ? `🤍 ${roleCounts.MRWHITE} Mr. White` : null,
      roleCounts.JESTER ? `🤡 ${roleCounts.JESTER} Si Badut` : null,
      roleCounts.BUNGLON ? `🦎 ${roleCounts.BUNGLON} Bunglon` : null
    ].filter(Boolean).join(' | ');

    roundHeader =
`🎮 *UNDERCOVER ULTRA 3.0 RESMI DIMULAI — RONDE 1* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤫 *Kata rahasia telah dikirim ke DM WhatsApp masing-masing!*
📚 *Tema Pilihan Grup:* ${themeLabel}
🏷️ *Kategori:* ${session.pair.category}
💰 *Total Prizepool:* *${totalPot.toLocaleString('id-ID')} Poin*
🎭 *Komposisi Peran:* ${roleSummary}

╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE 1:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

📜 *ATURAN GAME 3.0:*
🔁 *Ronde 1 = 2 Putaran Petunjuk!* Semua bicara 2x sebelum voting pertama (biar tidak vote buta).
💬 *Fase Diskusi:* 30 detik diskusi bebas setelah petunjuk, sebelum voting dibuka.
⏱️ *Durasi:* ${Math.round(CLUE_TIMEOUT_MS / 1000)}s Petunjuk (putaran 2 & Zona Merah: ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s), ${Math.round(VOTE_TIMEOUT_MS / 1000)}s Voting
🚫 *Batas Vote Skip:* Maksimal ${MAX_SKIPS}x per permainan
💀 *Zona Merah:* Mulai Ronde 4+ (Waktu ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)}s & Vote Skip Dikunci!)
⏳ *Batas Ronde:* Maksimal ${MAX_ROUNDS} Ronde

📋 *Urutan Giliran Pemain:*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}

💡 _Ketik \`.undercover role\` untuk membaca panduan peran._`;
  } else if (isSuddenDeath) {
    roundHeader =
`🚨 *ZONA MERAH / SUDDEN DEATH — RONDE ${session.round}* ☠️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *PERINGATAN ZONA MERAH:*
• Waktu giliran petunjuk dipercepat jadi **${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)} Detik**!
• Opsi \`.vote skip\` **DIKUNCI** (Wajib ada yang dieksekusi)!
• Batas akhir game: Ronde ${MAX_ROUNDS}.

╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE ${session.round}:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}`;
  } else {
    roundHeader =
`🔄 *UNDERCOVER — MASUK RONDE ${session.round}* 🕵️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
╔══════════════════════════════╗
🎲 *TANTANGAN KHUSUS RONDE ${session.round}:*
👉 *${mod.name}*
📝 *Aturan:* ${mod.desc}
╚══════════════════════════════╝

🔀 _Urutan bicara dirotasi — pembuka ronde ini bukan orang yang sama._
👥 *Pemain Bertahan (${session.alivePlayers.length}):*
${session.alivePlayers.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n')}`;
  }

  if (session.silencedPlayers.size > 0) {
    const muted = session.alivePlayers.filter(p => session.silencedPlayers.has(p));
    if (muted.length > 0) {
      roundHeader += `\n\n🤐 *KORBAN KARTU LAKBAN RONDE INI:* ${muted.map(m => tag(m)).join(', ')} — hanya boleh menulis *1 KATA*!`;
    }
  }

  roundHeader += hintNote;

  const deadCount = session.players.length - session.alivePlayers.length;
  if (deadCount > 0) {
    roundHeader += `\n\n👻 *Bisikan Arwah aktif:* ${deadCount} pemain gugur boleh menitip *1 bisikan anonim* ronde ini lewat DM \`.bisik <pesan>\` (maks ${GHOST_WHISPER_MAX_WORDS} kata, ${GHOST_WHISPER_PER_ROUND} bisikan per ronde).`;
  }

  saveUndercoverSessions();
  await send(sock, jid, messageObj, roundHeader, { mentions: session.alivePlayers });

  if (session.modifier?.key === 'ANON') {
    return await startAnonCluePhase(sock, jid, messageObj);
  }
  await announceTurn(sock, jid, messageObj);
}

// ─── 👤 RONDE ANONIM ─────────────────────────────────────────────────
// Petunjuk dikumpulkan lewat DM, lalu ditayangkan teracak tanpa nama. Pipeline
// pencatatan petunjuk tetap `recordClue` yang sama, jadi rekap akhir game tetap
// membongkar siapa menulis apa — itu justru bagian paling seru saat reveal.
export async function startAnonCluePhase(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'ANON_CLUE_PHASE';
  session.anonRound = session.round;
  session.anonBoard = [];
  session.anonSubmitted = new Set();
  saveUndercoverSessions();

  const detik = Math.round(ANON_CLUE_MS / 1000);
  await send(sock, jid, messageObj,
`👤 *RONDE ANONIM — SETOR PETUNJUK LEWAT DM!* 🕶️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ronde ini TIDAK ada giliran bicara di grup. Semua pemain hidup mengirim petunjuk *serentak* ke DM bot.

👉 *Caranya:* buka chat pribadi bot lalu ketik:
\`.anon <teks petunjukmu>\`

⏳ Waktu setor: *${detik} detik*.
🎲 Setelah waktu habis, semua petunjuk ditayangkan *TERACAK & TANPA NAMA* — kalian harus vote tanpa tahu siapa bilang apa.
💀 _Yang tidak menyetor akan muncul sebagai petunjuk kosong._`, { mentions: session.alivePlayers });

  for (const p of session.alivePlayers) {
    await dm(sock, p, `👤 *RONDE ANONIM RONDE ${session.round}!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nKirim petunjukmu SEKARANG lewat chat ini:\n\`.anon <teks>\`\n\n⏳ Batas waktu *${detik} detik*. Petunjukmu akan ditayangkan tanpa nama.`);
  }

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'ANON_CLUE_PHASE') return;
    await finishAnonCluePhase(sock, jid, null);
  }, ANON_CLUE_MS);
}

export async function handleUndercoverAnonClue(sock, jid, senderNumber, messageObj, text) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);
  if (!session || session.status !== 'ANON_CLUE_PHASE') {
    await send(sock, jid, messageObj, "❌ Perintah `.anon` hanya dipakai saat *Ronde Anonim* Undercover sedang membuka setoran petunjuk.");
    return true;
  }
  if (!isAlive(session, resolvedSender)) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur tidak menyetor petunjuk.");
    return true;
  }
  if (session.anonSubmitted?.has(resolvedSender)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah menyetor petunjuk ronde ini. Satu orang satu petunjuk!");
    return true;
  }

  const clean = String(text || '').trim();
  if (clean.length < 2) {
    await send(sock, jid, messageObj, "⚠️ Petunjuk terlalu pendek! Tulis minimal 2 karakter.\n*Contoh:* `.anon warnanya hitam pekat`");
    return true;
  }

  const rd = getPlayerRoleData(session, resolvedSender);
  if (clueLeaksSecret(clean, rd?.word)) {
    await send(sock, jid, messageObj, "❌ DILARANG menyebutkan kata rahasiamu (atau bagian dari kata itu) dalam petunjuk! Tulis deskripsi lain.");
    return true;
  }

  recordClue(session, resolvedSender, clean);
  if (!session.anonSubmitted) session.anonSubmitted = new Set();
  session.anonSubmitted.add(resolvedSender);
  saveUndercoverSessions();

  await send(sock, jid, messageObj, `✅ *Petunjuk anonimmu tercatat!*\n💬 _"${clean}"_\n\n⏳ Menunggu pemain lain… (${session.anonSubmitted.size}/${session.alivePlayers.length} setoran)`);
  await send(sock, session.jid, null, `📨 Satu petunjuk anonim masuk… (${session.anonSubmitted.size}/${session.alivePlayers.length})`);

  if (session.anonSubmitted.size >= session.alivePlayers.length) {
    clearSessionTimer(session);
    await finishAnonCluePhase(sock, session.jid, null);
  }
  return true;
}

async function finishAnonCluePhase(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  for (const p of session.alivePlayers) {
    if (!session.anonSubmitted?.has(p)) recordClue(session, p, '(Tidak menyetor petunjuk / AFK)');
  }

  session.anonBoard = shuffleArray(session.alivePlayers.map(p => clueOf(session, p)));
  session.anonRound = session.round;
  saveUndercoverSessions();

  await send(sock, jid, messageObj,
`🕶️ *SETORAN DITUTUP — PAPAN ANONIM DIBUKA!* 👤
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Urutannya sudah diacak. Tidak ada satu pun nama di bawah ini.

${buildClueBoard(session)}

🧠 _Selamat berdebat: kalian harus menebak siapa penulis tiap baris sebelum voting._`, { mentions: session.alivePlayers });

  return await startDiscussionPhase(sock, jid, messageObj);
}

export async function announceTurn(sock, jid, messageObj, prefix = '') {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return;
  clearSessionTimer(session);

  if (session.turnIndex >= session.alivePlayers.length) {
    return await finishCluePass(sock, jid, messageObj);
  }

  const player = session.alivePlayers[session.turnIndex];
  if (!player) return await finishCluePass(sock, jid, messageObj);

  const seq = ++session.turnSeq;
  const ms = computeTurnTimeout(session);
  const isSuddenDeath = session.round >= 4;
  const passLabel = (session.cluePass || 1) >= 2 ? ' — PUTARAN KE-2' : '';
  const silencedNote = session.silencedPlayers.has(player)
    ? `\n🤐 *KAMU KENA KARTU LAKBAN!* Petunjukmu hanya boleh *1 KATA*.`
    : '';
  const modInfo = session.modifier
    ? `\n🎲 *Tantangan Ronde:* *${session.modifier.name}* — _${session.modifier.desc}_`
    : '';

  const turnMsg =
`${prefix}👉 *GILIRAN PETUNJUK${passLabel}:* ${tag(player)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔢 Pemain ${session.turnIndex + 1}/${session.alivePlayers.length} | ⏳ Waktu: *${Math.round(ms / 1000)} detik*${modInfo}${silencedNote}
_Tulis 1 kalimat petunjuk katamu di grup ini!_
${isSuddenDeath ? '🚫 _(Zona Merah: Vote Skip Dikunci)_' : '_Atau ketik `.skip` untuk melewati giliran._'}`;

  session.skipVotes = new Set();
  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'CLUE_PHASE' || cur.turnSeq !== seq) return;
    const afkPlayer = cur.alivePlayers[cur.turnIndex];
    if (!afkPlayer) return;
    recordClue(cur, afkPlayer, '(Melewatkan giliran / AFK)');
    await send(sock, jid, null, `⌛ ${tag(afkPlayer)} kehabisan waktu memberi petunjuk! Giliran dialihkan ke pemain berikutnya.`, { mentions: [afkPlayer] });
    await advanceTurn(sock, jid, null);
  }, ms);

  saveUndercoverSessions();
  await send(sock, jid, messageObj, turnMsg, { mentions: [player] });
}

export async function advanceTurn(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return;
  clearSessionTimer(session);
  session.turnIndex++;
  saveUndercoverSessions();

  if (session.turnIndex < session.alivePlayers.length) {
    return await announceTurn(sock, jid, messageObj);
  }
  return await finishCluePass(sock, jid, messageObj);
}

// Selesai satu putaran petunjuk. Ronde 1 memakai 2 putaran supaya voting
// pertama tidak dilakukan tanpa informasi.
export async function finishCluePass(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  if (session.round === 1 && (session.cluePass || 1) === 1 && session.alivePlayers.length >= 3) {
    session.cluePass = 2;
    session.turnIndex = 0;
    saveUndercoverSessions();

    const board = buildClueBoard(session);
    await send(sock, jid, messageObj,
`🔁 *PUTARAN PETUNJUK KEDUA — RONDE 1!* 🗣️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Semua sudah bicara sekali. Sekarang beri petunjuk *BARU* (dilarang mengulang persis petunjuk pertamamu)!

📋 *Rekap Putaran 1:*
${board}

⏳ Waktu tiap giliran dipercepat jadi ${Math.round(CLUE_TIMEOUT_FAST_MS / 1000)} detik.`, { mentions: session.alivePlayers });

    return await announceTurn(sock, jid, messageObj);
  }

  return await startDiscussionPhase(sock, jid, messageObj);
}

export function recordClue(session, player, text) {
  const rd = getPlayerRoleData(session, player);
  if (!rd) return;
  rd.clue = text;
  if (!Array.isArray(rd.clueLog)) rd.clueLog = [];
  rd.clueLog.push({ round: session.round, pass: session.cluePass || 1, text });
}

export function clueLeaksSecret(clue, word) {
  if (!word) return false;
  const nClue = normalizeAnswer(clue);
  const nWord = normalizeAnswer(word);
  if (!nClue || !nWord) return false;
  if (nClue.includes(nWord)) return true;

  // Potongan kata diambil dua cara: per-spasi DAN per-tanda-baca. Dua-duanya perlu,
  // karena kata seperti "CS:GO" hanya utuh di pemisahan spasi, sedangkan
  // "(COUNTER-STRIKE)" hanya terpecah benar di pemisahan tanda baca.
  const candidates = new Set();
  for (const seg of String(word).split(/\s+/)) candidates.add(normalizeAnswer(seg));
  for (const seg of String(word).split(/[^A-Za-z0-9]+/)) candidates.add(normalizeAnswer(seg));

  for (const c of candidates) {
    if (c.length >= 4 && nClue.includes(c)) return true;
  }
  return false;
}

export async function handleUndercoverClue(sock, jid, senderNumber, messageObj, text) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'CLUE_PHASE') return false;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  if (!currentTurnPlayer || !samePlayer(senderNumber, currentTurnPlayer)) return false;

  const cleanClue = String(text || '').trim();
  if (cleanClue.length < 2) {
    await send(sock, jid, messageObj, "⚠️ Petunjuk terlalu pendek! Tulis minimal 2 karakter.");
    return true;
  }

  const pRole = getPlayerRoleData(session, currentTurnPlayer);

  if (clueLeaksSecret(cleanClue, pRole?.word)) {
    await send(sock, jid, messageObj, "❌ DILARANG menyebutkan kata rahasia Anda (atau bagian dari kata itu) dalam petunjuk! Tulis deskripsi/kiasan lain.");
    return true;
  }

  // Kartu Lakban: korban hanya boleh 1 kata
  if (session.silencedPlayers.has(currentTurnPlayer)) {
    const wc = cleanClue.split(/\s+/).filter(Boolean).length;
    if (wc > 1) {
      await send(sock, jid, messageObj, `🤐 *KAMU SEDANG DILAKBAN!* Petunjukmu hanya boleh *1 KATA* ronde ini (petunjukmu: ${wc} kata). Coba lagi!`);
      return true;
    }
  }

  if (session.modifier?.key === 'TIGA_KATA') {
    const wordCount = cleanClue.split(/\s+/).filter(Boolean).length;
    if (wordCount > 3) {
      await send(sock, jid, messageObj, `⚠️ *Tantangan Ronde Ini:* Maksimal hanya boleh *3 kata*! (Petunjukmu: ${wordCount} kata). Coba lagi!`);
      return true;
    }
  }

  if (session.modifier?.key === 'SATU_KATA') {
    const wordCount = cleanClue.split(/\s+/).filter(Boolean).length;
    if (wordCount > 1) {
      await send(sock, jid, messageObj, `🤫 *SUMPAH BISU!* Ronde ini petunjuk hanya boleh *1 KATA* (petunjukmu: ${wordCount} kata). Coba lagi!`);
      return true;
    }
  }

  // Petunjuk Estafet: wajib memuat salah satu kata dari petunjuk pemain
  // sebelumnya di ronde ini. Pembuka ronde otomatis bebas, begitu juga kalau
  // pemain sebelumnya ternyata skip/AFK (tidak ada kata untuk disambung).
  if (session.modifier?.key === 'ESTAFET' && session.turnIndex > 0) {
    const prevPlayer = session.alivePlayers[session.turnIndex - 1];
    const prevClue = prevPlayer ? clueOf(session, prevPlayer) : '';
    const prevWords = String(prevClue)
      .split(/[^A-Za-z0-9]+/)
      .map(w => normalizeAnswer(w))
      .filter(w => w.length >= 3);

    if (prevWords.length > 0) {
      const myWords = new Set(
        cleanClue.split(/[^A-Za-z0-9]+/).map(w => normalizeAnswer(w)).filter(Boolean)
      );
      const nyambung = prevWords.some(w => myWords.has(w));
      if (!nyambung) {
        await send(sock, jid, messageObj, `🔗 *PETUNJUK ESTAFET!* Petunjukmu wajib memuat salah satu kata dari petunjuk sebelumnya:\n_"${prevClue}"_\n\nCoba lagi dengan menyambung salah satu katanya.`);
        return true;
      }
    }
  }

  // Putaran ke-2 tidak boleh menyalin persis petunjuk sendiri di putaran 1
  if ((session.cluePass || 1) >= 2 && Array.isArray(pRole?.clueLog)) {
    const prev = pRole.clueLog.find(c => c.round === session.round && c.pass === 1);
    if (prev && normalizeAnswer(prev.text) === normalizeAnswer(cleanClue)) {
      await send(sock, jid, messageObj, "⚠️ Petunjuk putaran kedua tidak boleh sama persis dengan petunjuk pertamamu! Beri sudut pandang baru.");
      return true;
    }
  }

  recordClue(session, currentTurnPlayer, cleanClue);
  await advanceTurn(sock, jid, messageObj);
  return true;
}

// ─── 💬 FASE DISKUSI BEBAS ───────────────────────────────────────────
export async function startDiscussionPhase(sock, jid, messageObj, isResume = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'DISCUSSION_PHASE';
  session.discussionSkips = new Set();
  saveUndercoverSessions();

  const board = buildClueBoard(session);
  const header = isResume ? '🔄 *FASE DISKUSI DIPULIHKAN!*' : '💬 *SEMUA PETUNJUK SELESAI — FASE DISKUSI BEBAS!*';

  const msg =
`${header} 🗣️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Papan Petunjuk Ronde ${session.round}:*
${board}

🔎 *Silakan berdebat, saling tuduh, dan bela diri sekarang!*
⏳ Waktu diskusi: *${Math.round(DISCUSSION_TIMEOUT_MS / 1000)} detik* — setelah itu voting otomatis dibuka.
⏩ Ketik \`.lanjut\` untuk langsung membuka voting (Host/Admin instan, pemain biasa butuh 2 suara).`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'DISCUSSION_PHASE') return;
    await startVotingPhase(sock, jid, null);
  }, DISCUSSION_TIMEOUT_MS);

  await send(sock, jid, messageObj, msg, { mentions: session.alivePlayers });
}

export async function handleUndercoverContinue(sock, jid, senderNumber, messageObj, isAdmin = false, isOwner = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  if (session.status !== 'DISCUSSION_PHASE') {
    await send(sock, jid, messageObj, "❌ Perintah `.lanjut` hanya bisa dipakai saat fase diskusi Undercover.");
    return true;
  }

  const isHost = session.host && samePlayer(session.host, senderNumber);
  if (isHost || isAdmin || isOwner) {
    await send(sock, jid, messageObj, "⏩ *Diskusi ditutup lebih awal oleh Host/Admin!* Membuka fase voting...");
    return await startVotingPhase(sock, jid, messageObj) || true;
  }

  const voter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!voter) {
    await send(sock, jid, messageObj, "❌ Hanya pemain yang masih hidup yang bisa mempercepat diskusi!");
    return true;
  }

  if (!session.discussionSkips) session.discussionSkips = new Set();
  session.discussionSkips.add(voter);
  const needed = Math.min(2, Math.max(1, session.alivePlayers.length - 1));

  if (session.discussionSkips.size >= needed) {
    await send(sock, jid, messageObj, "⏩ *Diskusi ditutup atas kesepakatan pemain!* Membuka fase voting...");
    await startVotingPhase(sock, jid, messageObj);
    return true;
  }

  await send(sock, jid, messageObj, `⏩ ${tag(voter)} ingin langsung voting (${session.discussionSkips.size}/${needed} suara).`, { mentions: [voter] });
  return true;
}

// ─── 🗳️ FASE VOTING ELIMINASI ────────────────────────────────────────
export async function startVotingPhase(sock, jid, messageObj, isResume = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'VOTING_PHASE';
  if (!isResume) session.votes.clear();
  saveUndercoverSessions();

  const isSuddenDeath = session.round >= 4;
  const board = buildClueBoard(session);
  const header = isResume ? '🔄 *FASE VOTING DIPULIHKAN!*' : '🗳️ *DISKUSI SELESAI — FASE VOTING DIBUKA!*';
  const sisaSkip = Math.max(0, MAX_SKIPS - (session.skipCount || 0));

  const msg =
`${header} ⚖️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${board}

👉 *Pilihan Vote:*
• Ketik: \`.vote [nomor / @member]\` untuk mengeliminasi tersangka
${isSuddenDeath ? '🚫 *(Zona Merah: Vote Skip Dikunci)*' : `• Ketik: \`.vote skip\` (atau \`.skip\`) untuk **Abstain** (Sisa Kuota: ${sisaSkip}/${MAX_SKIPS})`}
⏳ Waktu voting: ${Math.round(VOTE_TIMEOUT_MS / 1000)} detik.`;

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'VOTING_PHASE') return;
    await processUndercoverVotes(sock, jid, null);
  }, VOTE_TIMEOUT_MS);

  await send(sock, jid, messageObj, msg, { mentions: session.alivePlayers });
}

// ─── ⏩ SKIP GILIRAN / ABSTAIN ────────────────────────────────────────
export async function handleUndercoverSkip(sock, jid, senderNumber, messageObj, text = '', isAdmin = false, isOwner = false) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  if (session.status === 'DISCUSSION_PHASE') {
    return await handleUndercoverContinue(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  if (session.status === 'VOTING_PHASE') {
    return await handleUndercoverVote(sock, jid, senderNumber, messageObj, 'SKIP');
  }

  if (session.status !== 'CLUE_PHASE') return false;

  const currentTurnPlayer = session.alivePlayers[session.turnIndex];
  if (!currentTurnPlayer) return false;

  const isCurrentTurn = samePlayer(senderNumber, currentTurnPlayer);
  const isHost = session.host && samePlayer(session.host, senderNumber);
  const isPrivileged = isHost || isAdmin || isOwner;

  if (!session.skipVotes) session.skipVotes = new Set();

  if (isCurrentTurn) {
    recordClue(session, currentTurnPlayer, '(Melewatkan giliran / Skip)');
    await send(sock, jid, messageObj, `⏩ ${tag(currentTurnPlayer)} memilih untuk **MELEWATKAN GILIRAN (SKIP)**!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  if (isPrivileged) {
    recordClue(session, currentTurnPlayer, '(Di-skip oleh Host/Admin)');
    await send(sock, jid, messageObj, `⏩ *FORCE SKIP:* Giliran ${tag(currentTurnPlayer)} dilewati oleh Host/Admin!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  const voter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!voter) return false;

  session.skipVotes.add(voter);
  const needed = Math.min(2, Math.max(1, session.alivePlayers.length - 1));

  if (session.skipVotes.size >= needed) {
    recordClue(session, currentTurnPlayer, '(Di-skip oleh voting pemain lain)');
    await send(sock, jid, messageObj, `⏩ *VOTE SKIP BERHASIL:* Giliran ${tag(currentTurnPlayer)} dilewati karena tidak merespons!`, { mentions: [currentTurnPlayer] });
    await advanceTurn(sock, jid, messageObj);
    return true;
  }

  await send(sock, jid, messageObj, `🗳️ ${tag(voter)} mengajukan vote skip untuk ${tag(currentTurnPlayer)} (${session.skipVotes.size}/${needed} suara diperlukan).`, { mentions: [voter, currentTurnPlayer] });
  return true;
}

// ─── 🔀 SKILL TUKAR GILIRAN UNDERCOVER (.tukargiliran) ──────────────────────
export async function handleUndercoverSwap(sock, jid, senderNumber, messageObj) {
  const { session, playerJid: resolvedSender } = findUndercoverSessionAndPlayer(senderNumber);
  if (!session || session.status !== 'CLUE_PHASE') {
    await send(sock, jid, messageObj, "❌ Skill tukar giliran hanya bisa dipakai saat fase petunjuk berlangsung!");
    return true;
  }

  const roleData = getPlayerRoleData(session, resolvedSender);
  if (!roleData || roleData.role !== 'UNDERCOVER') {
    await send(sock, jid, messageObj, "❌ Hanya Undercover yang memiliki skill tukar giliran!");
    return true;
  }
  if (!roleData.hasSwap) {
    await send(sock, jid, messageObj, "❌ Skill tukar giliran sudah kamu pakai (maksimal 1x per game)!");
    return true;
  }

  const idx = findAliveIndex(session, resolvedSender);
  if (idx === -1 || idx !== session.turnIndex) {
    await send(sock, jid, messageObj, "⚠️ Skill tukar giliran hanya bisa dipakai tepat saat giliranmu bicara!");
    return true;
  }
  if (session.turnIndex >= session.alivePlayers.length - 1) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di urutan terakhir, tidak ada giliran untuk ditukar!");
    return true;
  }

  roleData.hasSwap = false;
  const me = session.alivePlayers.splice(idx, 1)[0];
  session.alivePlayers.push(me);
  saveUndercoverSessions();

  const gameJid = session.jid;
  await send(sock, jid, messageObj, "🔀 *Skill Tukar Giliran dipakai!* Kamu dilempar ke urutan terakhir ronde ini. Dengarkan semua petunjuk dulu, baru bicara.");
  await send(sock, gameJid, null, `🔀 *PERGANTIAN URUTAN MENDADAK!* ${tag(me)} melempar gilirannya ke urutan paling akhir ronde ini!`, { mentions: [me] });
  await announceTurn(sock, gameJid, null);
  return true;
}

// ─── ☠️ ELIMINASI, INTEL KEMATIAN & SINKRONISASI GILIRAN ─────────────
export function killPlayer(session, jid, { byShoot = false } = {}) {
  const idx = findAliveIndex(session, jid);
  const roleData = getPlayerRoleData(session, jid);
  if (roleData) {
    roleData.isAlive = false;
    if (byShoot) roleData.killedByShoot = true;
  }
  if (idx === -1) return { idx: -1, wasCurrent: false };

  const wasCurrent = session.status === 'CLUE_PHASE' && idx === session.turnIndex;
  session.alivePlayers.splice(idx, 1);
  if (session.status === 'CLUE_PHASE' && idx < session.turnIndex) session.turnIndex--;

  // Bersihkan suara & efek yang menempel pada pemain yang gugur
  if (session.votes) {
    for (const voter of Array.from(session.votes.keys())) {
      if (samePlayer(voter, jid)) session.votes.delete(voter);
    }
  }
  session.goldenVoters?.delete(jid);
  session.shieldedPlayers?.delete(jid);
  session.silencedPlayers?.delete(jid);

  if (byShoot) {
    if (!Array.isArray(session.shotVictims)) session.shotVictims = [];
    if (!session.shotVictims.some(v => samePlayer(v, jid))) session.shotVictims.push(jid);
  }
  return { idx, wasCurrent };
}

// Dipanggil setelah ada kematian di luar jalur voting (tembakan) agar giliran
// bicara tidak macet. Tanpa ini, timer lama tidak cocok lagi dan game menggantung.
export async function resyncAfterDeath(sock, jid, killInfo) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  if (session.status === 'CLUE_PHASE') {
    if (!killInfo?.wasCurrent) return; // pembicara saat ini tidak berubah
    clearSessionTimer(session);
    if (session.turnIndex >= session.alivePlayers.length) {
      return await finishCluePass(sock, jid, null);
    }
    return await announceTurn(sock, jid, null, '🔄 *Giliran disesuaikan ulang setelah ada korban berjatuhan!*\n');
  }

  if (session.status === 'VOTING_PHASE') {
    if (session.votes.size >= session.alivePlayers.length && session.alivePlayers.length > 0) {
      clearSessionTimer(session);
      return await processUndercoverVotes(sock, jid, null);
    }
  }

  // Ronde Anonim & Sidang Terakhir juga bisa menggantung kalau orang yang
  // ditunggu setorannya/vonisnya keburu tewas ditembak di tengah fase.
  if (session.status === 'ANON_CLUE_PHASE') {
    const submitted = session.alivePlayers.filter(p => session.anonSubmitted?.has(p)).length;
    if (session.alivePlayers.length > 0 && submitted >= session.alivePlayers.length) {
      clearSessionTimer(session);
      return await finishAnonCluePhase(sock, jid, null);
    }
  }

  if (session.status === 'TRIAL_PHASE') {
    if (!session.trialAccused || !isAlive(session, session.trialAccused)) {
      clearSessionTimer(session);
      return await resolveTrial(sock, jid, null);
    }
    const totalJuri = session.alivePlayers.length - 1;
    const cast = session.alivePlayers.filter(p => session.trialVotes?.has(p)).length;
    if (totalJuri > 0 && cast >= totalJuri) {
      clearSessionTimer(session);
      return await resolveTrial(sock, jid, null);
    }
  }
}

// Pemain yang gugur dikirimi bocoran seluruh peran via DM (dead chat).
export async function sendDeathIntel(sock, session, deadJid, cause = 'tereliminasi') {
  // Badge publik: identitas Si Mabuk tetap dirahasiakan bahkan dari alam baka,
  // karena arwah sekarang punya saluran bicara (Bisikan Arwah) dan reveal-nya
  // adalah puncak rekap akhir.
  const board = session.players.map(p => {
    const rd = getPlayerRoleData(session, p);
    const mark = isAlive(session, p) ? '🟢 HIDUP' : '⚫ GUGUR';
    return `${mark} — ${plainLabel(session, p)}\n     ${getPublicRoleBadge(rd?.role)}`;
  }).join('\n');

  const kataUnder = session.pair.undercover2 && session.pair.undercover2 !== session.pair.undercover
    ? `*${session.pair.undercover}* & *${session.pair.undercover2}* (penyamar dapat kata BERBEDA game ini!)`
    : `*${session.pair.undercover}*`;

  await dm(sock, deadJid,
`👻 *KAMU SUDAH GUGUR — AKSES INTEL ALAM BAKA* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kamu ${cause} di Ronde ${session.round}. Sebagai arwah, kamu berhak tahu semuanya:

💡 Kata Warga: *${session.pair.civilian}*
🤫 Kata Undercover: ${kataUnder}

📋 *Bocoran Seluruh Peran:*
${board}

👻 *SATU HAK ARWAH:* tiap ronde kamu boleh menitip *1 bisikan anonim* ke grup lewat DM:
\`.bisik <maks ${GHOST_WHISPER_MAX_WORDS} kata>\`
🚫 Dilarang menyebut nama, nomor, atau kata rahasia — bisikan seperti itu otomatis ditolak bot.

🚫 *DILARANG KERAS membocorkan intel di atas mentah-mentah ke grup!* Nikmati sisa permainan sebagai dalang dari balik layar.`);
}

// ─── 🗳️ PEMROSESAN HASIL VOTING ──────────────────────────────────────
export async function processUndercoverVotes(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  const voteCounts = new Map();
  if (!Array.isArray(session.voteHistory)) session.voteHistory = [];
  for (const [voter, target] of session.votes.entries()) {
    if (!isAlive(session, voter)) continue;
    const weight = session.goldenVoters?.has(voter) ? 2 : 1;
    voteCounts.set(target, (voteCounts.get(target) || 0) + weight);
    // Riwayat suara dipakai Trust Score & penilaian misi di akhir game.
    session.voteHistory.push({ round: session.round, voter, target, weight });
  }

  if (session.framedPlayer && isAlive(session, session.framedPlayer)) {
    const framed = session.framedPlayer;
    voteCounts.set(framed, (voteCounts.get(framed) || 0) + 1);
    await send(sock, jid, messageObj, `🗣️ *JEJAK FITNAH TERBUKTI!* ${tag(framed)} terkena **+1 Suara Kutukan Tambahan** dari aksi Framer!`, { mentions: [framed] });
  }
  session.framedPlayer = null;

  let maxVotes = 0;
  let eliminated = null;
  let isTie = false;
  for (const [target, count] of voteCounts.entries()) {
    if (count > maxVotes) { maxVotes = count; eliminated = target; isTie = false; }
    else if (count === maxVotes) isTie = true;
  }

  if (isTie || !eliminated || eliminated === 'SKIP') {
    if (eliminated === 'SKIP' && !isTie) session.skipCount = (session.skipCount || 0) + 1;
    const reasonMsg = (eliminated === 'SKIP' && !isTie)
      ? `⚖️ *HASIL VOTING TERBANYAK ADALAH SKIP / ABSTAIN!* Tidak ada pemain yang dieliminasi ronde ini. (Penggunaan Skip: ${session.skipCount}/${MAX_SKIPS})`
      : `⚖️ *HASIL VOTING SERI / IMBANG!* Tidak ada yang dieliminasi ronde ini.`;
    await send(sock, jid, messageObj, `${reasonMsg}\nPermainan dilanjutkan ke ronde berikutnya!`);
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  // ⚖️ Sidang Terakhir: tersangka dengan suara terbanyak berhak membela diri
  // sebelum palu diketuk. Dilewati di Zona Merah (Ronde 4+, di sana skip memang
  // sudah dikunci — vonis bebas akan jadi skip terselubung) dan saat pemain
  // tinggal 3, karena di sana sidang hanya memperpanjang endgame.
  if (session.round < 4 && session.alivePlayers.length >= 4) {
    return await startTrialPhase(sock, jid, messageObj, eliminated, maxVotes);
  }

  return await executeElimination(sock, jid, messageObj, eliminated, maxVotes);
}

// ─── ⚖️ SIDANG TERAKHIR (PEMBELAAN + VONIS) ──────────────────────────
export async function startTrialPhase(sock, jid, messageObj, accused, maxVotes) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  session.status = 'TRIAL_PHASE';
  session.trialAccused = accused;
  session.trialVotes = new Map();
  session.trialMaxVotes = maxVotes;
  saveUndercoverSessions();

  const hakim = session.alivePlayers.filter(p => !samePlayer(p, accused));
  await send(sock, jid, messageObj,
`⚖️ *SIDANG TERAKHIR DIBUKA!* 🔨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Terdakwa:* ${tag(accused)} (${maxVotes} suara)

🗣️ ${tag(accused)}, kamu punya *${Math.round(TRIAL_MS / 1000)} detik* untuk membela diri di grup ini. Bicaralah sekarang!

⚖️ *Juri (${hakim.length} orang), ketik vonis kalian:*
• \`.bersalah\` — eksekusi tetap dijalankan
• \`.bebas\` — eksekusi DIBATALKAN, tidak ada yang mati ronde ini

📌 *Aturan Vonis:* eksekusi jalan kalau suara *BERSALAH* lebih banyak. Seri atau mayoritas *BEBAS* ➔ terdakwa lolos.
🚫 _Terdakwa tidak ikut memilih. Yang tidak memilih dianggap abstain._`, { mentions: [accused, ...hakim] });

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'TRIAL_PHASE') return;
    await resolveTrial(sock, jid, null);
  }, TRIAL_MS);
}

export async function handleTrialVote(sock, jid, senderNumber, messageObj, verdict) {
  const session = activeUndercoverGames.get(jid) || findUndercoverSessionAndPlayer(senderNumber).session;
  if (!session || session.status !== 'TRIAL_PHASE') {
    await send(sock, jid, messageObj, "❌ Saat ini tidak ada Sidang Terakhir Undercover yang sedang berjalan.");
    return true;
  }

  const juror = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!juror) {
    await send(sock, jid, messageObj, "❌ Hanya pemain yang masih hidup yang boleh menjatuhkan vonis!");
    return true;
  }
  if (samePlayer(juror, session.trialAccused)) {
    await send(sock, jid, messageObj, "⚠️ Terdakwa tidak boleh ikut menjatuhkan vonis atas dirinya sendiri! Bela dirimu saja.");
    return true;
  }

  if (!session.trialVotes) session.trialVotes = new Map();
  session.trialVotes.set(juror, verdict);
  saveUndercoverSessions();

  const totalJuri = session.alivePlayers.length - 1;
  const label = verdict === 'GUILTY' ? '🔨 *BERSALAH*' : '🕊️ *BEBAS*';
  await send(sock, session.jid, messageObj, `⚖️ ${tag(juror)} menjatuhkan vonis ${label}! (${session.trialVotes.size}/${totalJuri} juri)`, { mentions: [juror] });

  if (session.trialVotes.size >= totalJuri) {
    clearSessionTimer(session);
    await resolveTrial(sock, session.jid, null);
  }
  return true;
}

async function resolveTrial(sock, jid, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'TRIAL_PHASE') return;
  clearSessionTimer(session);

  const accused = session.trialAccused;
  const maxVotes = session.trialMaxVotes || 0;
  let guilty = 0;
  let innocent = 0;
  for (const v of (session.trialVotes?.values() || [])) {
    if (v === 'GUILTY') guilty++;
    else innocent++;
  }

  session.trialAccused = null;
  session.trialVotes = new Map();
  session.trialMaxVotes = 0;

  if (!accused || !isAlive(session, accused)) {
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  if (guilty <= innocent) {
    saveUndercoverSessions();
    await send(sock, jid, messageObj,
`🕊️ *TERDAKWA DIBEBASKAN!* ⚖️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vonis juri: *${guilty} Bersalah* vs *${innocent} Bebas*.
${tag(accused)} lolos dari eksekusi ronde ini!

_Permainan lanjut ke ronde berikutnya._`, { mentions: [accused] });
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  await send(sock, jid, messageObj, `🔨 *PALU DIKETUK — VONIS BERSALAH!* ⚖️\nJuri memutuskan *${guilty} Bersalah* vs *${innocent} Bebas*. Eksekusi dilanjutkan!`, { mentions: [accused] });
  return await executeElimination(sock, jid, messageObj, accused, maxVotes);
}

// ─── ☠️ EKSEKUSI HASIL VOTING ────────────────────────────────────────
export async function executeElimination(sock, jid, messageObj, eliminated, maxVotes) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);

  if (session.guardedPlayer && samePlayer(session.guardedPlayer, eliminated)) {
    session.guardedPlayer = null;
    await send(sock, jid, messageObj, `🛡️ *GUARDIAN MENYELAMATKAN DARI EKSEKUSI!* 🛡️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${tag(eliminated)} seharusnya dieksekusi oleh voting grup, namun Bodyguard berhasil melindunginya dari maut! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  if (session.shieldedPlayers?.has(eliminated)) {
    session.shieldedPlayers.delete(eliminated);
    await send(sock, jid, messageObj, `🛡️ *ROMPI ANTI-PELURU AKTIF!* ${tag(eliminated)} selamat dari eksekusi vote berkat Rompi Pelindung! Eksekusi dibatalkan ronde ini.`, { mentions: [eliminated] });
    saveUndercoverSessions();
    return await startNextUndercoverRound(sock, jid, messageObj);
  }

  const eliminatedRole = getPlayerRoleData(session, eliminated);
  killPlayer(session, eliminated);

  if (!Array.isArray(session.eliminations)) session.eliminations = [];
  session.eliminations.push({ round: session.round, jid: eliminated, votes: maxVotes });

  // Peran dibuka dengan badge PUBLIK: Si Mabuk tetap tampil sebagai Warga Sipil
  // sampai rekap akhir, karena kejutannya justru ada di reveal penutup.
  await send(sock, jid, messageObj, `☠️ *${tag(eliminated)}* resmi dieliminasi dari grup dengan ${maxVotes} suara!\n🎭 Peran Terbuka: *${getPublicRoleBadge(eliminatedRole?.role)}*`, { mentions: [eliminated] });
  saveUndercoverSessions();

  // 1. Kemenangan solo Si Badut (Jester Solo Win)
  if (eliminatedRole?.role === 'JESTER') {
    try { await db.bumpUndercoverCounter(eliminated, 'jester_win'); } catch (e) {}
    return await finishGame(sock, jid, {
      headline: `🃏 *SI BADUT (JESTER) MENANG SOLO TELAK!* 🤡`,
      detail: `🎉 *PLOT TWIST RONDE ${session.round}!* ${tag(eliminated)} berhasil memprovokasi grup agar mem-vote dirinya keluar!\n_Seluruh pot taruhan disapu bersih oleh Si Badut!_`,
      winners: [eliminated],
      xpEach: 150
    });
  }

  await sendDeathIntel(sock, session, eliminated, 'dieksekusi lewat voting grup');

  // 2. Mr. White dapat kesempatan tebak kata terakhir
  if (eliminatedRole?.role === 'MRWHITE') {
    session.status = 'MR_WHITE_GUESS';
    session.mrWhiteGuessPending = eliminated;
    saveUndercoverSessions();
    await send(sock, jid, messageObj, `🤍 *MR. WHITE DIBERI KESEMPATAN TERAKHIR!* 🤍\n${tag(eliminated)} punya ${Math.round(MRWHITE_GUESS_MS / 1000)} detik untuk menebak kata warga sipil!\n👉 Ketik: \`.tebakwarga <kata>\``, { mentions: [eliminated] });
    return await armMrWhiteGuessTimer(sock, jid, eliminated);
  }

  const isWon = await checkUndercoverWinCondition(sock, jid);
  if (!isWon) await startNextUndercoverRound(sock, jid, messageObj, false);
}

export async function armMrWhiteGuessTimer(sock, jid, pendingJid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;
  clearSessionTimer(session);
  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'MR_WHITE_GUESS') return;
    cur.mrWhiteGuessPending = null;
    await send(sock, jid, null, `⏰ Waktu Mr. White habis! Kata warga tidak tertebak.`);
    const isWon = await checkUndercoverWinCondition(sock, jid);
    if (!isWon) await startNextUndercoverRound(sock, jid, null, false);
  }, MRWHITE_GUESS_MS);
}

export async function handleUndercoverVote(sock, jid, senderNumber, messageObj, targetJid) {
  let session = activeUndercoverGames.get(jid);
  if (!session) {
    const found = findUndercoverSessionAndPlayer(senderNumber);
    session = found.session;
  }
  if (!session) {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  // Voting kategori kata sebelum game dimulai
  if (session.status === 'CATEGORY_VOTE') {
    return await handleCategoryVote(sock, session.jid, senderNumber, messageObj, targetJid);
  }

  // Sidang Terakhir punya perintah vonisnya sendiri — arahkan ke sana supaya
  // pemain tidak mengira suaranya hilang.
  if (session.status === 'TRIAL_PHASE') {
    await send(sock, jid, messageObj, `⚖️ *Sedang berlangsung Sidang Terakhir untuk ${tag(session.trialAccused)}!*\nFase voting sudah tutup. Jatuhkan vonismu dengan \`.bersalah\` atau \`.bebas\`.`, { mentions: session.trialAccused ? [session.trialAccused] : [] });
    return true;
  }

  // Vote saat diskusi = langsung tutup diskusi lalu catat suaranya
  if (session.status === 'DISCUSSION_PHASE') {
    await send(sock, session.jid, null, "⏩ *Ada yang sudah mantap memilih!* Fase diskusi ditutup, voting dibuka sekarang.");
    await startVotingPhase(sock, session.jid, null);
  }

  if (session.status !== 'VOTING_PHASE') {
    await send(sock, jid, messageObj, "❌ Saat ini bukan fase voting Undercover.");
    return true;
  }

  const resolvedVoter = session.alivePlayers.find(p => samePlayer(p, senderNumber));
  if (!resolvedVoter) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur/mati tidak dapat memberikan suara!");
    return true;
  }

  let rawTarget = targetJid ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
    messageObj?.message?.extendedTextMessage?.contextInfo?.participant;

  const isSkipVote = ['skip', '0', 'lewat', 'abstain', 'pass', 'voteskip'].includes(String(rawTarget || '').trim().toLowerCase());
  let resolvedTarget = null;

  if (isSkipVote) {
    if (session.round >= 4) {
      await send(sock, jid, messageObj, "🚨 *ZONA MERAH (SUDDEN DEATH)!* Mulai Ronde 4, opsi vote skip dikunci. Seluruh pemain wajib memilih salah satu tersangka!");
      return true;
    }
    if ((session.skipCount || 0) >= MAX_SKIPS) {
      await send(sock, jid, messageObj, `❌ *KUOTA VOTE SKIP HABIS!* Vote skip hanya bisa dipakai ${MAX_SKIPS}x per game. Silakan pilih tersangka!`);
      return true;
    }
    resolvedTarget = 'SKIP';
  } else if (rawTarget) {
    resolvedTarget = resolveTargetInSession(session, rawTarget);
  }

  if (!resolvedTarget || (resolvedTarget !== 'SKIP' && !isAlive(session, resolvedTarget))) {
    const isSd = session.round >= 4;
    await send(sock, jid, messageObj, `⚠️ Target vote tidak valid atau sudah mati!\n👉 *Cara Vote:* \`.vote @member\`, nomor urut \`.vote [1-${session.alivePlayers.length}]\`${isSd ? '' : ' atau `.vote skip` (Abstain)'}`);
    return true;
  }

  if (resolvedTarget !== 'SKIP' && samePlayer(resolvedTarget, resolvedVoter)) {
    await send(sock, jid, messageObj, `⚠️ Kamu tidak bisa mem-vote dirimu sendiri! ${session.round >= 4 ? 'Wajib pilih pemain lain!' : 'Jika ingin abstain, ketik `.vote skip`.'}`);
    return true;
  }

  session.votes.set(resolvedVoter, resolvedTarget);
  saveUndercoverSessions();

  const isGolden = session.goldenVoters?.has(resolvedVoter);
  const goldNote = isGolden ? '🌟 *(Golden Vote x2)*' : '';

  if (resolvedTarget === 'SKIP') {
    await send(sock, session.jid, messageObj, `🗳️ ${tag(resolvedVoter)} memilih **SKIP / ABSTAIN**! ${goldNote} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter] });
  } else {
    await send(sock, session.jid, messageObj, `🗳️ ${tag(resolvedVoter)} mem-vote ${tag(resolvedTarget)}! ${goldNote} (${session.votes.size}/${session.alivePlayers.length} suara)`, { mentions: [resolvedVoter, resolvedTarget] });
  }

  if (session.votes.size >= session.alivePlayers.length) {
    clearSessionTimer(session);
    await processUndercoverVotes(sock, session.jid, messageObj);
  }
  return true;
}


export async function finishGame(sock, jid, { headline, detail, winners = [], xpEach = 100 }) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return true;
  clearSessionTimer(session);

  const totalPrize = session.buyIn * session.players.length;
  const uniqWinners = [];
  for (const w of winners) {
    if (w && !uniqWinners.some(u => samePlayer(u, w))) uniqWinners.push(w);
  }

  const prizePer = uniqWinners.length > 0 ? Math.floor(totalPrize / uniqWinners.length) : 0;
  for (const w of uniqWinners) {
    await db.addGamePoints(w, prizePer);
    await db.grantXp(w, xpEach);
  }

  // Konsolasi Si Badut: gagal menang tapi selamat sampai akhir ➔ taruhan dikembalikan
  let jesterNote = '';
  const survivingJester = session.alivePlayers.filter(p => {
    const rd = getPlayerRoleData(session, p);
    return rd?.role === 'JESTER' && !uniqWinners.some(u => samePlayer(u, p));
  });
  for (const j of survivingJester) {
    await db.addGamePoints(j, session.buyIn);
    jesterNote += `\n🤡 *Konsolasi Si Badut:* ${tag(j)} selamat sampai akhir ➔ taruhan *${session.buyIn} Poin* dikembalikan.`;
  }

  await recordMatchStats(session, uniqWinners, prizePer);

  // Bonus misi dibayar setelah statistik pertandingan tercatat supaya tidak ikut
  // terhitung sebagai kemenangan/hadiah pot.
  let missionNote = '';
  try {
    missionNote = await resolveMissions(session);
  } catch (e) {
    console.error('[UNDERCOVER] Gagal menilai misi rahasia:', e.message);
  }

  const winnerLine = uniqWinners.length > 0
    ? `\n🏆 *Pemenang:* ${uniqWinners.map(w => tag(w)).join(', ')}\n🎁 *Hadiah Tiap Pemenang:* *+${prizePer.toLocaleString('id-ID')} Poin* & *+${xpEach} XP*`
    : `\n🤷 Tidak ada pemenang di permainan ini.`;

  const kataUnderLine = session.pair.undercover2 && session.pair.undercover2 !== session.pair.undercover
    ? `🤫 Kata Undercover: *${session.pair.undercover}* & *${session.pair.undercover2}*\n🎭 _Ronde ini kedua penyamar sengaja dikasih kata BERBEDA — mereka pun tidak bisa saling bersandar!_`
    : `🤫 Kata Undercover: *${session.pair.undercover}*`;

  const msg =
`${headline}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${detail}

💡 Kata Warga: *${session.pair.civilian}*
${kataUnderLine}
📚 Tema: *${THEMES[session.theme]?.label || 'Acak'}*${winnerLine}${jesterNote}${buildFinalRecap(session)}${missionNote}${buildDeadliestClue(session)}${buildTrustBoard(session)}

📊 Ketik \`.undercover stats\` untuk melihat statistikmu, atau \`.undercover top\` untuk papan peringkat.`;

  const mentions = [...new Set([...uniqWinners, ...survivingJester])];
  activeUndercoverGames.delete(jid);
  saveUndercoverSessions();
  await send(sock, jid, null, msg, { mentions });
  return true;
}

export async function checkUndercoverWinCondition(sock, jid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return false;

  const aliveUndercover = session.alivePlayers.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
  const aliveMrWhite = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'MRWHITE');
  const aliveCivilians = session.alivePlayers.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
  const aliveBunglon = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'BUNGLON');
  const totalAlive = session.alivePlayers.length;

  // 1. Seluruh penyamar & Mr. White gugur ➔ Warga menang
  if (aliveUndercover.length === 0 && aliveMrWhite.length === 0) {
    const civTeam = session.players.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
    const bunglonText = aliveBunglon.length > 0
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => tag(b)).join(', ')} (Ikut menang karena selamat!)`
      : '';
    return await finishGame(sock, jid, {
      headline: `🎉 *WARGA SIPIL MENANG! (CIVILIAN VICTORY)* 🛡️`,
      detail: `Seluruh penyamar berhasil dibongkar dan dieliminasi warga!${bunglonText}`,
      winners: [...civTeam, ...aliveBunglon],
      xpEach: 80
    });
  }

  // 2. Kemenangan Kubu Penyamar (Undercover Victory):
  //    Penyamar HANYA menang jika:
  //    a) Seluruh Warga Sipil sudah habis (aliveCivilians.length === 0), ATAU
  //    b) Sisa pemain hidup <= 2 orang (misal 1v1), ATAU
  //    c) Penyamar menguasai mayoritas mutlak dari SELURUH pemain hidup (aliveUndercover.length * 2 > totalAlive).
  //    Jika masih ada pemain Netral dan Warga yang bisa membalikkan keadaan (misal 1 Under, 1 Netral, 1 Warga), game TETAP LANJUT!
  const isUndercoverDominant = (aliveCivilians.length === 0) || 
    (totalAlive <= 2 && aliveUndercover.length > 0) || 
    (aliveUndercover.length * 2 > totalAlive);

  if (aliveUndercover.length > 0 && isUndercoverDominant) {
    const underTeam = session.players.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
    const bunglonText = aliveBunglon.length > 0
      ? `\n🦎 *Bunglon Berjaya:* ${aliveBunglon.map(b => tag(b)).join(', ')} (Ikut menang karena selamat!)`
      : '';
    return await finishGame(sock, jid, {
      headline: `🎭 *UNDERCOVER MENANG! (IMPOSTOR VICTORY)* 🕵️`,
      detail: `Penyamar berhasil menguasai permainan dan mengeliminasi mayoritas warga!${bunglonText}`,
      winners: [...underTeam, ...aliveMrWhite, ...aliveBunglon],
      xpEach: 120
    });
  }

  // 3. Penyamar habis tapi Mr. White menguasai lapangan ➔ Mr. White menang solo
  const isMrWhiteDominant = aliveUndercover.length === 0 && aliveMrWhite.length > 0 && 
    ((aliveCivilians.length === 0) || (totalAlive <= 2) || (aliveMrWhite.length * 2 > totalAlive));

  if (isMrWhiteDominant) {
    return await finishGame(sock, jid, {
      headline: `🤍 *MR. WHITE MENANG SOLO! (BLANK VICTORY)* 👻`,
      detail: `Semua penyamar sudah gugur, tapi Mr. White justru bertahan sampai warga kehabisan orang!`,
      winners: [...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  return false;
}

export async function resolveMaxRoundLimit(sock, jid) {
  const session = activeUndercoverGames.get(jid);
  if (!session) return;

  const aliveUndercover = session.alivePlayers.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
  const aliveMrWhite = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'MRWHITE');
  const aliveBunglon = session.alivePlayers.filter(p => getPlayerRoleData(session, p)?.role === 'BUNGLON');

  if (aliveUndercover.length > 0) {
    const underTeam = session.players.filter(p => isUndercoverRole(getPlayerRoleData(session, p)?.role));
    return await finishGame(sock, jid, {
      headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🕵️👑`,
      detail: `Warga sipil kehabisan waktu dan gagal membongkar penyamar!\n🏆 *UNDERCOVER MENANG SURVIVAL!* 🎭`,
      winners: [...underTeam, ...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  if (aliveMrWhite.length > 0) {
    return await finishGame(sock, jid, {
      headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🤍`,
      detail: `Semua penyamar sudah gugur, tapi warga tidak pernah berhasil membekuk Mr. White!\n🏆 *MR. WHITE MENANG SURVIVAL!* 👻`,
      winners: [...aliveMrWhite, ...aliveBunglon],
      xpEach: 150
    });
  }

  const civTeam = session.players.filter(p => isCivilianRole(getPlayerRoleData(session, p)?.role));
  return await finishGame(sock, jid, {
    headline: `⌛ *BATAS MAKSIMAL ${MAX_ROUNDS} RONDE TERCAPAI!* 🛡️`,
    detail: `Tidak ada penyamar tersisa di lapangan — warga bertahan sampai peluit akhir!\n🏆 *WARGA SIPIL MENANG SURVIVAL!*`,
    winners: [...civTeam, ...aliveBunglon],
    xpEach: 100
  });
}

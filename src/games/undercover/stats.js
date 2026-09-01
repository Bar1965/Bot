// ─── 📊 REKAP, TRUST SCORE, MISI & PAPAN PERINGKAT UNDERCOVER ────────
// Semua di sini bersifat penilaian/penyajian: tidak ada yang mengubah alur
// permainan, jadi modul ini aman diimpor `flow.js` tanpa membentuk cycle.

import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { MISSION_DEFS, MISSION_BONUS_MIN, MISSION_BONUS_XP } from './constants.js';
import {
  getPlayerRoleData, getRoleBadge, isAlive, isCivilianRole,
  plainLabel, samePlayer, tag, factionOf
} from './state.js';

// ─── 🏁 PENUTUPAN GAME, REKAP & STATISTIK ────────────────────────────
export function buildFinalRecap(session) {
  const lines = session.players.map(p => {
    const rd = getPlayerRoleData(session, p);
    const mark = isAlive(session, p) ? '🟢' : '⚫';
    const clues = Array.isArray(rd?.clueLog) ? rd.clueLog : [];
    const byRound = new Map();
    for (const c of clues) {
      if (!byRound.has(c.round)) byRound.set(c.round, []);
      byRound.get(c.round).push(String(c.text || '').slice(0, 40));
    }
    const clueText = byRound.size > 0
      ? Array.from(byRound.entries()).map(([r, list]) => `R${r}: "${list.join(' → ')}"`).join(' | ')
      : '(tidak sempat memberi petunjuk)';
    const drunkNote = rd?.role === 'DRUNK'
      ? `\n     🍺 _Sepanjang game dia mengira dirinya Warga biasa — katanya "${rd.word}", padahal kata warga "${session.pair?.civilian}"!_`
      : '';
    return `${mark} ${plainLabel(session, p)}\n     ${getRoleBadge(rd?.role)}\n     💬 ${clueText}${drunkNote}`;
  }).join('\n');

  return `\n\n🎬 *REKAP LENGKAP PERMAINAN* 🎞️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${lines}`;
}

// ─── 📊 TRUST SCORE & PETUNJUK PALING MEMATIKAN ──────────────────────
// Murni hiburan pasca-game: tidak pernah menyentuh win condition maupun hadiah.
// Semua angkanya dihitung dari data yang memang sudah dicatat sesi
// (voteHistory, eliminations, clueLog) — tidak ada state tambahan yang perlu
// dijaga di tengah permainan.
function clueIsSkip(text) {
  const t = String(text || '');
  return t.includes('Melewatkan giliran') || t.includes('Di-skip');
}

export function computeTrustScores(session) {
  const history = Array.isArray(session.voteHistory) ? session.voteHistory : [];

  return session.players.map(p => {
    const rd = getPlayerRoleData(session, p);
    let score = 50;

    for (const v of history) {
      if (!samePlayer(v.voter, p)) continue;
      if (v.target === 'SKIP') { score -= 2; continue; }
      const targetRole = getPlayerRoleData(session, v.target)?.role;
      // Menuduh orang yang ternyata bukan warga = insting bagus.
      if (targetRole && !isCivilianRole(targetRole)) score += 10;
      else score -= 6;
    }

    // Tiap suara yang mendarat di kepalamu = kamu tampak mencurigakan.
    const suspicion = history.filter(v => v.target !== 'SKIP' && samePlayer(v.target, p)).length;
    score -= suspicion * 4;

    const clues = Array.isArray(rd?.clueLog) ? rd.clueLog : [];
    for (const c of clues) score += clueIsSkip(c.text) ? -5 : 2;

    if (isAlive(session, p)) score += 8;

    return { jid: p, score: Math.max(0, Math.min(100, Math.round(score))) };
  }).sort((a, b) => b.score - a.score);
}

export function buildTrustBoard(session) {
  const scores = computeTrustScores(session);
  if (scores.length === 0) return '';

  const medals = ['🥇', '🥈', '🥉'];
  const lines = scores.map((s, i) => {
    let note = '';
    if (i === 0) note = ' _(Paling Dipercaya)_';
    else if (i === scores.length - 1 && scores.length >= 3) note = ' _(Paling Mencurigakan 🤡)_';
    return `${medals[i] || `${i + 1}.`} ${plainLabel(session, s.jid)} — *${s.score}/100*${note}`;
  }).join('\n');

  return `\n\n📊 *TRUST SCORE AKHIR GAME* 🧠\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${lines}\n_Skor ini cuma bahan bully — tidak mempengaruhi hadiah._`;
}

export function buildDeadliestClue(session) {
  const elims = Array.isArray(session.eliminations) ? session.eliminations : [];
  if (elims.length === 0) return '';

  let worst = null;
  for (const e of elims) {
    if (!worst || (e.votes || 0) > (worst.votes || 0)) worst = e;
  }
  if (!worst) return '';

  const rd = getPlayerRoleData(session, worst.jid);
  const clues = Array.isArray(rd?.clueLog) ? rd.clueLog : [];
  const fatal = clues.filter(c => c.round === worst.round).map(c => c.text).join(' → ');
  if (!fatal) return '';

  return `\n\n☠️ *PETUNJUK PALING MEMATIKAN RONDE INI* 🔪\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💬 _"${fatal}"_\n👤 ${plainLabel(session, worst.jid)} (Ronde ${worst.round}) — ${worst.votes} suara langsung menguburnya.`;
}

// ─── 🎯 PENILAIAN MISI RAHASIA PERSONAL ──────────────────────────────
function missionAchieved(session, jid, mission) {
  if (!mission) return false;
  const history = Array.isArray(session.voteHistory) ? session.voteHistory : [];
  const elims = Array.isArray(session.eliminations) ? session.eliminations : [];
  const rd = getPlayerRoleData(session, jid);

  switch (mission.key) {
    case 'SURVIVOR':
      return isAlive(session, jid);

    case 'PEMBURU': {
      const hits = history.filter(v => {
        if (!samePlayer(v.voter, jid) || v.target === 'SKIP') return false;
        const role = getPlayerRoleData(session, v.target)?.role;
        return role && !isCivilianRole(role);
      }).length;
      return hits >= 2;
    }

    case 'TAK_TERSANGKA': {
      const perRound = new Map();
      for (const v of history) {
        if (v.target === 'SKIP' || !samePlayer(v.target, jid)) continue;
        perRound.set(v.round, (perRound.get(v.round) || 0) + 1);
      }
      for (const count of perRound.values()) {
        if (count > 1) return false;
      }
      return true;
    }

    case 'PELINDUNG':
      return !!mission.targetJid && isAlive(session, mission.targetJid);

    case 'ORATOR': {
      const clues = Array.isArray(rd?.clueLog) ? rd.clueLog : [];
      if (clues.length === 0) return false;
      return clues.every(c => !clueIsSkip(c.text));
    }

    case 'EKSEKUTOR': {
      const elimRounds = new Set(elims.map(e => e.round));
      const rounds = new Set();
      for (const v of history) {
        if (!samePlayer(v.voter, jid) || v.target === 'SKIP') continue;
        if (elimRounds.has(v.round)) rounds.add(v.round);
      }
      return rounds.size >= 2;
    }

    default:
      return false;
  }
}

/**
 * Nilai seluruh misi rahasia lalu bayarkan bonusnya.
 *
 * Bonus sengaja dibayar DI LUAR pot taruhan (`addGamePoints`, bukan
 * `awardGamePoints`) supaya tidak memotong hadiah pemenang dan tidak ikut
 * menaikkan `games_played` — pertandingannya sudah dicatat `recordMatchStats`
 * (AGENTS.md §12i).
 */
export async function resolveMissions(session) {
  const bonus = Math.max(MISSION_BONUS_MIN, Math.round((session.buyIn || 30) * 0.5));
  const done = [];
  const failed = [];

  for (const p of session.players) {
    const rd = getPlayerRoleData(session, p);
    const mission = rd?.mission;
    if (!mission) continue;

    const def = MISSION_DEFS.find(m => m.key === mission.key);
    const label = def ? def.name : mission.key;
    const targetNote = mission.targetJid ? ` (${plainLabel(session, mission.targetJid)})` : '';

    if (missionAchieved(session, p, mission)) {
      try {
        await db.addGamePoints(p, bonus);
        await db.grantXp(p, MISSION_BONUS_XP);
      } catch (e) {
        console.error('[UNDERCOVER] Gagal membayar bonus misi:', e.message);
      }
      done.push(`✅ ${plainLabel(session, p)} — *${label}*${targetNote} ➔ +${bonus} Poin`);
    } else {
      failed.push(`❌ ${plainLabel(session, p)} — *${label}*${targetNote}`);
    }
  }

  if (done.length === 0 && failed.length === 0) return '';

  const body = [...done, ...failed].join('\n');
  return `\n\n🎯 *HASIL MISI RAHASIA PERSONAL* 🕯️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${body}\n_Bonus misi dibayar di luar pot taruhan._`;
}

export async function recordMatchStats(session, winners, prizePer) {
  for (const p of session.players) {
    const rd = getPlayerRoleData(session, p);
    const won = winners.some(w => samePlayer(w, p));
    try {
      await db.recordUndercoverResult(p, {
        faction: factionOf(rd?.role),
        role: rd?.role || 'CIVILIAN',
        won,
        prize: won ? prizePer : 0
      });
    } catch (e) {
      console.error('[UNDERCOVER] Gagal menyimpan statistik:', e.message);
    }
  }
}

// ─── 📊 STATISTIK & PAPAN PERINGKAT ──────────────────────────────────
export function winRateText(won, played) {
  if (!played) return '0%';
  return `${Math.round((won / played) * 100)}%`;
}

export function agentTitle(stats) {
  const played = stats.games_played || 0;
  const won = stats.games_won || 0;
  if (played < 5) return '🥚 Agen Magang';
  const rate = won / played;
  if (rate >= 0.7) return '👑 Legenda Undercover';
  if (rate >= 0.55) return '🎖️ Agen Elite';
  if (rate >= 0.4) return '🕵️ Agen Lapangan';
  return '🧑‍🌾 Warga Biasa';
}

export async function showUndercoverStats(sock, jid, senderNumber, messageObj) {
  const cust = await db.getCustomerByPhone(senderNumber);
  const name = cust?.nama || tag(senderNumber);
  const prof = await db.getGameProfile(senderNumber);

  let s;
  try {
    s = await db.getUndercoverStats(senderNumber);
  } catch (e) {
    s = null;
  }

  if (!s || !s.games_played) {
    await send(sock, jid, messageObj, `🕵️ *PROFIL AGEN UNDERCOVER* 🎭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Agen: *${name}*\n💰 Akbar Poin: *${(prof?.points || 0).toLocaleString('id-ID')}*\n\n📊 Kamu belum pernah menyelesaikan satu game Undercover pun!\n👉 Ketik \`.undercover\` di grup untuk membuka lobi dan mulai mencatat statistik.`, { mentions: [senderNumber] });
    return true;
  }

  const statsMsg =
`🕵️ *PROFIL & STATISTIK AGEN UNDERCOVER* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Agen: *${name}*
🎖️ Gelar: *${agentTitle(s)}*
💰 Akbar Poin: *${(prof?.points || 0).toLocaleString('id-ID')}*
⭐ Rank Level: *Level ${prof?.level || 1}* (${prof?.xp || 0} XP)

📊 *REKAM JEJAK PERTANDINGAN:*
🎮 Total Main: *${s.games_played}x*
🏆 Total Menang: *${s.games_won}x* (Win Rate: *${winRateText(s.games_won, s.games_played)}*)
🔥 Streak Menang: *${s.win_streak}* (Rekor Terbaik: *${s.best_streak}*)
💵 Total Poin Dimenangkan: *${(s.points_won || 0).toLocaleString('id-ID')}*

🎭 *PERFORMA PER KUBU:*
🛡️ Warga: *${s.wins_civilian}/${s.times_civilian}* (${winRateText(s.wins_civilian, s.times_civilian)})
🕵️ Penyamar: *${s.wins_impostor}/${s.times_impostor}* (${winRateText(s.wins_impostor, s.times_impostor)})
🎲 Netral: *${s.wins_neutral}/${s.times_neutral}* (${winRateText(s.wins_neutral, s.times_neutral)})

⚡ *AKSI SPESIAL:*
🤍 Tebakan Mr. White Tepat: *${s.mrwhite_guess_win}x*
🤡 Kemenangan Si Badut: *${s.jester_win}x*
🤠 Eksekusi Sheriff Tepat: *${s.sheriff_kills}x*
🗡️ Pembunuhan Assassin: *${s.assassin_kills}x*
🔍 Intel Detektif Akurat: *${s.detective_correct}x*

👉 Ketik \`.undercover top\` untuk melihat papan peringkat!`;

  await send(sock, jid, messageObj, statsMsg, { mentions: [senderNumber] });
  return true;
}

export async function showUndercoverLeaderboard(sock, jid, messageObj) {
  let rows = [];
  try {
    rows = await db.getUndercoverLeaderboard(10);
  } catch (e) {
    rows = [];
  }

  if (!rows || rows.length === 0) {
    await send(sock, jid, messageObj, "📊 *PAPAN PERINGKAT UNDERCOVER*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nBelum ada data pertandingan yang tercatat. Mainkan `.undercover` untuk jadi yang pertama!");
    return true;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const nama = r.customer_nama || `+${String(r.customer_jid).split('@')[0]}`;
    return `${medals[i] || `${i + 1}.`} *${nama}*\n     🏆 ${r.games_won}/${r.games_played} menang (${winRateText(r.games_won, r.games_played)}) | 🔥 Rekor Streak: ${r.best_streak}`;
  }).join('\n');

  await send(sock, jid, messageObj,
`📊 *PAPAN PERINGKAT AGEN UNDERCOVER* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Minimal 3x bermain untuk masuk daftar._

${lines}

👉 Ketik \`.undercover stats\` untuk statistik pribadimu.`);
  return true;
}

// ─── 🗃️ STATE, PERSISTENSI & UTILITAS DASAR UNDERCOVER ───────────────
// Berisi registry sesi aktif, helper murni, dan penyimpanan state ke disk.
// Modul ini hanya boleh mengimpor `constants.js` + database supaya tetap aman
// dari import cycle (AGENTS.md §16).

import fs from 'fs';
import path from 'path';
import * as db from '../../../database.js';
import { STATE_FILE } from './constants.js';

export const activeUndercoverGames = new Map();

export function cardPrice(session, def) {
  return Math.max(def.minPrice, Math.round((session?.buyIn || 30) * def.mult));
}

// ─── 🔧 UTILITAS DASAR ───────────────────────────────────────────────
export function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return db.isPhoneMatch(a, b); } catch (e) { return false; }
}

export function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function clearSessionTimer(session) {
  if (session?.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
}

export function findAliveIndex(session, jid) {
  return session.alivePlayers.findIndex(p => samePlayer(p, jid));
}

export function isAlive(session, jid) {
  return findAliveIndex(session, jid) !== -1;
}

// Label pemain versi teks polos (tanpa mention) untuk DM & rekap
export function plainLabel(session, jid) {
  const idx = session.players.findIndex(p => samePlayer(p, jid));
  const raw = idx !== -1 ? (session.playerLabels[idx] || '') : '';
  const cleaned = String(raw).replace(/\*/g, '').trim();
  return cleaned || `+${String(jid).split('@')[0]}`;
}

export function tag(jid) {
  return `@${String(jid).split('@')[0]}`;
}

// Kembalikan taruhan & harga kartu jika sesi dibatalkan/kedaluwarsa sebelum tuntas,
// supaya pemain tidak kehilangan poin karena game yang tidak pernah selesai.
export async function refundUndercoverSession(session) {
  if (!session) return { players: 0, cards: 0 };
  let refundedPlayers = 0;
  let refundedCards = 0;

  if (session.chargedPlayers && session.chargedPlayers.size > 0) {
    for (const p of session.chargedPlayers) {
      try { await db.addGamePoints(p, session.buyIn); refundedPlayers++; } catch (e) {}
    }
    session.chargedPlayers.clear();
    session.buyInCharged = false;
  } else if (session.buyInCharged) {
    for (const p of session.players) {
      try { await db.addGamePoints(p, session.buyIn); refundedPlayers++; } catch (e) {}
    }
    session.buyInCharged = false;
  }

  for (const purchase of (session.cardPurchases || [])) {
    try { await db.addGamePoints(purchase.jid, purchase.price); refundedCards += purchase.price; } catch (e) {}
  }
  session.cardPurchases = [];

  return { players: refundedPlayers, cards: refundedCards };
}


// ─── 💾 PERSISTENSI SESI ─────────────────────────────────────────────
export function saveUndercoverSessions() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serialized = [];
    for (const [jid, s] of activeUndercoverGames.entries()) {
      if (s.status === 'LOBBY' || s.status === 'CATEGORY_VOTE') continue;

      const rolesObj = {};
      for (const [p, r] of s.playerRoles.entries()) {
        rolesObj[p] = {
          ...r,
          cards: r.cards ? Array.from(r.cards) : [],
          clueLog: Array.isArray(r.clueLog) ? r.clueLog : []
        };
      }

      serialized.push({
        jid,
        host: s.host,
        buyIn: s.buyIn,
        players: s.players,
        playerLabels: s.playerLabels,
        alivePlayers: s.alivePlayers,
        pair: s.pair,
        theme: s.theme || null,
        round: s.round,
        cluePass: s.cluePass || 1,
        status: s.status,
        turnIndex: s.turnIndex,
        turnSeq: s.turnSeq || 0,
        skipCount: s.skipCount || 0,
        modifier: s.modifier,
        guardedPlayer: s.guardedPlayer || null,
        framedPlayer: s.framedPlayer || null,
        mrWhiteGuessPending: s.mrWhiteGuessPending || null,
        goldenVoters: s.goldenVoters ? Array.from(s.goldenVoters) : [],
        shieldedPlayers: s.shieldedPlayers ? Array.from(s.shieldedPlayers) : [],
        silencedPlayers: s.silencedPlayers ? Array.from(s.silencedPlayers) : [],
        pendingSilence: s.pendingSilence ? Array.from(s.pendingSilence) : [],
        cardOwners: s.cardOwners ? Array.from(s.cardOwners) : [],
        cardPurchases: Array.isArray(s.cardPurchases) ? s.cardPurchases : [],
        buyInCharged: !!s.buyInCharged,
        chargedPlayers: s.chargedPlayers ? Array.from(s.chargedPlayers) : [],
        shotVictims: Array.isArray(s.shotVictims) ? s.shotVictims : [],
        votes: s.votes ? Array.from(s.votes.entries()) : [],
        voteHistory: Array.isArray(s.voteHistory) ? s.voteHistory : [],
        eliminations: Array.isArray(s.eliminations) ? s.eliminations : [],
        anonRound: s.anonRound || 0,
        anonBoard: Array.isArray(s.anonBoard) ? s.anonBoard : [],
        anonSubmitted: s.anonSubmitted ? Array.from(s.anonSubmitted) : [],
        trialAccused: s.trialAccused || null,
        trialVotes: s.trialVotes ? Array.from(s.trialVotes.entries()) : [],
        trialMaxVotes: s.trialMaxVotes || 0,
        ghostWhisperRound: s.ghostWhisperRound || 0,
        ghostWhisperers: s.ghostWhisperers ? Array.from(s.ghostWhisperers) : [],
        revealedLetters: Array.isArray(s.revealedLetters) ? s.revealedLetters : [],
        blackMarketBuys: s.blackMarketBuys || 0,
        playerRoles: rolesObj
      });
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.error('[UNDERCOVER] Gagal menyimpan state game:', err.message);
  }
}

export async function dm(sock, jid, text, mentions = []) {
  try {
    await sock.sendMessage(jid, mentions.length > 0 ? { text, mentions } : { text });
    return true;
  } catch (e) {
    return false;
  }
}

// ─── 🏷️ HELPER PERAN ─────────────────────────────────────────────────
export function getPlayerRoleData(session, targetJid) {
  if (!session || !session.playerRoles || !targetJid) return null;
  if (session.playerRoles.has(targetJid)) return session.playerRoles.get(targetJid);
  for (const [p, data] of session.playerRoles.entries()) {
    if (samePlayer(p, targetJid)) return data;
  }
  return null;
}

export function isUndercoverRole(role) {
  return ['UNDERCOVER', 'ASSASSIN', 'FRAMER', 'SABOTEUR'].includes(role);
}

// Si Mabuk (DRUNK) sengaja dihitung sebagai Warga Sipil: dia memang warga, cuma
// memegang kata yang salah. Kalau dia dihitung di luar kubu warga, parity
// kemenangan penyamar jadi ikut bergeser dan game 6 orang bisa tamat mendadak.
export function isCivilianRole(role) {
  return ['CIVILIAN', 'SHERIFF', 'DETECTIVE', 'GUARDIAN', 'DOCTOR', 'DRUNK'].includes(role);
}

export function isNeutralRole(role) {
  return ['MRWHITE', 'JESTER', 'BUNGLON'].includes(role);
}

export function factionOf(role) {
  if (isUndercoverRole(role)) return 'IMPOSTOR';
  if (isCivilianRole(role)) return 'CIVILIAN';
  return 'NEUTRAL';
}

export function getRoleBadge(role) {
  switch (role) {
    case 'UNDERCOVER': return '🕵️ UNDERCOVER (PENYAMAR)';
    case 'ASSASSIN': return '🗡️ ASSASSIN (PEMBUNUH BAYARAN)';
    case 'FRAMER': return '🗣️ FRAMER (TUKANG FITNAH)';
    case 'SABOTEUR': return '🦹 SABOTEUR (PENYABOT INTEL)';
    case 'SHERIFF': return '🤠 KOBOI / SHERIFF';
    case 'DETECTIVE': return '🔍 DETEKTIF INTEL';
    case 'GUARDIAN': return '🛡️ GUARDIAN (BODYGUARD)';
    case 'DOCTOR': return '🩺 DOKTER LAPANGAN (MEDIC)';
    case 'MRWHITE': return '🤍 MR. WHITE (BLANK)';
    case 'JESTER': return '🤡 SI BADUT (JESTER)';
    case 'BUNGLON': return '🦎 BUNGLON (NETRAL)';
    case 'DRUNK': return '🍺 SI MABUK (WARGA SALAH KATA)';
    default: return '🧑‍🌾 WARGA SIPIL';
  }
}

// Badge versi "menurut pengakuan resmi" — Si Mabuk tidak boleh pernah tahu dia
// Si Mabuk sebelum rekap akhir, jadi setiap tampilan di tengah permainan
// (laporan Detektif, retasan Saboteur, dead chat) memakai versi ini.
export function getPublicRoleBadge(role) {
  return role === 'DRUNK' ? getRoleBadge('CIVILIAN') : getRoleBadge(role);
}

// Papan huruf kata warga: dipakai anti-stall Zona Merah & Pasar Gelap Mr. White.
// Huruf yang belum terbuka ditampilkan sebagai "_", spasi tetap spasi.
export function buildWordMask(session) {
  const word = String(session?.pair?.civilian || '');
  const opened = new Set(Array.isArray(session?.revealedLetters) ? session.revealedLetters : []);
  return word
    .split('')
    .map((ch, i) => (ch === ' ' ? ' ' : (opened.has(i) ? ch.toUpperCase() : '_')))
    .join(' ')
    .trim();
}

// Buka 1 huruf acak yang belum terbuka. Mengembalikan indeks huruf, atau -1
// kalau seluruh huruf sudah terbuka.
export function revealRandomLetter(session) {
  const word = String(session?.pair?.civilian || '');
  if (!word) return -1;
  if (!Array.isArray(session.revealedLetters)) session.revealedLetters = [];
  const opened = new Set(session.revealedLetters);
  const candidates = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ' ' && !opened.has(i)) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  session.revealedLetters.push(picked);
  return picked;
}

export function findUndercoverSessionAndPlayer(senderNumber) {
  for (const s of activeUndercoverGames.values()) {
    if (s.playerRoles?.has(senderNumber)) return { session: s, playerJid: senderNumber };
    for (const p of s.playerRoles.keys()) {
      if (samePlayer(p, senderNumber)) return { session: s, playerJid: p };
    }
  }
  return { session: null, playerJid: null };
}

export function resolveTargetInSession(session, rawTarget, allowDead = false) {
  if (!session || rawTarget === undefined || rawTarget === null) return null;
  const targetList = allowDead ? session.players : session.alivePlayers;
  const str = String(rawTarget).trim();
  if (!str) return null;

  const parsedNum = parseInt(str, 10);
  if (!isNaN(parsedNum) && parsedNum >= 1 && parsedNum <= targetList.length && !str.includes('@') && str.length <= 2) {
    return targetList[parsedNum - 1];
  }
  const direct = targetList.find(p => p === str);
  if (direct) return direct;

  const digits = str.replace(/\D/g, '');
  if (digits.length >= 4) {
    const found = targetList.find(p => samePlayer(p, digits) || p.replace(/\D/g, '').includes(digits) || digits.includes(p.replace(/\D/g, '')));
    if (found) return found;
  }
  return null;
}

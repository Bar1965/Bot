// ─── 🕵️ UNDERCOVER — TITIK MASUK & RE-EXPORT PUBLIK ──────────────────
// `src/games/undercover.js` cuma barrel tipis yang meneruskan ke sini, jadi
// seluruh import lama (`src/games/index.js`, `bot.js`, `leaderboard.js`) tetap
// jalan tanpa perubahan.
//
// Peta modul:
//   constants.js  — angka, tabel modifier, definisi kartu & misi (daun)
//   state.js      — registry sesi, helper murni, simpan state ke disk
//   flow.js       — mesin fase: ronde → petunjuk → diskusi → voting → tamat
//   roles.js      — voting kategori, pembagian peran, panduan peran
//   abilities.js  — skill peran via DM + Bisikan Arwah + Pasar Gelap
//   cards.js      — toko kartu aksi
//   stats.js      — rekap, Trust Score, misi rahasia, papan peringkat

import fs from 'fs';
import * as db from '../../../database.js';
import { send } from '../helpers.js';
import {
  LOBBY_TIMEOUT_MS, MAX_PLAYERS, MIN_PLAYERS, STATE_FILE, CARD_DEFS
} from './constants.js';
import {
  activeUndercoverGames, saveUndercoverSessions, samePlayer, clearSessionTimer,
  cardPrice, tag, refundUndercoverSession
} from './state.js';
import {
  announceTurn, finishCluePass, startDiscussionPhase, startVotingPhase,
  startAnonCluePhase, startTrialPhase, armMrWhiteGuessTimer,
  handleUndercoverVote, handleUndercoverContinue, handleUndercoverSkip
} from './flow.js';
import {
  startUndercoverGame, handleCategoryVote, showUndercoverRoleGuide
} from './roles.js';
import { handleMrWhiteGuess, handleShowMission } from './abilities.js';
import { handleUndercoverCardShop } from './cards.js';
import { showUndercoverStats, showUndercoverLeaderboard } from './stats.js';

// Re-export seluruh permukaan publik yang dipakai modul lain.
export {
  activeUndercoverGames, saveUndercoverSessions, getPlayerRoleData,
  isUndercoverRole, isCivilianRole, isNeutralRole, getRoleBadge,
  findUndercoverSessionAndPlayer, resolveTargetInSession
} from './state.js';
export {
  handleUndercoverClue, handleUndercoverVote, handleUndercoverSkip,
  handleUndercoverContinue, handleUndercoverSwap, checkUndercoverWinCondition,
  handleUndercoverAnonClue, handleTrialVote
} from './flow.js';
export { handleCategoryVote, showUndercoverRoleGuide } from './roles.js';
export {
  handleMrWhiteGuess, handleDetectiveCheck, handleGuardianProtect,
  handleDoctorRevive, isUndercoverDoctorActive, handleFramerFrame,
  handleSaboteurHack, handleUndercoverShoot, handleGhostWhisper,
  handleShowMission, handleBlackMarket
} from './abilities.js';

export async function restoreUndercoverSessions(sock) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    if (!content) return;
    const data = JSON.parse(content);
    if (!Array.isArray(data) || data.length === 0) return;

    for (const item of data) {
      const rolesMap = new Map();
      for (const [p, r] of Object.entries(item.playerRoles || {})) {
        rolesMap.set(p, {
          ...r,
          cards: new Set(r.cards || []),
          clueLog: Array.isArray(r.clueLog) ? r.clueLog : []
        });
      }

      const session = {
        jid: item.jid,
        host: item.host || null,
        buyIn: item.buyIn,
        players: item.players || [],
        playerLabels: item.playerLabels || [],
        alivePlayers: item.alivePlayers || [],
        pair: item.pair,
        theme: item.theme || null,
        round: item.round,
        cluePass: item.cluePass || 1,
        status: item.status,
        turnIndex: item.turnIndex || 0,
        turnSeq: item.turnSeq || 0,
        skipCount: item.skipCount || 0,
        modifier: item.modifier,
        guardedPlayer: item.guardedPlayer || null,
        framedPlayer: item.framedPlayer || null,
        mrWhiteGuessPending: item.mrWhiteGuessPending || null,
        goldenVoters: new Set(item.goldenVoters || []),
        shieldedPlayers: new Set(item.shieldedPlayers || []),
        silencedPlayers: new Set(item.silencedPlayers || []),
        pendingSilence: new Set(item.pendingSilence || []),
        cardOwners: new Set(item.cardOwners || []),
        cardPurchases: item.cardPurchases || [],
        buyInCharged: item.buyInCharged !== false,
        chargedPlayers: new Set(item.chargedPlayers || []),
        shotVictims: item.shotVictims || [],
        votes: new Map(item.votes || []),
        voteHistory: item.voteHistory || [],
        eliminations: item.eliminations || [],
        anonRound: item.anonRound || 0,
        anonBoard: item.anonBoard || [],
        anonSubmitted: new Set(item.anonSubmitted || []),
        trialAccused: item.trialAccused || null,
        trialVotes: new Map(item.trialVotes || []),
        trialMaxVotes: item.trialMaxVotes || 0,
        ghostWhisperRound: item.ghostWhisperRound || 0,
        ghostWhisperers: new Set(item.ghostWhisperers || []),
        revealedLetters: item.revealedLetters || [],
        blackMarketBuys: item.blackMarketBuys || 0,
        categoryVotes: new Map(),
        themeOptions: [],
        skipVotes: new Set(),
        discussionSkips: new Set(),
        playerRoles: rolesMap,
        timeout: null
      };

      activeUndercoverGames.set(item.jid, session);

      await send(sock, item.jid, null, `🔄 *GAME UNDERCOVER DIPULIHKAN DARI RESTART!* 🕵️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSesi Ronde ${session.round} otomatis dilanjutkan dari titik terakhir.`);

      // Lanjutkan sesi memakai fungsi alur yang sama dengan permainan normal
      if (session.status === 'CLUE_PHASE') {
        if (session.turnIndex >= session.alivePlayers.length) {
          await finishCluePass(sock, item.jid, null);
        } else {
          await announceTurn(sock, item.jid, null);
        }
      } else if (session.status === 'DISCUSSION_PHASE') {
        await startDiscussionPhase(sock, item.jid, null, true);
      } else if (session.status === 'VOTING_PHASE') {
        await startVotingPhase(sock, item.jid, null, true);
      } else if (session.status === 'ANON_CLUE_PHASE') {
        // Setoran petunjuk yang sudah masuk tetap tersimpan di clueLog; yang
        // dibuka ulang cuma jendela waktunya.
        await startAnonCluePhase(sock, item.jid, null);
      } else if (session.status === 'TRIAL_PHASE' && session.trialAccused) {
        // Sidang diulang dari awal: vonis yang sempat masuk sebelum restart
        // sengaja dibuang supaya tidak ada juri yang kehilangan suaranya.
        await startTrialPhase(sock, item.jid, null, session.trialAccused, session.trialMaxVotes);
      } else if (session.status === 'MR_WHITE_GUESS' && session.mrWhiteGuessPending) {
        await armMrWhiteGuessTimer(sock, item.jid, session.mrWhiteGuessPending);
      }
    }
  } catch (err) {
    console.error('[UNDERCOVER] Gagal memulihkan state game:', err.message);
  }
}

// ─── 🎮 ROUTER PERINTAH UTAMA ────────────────────────────────────────
export async function handleUndercover(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Game Undercover / Impostor hanya bisa dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['role', 'roles', 'panduan', 'help', 'bantuan'].includes(subCmd) || command === 'roleundercover') {
    return await showUndercoverRoleGuide(sock, jid, messageObj);
  }

  if (['card', 'cards', 'kartu', 'item'].includes(subCmd)) {
    return await handleUndercoverCardShop(sock, jid, senderNumber, messageObj, args);
  }

  if (['stats', 'profil', 'stat', 'statistik'].includes(subCmd)) {
    return await showUndercoverStats(sock, jid, senderNumber, messageObj);
  }

  if (['misi', 'mission', 'misiku'].includes(subCmd)) {
    return await handleShowMission(sock, jid, senderNumber, messageObj);
  }

  if (['top', 'leaderboard', 'lb', 'rank', 'ranking'].includes(subCmd)) {
    return await showUndercoverLeaderboard(sock, jid, messageObj);
  }

  if (['join', 'ikut'].includes(subCmd) || command === 'joinundercover') {
    return await joinUndercoverLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'startgame'].includes(subCmd) || command === 'startundercover') {
    return await startUndercoverGame(sock, jid, senderNumber, messageObj);
  }

  if (['kategori', 'katakategori', 'tema', 'votekategori'].includes(subCmd)) {
    return await handleCategoryVote(sock, jid, senderNumber, messageObj, args[2]);
  }

  if (['lanjut', 'gasvote', 'mulaivote'].includes(subCmd)) {
    return await handleUndercoverContinue(sock, jid, senderNumber, messageObj);
  }

  if (['vote', 'v'].includes(subCmd)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[2];
    return await handleUndercoverVote(sock, jid, senderNumber, messageObj, target);
  }

  if (['tebakwarga', 'guess'].includes(subCmd)) {
    const guess = args.slice(2).join(' ').trim();
    return await handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess);
  }

  if (['skip', 'lewat', 'pass'].includes(subCmd)) {
    return await handleUndercoverSkip(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd)) {
    const session = activeUndercoverGames.get(jid);
    if (!session) {
      await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover aktif di grup ini.");
      return true;
    }
    if (session.host && !samePlayer(session.host, senderNumber)) {
      await send(sock, jid, messageObj, "❌ Hanya pembuat lobi yang dapat membatalkan game!");
      return true;
    }
    clearSessionTimer(session);
    const refund = await refundUndercoverSession(session);
    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    const refundNote = (refund.players > 0 || refund.cards > 0)
      ? `\n💸 *Taruhan dikembalikan* ke ${refund.players} pemain${refund.cards > 0 ? ` (+ ${refund.cards} Poin biaya kartu)` : ''}.`
      : '';
    await send(sock, jid, messageObj, `🛑 Permainan Undercover berhasil dibatalkan.${refundNote}`);
    return true;
  }

  if (activeUndercoverGames.has(jid)) {
    const s = activeUndercoverGames.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Undercover aktif di grup ini!\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.playerLabels.join(', ')}\n\nKetik \`.joinundercover\` untuk ikut atau \`.startundercover\` untuk mulai!`, { mentions: s.players });
    } else {
      await send(sock, jid, messageObj, `⚠️ Permainan Undercover sedang berlangsung di grup ini!`);
    }
    return true;
  }

  const buyIn = Math.max(10, parseInt(args[1], 10) || 30);
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh minimal *${buyIn} Poin* untuk membuka lobi.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    round: 0,
    cluePass: 1,
    pair: null,
    theme: null,
    modifier: null,
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerRoles: new Map(),
    turnIndex: 0,
    turnSeq: 0,
    skipCount: 0,
    alivePlayers: [],
    votes: new Map(),
    voteHistory: [],              // riwayat suara untuk Trust Score & misi
    eliminations: [],             // siapa dieksekusi di ronde berapa & berapa suara
    anonRound: 0,                 // ronde terakhir yang memakai papan anonim
    anonBoard: [],
    anonSubmitted: new Set(),
    trialAccused: null,           // terdakwa Sidang Terakhir
    trialVotes: new Map(),
    trialMaxVotes: 0,
    ghostWhisperRound: 0,         // kuota Bisikan Arwah direset tiap ronde
    ghostWhisperers: new Set(),
    revealedLetters: [],          // huruf kata warga yang dibuka Zona Merah
    blackMarketBuys: 0,           // jatah huruf Pasar Gelap Mr. White
    categoryVotes: new Map(),
    themeOptions: [],
    mrWhiteGuessPending: null,
    guardedPlayer: null,
    framedPlayer: null,
    shotVictims: [],
    silencedPlayers: new Set(),   // aktif ronde ini
    pendingSilence: new Set(),    // dibeli ronde ini, berlaku ronde depan
    shieldedPlayers: new Set(),
    goldenVoters: new Set(),
    cardOwners: new Set(),        // 1 kartu per pemain per game
    cardPurchases: [],            // riwayat pembelian untuk keperluan refund
    buyInCharged: false,          // taruhan baru dipotong setelah kategori terpilih
    skipVotes: new Set(),
    discussionSkips: new Set(),
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    const cur = activeUndercoverGames.get(jid);
    if (!cur || cur.status !== 'LOBBY') return;
    const refund = await refundUndercoverSession(cur);
    activeUndercoverGames.delete(jid);
    saveUndercoverSessions();
    const refundNote = refund.cards > 0 ? `\n💸 Biaya kartu sebesar *${refund.cards} Poin* dikembalikan.` : '';
    await send(sock, jid, null, `⌛ *LOBI UNDERCOVER KEDALUWARSA!* Game dibatalkan karena tidak dimulai dalam 90 detik.${refundNote}`);
  }, LOBBY_TIMEOUT_MS);

  activeUndercoverGames.set(jid, session);

  const shieldPrice = cardPrice(session, CARD_DEFS.shield);
  const goldPrice = cardPrice(session, CARD_DEFS.gold);

  const lobbyMsg =
`🕵️ *LOBBY UNDERCOVER ULTRA 3.0 — SOCIAL DEDUCTION* 🎭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host:* ${hostLabel}
👥 *Pemain (1/${MAX_PLAYERS}):* ${hostLabel}
💰 *Taruhan:* *${buyIn} Poin* / orang

🎭 *Daftar Peran Rahasia (Diacak via DM WhatsApp):*
▫️ 🧑‍🌾 *Civilian (Warga)*: Mendapat kata asli.
▫️ 🕵️ *Undercover / Impostor*: 1 Orang (3–5 Pemain) | 2 Orang (6–8 Pemain)!
▫️ 🤍 *Mr. White (Blank)*: Tidak dapat kata, pura-pura tahu! (5+ Pemain)
▫️ 🤡 *Si Badut (Jester)* (4+ Pemain): Ingin di-vote keluar oleh grup untuk menang solo & mencuri seluruh pot!
▫️ 🔍 *Detektif Intel* (4+ Pemain): Bisa DM bot \`.intip @member\` untuk lacak penyamar!

🗳️ *BARU — VOTING KATEGORI KATA:* Begitu game dimulai, semua pemain memilih tema kata dulu!
🃏 *Kartu Pra-Game:* \`.undercover card shield\` (${shieldPrice} Poin) / \`.undercover card gold\` (${goldPrice} Poin) — *hanya bisa dibeli di lobi ini!*

👉 Ketik \`.joinundercover\` untuk bergabung!
🚀 Host ketik \`.startundercover\` jika sudah siap (Minimal ${MIN_PLAYERS} pemain).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

export async function joinUndercoverLobby(sock, jid, senderNumber, messageObj) {
  const session = activeUndercoverGames.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Undercover aktif. Ketik `.undercover [taruhan]` untuk membuka game baru!");
    return true;
  }

  if (session.players.some(p => samePlayer(p, senderNumber))) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah berada di dalam lobi Undercover ini!");
    return true;
  }

  if (session.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Lobi sudah penuh (Maksimal ${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Butuh *${session.buyIn} Poin* untuk bergabung.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (${tag(senderNumber)})` : tag(senderNumber);

  session.players.push(senderNumber);
  session.playerLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil bergabung ke game Undercover!\n👥 Total Pemain (${session.players.length}/${MAX_PLAYERS}): ${session.playerLabels.join(', ')}\n\nKetik \`.startundercover\` jika sudah siap!`, { mentions: session.players });
  return true;
}

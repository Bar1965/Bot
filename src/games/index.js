import * as db from '../../database.js';
import * as entertainment from '../../entertainmentHandler.js';
import { sendInteractiveButtons } from '../../bot.js';
import { getPremiumBenefits } from '../../premiumHandler.js';
import * as ww from '../../werewolfGame.js';
import { send, isOnCooldown, randomItem, normalizeAnswer, scopeKey } from './helpers.js';
import { activeFamily100, activeCakLontong, startFamily100, handleFamily100Answer, surrenderFamily100, startCakLontong, handleCakLontongAnswer, surrenderCakLontong } from './family100.js';
import { activeDuels, pendingDuels, handleDuelCommand, handleDuelAction } from './duelRoulette.js';
import { activeBlackjackGames, handleBlackjack } from './blackjack.js';
import { activeBankHeists, handleBankHeist } from './bankHeist.js';
import { activeHorseRaces, handleHorseRace } from './umaDerby.js';
import { handleBankEconomy } from './bankEconomy.js';
import { activeRounds, startRound, handleRoundCommand, surrenderRound, ROUND_DURATION_MS, scheduleRoundExpiry } from './triviaEngine.js';
import { activeStealSessions, profileText, handleStealHeist, handleStealAnswer } from './rpgSystem.js';
import { activeJailbreakSessions, handleJailbreak, handleJailbreakAnswer, handleTebusNapi } from './jailbreak.js';
import { activeUndercoverGames, handleUndercover, handleUndercoverClue, handleUndercoverVote, handleUndercoverSkip, handleUndercoverShoot, handleMrWhiteGuess, handleDetectiveCheck, handleGuardianProtect, handleDoctorRevive, handleFramerFrame, handleSaboteurHack, handleUndercoverContinue, handleUndercoverSwap, handleCategoryVote, isUndercoverDoctorActive, handleUndercoverAnonClue, handleTrialVote, handleGhostWhisper, handleShowMission, handleBlackMarket, findUndercoverSessionAndPlayer, getPlayerRoleData } from './undercover.js';
import { activeQuizTournaments, handleQuizTournament, handleTournamentAnswer } from './quizTournament.js';
import { activeAuctions, handleAuctionCommand } from './mysteryAuction.js';
import { activeMinesGames, handleMinesCommand } from './minesGame.js';
import { activeRaids, handleRaidCommand, getRaidContext } from './raidBoss.js';
import { handleTcgCommand } from './tcg/index.js';
import { handlePokerCommand, activeTexasGames, activeCapsaGames, activeFastPokerGames } from './poker/index.js';
import { activeWireGames, handleCutTheWire } from './cutTheWire.js';
import { activeBattleships, pendingBattleships, handleBattleshipCommand } from './battleship.js';
import { activeBuckshots, pendingBuckshots, handleBuckshotCommand } from './buckshotRoulette.js';
import { getSystemChangelog } from '../utils/changelog.js';
import { buildCommandMenu } from '../../commandRegistry.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { adalahJidBot } from '../utils/botIdentity.js';

export const easterEggCooldowns = new Map();

const missionList = [
  'Menangkan 1 quiz hari ini untuk mendapat bonus XP.',
  'Ajak teman mencoba `.daily` dan kumpulkan streak.',
  'Mainkan `.sambungkata` bersama grup.',
  'Gunakan reaction terbaikmu pada pesan bot hari ini.',
  'Coba satu command media dan satu command game.'
];

// Perintah yang TETAP hidup walaupun game dimatikan di grup (`.mode game off`).
// Mematikan game tujuannya meredam keramaian permainan, bukan mengunci saldo
// poin, profil, atau perintah admin poin milik member.
const FUN_CMD_TETAP_AKTIF = [
  'afk',
  'poin', 'point', 'points', 'profile', 'profil', 'level', 'me', 'cekpoin',
  'rank', 'leaderboard', 'top', 'lb', 'papan', 'peringkat',
  'badge', 'badges', 'achievement', 'achievements', 'misi', 'mission', 'challenge',
  'transfer', 'kirimpoin', 'transferpoin', 'tfpoin',
  'bank', 'brankas', 'depo', 'setor', 'tarik', 'withdraw',
  'daily', 'harian', 'reward', 'bansos', 'sembako', 'kompensasi',
  'addpoint', 'addpoints', 'addpoin', 'tambahpoin', 'tambahpoint', 'pluspoin',
  'kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin', 'minuspoin',
  'giveaway', 'setpoints', 'bagipoin',
  'tukar', 'pointshop', 'penukaran',
  'poll', 'voting', 'vote',
  // Jalan keluar: sesi yang terlanjur jalan saat sakelar dimatikan tetap bisa
  // ditutup rapi, bukannya menggantung dengan taruhan poin ikut tertahan.
  'nyerah', 'surrender', 'menyerah', 'cancelraid', 'batalraid', 'cancelbalap',
  'cancellelang', 'batallelang', 'cancelsuit', 'batalsuit', 'batalmines',
  'batalpoker', 'cancelpoker', 'batalcapsa', 'cancelcapsa', 'batalfastpoker', 'cancelfastpoker',
  'batalbom', 'cancelbom', 'batalkapal', 'tolakkapal',
  'batalbuckshot', 'tolakbuckshot', 'nyerahbuckshot',
  'update', 'changelog', 'patchnotes', 'whatsnew', 'pembaruan',
  'rekomendasi', 'recommend', 'saranproduk',
  'freegames', 'freegame', 'gamegratis', 'freegamestag'
];

/**
 * Apakah game & hiburan sedang dimatikan di grup ini?
 * Sumber kebenarannya satu: group_settings.features_config.game, yang ditulis
 * baik oleh `.mode game on/off` maupun `.fitur game on/off`.
 */
async function gameDimatikanDiGrup(jid) {
  try {
    const setelan = await db.getGroupSettings(jid);
    return (setelan?.features_config || {}).game === false;
  } catch (_) {
    return false;
  }
}

export async function handleFunCommand({ sock, jid, senderNumber, messageObj, text, args, cleanCmd, isFromGroup = false, isAdmin = false, isOwner = false, isStoreAdmin = false, isPrefixCmd }) {
  const command = String(cleanCmd || '').toLowerCase();
  const scope = scopeKey(jid, senderNumber, isFromGroup);

  // Kalau game baru saja dimatikan admin, sesi yang terlanjur jalan pun ikut
  // dibungkam. Query DB-nya hanya ditembak saat memang ADA sesi hidup, supaya
  // obrolan biasa di grup tidak membayar ongkos baca database tiap pesan.
  const adaSesiHidup = isFromGroup && text && !text.startsWith('.') && (
    activeJailbreakSessions.has(senderNumber) ||
    activeUndercoverGames.has(jid) ||
    activeQuizTournaments.has(jid) ||
    activeStealSessions.has(senderNumber) ||
    activeFamily100.has(scope) ||
    activeCakLontong.has(scope) ||
    activeRounds.has(scope) ||
    activeTexasGames.has(jid) ||
    activeCapsaGames.has(jid) ||
    activeFastPokerGames.has(jid)
  );
  if (adaSesiHidup && await gameDimatikanDiGrup(jid)) return false;

  // Deteksi Jawaban Misi Bobol Penjara (.jailbreak)
  if (activeJailbreakSessions.has(senderNumber) && text && !text.startsWith('.')) {
    const isJbProcessed = await handleJailbreakAnswer(sock, jid, senderNumber, messageObj, text);
    if (isJbProcessed) return true;
  }

  // Deteksi Petunjuk / Clue Game Undercover Aktif
  if (activeUndercoverGames.has(jid) && text && !text.startsWith('.')) {
    const isUndercoverClue = await handleUndercoverClue(sock, jid, senderNumber, messageObj, text);
    if (isUndercoverClue) return true;
  }

  // Deteksi Jawaban Turnamen Cerdas Cermat Aktif
  if (activeQuizTournaments.has(jid) && text && !text.startsWith('.')) {
    const isTournamentAns = await handleTournamentAnswer(sock, jid, senderNumber, messageObj, text);
    if (isTournamentAns) return true;
  }

  // Deteksi Jawaban Tantangan Pembobolan / Steal (.steal / .hack)
  if (activeStealSessions.has(senderNumber) && text && !text.startsWith('.')) {
    const isStealProcessed = await handleStealAnswer(sock, jid, messageObj, senderNumber, text);
    if (isStealProcessed) return true;
  }

  // Deteksi Jawaban Family 100 Aktif
  if (activeFamily100.has(scope) && text && !text.startsWith('.')) {
    const isF100Processed = await handleFamily100Answer(sock, jid, messageObj, senderNumber, text, scope);
    if (isF100Processed) return true;
  }

  // Deteksi Jawaban Cak Lontong Aktif
  if (activeCakLontong.has(scope) && text && !text.startsWith('.')) {
    const isCakProcessed = await handleCakLontongAnswer(sock, jid, messageObj, senderNumber, text, scope);
    if (isCakProcessed) return true;
  }

  // Deteksi Jawaban Langsung Game Aktif (Quiz, Tebak Kata, Tebak Emoji, Tebak Lagu, Tebak Bendera)
  const activeGameRound = activeRounds.get(scope);
  if (activeGameRound && !activeGameRound.isAnswered && text) {
    const rawAnswer = normalizeAnswer(text);
    const isDirectMatch = (activeGameRound.alias && Array.isArray(activeGameRound.alias))
      ? activeGameRound.alias.some(a => normalizeAnswer(a) === rawAnswer)
      : (rawAnswer === normalizeAnswer(activeGameRound.answer));

    if (rawAnswer && isDirectMatch) {
      // HANYA user yang sudah terdaftar (.daftar) yang bisa menjawab dan klaim hadiah
      const isRegUser = await db.isCustomerRegistered(senderNumber);
      if (!isRegUser && !isAdmin && !isOwner) {
        await sock.sendMessage(jid, {
          text: `⚠️ Jawabanmu benar, tapi kamu belum terdaftar sebagai member!\nKetik *.daftar <Nama Kamu>* terlebih dahulu untuk mulai mengumpulkan poin dan bermain game.`
        }, { quoted: messageObj });
        return true;
      }

      activeGameRound.isAnswered = true;
      if (activeGameRound.timeout) clearTimeout(activeGameRound.timeout);
      activeRounds.delete(scope);
      
      const pointsReward = activeGameRound.type === 'tebaklagu' ? 25 : (activeGameRound.type === 'tebakbendera' ? 20 : 20);
      const xpReward = activeGameRound.type === 'tebaklagu' ? 50 : (activeGameRound.type === 'tebakbendera' ? 35 : 30);
      
      const profile = await db.awardGamePoints(senderNumber, pointsReward, true);
      await db.grantXp(senderNumber, xpReward);
      
      const userTag = `@${senderNumber.split('@')[0]}`;
      let congratsMsg = '';
      if (activeGameRound.type === 'tebaklagu') {
        congratsMsg = `🎉 *TEBAK LAGU TERJAWAB!* 🎶\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Pemenang: *${userTag}*\n🎵 Artis: *${activeGameRound.artist}*\n🎼 Judul Lagu: *${activeGameRound.answer}*\n🎁 Bonus: *+${pointsReward} Poin* | *+${xpReward} XP*\n💰 Total Poin: *${profile.points} Poin*`;
      } else if (activeGameRound.type === 'tebakbendera') {
        congratsMsg = `🎉 *TEBAK BENDERA TERJAWAB!* 🚩\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Pemenang: *${userTag}*\n🚩 Bendera: *${activeGameRound.flag}*\n🏛️ Negara: *${activeGameRound.country}*\n🎁 Bonus: *+${pointsReward} Poin* | *+${xpReward} XP*\n💰 Total Poin: *${profile.points} Poin*`;
      } else {
        congratsMsg = `🎉 *SELAMAT!* ${userTag} berhasil menjawab dengan benar!\n\n💡 Jawaban: *${activeGameRound.answer}*\n🎁 Hadiah: *+${pointsReward} Poin* & *+${xpReward} XP*\n💰 Total Poin: *${profile.points}*`;
      }
        
      await sock.sendMessage(jid, {
        text: congratsMsg,
        mentions: [senderNumber]
      }, { quoted: messageObj });
      return true;
    }
  }

  // SEMUA COMMAND FUN/GAME LAIN WAJIB MENGGUNAKAN PREFIX . / #
  const isPrefix = isPrefixCmd !== undefined 
    ? isPrefixCmd 
    : ((text || '').trim().startsWith('.') || (text || '').trim().startsWith('/') || (text || '').trim().startsWith('#'));
  if (!isPrefix) {
    return false;
  }

  const knownFunCmds = [
    'afk', 'steal', 'maling', 'copet', 'rampok', 'curi', 'rob', 'hack', 'ww', 'werewolf',
    'jawab', 'answer', 'hint', 'nyerah', 'surrender', 'menyerah',
    'quiz', 'trivia', 'tebakquiz', 'tebakemoji', 'emoji', 'tebakkata', 'hangman', 'kata',
    'family100', 'f100', 'caklontong', 'tts',
    'undercover', 'sus', 'impostor', 'joinundercover', 'startundercover', 'tebakwarga', 'guess', 'mrwhite', 'tebakciv', 'intip', 'cekintip', 'v', 'skip', 'lewat', 'pass', 'skipundercover', 'lindung', 'guard', 'protect', 'lindungi', 'sembuhkan', 'revive', 'heal', 'cpr', 'obati', 'doctor', 'fitnah', 'framer', 'frame', 'sabotase',
    'lanjut', 'gasvote', 'mulaivote', 'tukargiliran', 'swapgiliran', 'lempargiliran', 'votekategori', 'katakategori',
    'anon', 'clue', 'setorpetunjuk', 'kirimpetunjuk', 'bersalah', 'guilty', 'bebas', 'innocent', 'vonis',
    'bisik', 'whisper', 'arwah', 'misirahasia', 'belihuruf', 'pasargelap',
    'cerdascermat', 'kuisturnamen', 'quizbattle', 'joincerdascermat', 'startcerdascermat',
    'jailbreak', 'kabur', 'bobolpenjara', 'tebus', 'bebasinnapi',
    'duel', 'terimaduel', 'gasduel', 'tolakduel', 'tembak', 'shoot', 'dor',
    'blackjack', 'bj', 'hit', 'stand', 'double',
    'poker', 'texaspoker', 'texas', 'holdem', 'joinpoker', 'startpoker', 'batalpoker',
    'check', 'call', 'raise', 'allin', 'fold', 'kartu', 'hand', 'mycards', 'cekkartu', 'kartuku',
    'capsa', 'capsasusun', 'joincapsa', 'startcapsa', 'batalcapsa',
    'fastpoker', 'poker3', 'joinfastpoker', 'startfastpoker', 'batalfastpoker',
    'bom', 'cutthewire', 'jinakkanbom', 'joinbom', 'gasbom', 'batalbom', 'cancelbom', 'potong', 'cut', 'kabel',
    'battleship', 'kapal', 'perangkapal', 'terimakapal', 'gaskapal', 'tolakkapal', 'batalkapal', 'rudal', 'bomkapal',
    'buckshot', 'shotgun', 'gasbuckshot', 'tolakbuckshot', 'batalbuckshot', 'nyerahbuckshot', 'pakai', 'use', 'rokok', 'kaca', 'gergaji', 'bir', 'borgol',
    'heist', 'rampokbank', 'joinheist', 'startheist',
    'balapkuda', 'pasangkuda', 'betkuda', 'pasang', 'bet', 'kuda', 'race', 'startbalap', 'startrace', 'cancelbalap',
    'bank', 'brankas', 'depo', 'setor', 'tarik', 'withdraw',
    'tebaklagu', 'lagu', 'musicquiz', 'tebakmusik',
    'tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag',
    'truth', 'dare', 'tod', 'dadu', 'dice', 'coinflip', 'koin', 'coin',
    'sambungkata', 'wordchain', 'daily', 'harian', 'reward',
    'addpoint', 'addpoints', 'addpoin', 'tambahpoin', 'tambahpoint', 'pluspoin',
    'kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin', 'minuspoin',
    'transfer', 'kirimpoin', 'transferpoin', 'tfpoin',
    'poin', 'point', 'points', 'profile', 'profil', 'level', 'me', 'cekpoin',
    'rank', 'leaderboard', 'top', 'lb', 'papan', 'peringkat', 'misi', 'mission', 'challenge',
    'bansos', 'sembako', 'kompensasi',
    'giveaway', 'setpoints', 'bagipoin', 'kompensasi',
    'badge', 'badges', 'achievement', 'achievements',
    'rekomendasi', 'recommend', 'saranproduk',
    'poll', 'voting', 'vote', 'love', 'jodoh', 'compatibility', 'karbit', 'fanskarbit',
    'zodiak', 'zodiac', 'horoscope',
    'freegames', 'freegame', 'gamegratis', 'freegamestag',
    'slot', 'slots', 'judi',
    'torebot', 'tochipmunk', 'todeep', 'toecho',
    'tebakangka', 'tebak', 'spin', 'luckyspin',
    'suit', 'pilihsuit', 'cancelsuit', 'batalsuit',
    'tukar', 'pointshop', 'penukaran',
    'dompet', 'wallet', 'aset', 'assets', 'rekening',
    'update', 'changelog', 'patchnotes', 'whatsnew', 'pembaruan',
    'fun', 'game', 'games', 'hiburan',
    'tcg', 'arena', 'kartumonster',
    'lelang', 'auction', 'lelangkotak', 'bid', 'tawar', 'bidup', 'cancellelang', 'batallelang', 'infolelang', 'lelanginfo',
    'lelangstats', 'statlelang', 'lelangstat', 'lelangtop', 'toplelang', 'lelangleaderboard',
    'endus', 'periksakotak', 'ciumkotak', 'gertak', 'gertakan', 'sikut', 'blokir', 'ganggu',
    'mines', 'ranjau', 'buka', 'pick', 'cashout', 'tarikdana', 'batalmines',
    'infomines', 'tabelmines', 'minesinfo',
    'raid', 'worldboss', 'bos', 'joinraid', 'joinr', 'pilihrole', 'startraid', 'gasraid', 'mulairaid', 'cancelraid', 'batalraid',
    'statusraid', 'raidstatus', 'statusr', 'inforaid', 'raidtop', 'topraid', 'raidleaderboard', 'raidstats', 'statraid', 'raidstat',
    'serang', 'atk', 'berserk', 'tameng', 'shield', 'taunt', 'provokasi', 'provoke', 'benteng', 'heal', 'massheal', 'revive', 'sihir', 'cast', 'freeze', 'stun'
  ];

  if (!knownFunCmds.includes(command)) {
    return false;
  }

  // GERBANG SAKELAR GAME PER-GRUP (`.mode game off` / `.fitur game off`).
  // Ditaruh setelah daftar perintah dikenali supaya obrolan biasa tidak kena,
  // dan sebelum cek registrasi supaya grup yang mematikan game tidak malah
  // dibanjiri pesan "wajib daftar".
  if (isFromGroup && !FUN_CMD_TETAP_AKTIF.includes(command) && await gameDimatikanDiGrup(jid)) {
    // Balas maksimal sekali per menit per grup: pesan penolakan tidak boleh
    // jadi keramaian baru yang justru ingin dihindari admin.
    if (!isOnCooldown(`${jid}:game-off-notice`, 60_000)) {
      await send(sock, jid, messageObj, '🚫 *Fitur game & hiburan sedang dimatikan di grup ini.*\n\n_Admin grup dapat menyalakannya lagi dengan_ `.mode game on`');
    }
    return true;
  }

  // REGISTRATION CHECK: User non-admin yang belum daftar tidak boleh menggunakan fitur game/fun
  const isReg = await db.isCustomerRegistered(senderNumber);
  if (!isReg && !isAdmin && !isOwner) {
    const senderMention = senderNumber.split('@')[0];
    const regNotice = `⚠️ *AKSES DITOLAK — REGISTRASI DIPERLUKAN* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nHalo @${senderMention}! Anda harus terdaftar sebagai member terlebih dahulu untuk bermain game & menggunakan fitur hiburan (100% Gratis & Cepat).\n\n📌 *Cara Pendaftaran (Hanya 5 Detik):*\nKetik: \`.daftar Nama Kamu\`\n\n_Contoh:_ \`.daftar Budi Santoso\`\n\nSetelah terdaftar, Anda dapat langsung menikmati semua game dan fitur bot! 🙏`;
    await sendInteractiveButtons(sock, jid, {
      text: regNotice,
      buttons: [
        { type: 'copy', text: '📋 Salin Format .daftar', copy_code: '.daftar ' }
      ]
    });
    return true;
  }

  // JAIL CHECK: User yang sedang dipenjara hanya bisa menggunakan command pelarian .jailbreak / .kabur
  const jailStatus = await db.isPlayerJailed(senderNumber);
  const isJailExemptCmd = ['jailbreak', 'kabur', 'bobolpenjara'].includes(command);
  if (jailStatus.isJailed && !isJailExemptCmd && !isAdmin && !isOwner) {
    await send(sock, jid, messageObj, `🔒 *KAMU SEDANG DI DALAM PENJARA!* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nKamu sedang menjalani masa tahanan selama *${jailStatus.remainingMinutes} menit* ke depan akibat tertangkap saat merampok/maling.\n\n👉 Ketik \`.jailbreak\` untuk mencoba melarikan diri dari sel, atau minta temanmu mengetik \`.tebus @kamu\`!`);
    return true;
  }
  
  // Catatan Pembaruan Sistem (Changelog & Patch Notes)
  if (['update', 'changelog', 'patchnotes', 'whatsnew', 'pembaruan'].includes(command)) {
    const sub = String(args[1] || '').toLowerCase();

    if (['broadcast', 'siar', 'siarkan', 'umumkan'].includes(sub)) {
      if (!isOwner) {
        await send(sock, jid, messageObj, '⚠️ Hanya Owner yang bisa menyiarkan catatan pembaruan ke seluruh grup.');
        return true;
      }
      const { siarkanUpdateManual } = await import('../utils/startupAnnounce.js');
      await send(sock, jid, messageObj, '📢 Menyiarkan catatan pembaruan ke seluruh grup terkonfigurasi…');
      const hasil = await siarkanUpdateManual(sock);
      await send(sock, jid, messageObj,
        `✅ *Siaran selesai.*\n📤 Terkirim: *${hasil.sukses}/${hasil.tujuan} grup*\n👥 Total grup terhubung: *${hasil.totalGrup}*`);
      return true;
    }

    if (['on', 'off', 'nyala', 'mati'].includes(sub)) {
      if (!isOwner) {
        await send(sock, jid, messageObj, '⚠️ Hanya Owner yang bisa mengatur pengumuman otomatis.');
        return true;
      }
      const nyala = ['on', 'nyala'].includes(sub);
      const { setPengumumanOtomatis } = await import('../utils/startupAnnounce.js');
      await setPengumumanOtomatis(nyala);
      await send(sock, jid, messageObj, nyala
        ? '🔔 *Pengumuman rilis otomatis DINYALAKAN.* Setiap versi baru akan disiarkan sekali ke seluruh grup terkonfigurasi.'
        : '🔕 *Pengumuman rilis otomatis DIMATIKAN.* Owner tetap menerima laporan status saat bot online.');
      return true;
    }

    await send(sock, jid, messageObj, getSystemChangelog());
    return true;
  }

  // AFK System
  if (['afk'].includes(command)) {
    const reason = args.slice(1).join(' ').trim() || 'Tanpa alasan';
    await db.setAfk(senderNumber, reason);

    let displayName = messageObj.pushName;
    if (!displayName || displayName === 'Pelanggan') {
      const cust = await db.getQuery("SELECT nama FROM customers WHERE nomor = ?", [senderNumber]);
      displayName = cust?.nama && cust.nama !== 'Pelanggan' ? cust.nama : `@${senderNumber.split('@')[0]}`;
    }

    await send(sock, jid, messageObj, `😴 *${displayName}* (@${senderNumber.split('@')[0]}) sekarang sedang **AFK**!\n📝 *Alasan:* ${reason}\n\n_Bot akan memberi tahu jika ada yang mention kamu, dan status AFK akan otomatis dicabut saat kamu mengirim pesan._`, [senderNumber]);
    return true;
  }

  // Interactive Point Heist / Steal System (.steal, .maling, .copet, .rampok, .rob)
  if (['steal', 'maling', 'copet', 'rampok', 'curi', 'rob'].includes(command)) {
    if (!isFromGroup) {
      await send(sock, jid, messageObj, "❌ Fitur pencurian/pembobolan poin (.steal) hanya bisa dimainkan di dalam grup!");
      return true;
    }
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetNumber = mentions[0] || contextInfo?.participant;

    if (!targetNumber && args[1]) {
      const res = await db.resolveTargetJid(args[1]);
      if (res?.ditemukan && res.jid) targetNumber = res.jid;
      else {
        const cleanNum = args[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) targetNumber = `${cleanNum}@s.whatsapp.net`;
      }
    }

    await handleStealHeist(sock, jid, messageObj, senderNumber, targetNumber);
    return true;
  }

  // Jawaban Manual Hack Brankas (.hack <jawaban>)
  if (['hack'].includes(command)) {
    const answer = args.slice(1).join(' ').trim();
    if (!activeStealSessions.has(senderNumber)) {
      await send(sock, jid, messageObj, "❌ Kamu tidak sedang dalam misi pembobolan brankas. Ketik `.steal @member` untuk memulai misi!");
      return true;
    }
    await handleStealAnswer(sock, jid, messageObj, senderNumber, answer);
    return true;
  }


  // Werewolf System
  if (['ww', 'werewolf'].includes(command)) {
    const subCmd = (args[1] || 'help').toLowerCase();
    const targetArg = args.slice(2).join(' ') || '';

    if (!isFromGroup && ['kill', 'inspect', 'protect'].includes(subCmd)) {
      const res = await ww.handleNightAction(sock, senderNumber, subCmd, targetArg);
      await send(sock, jid, messageObj, res.message, res.mentions || []);
      return true;
    }

    if (!isFromGroup) {
      await send(sock, jid, messageObj, `🐺 *WEREWOLF NIGHT ACTION*\n\nGunakan perintah berikut via PM:\n• \`.ww kill <nomor/mention>\` (Werewolf)\n• \`.ww inspect <nomor/mention>\` (Seer)\n• \`.ww protect <nomor/mention>\` (Guardian)`);
      return true;
    }

    if (['start', 'create', 'lobby'].includes(subCmd)) {
      const senderName = messageObj.pushName || senderNumber.split('@')[0];
      const res = await ww.startWwLobby(sock, jid, senderNumber, senderName);
      await send(sock, jid, messageObj, res.message, res.mentions || []);
      return true;
    }

    if (['join'].includes(subCmd)) {
      const senderName = messageObj.pushName || senderNumber.split('@')[0];
      const res = await ww.joinWwLobby(sock, jid, senderNumber, senderName);
      await send(sock, jid, messageObj, res.message, res.mentions || []);
      return true;
    }

    if (['startgame', 'mulai'].includes(subCmd)) {
      const res = await ww.startGameWw(sock, jid, senderNumber);
      if (res.message) await send(sock, jid, messageObj, res.message);
      return true;
    }

    if (['vote'].includes(subCmd)) {
      const res = await ww.handleDayVote(sock, jid, senderNumber, targetArg);
      await send(sock, jid, messageObj, res.message, res.mentions || []);
      return true;
    }

    if (['cancel', 'batal'].includes(subCmd)) {
      const res = ww.cancelWwGame(jid, senderNumber);
      await send(sock, jid, messageObj, res.message);
      return true;
    }

    const helpText = `🐺 *GAME WEREWOLF / MAFIA MULTIPLAYER* 🐺\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*Perintah di Grup:*\n` +
      `• \`.ww start\` — Buka lobby game di grup\n` +
      `• \`.ww join\` — Bergabung ke lobby\n` +
      `• \`.ww startgame\` — Memulai game (Min 4 Pemain)\n` +
      `• \`.ww vote @user\` — Voting eksekusi warga di siang hari\n` +
      `• \`.ww cancel\` — Batalkan game\n\n` +
      `*Perintah di PM Bot (Malam Hari):*\n` +
      `• \`.ww kill <nomor>\` — Memangsa target (Werewolf)\n` +
      `• \`.ww inspect <nomor>\` — Menerawang peran (Seer)\n` +
      `• \`.ww protect <nomor>\` — Melindungi target (Guardian)`;
    await send(sock, jid, messageObj, helpText);
    return true;
  }


  // --- UNIVERSAL GAME SURRENDER (.nyerah / .surrender / .menyerah) ---
  if (['nyerah', 'surrender', 'menyerah'].includes(command)) {
    // 1. Cek Trivia / Quiz / Tebak Kata / Tebak Emoji / Tebak Lagu / Tebak Bendera
    if (activeRounds.has(scope)) {
      return await surrenderRound({ sock, jid, senderNumber, messageObj, isFromGroup });
    }

    // 2. Cek Cak Lontong
    if (activeCakLontong.has(scope)) {
      return await surrenderCakLontong(sock, jid, messageObj, scope);
    }

    // 3. Cek Family 100
    if (activeFamily100.has(scope)) {
      return await surrenderFamily100(sock, jid, messageObj, scope);
    }

    // 4. Cek Tebak Gambar
    if (entertainment.activeGames.has(jid)) {
      const game = entertainment.activeGames.get(jid);
      game.isAnswered = true;
      if (game.timeout) clearTimeout(game.timeout);
      entertainment.activeGames.delete(jid);
      await send(sock, jid, messageObj, `🏳️ *MENYERAH — TEBAK GAMBAR* 🖼️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Jawaban yang benar: *${game.answer}*\n\n_Ketik \`.tebakgambar\` untuk bermain lagi._`);
      return true;
    }

    // 5. Cek Tebak Angka
    const gameKeyAngka = jid + '_angka';
    if (entertainment.activeGames.has(gameKeyAngka)) {
      const game = entertainment.activeGames.get(gameKeyAngka);
      game.isAnswered = true;
      if (game.timeout) clearTimeout(game.timeout);
      entertainment.activeGames.delete(gameKeyAngka);
      await send(sock, jid, messageObj, `🏳️ *MENYERAH — TEBAK ANGKA* 🔢\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔢 Angka rahasia yang benar: *${game.target || game.answer}*\n💰 Total Pot Jackpot Tersimpan: *${game.pot || 200} Poin*\n\n_Ketik \`.tebakangka\` untuk memulai ronde baru._`);
      return true;
    }

    // 6. Cek Susun Kata
    const gameKeySusun = jid + '_susunkata';
    if (entertainment.activeGames.has(gameKeySusun)) {
      const game = entertainment.activeGames.get(gameKeySusun);
      game.isAnswered = true;
      if (game.timeout) clearTimeout(game.timeout);
      entertainment.activeGames.delete(gameKeySusun);
      await send(sock, jid, messageObj, `🏳️ *MENYERAH — SUSUN KATA* 🔠\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔠 Kata yang benar adalah: *${game.answer}*\n\n_Ketik \`.susunkata\` untuk bermain lagi._`);
      return true;
    }

    // 7. Cek Ranjau Poin / Mines
    // `.surrender` juga terdaftar sebagai alias Mines, tapi cabang universal ini
    // ada di atas router Mines dan selalu balik `true`, jadi dulu pemain Mines
    // yang mengetik `.surrender` cuma dapat pesan "tidak ada sesi tebakan" dan
    // modalnya tetap tertahan di sesi. Diarahkan ke pembatalan Mines di sini.
    if (activeMinesGames.has(senderNumber)) {
      return await handleMinesCommand(sock, jid, senderNumber, messageObj, args, 'batalmines', isFromGroup);
    }

    await send(sock, jid, messageObj, "❌ Tidak ada sesi game tebakan yang sedang aktif di chat ini.");
    return true;
  }

  const roundCommands = ['jawab', 'answer', 'hint'];
  if (roundCommands.includes(command)) {
    return await handleRoundCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd: command, isFromGroup });
  }

  // Arena Kartu Monster (TCG). Semua sub-perintah bersarang di bawah `.tcg`
  // supaya tidak menambah nama baru ke ruang perintah tingkat atas yang sudah padat.
  if (['tcg', 'arena', 'kartumonster'].includes(command)) {
    return await handleTcgCommand({
      sock, jid, senderNumber, messageObj, args,
      isFromGroup, isAdmin, isOwner, isStoreAdmin
    });
  }

  if (isFromGroup && ['quiz', 'trivia', 'tebakquiz', 'tebakemoji', 'emoji', 'tebakkata', 'hangman', 'kata', 'tebaklagu', 'tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag', 'sambungkata', 'wordchain', 'truth', 'dare', 'tod', 'dadu', 'dice', 'coinflip', 'koin', 'coin', 'poll', 'voting', 'vote', 'love', 'jodoh', 'compatibility', 'slot', 'daily', 'spin', 'luckyspin', 'suit', 'pilihsuit', 'cancelsuit', 'batalsuit', 'tebakangka', 'tebak', 'tukar', 'pointshop', 'penukaran'].includes(command)) {
    const groupSettings = await db.getGroupSettings(jid);
    if (groupSettings.bot_mode === 'sales') return false;
  }

  // Misi Pelarian Penjara (Jailbreak / Prison Break)
  if (['jailbreak', 'kabur', 'bobolpenjara'].includes(command)) {
    return await handleJailbreak(sock, jid, senderNumber, messageObj);
  }

  // Tebus / Bebaskan Teman dari Penjara
  if (['tebus', 'bebasinnapi'].includes(command)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
    return await handleTebusNapi(sock, jid, senderNumber, messageObj, target);
  }

  // Game Undercover / Impostor Kata
  if (['undercover', 'sus', 'impostor', 'joinundercover', 'startundercover'].includes(command)) {
    return await handleUndercover(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Voting kategori kata Undercover (.votekategori / .katakategori)
  if (['votekategori', 'katakategori'].includes(command)) {
    if (activeUndercoverGames.has(jid)) {
      return await handleCategoryVote(sock, jid, senderNumber, messageObj, args[1]);
    }
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover aktif di grup ini.");
    return true;
  }

  // Setoran petunjuk Ronde Anonim Undercover (.anon <teks>)
  //
  // Sengaja BUKAN `.petunjuk`: nama itu sudah dipakai tutorial toko di
  // customerHandler, dan handler game berjalan lebih dulu di rantai router
  // (AGENTS.md §5) sehingga akan menelannya untuk semua pengguna.
  if (['anon', 'clue', 'setorpetunjuk', 'kirimpetunjuk'].includes(command)) {
    const isiPetunjuk = args.slice(1).join(' ').trim();
    return await handleUndercoverAnonClue(sock, jid, senderNumber, messageObj, isiPetunjuk);
  }

  // Vonis juri Sidang Terakhir Undercover (.bersalah / .bebas)
  if (['bersalah', 'guilty'].includes(command)) {
    return await handleTrialVote(sock, jid, senderNumber, messageObj, 'GUILTY');
  }
  if (['bebas', 'innocent'].includes(command)) {
    return await handleTrialVote(sock, jid, senderNumber, messageObj, 'INNOCENT');
  }
  if (command === 'vonis') {
    const pilihan = (args[1] || '').toLowerCase();
    if (['bersalah', 'guilty', 'salah'].includes(pilihan)) {
      return await handleTrialVote(sock, jid, senderNumber, messageObj, 'GUILTY');
    }
    if (['bebas', 'innocent', 'lolos'].includes(pilihan)) {
      return await handleTrialVote(sock, jid, senderNumber, messageObj, 'INNOCENT');
    }
    await send(sock, jid, messageObj, "⚖️ Tentukan vonismu: `.vonis bersalah` atau `.vonis bebas` (bisa juga langsung `.bersalah` / `.bebas`).");
    return true;
  }

  // Bisikan Arwah Undercover (.bisik <pesan>) — khusus pemain yang sudah gugur
  if (['bisik', 'whisper', 'arwah'].includes(command)) {
    const isiBisikan = args.slice(1).join(' ').trim();
    return await handleGhostWhisper(sock, jid, senderNumber, messageObj, isiBisikan);
  }

  // Pasar Gelap Mr. White (.belihuruf)
  if (['belihuruf', 'pasargelap'].includes(command)) {
    return await handleBlackMarket(sock, jid, senderNumber, messageObj);
  }

  // Misi rahasia Undercover.
  //
  // `.misi` adalah alias bersama dengan papan misi harian di bawah. Dipilah
  // berdasarkan sesi yang benar-benar berjalan (pola yang sama dengan
  // `.heal` Dokter vs Healer raid), bukan urutan if: hanya pemain yang sedang
  // memegang misi rahasia Undercover yang dibelokkan ke sini.
  if (['misi', 'misirahasia'].includes(command)) {
    const ucCtx = findUndercoverSessionAndPlayer(senderNumber);
    const punyaMisiUc = !!getPlayerRoleData(ucCtx.session, ucCtx.playerJid)?.mission;
    if (punyaMisiUc || command === 'misirahasia') {
      return await handleShowMission(sock, jid, senderNumber, messageObj);
    }
  }

  // Tutup fase diskusi Undercover lebih cepat (.lanjut)
  if (['lanjut', 'gasvote', 'mulaivote'].includes(command)) {
    if (activeUndercoverGames.has(jid)) {
      return await handleUndercoverContinue(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
    }
    return false;
  }

  // Skill tukar giliran Undercover (.tukargiliran) — nama sengaja tidak memakai
  // `.tukar` karena command itu sudah dipakai untuk Toko Penukaran Poin.
  if (['tukargiliran', 'swapgiliran', 'lempargiliran'].includes(command)) {
    return await handleUndercoverSwap(sock, jid, senderNumber, messageObj);
  }

  // Voting Undercover / Werewolf (.vote / .v)
  if (['vote', 'v'].includes(command)) {
    const ucSession = activeUndercoverGames.get(jid);
    if (ucSession && ['CATEGORY_VOTE', 'DISCUSSION_PHASE', 'VOTING_PHASE'].includes(ucSession.status)) {
      const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
      return await handleUndercoverVote(sock, jid, senderNumber, messageObj, target);
    }
    if (ww.activeWwGames.has(jid) && ww.activeWwGames.get(jid).status === 'DAY') {
      const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
      const wwRes = await ww.handleWwDayVote(sock, jid, senderNumber, messageObj, target);
      if (wwRes) return true;
    }
    if ((text || '').includes('|')) {
      const parts = text.slice(command.length + 1).trim().split('|').map(part => part.trim()).filter(Boolean);
      if (parts.length < 3 || parts.length > 13) {
        await send(sock, jid, messageObj, 'Format: `.poll Pertanyaan | Opsi 1 | Opsi 2`\nMinimal 2 opsi, maksimal 12 opsi.');
        return true;
      }
      await sock.sendMessage(jid, { poll: { name: parts[0], values: parts.slice(1), selectableCount: 1 } });
      return true;
    }
    await send(sock, jid, messageObj, "❌ Saat ini tidak ada sesi voting game (Undercover / Werewolf) aktif di grup ini.\n\nUntuk membuat polling WhatsApp biasa, gunakan format:\n`.poll Pertanyaan | Opsi 1 | Opsi 2`");
    return true;
  }

  // Skip Turn / Skip Vote Undercover (.skip / .lewat / .pass / .skipundercover)
  if (['skip', 'lewat', 'pass', 'skipundercover'].includes(command)) {
    if (activeUndercoverGames.has(jid)) {
      return await handleUndercoverSkip(sock, jid, senderNumber, messageObj, text, isAdmin, isOwner);
    }
  }

  // Tebak Kata Warga untuk Mr. White (.tebakwarga <kata> / .guess <kata> / .mrwhite <kata>)
  if (['tebakwarga', 'guess', 'mrwhite', 'tebakciv'].includes(command)) {
    const guess = args.slice(1).join(' ').trim();
    return await handleMrWhiteGuess(sock, jid, senderNumber, messageObj, guess);
  }

  // Detektif Undercover (.intip @member)
  if (['intip', 'cekintip'].includes(command)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
    return await handleDetectiveCheck(sock, jid, senderNumber, messageObj, target);
  }

  // Guardian Undercover (.lindung @member / .guard @member)
  if (['lindung', 'guard', 'protect', 'lindungi'].includes(command)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
    return await handleGuardianProtect(sock, jid, senderNumber, messageObj, target);
  }

  // Doctor Undercover (.sembuhkan @member / .revive @member)
  //
  // `heal` dan `revive` adalah alias milik dua game sekaligus: Dokter Undercover
  // dan Healer Raid Boss. Dulu blok ini menelan keduanya karena letaknya di atas
  // router raid dan handler Dokter selalu balik `true` (walau cuma untuk kirim
  // pesan "tidak ada sesi Undercover"), sehingga Healer raid tidak pernah bisa
  // memakai skill-nya. Sekarang alias bersama dipilah berdasarkan sesi yang
  // benar-benar sedang berjalan, bukan urutan if:
  //   1. Pengirim anggota regu raid di grup ini  -> raid.
  //   2. Pengirim Dokter hidup di sesi Undercover -> undercover.
  //   3. Ada sesi raid di grup ini (tapi bukan anggota) -> raid, biar pesannya
  //      "kamu bukan anggota regu", bukan pesan Undercover yang membingungkan.
  //   4. Sisanya -> undercover (termasuk Dokter yang main lewat DM).
  // Alias eksklusif tiap game (.sembuhkan/.cpr/.obati vs .massheal) tidak ikut
  // dipilah dan tetap langsung ke pemiliknya.
  if (['sembuhkan', 'revive', 'heal', 'cpr', 'obati', 'doctor'].includes(command)) {
    const isAliasBersama = ['heal', 'revive'].includes(command);
    let milikRaid = false;

    if (isAliasBersama && isFromGroup) {
      const raidCtx = getRaidContext(jid, senderNumber);
      milikRaid = raidCtx.anggota || (raidCtx.adaSesi && !isUndercoverDoctorActive(senderNumber));
    }

    if (!milikRaid) {
      const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
      return await handleDoctorRevive(sock, jid, senderNumber, messageObj, target);
    }
  }

  // Framer Undercover (.fitnah @member / .frame @member)
  if (['fitnah', 'frame', 'framer'].includes(command)) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
    return await handleFramerFrame(sock, jid, senderNumber, messageObj, target);
  }

  // Saboteur Undercover (.hack @member / .sabotase @member)
  if (['sabotase'].includes(command) || (command === 'hack' && !args[1]?.includes('bank'))) {
    const target = messageObj.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[1];
    const isSabotageHandled = await handleSaboteurHack(sock, jid, senderNumber, messageObj, target);
    if (isSabotageHandled) return true;
  }

  // Turnamen Battle Royale Cerdas Cermat
  if (['cerdascermat', 'kuisturnamen', 'quizbattle', 'joincerdascermat', 'startcerdascermat'].includes(command)) {
    return await handleQuizTournament(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Family 100
  if (['family100', 'f100'].includes(command)) return await startFamily100(sock, jid, senderNumber, messageObj, isFromGroup);

  // Cak Lontong
  if (['caklontong', 'tts'].includes(command)) return await startCakLontong(sock, jid, senderNumber, messageObj, isFromGroup);

  // Duel Tembak (Russian Roulette)
  if (['duel'].includes(command)) return await handleDuelCommand(sock, jid, senderNumber, messageObj, args, isFromGroup);
  if (['terimaduel', 'gasduel', 'gas', 'tolakduel', 'tembak', 'shoot', 'dor', 'pull'].includes(command)) {
    // Tembakan Rahasia Undercover / Sheriff Koboi (.tembak @member / .shoot @member / .dor <nomor>)
    if (['tembak', 'shoot', 'dor'].includes(command)) {
      const isUndercoverShot = await handleUndercoverShoot(sock, jid, senderNumber, messageObj, args);
      if (isUndercoverShot) return true;
    }

    const isDuelHandled = await handleDuelAction(sock, jid, senderNumber, messageObj, command);
    if (isDuelHandled) return true;
  }

  // Blackjack 21
  if (['blackjack', 'bj', 'hit', 'stand', 'double'].includes(command)) {
    return await handleBlackjack(sock, jid, senderNumber, messageObj, args, command);
  }

  // Poker Suite: Texas Hold'em, Capsa Susun, Fast 3-Card Poker
  if (['poker', 'texaspoker', 'texas', 'holdem', 'joinpoker', 'startpoker', 'batalpoker', 'check', 'call', 'raise', 'allin', 'fold', 'capsa', 'capsasusun', 'joincapsa', 'startcapsa', 'batalcapsa', 'fastpoker', 'poker3', 'joinfastpoker', 'startfastpoker', 'batalfastpoker'].includes(command)) {
    return await handlePokerCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // `.kartu` / `.hand` / `.cekkartu` untuk mengintip kartu Texas Poker.
  // Dispatcher poker sudah menangani alias ini, tapi dulu tidak pernah dipanggil
  // dari sini sehingga perintahnya mati total (hanya `.poker kartu` yang jalan).
  // Digerbangi sesi aktif supaya tidak menyerobot alias `.kartu` milik fitur lain.
  if (['kartu', 'hand', 'mycards', 'cekkartu', 'kartuku'].includes(command)) {
    const adaSesiPoker = activeTexasGames.has(jid)
      || [...activeTexasGames.values()].some(s => s.players?.some(p => p === senderNumber));
    if (adaSesiPoker) {
      return await handlePokerCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
    }
  }

  // Cut The Wire (Jinakkan Bom Waktu)
  if (['bom', 'cutthewire', 'jinakkanbom', 'joinbom', 'gasbom', 'batalbom', 'cancelbom', 'potong', 'cut', 'kabel'].includes(command)) {
    return await handleCutTheWire(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Battleship 1v1 (Perang Armada Kapal Laut)
  if (['battleship', 'kapal', 'perangkapal', 'terimakapal', 'gaskapal', 'tolakkapal', 'batalkapal', 'rudal', 'bomkapal'].includes(command) || (['tembak', 'shoot', 'fire'].includes(command) && activeBattleships.has(jid))) {
    return await handleBattleshipCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Buckshot Roulette 1v1 (Shotgun Taktis)
  //
  // Alias milik game sendiri selalu hidup; alias yang dipinjam dari kosakata
  // umum (`pakai`, `use`, `bir`, `kaca`, `tembak`, ...) hanya boleh diklaim saat
  // memang ada duel di grup ini. Dulu kelima alias item ikut rute tanpa syarat,
  // sehingga mengetik `.use` atau `.pakai` di DM pun dibalas "❌ hanya dapat
  // dimainkan di grup" padahal tidak ada duel di mana pun.
  const BUCKSHOT_CMD = ['buckshot', 'shotgun', 'gasbuckshot', 'tolakbuckshot', 'batalbuckshot', 'nyerahbuckshot'];
  const BUCKSHOT_CMD_SESI = ['pakai', 'use', 'rokok', 'kaca', 'gergaji', 'bir', 'borgol', 'tembak', 'shoot', 'dor', 'fire'];
  if (BUCKSHOT_CMD.includes(command) || (BUCKSHOT_CMD_SESI.includes(command) && activeBuckshots.has(jid))) {
    return await handleBuckshotCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Rampok Bank Akbar (Group Heist)
  if (['heist', 'rampokbank', 'joinheist', 'startheist'].includes(command)) {
    return await handleBankHeist(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Balap Kuda Uma Musume Derby Multi-Betting
  if (['balapkuda', 'pasangkuda', 'betkuda', 'pasang', 'bet', 'kuda', 'race', 'startbalap', 'startrace', 'cancelbalap'].includes(command)) {
    return await handleHorseRace(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin, isOwner);
  }

  // Mystery Auction (Lelang Kotak Misteri)
  if (['lelang', 'auction', 'lelangkotak', 'bid', 'tawar', 'bidup', 'cancellelang', 'batallelang', 'infolelang', 'lelanginfo', 'lelangstats', 'statlelang', 'lelangstat', 'lelangtop', 'toplelang', 'lelangleaderboard', 'endus', 'periksakotak', 'ciumkotak', 'gertak', 'gertakan', 'sikut', 'blokir', 'ganggu'].includes(command)) {
    return await handleAuctionCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin, isOwner);
  }

  // Ranjau Poin / Mines & Cashout
  if (['mines', 'ranjau', 'buka', 'pick', 'cashout', 'tarikdana', 'batalmines', 'surrender', 'infomines', 'tabelmines', 'minesinfo'].includes(command)) {
    return await handleMinesCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Raid World Boss (MMORPG Co-op)
  if (['raid', 'worldboss', 'bos', 'joinraid', 'joinr', 'pilihrole', 'startraid', 'gasraid', 'mulairaid', 'cancelraid', 'batalraid', 'statusraid', 'raidstatus', 'statusr', 'inforaid', 'raidtop', 'topraid', 'raidleaderboard', 'raidstats', 'statraid', 'raidstat', 'serang', 'atk', 'berserk', 'tameng', 'shield', 'taunt', 'provokasi', 'provoke', 'benteng', 'heal', 'massheal', 'revive', 'sihir', 'cast', 'freeze', 'stun'].includes(command)) {
    return await handleRaidCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin, isOwner);
  }

  // Bank Poin & Bunga Harian
  if (['bank', 'brankas', 'depo', 'setor', 'tarik', 'withdraw'].includes(command)) {
    return await handleBankEconomy(sock, jid, senderNumber, messageObj, args, command);
  }

  if (['quiz', 'trivia', 'tebakquiz'].includes(command)) return await startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'quiz' });
  if (['tebakemoji', 'emoji'].includes(command)) return await startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebakemoji' });
  if (['tebakkata', 'hangman', 'kata'].includes(command)) return await startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebakkata' });
  if (['tebaklagu', 'lagu', 'musicquiz', 'tebakmusik'].includes(command)) return await startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebaklagu' });
  if (['tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag'].includes(command)) return await startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebakbendera' });

  if (['truth', 'dare', 'tod'].includes(command)) {
    if (isOnCooldown(`${scope}:truth`, 5000)) return true;
    await send(sock, jid, messageObj, entertainment.getTruthOrDare(command));
    return true;
  }

  if (['dadu', 'dice'].includes(command)) {
    if (isOnCooldown(`${scope}:dice`, 3000)) return true;

    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : (benefits?.slotMaxBet || 50_000);

    const prediction = args[1]?.toLowerCase();
    const rawBet = args[2]?.toLowerCase();

    const isSpecificNumber = ['1', '2', '3', '4', '5', '6'].includes(prediction);
    const isEvenOdd = ['ganjil', 'genap', 'odd', 'even'].includes(prediction);
    const isUnderOver = ['kecil', 'besar', 'under', 'over'].includes(prediction);

    if (!prediction || (!isSpecificNumber && !isEvenOdd && !isUnderOver)) {
      await send(sock, jid, messageObj, `🎲 *TARUHAN DADU* 🎲\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*Format Perintah:* \`.dadu [pilihan] [taruhan/all]\`\n\n*Pilihan Yang Tersedia:*\n▫️ Angka: *1* s/d *6* (Hadiah 5x lipat 💥)\n▫️ Genap / Ganjil (Hadiah 2x lipat 💰)\n▫️ Besar (4-6) / Kecil (1-3) (Hadiah 2x lipat 💰)\n\n*Contoh:* \`.dadu besar 50\` atau \`.dadu 4 all\``);
      return true;
    }

    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    let bet = 10;
    if (rawBet === 'all' || rawBet === 'allin') {
      bet = Math.max(1, Math.min(maxBet, currentPoints));
    } else {
      const parsedBet = rawBet ? Number.parseInt(rawBet, 10) : 10;
      if (rawBet && (isNaN(parsedBet) || !isFinite(parsedBet) || parsedBet <= 0)) {
        await send(sock, jid, messageObj, `❌ Jumlah taruhan tidak valid: *${rawBet}*\n\nGunakan angka positif minimal 1 atau 'all'. Contoh: \`.dadu besar 50\` atau \`.dadu besar all\``);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, isNaN(parsedBet) ? 10 : parsedBet));
    }

    const deductRes = await db.deductGamePoints(senderNumber, bet);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu butuh *${bet} poin*, tapi sisa poinmu hanya *${deductRes.currentPoints || currentPoints} poin*.\n\nKetik \`.daily\` untuk mengambil poin gratis harian!`);
      return true;
    }

    const roll = Math.floor(Math.random() * 6) + 1;
    let isWin = false;
    let multiplier = 1;

    if (isSpecificNumber) {
      isWin = parseInt(prediction, 10) === roll;
      multiplier = 5; // Payout 5x lipat net profit 4x
    } else if (isEvenOdd) {
      const isRollEven = roll % 2 === 0;
      if (prediction === 'genap' || prediction === 'even') {
        isWin = isRollEven;
      } else {
        isWin = !isRollEven;
      }
      multiplier = 2; // Payout 2x lipat net profit 1x
    } else if (isUnderOver) {
      const isRollKecil = roll <= 3;
      if (prediction === 'kecil' || prediction === 'under') {
        isWin = isRollKecil;
      } else {
        isWin = !isRollKecil;
      }
      multiplier = 2; // Payout 2x lipat net profit 1x
    }

    let newPoints = deductRes.newPoints;
    if (isWin) {
      const winPayout = bet * multiplier;
      const updatedProf = await db.addGamePoints(senderNumber, winPayout);
      newPoints = updatedProf.points;
    }

    let msg = `🎲 *DICE ROLL BETTING* 🎲\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `Taruhan: *${bet} poin* pada *${prediction.toUpperCase()}*\n`;
    msg += `Hasil Dadu: *${roll}*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (isWin) {
      msg += `🎉 *MENANG!* Pilihan kamu benar.\n`;
      msg += `🎁 Hadiah: *+${bet * (multiplier - 1)} poin* (${multiplier}x total payout)\n`;
    } else {
      msg += `💸 *RUNGKAD!* Pilihan kamu meleset.\n`;
      msg += `💰 Kerugian: *-${bet} poin*\n`;
    }
    msg += `💳 Sisa Poin: *${newPoints} poin*`;

    await send(sock, jid, messageObj, msg, {
      buttons: [
        { type: 'reply', text: `🎲 Main Lagi (${prediction} ${bet})`, id: `.dadu ${prediction} ${bet}` }
      ]
    });
    return true;
  }

  if (['coinflip', 'koin', 'coin'].includes(command)) {
    if (isOnCooldown(`${scope}:coin`, 3000)) return true;

    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    // Owner/Admin bebas limit max bet
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : (benefits?.slotMaxBet || 50_000);

    const choice = args[1]?.toLowerCase();
    const rawBet = args[2]?.toLowerCase();

    if (!choice || !['heads', 'tails', 'angka', 'gambar', 'h', 't'].includes(choice)) {
      await send(sock, jid, messageObj, `🪙 *TARUHAN LEMPAR KOIN* 🪙\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*Format Perintah:* \`.coinflip [heads/tails/angka/gambar] [taruhan/all]\`\n\n*Contoh:* \`.coinflip heads 50\` atau \`.coinflip tails all\``);
      return true;
    }

    const playerChoice = ['heads', 'angka', 'h'].includes(choice) ? 'HEADS 🪙' : 'TAILS 🪙';

    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    let bet = 10;
    if (rawBet === 'all' || rawBet === 'allin') {
      bet = Math.max(1, Math.min(maxBet, currentPoints));
    } else {
      const parsedBet = rawBet ? Number.parseInt(rawBet, 10) : 10;
      if (rawBet && (isNaN(parsedBet) || !isFinite(parsedBet) || parsedBet <= 0)) {
        await send(sock, jid, messageObj, `❌ Jumlah taruhan tidak valid: *${rawBet}*\n\nGunakan angka positif minimal 1 atau 'all'. Contoh: \`.coinflip heads 50\` atau \`.coinflip heads all\``);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, isNaN(parsedBet) ? 10 : parsedBet));
    }

    const deductRes = await db.deductGamePoints(senderNumber, bet);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu butuh *${bet} poin*, tapi sisa poinmu hanya *${deductRes.currentPoints || currentPoints} poin*.\n\nKetik \`.daily\` untuk mengambil poin gratis harian!`);
      return true;
    }

    const roll = Math.random() < 0.5 ? 'HEADS 🪙' : 'TAILS 🪙';
    const isWin = playerChoice === roll;
    let newPoints = deductRes.newPoints;

    if (isWin) {
      const winPayout = bet * 2;
      const updatedProf = await db.addGamePoints(senderNumber, winPayout);
      newPoints = updatedProf.points;
    }

    let msg = `🪙 *LEMPAR KOIN BETTING* 🪙\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `Pilihan Kamu: *${playerChoice}*\n`;
    msg += `Hasil Koin: *${roll}*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (isWin) {
      msg += `🎉 *MENANG DOUBLE!* Tebakanmu tepat.\n`;
      msg += `🎁 Hadiah: *+${bet} poin*\n`;
    } else {
      msg += `💸 *RUNGKAD!* Tebakanmu salah.\n`;
      msg += `💰 Kerugian: *-${bet} poin*\n`;
    }
    msg += `💳 Sisa Poin: *${newPoints} poin*`;

    await send(sock, jid, messageObj, msg, {
      buttons: [
        { type: 'reply', text: `🪙 Heads (${bet} Poin)`, id: `.coinflip heads ${bet}` },
        { type: 'reply', text: `🪙 Tails (${bet} Poin)`, id: `.coinflip tails ${bet}` }
      ]
    });
    return true;
  }

  if (['sambungkata', 'wordchain'].includes(command)) {
    const word = normalizeAnswer(args.slice(1).join(' '));
    const round = activeRounds.get(scope);
    if (!word && !round) {
      const starter = randomItem(['AKBAR', 'TOKO', 'DIGITAL', 'PROMO', 'GAME']);
      // kataTerpakai menutup rantai `RR -> RR -> RR`: normalizeAnswer membuang
      // semua non-huruf, jadi tanpa daftar ini satu kata bisa diulang selamanya.
      const round = { type: 'wordchain', lastWord: starter, kataTerpakai: new Set([starter]), answer: '', expiresAt: Date.now() + ROUND_DURATION_MS };
      activeRounds.set(scope, round);
      scheduleRoundExpiry({ sock, jid, messageObj, key: scope, round });
      await send(sock, jid, messageObj, `🔗 *SAMBUNG KATA*\n\nKata awal: *${starter}*\nKirim *.sambungkata <kata>* yang diawali huruf *${starter.slice(-1)}*.`);
      return true;
    }
    if (!round || round.type !== 'wordchain') {
      await send(sock, jid, messageObj, 'Belum ada sambung kata aktif. Ketik `.sambungkata` untuk memulai.');
      return true;
    }
    if (!word) {
      await send(sock, jid, messageObj, `Kata berikutnya harus dimulai dengan huruf *${round.lastWord.slice(-1)}*.`);
      return true;
    }
    if (word[0] !== round.lastWord.slice(-1)) {
      await send(sock, jid, messageObj, `❌ Harus dimulai dari huruf *${round.lastWord.slice(-1)}*.`);
      return true;
    }
    if (word.length < 4) {
      await send(sock, jid, messageObj, `❌ Kata minimal *4 huruf*. Coba kata lain berawalan *${round.lastWord.slice(-1)}*.`);
      return true;
    }
    if (!round.kataTerpakai) round.kataTerpakai = new Set([round.lastWord]);
    if (round.kataTerpakai.has(word)) {
      await send(sock, jid, messageObj, `❌ Kata *${word}* sudah dipakai di ronde ini. Cari kata lain berawalan *${round.lastWord.slice(-1)}*.`);
      return true;
    }
    // Penjaga giliran dulu hanya menyala di grup (`&& isFromGroup`), sehingga di
    // DM satu orang bisa menyambung kata sendiri tanpa henti — tiap sambungan
    // mencetak 5 poin + 5 XP. Sambung kata memang butuh lawan, jadi penjaganya
    // sekarang berlaku di mana pun.
    if (round.lastPlayer === senderNumber) {
      await send(sock, jid, messageObj, isFromGroup
        ? `⚠️ Tunggu giliran member lain untuk menyambung kata selanjutnya!`
        : `⚠️ Sambung kata butuh lawan. Mainkan di grup supaya ada yang menyambung giliranmu.`);
      return true;
    }
    round.lastWord = word;
    round.lastPlayer = senderNumber;
    round.kataTerpakai.add(word);
    // addGamePoints, BUKAN awardGamePoints: menyambung satu kata bukan
    // "memenangkan satu pertandingan". awardGamePoints ikut mencetak XP senilai
    // poin dan menaikkan games_played + games_won sekaligus.
    const profile = await db.addGamePoints(senderNumber, 5);
    await send(sock, jid, messageObj, `✅ *${word}* diterima! Lanjutkan dengan kata berawalan *${word.slice(-1)}*.\n+5 poin untukmu. Total: *${profile.points}*`);
    return true;
  }

  if (['daily', 'hadian', 'reward'].includes(command)) {
    // Tanggal WIB, bukan UTC — lihat db.tanggalWIB(). Sebelum ini hari pemain
    // berganti jam 07:00 pagi, jadi klaim lewat tengah malam ditolak palsu.
    const today = db.tanggalWIB();
    // Cek premium multiplier
    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    const baseReward = 25;
    // Power-Up Daily Boost dari toko poin `.tukar`. Jatahnya baru dipotong kalau
    // klaim benar-benar berhasil, supaya klaim kedua di hari yang sama tidak
    // membakar buff pemain.
    const dailyBuff = await db.getActiveBuff(senderNumber, 'DAILY_BOOST');
    const dailyBoostMult = (dailyBuff && Number(dailyBuff.multiplier) > 0) ? Number(dailyBuff.multiplier) : 1;
    const finalReward = Math.floor(baseReward * benefits.dailyRewardMult * dailyBoostMult);
    const result = await db.claimGameDaily(senderNumber, today, finalReward);
    if (!result.success) {
      await send(sock, jid, messageObj, `⏳ ${result.message}`, {
        title: '⏳ KLAIM DAILY HARIAN',
        buttons: [
          { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
          { type: 'reply', text: '👤 Profil Saya', id: '.poin' },
          { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
        ]
      });
      return true;
    }
    if (dailyBoostMult > 1) {
      await db.consumeBuffUse(senderNumber, 'DAILY_BOOST');
    }
    const boostLabel = dailyBoostMult > 1 ? ` + Daily Boost ${dailyBoostMult}x ⚡` : '';
    const bonusLabel = benefits.dailyRewardMult > 1 ? ` (${premiumTier} Bonus ${benefits.dailyRewardMult}x 🚀)` : '';
    const safeDailyPoints = Math.max(0, Math.floor(Number(result.profile?.points) || 0));
    await send(sock, jid, messageObj, `🎁 Hadiah harian berhasil diklaim: *+${result.reward} poin*${bonusLabel}${boostLabel}\n🔥 Streak: *${result.streak} hari*\n💰 Total poin: *${safeDailyPoints}*`, {
      title: '🎁 HADIAH HARIAN TERKLAIM',
      buttons: [
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '👤 Profil Saya', id: '.poin' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ]
    });
    return true;
  }

  if (['addpoint', 'addpoints', 'addpoin', 'tambahpoin', 'tambahpoint', 'pluspoin'].includes(command)) {
    // Mencetak poin harus butuh identitas Admin Toko. isAdmin bernilai true untuk admin grup
    // WhatsApp mana pun, dan poin menentukan power-up serta papan peringkat.
    if (!isStoreAdmin && !isOwner) {
      await send(sock, jid, messageObj, "❌ Perintah penambahan poin ini khusus untuk *Admin Toko* atau *Owner*. Status admin grup WhatsApp saja tidak cukup.");
      return true;
    }
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = null;
    let amount = NaN;

    if (mentions.length > 0) {
      targetJid = mentions[0];
      for (let i = 1; i < args.length; i++) {
        const val = parseInt(args[i], 10);
        if (!isNaN(val) && val > 0 && !args[i].startsWith('@')) {
          amount = val;
          break;
        }
      }
    } else if (contextInfo?.participant) {
      targetJid = contextInfo.participant;
      for (let i = 1; i < args.length; i++) {
        const val = parseInt(args[i], 10);
        if (!isNaN(val) && val > 0) {
          amount = val;
          break;
        }
      }
    } else {
      const arg1 = args[1];
      const arg2 = args[2];

      if (!arg1) {
        // empty
      } else if (arg1.toLowerCase() === 'me' || arg1.toLowerCase() === 'self' || arg1.toLowerCase() === 'saya') {
        targetJid = senderNumber;
        amount = parseInt(arg2, 10);
      } else if (arg1 && !arg2) {
        const parsed = parseInt(arg1, 10);
        if (!isNaN(parsed) && parsed > 0) {
          targetJid = senderNumber;
          amount = parsed;
        }
      } else if (arg1 && arg2) {
        const res1 = await db.resolveTargetJid(arg1);
        const res2 = await db.resolveTargetJid(arg2);
        if (res1?.ditemukan && !isNaN(parseInt(arg2, 10))) {
          targetJid = res1.jid;
          amount = parseInt(arg2, 10);
        } else if (res2?.ditemukan && !isNaN(parseInt(arg1, 10))) {
          targetJid = res2.jid;
          amount = parseInt(arg1, 10);
        } else {
          const num1 = arg1.replace(/[^0-9]/g, '');
          const num2 = arg2.replace(/[^0-9]/g, '');
          if (num1.length > 5 && !isNaN(parseInt(arg2, 10))) {
            targetJid = `${num1}@s.whatsapp.net`;
            amount = parseInt(arg2, 10);
          } else if (num2.length > 5 && !isNaN(parseInt(arg1, 10))) {
            targetJid = `${num2}@s.whatsapp.net`;
            amount = parseInt(arg1, 10);
          }
        }
      }
    }

    if (!targetJid || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Tambah Poin (Admin/Owner):*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n▫️ `.addpoint [jumlah]` (tambah ke diri sendiri)\n▫️ `.addpoint @member [jumlah]` (tag orang)\n▫️ `.addpoint [nomor] [jumlah]` (ketik nomor)\n▫️ Balas/Quote pesan member lalu ketik `.addpoint [jumlah]`\n\n*Contoh:* `.addpoint 500` atau `.addpoint @628123456789 500`");
      return true;
    }

    let actualTargetJid = targetJid;
    const resolvedTarget = await db.resolveTargetJid(targetJid);
    if (resolvedTarget?.ditemukan && resolvedTarget.jid) {
      actualTargetJid = resolvedTarget.jid;
    }

    try {
      const profile = await db.addGamePoints(actualTargetJid, amount);
      const targetPhone = actualTargetJid.split('@')[0];
      const targetCust = await db.getCustomerByPhone(actualTargetJid);
      const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;
      await send(sock, jid, messageObj, `✅ Berhasil menambahkan *${amount.toLocaleString('id-ID')} poin* ke ${targetLabel}.\n💰 Total Poin Sekarang: *${profile.points.toLocaleString('id-ID')} poin*`, {
        mentions: [actualTargetJid]
      });
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Gagal menambahkan poin: ${err.message}`);
    }
    return true;
  }

  // ─── OWNER ONLY: KURANGI POIN MEMBER LAIN (.kurangpoin / .delpoint) ───
  if (['kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin', 'minuspoin'].includes(command)) {
    if (!isOwner) {
      await send(sock, jid, messageObj, "❌ Fitur pengurangan poin ini khusus untuk Pemilik (Owner) bot.");
      return true;
    }
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = null;
    let amount = NaN;

    if (mentions.length > 0) {
      targetJid = mentions[0];
      for (let i = 1; i < args.length; i++) {
        const val = parseInt(args[i], 10);
        if (!isNaN(val) && val > 0 && !args[i].startsWith('@')) {
          amount = val;
          break;
        }
      }
    } else if (contextInfo?.participant) {
      targetJid = contextInfo.participant;
      for (let i = 1; i < args.length; i++) {
        const val = parseInt(args[i], 10);
        if (!isNaN(val) && val > 0) {
          amount = val;
          break;
        }
      }
    } else {
      const arg1 = args[1];
      const arg2 = args[2];

      if (arg1 && arg2) {
        const res1 = await db.resolveTargetJid(arg1);
        const res2 = await db.resolveTargetJid(arg2);
        if (res1?.ditemukan && !isNaN(parseInt(arg2, 10))) {
          targetJid = res1.jid;
          amount = parseInt(arg2, 10);
        } else if (res2?.ditemukan && !isNaN(parseInt(arg1, 10))) {
          targetJid = res2.jid;
          amount = parseInt(arg1, 10);
        } else {
          const num1 = arg1.replace(/[^0-9]/g, '');
          const num2 = arg2.replace(/[^0-9]/g, '');
          if (num1.length > 5 && !isNaN(parseInt(arg2, 10))) {
            targetJid = `${num1}@s.whatsapp.net`;
            amount = parseInt(arg2, 10);
          } else if (num2.length > 5 && !isNaN(parseInt(arg1, 10))) {
            targetJid = `${num2}@s.whatsapp.net`;
            amount = parseInt(arg1, 10);
          }
        }
      }
    }

    if (!targetJid || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Kurangi Poin (Khusus Owner):*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n▫️ `.kurangpoin @member [jumlah]` (tag orang)\n▫️ `.kurangpoin [nomor] [jumlah]` (ketik nomor)\n▫️ Balas/Quote pesan member lalu ketik `.kurangpoin [jumlah]`\n\n*Contoh:* `.kurangpoin @628123456789 500`");
      return true;
    }

    let actualTargetJid = targetJid;
    const resolvedTarget = await db.resolveTargetJid(targetJid);
    if (resolvedTarget?.ditemukan && resolvedTarget.jid) {
      actualTargetJid = resolvedTarget.jid;
    }

    try {
      const currentProfile = await db.getGameProfile(actualTargetJid);
      const safeCurrent = Math.max(0, currentProfile?.points || 0);
      const deductAmt = Math.min(safeCurrent, amount);
      await db.deductGamePoints(actualTargetJid, deductAmt);
      
      const newProfile = await db.getGameProfile(actualTargetJid);
      const targetPhone = actualTargetJid.split('@')[0];
      const targetCust = await db.getCustomerByPhone(actualTargetJid);
      const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;
      await send(sock, jid, messageObj, `✅ *Berhasil Mengurangi Poin!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${targetLabel}\n🔻 Poin Dikurangi: *${deductAmt.toLocaleString('id-ID')} poin*\n💰 Sisa Poin Sekarang: *${newProfile.points.toLocaleString('id-ID')} poin*`, {
        mentions: [actualTargetJid]
      });
      await db.addLog('ADMIN', `Owner mengurangi ${deductAmt} poin dari ${targetLabel}. Sisa: ${newProfile.points || 0}`);
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Gagal mengurangi poin: ${err.message}`);
    }
    return true;
  }

  // ─── TRANSFER POIN ANTAR MEMBER (.transfer) ───
  if (['transfer', 'kirimpoin', 'transferpoin'].includes(command)) {
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = mentions[0] || contextInfo?.participant;
    let amount = NaN;

    if (mentions.length > 0) {
      amount = parseInt(args[2], 10) || parseInt(args[1], 10);
    } else if (contextInfo?.participant) {
      targetJid = contextInfo.participant;
      amount = parseInt(args[1], 10);
    } else {
      const arg1 = args[1]?.toLowerCase();
      const arg2 = args[2];

      if (arg1 && arg2) {
        const res1 = await db.resolveTargetJid(arg1);
        const res2 = await db.resolveTargetJid(arg2);
        if (res1?.ditemukan && !isNaN(parseInt(arg2, 10))) {
          targetJid = res1.jid;
          amount = parseInt(arg2, 10);
        } else if (res2?.ditemukan && !isNaN(parseInt(arg1, 10))) {
          targetJid = res2.jid;
          amount = parseInt(arg1, 10);
        } else {
          const cleanNum1 = arg1.replace(/[^0-9]/g, '');
          const cleanNum2 = (arg2 || '').replace(/[^0-9]/g, '');
          if (cleanNum1.length > 5) {
            targetJid = `${cleanNum1}@s.whatsapp.net`;
            amount = parseInt(arg2, 10);
          } else if (cleanNum2.length > 5) {
            targetJid = `${cleanNum2}@s.whatsapp.net`;
            amount = parseInt(arg1, 10);
          }
        }
      }
    }

    if (targetJid) {
      const res = await db.resolveTargetJid(targetJid);
      if (res?.ditemukan && res.jid) targetJid = res.jid;
    }

    if (!targetJid || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "💸 *TRANSFER POIN GAME*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Format Perintah:*\n▫️ `.transfer @member [jumlah]` (tag orang)\n▫️ `.transfer [nomor] [jumlah]` (ketik nomor)\n▫️ Balas/Quote pesan member lalu ketik `.transfer [jumlah]`\n\n*Contoh:* `.transfer @628123456789 100`\n\n_Catatan: Dikenakan pajak transfer 1%._");
      return true;
    }

    if (targetJid === senderNumber || db.isPhoneMatch(targetJid, senderNumber)) {
      await send(sock, jid, messageObj, "❌ Tidak bisa mentransfer poin ke diri sendiri.");
      return true;
    }

    const res = await db.transferPoints(senderNumber, targetJid, amount);
    if (res.success) {
      const targetPhone = targetJid.split('@')[0];
      const senderPhone = senderNumber.split('@')[0];
      const senderCust = await db.getCustomerByPhone(senderNumber);
      const targetCust = await db.getCustomerByPhone(targetJid);
      const senderLabel = senderCust?.nama ? `*${senderCust.nama}* (@${senderPhone})` : `@${senderPhone}`;
      const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;
      await send(sock, jid, messageObj, `✅ *Transfer Poin Berhasil!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📤 Pengirim: ${senderLabel}\n📥 Penerima: ${targetLabel}\n💰 Jumlah: *${amount} Poin*\n💸 Pajak (1%): *${amount - res.received} Poin*\n🎁 Diterima: *${res.received} Poin*`, {
        mentions: [senderNumber, targetJid]
      });
    } else {
      if (res.reason === 'INSUFFICIENT_FUNDS') {
        const senderProfile = await db.getGameProfile(senderNumber);
        await send(sock, jid, messageObj, `❌ Saldo poin kamu tidak mencukupi!\nPoin kamu saat ini: *${senderProfile.points || 0} Poin*.\n\nKetik \`.daily\` atau mainkan game untuk mendapatkan poin.`);
      } else {
        await send(sock, jid, messageObj, "❌ Gagal memproses transfer poin. Pastikan nominal valid.");
      }
    }
    return true;
  }

  // --- DOMPET & MULTI-ASET TERPADU ---
  if (['dompet', 'wallet', 'aset', 'assets', 'rekening'].includes(command)) {
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = mentions[0] || contextInfo?.participant;
    if (!targetJid && args[1]) {
      const res = await db.resolveTargetJid(args[1]);
      if (res?.ditemukan && res.jid) targetJid = res.jid;
      else {
        const cleanNum = args[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) targetJid = `${cleanNum}@s.whatsapp.net`;
      }
    }
    const target = targetJid || senderNumber;
    const data = await db.getUnifiedWalletData(target);
    const targetPhone = target.split('@')[0];

    const premBenefits = getPremiumBenefits(data.premium.tier);
    const aiLimit = premBenefits?.aiDailyLimit || 10;
    const mediaLimit = 10;

    let nameStr = '';
    if (data.customer.nama && data.customer.nama !== 'Member') {
      nameStr = `*${data.customer.nama}* (@${targetPhone})`;
    } else if (target === senderNumber && messageObj?.pushName) {
      nameStr = `*${messageObj.pushName}* (@${targetPhone})`;
    } else {
      nameStr = `@${targetPhone}`;
    }

    const tierBadge = {
      Free: '🥉 Member Free',
      Bronze: '🥉 Bronze Member',
      Silver: '🥈 Silver Member',
      Gold: '🥇 Gold Member',
      Platinum: '💎 Platinum VIP',
      Diamond: '👑 Diamond VIP'
    }[data.premium.tier] || `✨ ${data.premium.tier}`;

    const roleBadge = {
      OWNER: '👑 Owner',
      ADMIN: '🛡️ Admin',
      MODERATOR: '⚔️ Moderator',
      RESELLER: '💼 Reseller',
      USER: '👤 Pelanggan'
    }[data.customer.role] || data.customer.role;

    const totalSerpih = Object.values(data.tcg.shards).reduce((a, b) => a + b, 0);

    const card = [
      '╔══════════════════════════════╗',
      '║   💳 *DOMPET & ASET TERPADU*  ║',
      '╚══════════════════════════════╝',
      `👤 Pemilik: ${nameStr}`,
      `🏷️ Role: *${roleBadge}* · Tier: *${tierBadge}*`,
      data.tcg.activeTitle ? `🏷️ Gelar Arena: *${data.tcg.activeTitle}*` : '',
      '',
      '💵 *FINANSIAL & POIN TOKO:*',
      `• 💳 Saldo Rupiah (IDR): *Rp ${Number(data.customer.balance).toLocaleString('id-ID')}*`,
      `• 🪙 Akbar Poin Game: *${Number(data.game.points).toLocaleString('id-ID')} Poin*`,
      `• 🏦 Tabungan Bank: *${Number(data.game.bankPoints).toLocaleString('id-ID')} Poin*`,
      data.game.bankPending > 0 ? `• ⏳ Dana Endap: *${Number(data.game.bankPending).toLocaleString('id-ID')} Poin*` : '',
      `• 💎 Total Kekayaan: *${Number(data.game.totalWealth).toLocaleString('id-ID')} Poin*`,
      '',
      '🎴 *ASET ARENA TCG:*',
      `• 💠 Keping Arena: *${Number(data.tcg.keping).toLocaleString('id-ID')} Keping*`,
      `• 📚 Koleksi Monster: *${data.tcg.uniqueCards} Jenis* (Total ${data.tcg.totalCards} Kartu)`,
      `• ✦ Total Serpihan: *${totalSerpih} Serpihan*`,
      `  └ ⚪ ${data.tcg.shards.COMMON} C · 🟢 ${data.tcg.shards.RARE} R · 🟣 ${data.tcg.shards.EPIC} E · 🟡 ${data.tcg.shards.LEGENDARY} L`,
      '',
      '⚡ *KUOTA HARIAN & AKTIVITAS:*',
      `• 🤖 Smart AI Chat: *${data.quota.aiUsed} / ${aiLimit >= 9999 ? '∞' : aiLimit}* per hari`,
      `• 📥 Media Downloader: *${data.quota.mediaUsed} / ${mediaLimit}* per hari`,
      `• 🔥 Streak Harian: *${data.game.dailyStreak} Hari* (Level ${data.game.level} · ${data.game.xp} XP)`,
      data.game.isJailed ? '• 🚨 *STATUS: SEDANG DALAM PENJARA*' : '',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '_Ketik `.depo <nominal>` untuk top-up IDR atau `.daily` untuk reward harian._'
    ].filter(line => line !== '').join('\n');

    await send(sock, jid, messageObj, card, { mentions: [target] });
    return true;
  }

  if (['poin', 'point', 'profile', 'level', 'me', 'cekpoin'].includes(command)) {
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = mentions[0] || contextInfo?.participant;
    if (!targetJid && args[1]) {
      const res = await db.resolveTargetJid(args[1]);
      if (res?.ditemukan && res.jid) targetJid = res.jid;
      else {
        const cleanNum = args[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) targetJid = `${cleanNum}@s.whatsapp.net`;
      }
    }
    const target = targetJid || senderNumber;
    const profile = await db.getGameProfile(target);
    const premiumTier = await db.getPremiumTier(target);
    const cust = await db.getCustomerByPhone(target);
    const targetPhone = target.split('@')[0];
    
    // Tampilkan Nama / Nick Terdaftar dan @tag nomornya
    let nameStr = '';
    if (cust?.nama) {
      nameStr = `*${cust.nama}* (@${targetPhone})`;
    } else if (target === senderNumber && messageObj?.pushName) {
      nameStr = `*${messageObj.pushName}* (@${targetPhone})`;
    } else {
      nameStr = `@${targetPhone}`;
    }

    await send(sock, jid, messageObj, profileText(profile, nameStr, premiumTier), {
      title: '👤 PROFIL & POIN GAME',
      buttons: [
        { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ],
      mentions: [target]
    });
    return true;
  }

  // Bansos Owner — pembagian hadiah massal ala surat kompensasi gacha.
  if (['bansos', 'sembako'].includes(command)) {
    const { handleBansosCommand } = await import('./bansos.js');
    return await handleBansosCommand(sock, jid, senderNumber, messageObj, args, { isOwner });
  }

  // Papan peringkat terpadu: `.lb`, `.lb poin`, `.lb raid`, `.lb chat`, dst.
  // `.rank` / `.top` / `.leaderboard` sengaja ikut ke sini supaya perintah lama
  // tetap jalan tapi ikut mendapat semua kategori baru.
  if (['rank', 'leaderboard', 'top', 'lb', 'papan', 'peringkat'].includes(command)) {
    const { handleLeaderboardCommand } = await import('./leaderboard.js');
    return await handleLeaderboardCommand(sock, jid, senderNumber, messageObj, args, { isFromGroup, isAdmin, isOwner });
  }

  if (['misi', 'mission', 'challenge'].includes(command)) {
    const missions = [...missionList].sort(() => Math.random() - 0.5).slice(0, 3);
    await send(sock, jid, messageObj, `🎯 *MISI HARI INI*\n\n${missions.map((mission, index) => `${index + 1}. ${mission}`).join('\n')}`, {
      title: '🎯 MISI HARI INI',
      buttons: [
        { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
      ]
    });
    return true;
  }

  // ─── GIVEAWAY / SETPOINTS ALL ─────────────────────────────────
  if (['giveaway', 'setpoints', 'bagipoin', 'kompensasi'].includes(command)) {
    // Sama seperti .addpoint — semuanya menambah saldo poin, jadi wajib Admin Toko.
    if (!isStoreAdmin && !isOwner) {
      await send(sock, jid, messageObj, '❌ Perintah ini hanya untuk *Admin* atau *Owner*.');
      return true;
    }

    const subCmd = args[1]?.toLowerCase(); // 'all' | angka | undefined
    const rawAmount = subCmd === 'all' ? args[2] : args[1];
    const amount = parseInt(rawAmount, 10);

    // Tampilkan help jika tidak ada argumen
    if (!rawAmount || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj,
        `🎁 *GIVEAWAY POIN — PANDUAN PENGGUNAAN*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Format:*\n` +
        `▫️ \`.giveaway all [jumlah]\` — Bagikan poin ke *semua member terdaftar*\n` +
        `▫️ \`.giveaway [jumlah]\` — Sama seperti di atas\n\n` +
        `*Contoh:*\n` +
        `▫️ \`.giveaway all 100\` → Semua member +100 poin\n` +
        `▫️ \`.giveaway 500\` → Semua member +500 poin\n\n` +
        `_Perintah ini memberikan poin tambahan ke semua member yang punya akun game._`
      );
      return true;
    }

    if (amount > 50000) {
      await send(sock, jid, messageObj, `⚠️ Maksimal giveaway adalah *50.000 poin* per eksekusi untuk mencegah kesalahan.\n\nJika kamu yakin, pecah menjadi beberapa batch.`);
      return true;
    }

    // Kirim pesan loading dulu
    await send(sock, jid, messageObj,
      `⏳ *Sedang memproses giveaway...*\n` +
      `💰 Jumlah: *${amount} poin* per member\n\n` +
      `_Mohon tunggu sebentar..._`
    );

    try {
      // Ambil semua member yang punya game_profile
      const allMembers = await db.allQuery(
        `SELECT DISTINCT gp.customer_jid, COALESCE(c.nama, 'Member') as nama
         FROM game_profiles gp
         LEFT JOIN customers c ON c.nomor = gp.customer_jid
         ORDER BY gp.customer_jid`
      );

      if (!allMembers || allMembers.length === 0) {
        await send(sock, jid, messageObj, '❌ Tidak ada member yang ditemukan di database.');
        return true;
      }

      let successCount = 0;
      let failCount = 0;

      for (const member of allMembers) {
        try {
          await db.addGamePoints(member.customer_jid, amount);
          successCount++;
        } catch (_err) {
          failCount++;
        }
      }

      const resultMsg =
        `🎁 *GIVEAWAY POIN SELESAI!*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 Poin dibagikan: *+${amount} poin*\n` +
        `👥 Member berhasil: *${successCount} orang*\n` +
        (failCount > 0 ? `⚠️ Member gagal: *${failCount} orang*\n` : '') +
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ Semua member sudah menerima poin kompensasi!\n` +
        `_Ketik .rank untuk melihat leaderboard terbaru._`;

      await send(sock, jid, messageObj, resultMsg, {
        title: '🎁 GIVEAWAY POIN',
        buttons: [
          { type: 'reply', text: '🏆 Lihat Leaderboard', id: '.rank' },
          { type: 'reply', text: '👤 Profil Saya', id: '.poin' }
        ]
      });

    } catch (err) {
      await send(sock, jid, messageObj, `❌ Giveaway gagal: ${err.message}`);
    }
    return true;
  }
  // ────────────────────────────────────────────────────────────────



  if (['badge', 'badges', 'achievement', 'achievements'].includes(command)) {
    const profile = await db.getGameProfile(senderNumber);
    const badges = ['🌱 Pemula'];
    if (profile.games_won >= 5) badges.push('🧠 Quiz Master');
    if (profile.daily_streak >= 7) badges.push('🔥 Konsisten 7 Hari');
    if (profile.points >= 100) badges.push('💎 Pengumpul Poin');
    if (profile.level >= 5) badges.push('🚀 Level 5');
    await send(sock, jid, messageObj, `🏅 *PENCAPAIAN KAMU*\n\n${badges.map(badge => `• ${badge}`).join('\n')}\n\nMain lebih sering untuk membuka badge baru.`);
    return true;
  }


  if (['rekomendasi', 'recommend', 'saranproduk'].includes(command)) {
    const products = (await db.getProducts()).filter(product => product.stok > 0).sort(() => Math.random() - 0.5).slice(0, 3);
    if (products.length === 0) {
      await send(sock, jid, messageObj, 'Belum ada produk ready untuk direkomendasikan.');
      return true;
    }
    const lines = products.map(product => `• *${product.nama}* (\`${product.kode}\`) — Rp${product.harga.toLocaleString('id-ID')}\n  Stok: ${product.stok} pcs`);
    await send(sock, jid, messageObj, `✨ *REKOMENDASI PRODUK UNTUK KAMU*\n\n${lines.join('\n')}\n\nKetik .beli KODE JUMLAH untuk memesan.`);
    return true;
  }

  if (['poll', 'voting'].includes(command)) {
    const parts = text.slice(command.length).trim().split('|').map(part => part.trim()).filter(Boolean);
    if (parts.length < 3 || parts.length > 13) {
      await send(sock, jid, messageObj, 'Format: `.poll Pertanyaan | Opsi 1 | Opsi 2`\nMinimal 2 opsi, maksimal 12 opsi.');
      return true;
    }
    await sock.sendMessage(jid, { poll: { name: parts[0], values: parts.slice(1), selectableCount: 1 } });
    return true;
  }

  if (['love', 'jodoh', 'compatibility'].includes(command)) {
    if (isOnCooldown(`${scope}:love`, 5000)) return true;
    const names = text.slice(command.length).trim();
    if (names && names.includes('&')) {
      const parts = names.split('&').map(p => p.trim());
      const info = entertainment.getJodohInfo(parts[0], parts[1]);
      if (info) {
        await send(sock, jid, messageObj, info);
        return true;
      }
    }
    const percent = Math.floor(Math.random() * 101);
    const target = args.slice(1).join(' ') || 'pasangan masa depanmu';
    await send(sock, jid, messageObj, `💘 Kecocokan kamu dengan *${target}*: *${percent}%*\n${percent > 75 ? 'Wah, cocok banget!' : percent > 45 ? 'Masih ada harapan 😄' : 'Coba berteman dulu ya.'}`);
    return true;
  }

  if (['karbit', 'fanskarbit'].includes(command)) {
    if (isOnCooldown(`${scope}:karbit`, 3000)) return true;
    const target = args.slice(1).join(' ') || (messageObj?.pushName || 'Kamu');
    const persen = Math.floor(Math.random() * 101);
    let level = '🔥 Fans Karbit Sejati (Baru ikut waktu menang doang)';
    if (persen < 20) level = '👑 Fans Garis Keras / Loyalis Sejati!';
    else if (persen < 50) level = '🥈 Fans Kasual / Santai';
    else if (persen < 80) level = '👀 Mulai Goyah / Rawan Loncat Pagar';
    await send(sock, jid, messageObj, `📊 *DETEKTOR FANS KARBIT* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: *${target}*\n📈 Kadar Karbit: *${persen}%*\n🏷️ Kategori: ${level}`);
    return true;
  }

  if (['zodiak', 'zodiac', 'horoscope'].includes(command)) {
    if (isOnCooldown(`${scope}:zodiak`, 3000)) return true;
    const inputZodiak = args[1];
    if (!inputZodiak) {
      await send(sock, jid, messageObj, '⚠️ *Format Salah:* Masukkan nama zodiak kamu!\n\n_Contoh:_ `.zodiak leo`\n\n📌 *Daftar Zodiak:* Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces.');
      return true;
    }
    const info = entertainment.getZodiakInfo(inputZodiak);
    if (!info) {
      await send(sock, jid, messageObj, '❌ Zodiak tidak ditemukan. Pilih salah satu: Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces.');
      return true;
    }
    await send(sock, jid, messageObj, info);
    return true;
  }

  if (['freegames', 'freegame', 'gamegratis', 'freegamestag'].includes(command)) {
    if (isOnCooldown(`${scope}:freegames`, 5000)) return true;

    // Shortcut: .freegames on / off
    if (args[1] === 'on' || args[1] === 'off') {
       if (!isFromGroup) {
          await send(sock, jid, messageObj, '❌ Pengaturan fitur hanya bisa dilakukan di dalam grup.');
          return true;
       }
       if (!isAdmin && !isOwner) {
          await send(sock, jid, messageObj, '❌ Hanya Admin/Owner yang bisa mengatur fitur grup!');
          return true;
       }
       const action = args[1];
       const currentSettings = await db.getGroupSettings(jid);
       const featuresConfig = currentSettings.features_config || {};
       featuresConfig['freegames'] = (action === 'on');
       await db.updateGroupSettings(jid, { features_config: featuresConfig });
       await sock.sendMessage(jid, { text: `✅ Fitur *FREEGAMES ALERT* berhasil di-${action.toUpperCase()}-kan untuk grup ini.` });
       return true;
    }

    // MENTION MASSAL WAJIB IZIN ADMIN.
    //
    // `.freegames` adalah perintah publik, jadi jalur tag di bawah dulu memberi
    // SETIAP member kemampuan memanggil seluruh isi grup — persis alat spam yang
    // `.tagall` di groupAdminHandler sudah lama dijaga. Kebocorannya bukan di
    // `.tagall`; ia ada di sini, dan lebih parah: tombol '📢 TagAll Group' di
    // bawah menempelkan pemicunya satu ketukan dari siapa pun yang melihat pesan.
    //
    // Sengaja tidak diam-diam diabaikan. Orang yang menekan tombol berhak tahu
    // kenapa tidak terjadi apa-apa, kalau tidak ia akan menekannya berkali-kali.
    const mintaTagAll = command === 'freegamestag' || args[1] === 'tag' || args[1] === 'tagall';
    const bolehTagAll = isAdmin || isOwner || isStoreAdmin;
    if (mintaTagAll && isFromGroup && !bolehTagAll) {
      await send(sock, jid, messageObj,
        '❌ Memanggil seluruh member hanya bisa dilakukan *Admin Grup* atau *Owner*.\n\n_Info game gratisnya tetap bisa kamu lihat dengan_ `.freegames` _tanpa tag._');
      return true;
    }
    const isTagAllRequested = mintaTagAll && bolehTagAll;

    const res = await entertainment.fetchFreeGames();
    if (res.success) {
      if (isTagAllRequested && isFromGroup) {
        try {
          const meta = await sock.groupMetadata(jid);
          const mentions = meta.participants.map(p => p.id);
          let tagMsg = `${res.text}\n\n👥 *PANGGILAN SEMUA MEMBER (TAGALL):*\n`;
          mentions.forEach(m => {
            tagMsg += `@${m.split('@')[0]} `;
          });
          await sock.sendMessage(jid, { text: tagMsg, mentions });
          return true;
        } catch (e) {}
      }

      const buttons = (isFromGroup && bolehTagAll)
        ? [{ type: 'reply', text: '📢 TagAll Group', id: '.freegames tag' }]
        : [];
      await send(sock, jid, messageObj, res.text, {
        title: '🎮 FREE GAMES ALERT (STEAM / EPIC / GOG / UBISOFT)',
        buttons
      });
    } else {
      await send(sock, jid, messageObj, `❌ ${res.message}`);
    }
    return true;
  }

  if (['slot', 'slots', 'judi'].includes(command)) {
    if (isOnCooldown(`${scope}:slot`, 4000)) return true;

    // Cek premium slot limit
    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    // Owner/Admin bebas limit max bet
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : (benefits?.slotMaxBet || 50_000);

    // Ambil profil & pastikan points tidak null/NaN
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    // Validasi input bet — mendukung input 'all' atau 'allin'
    const rawBetArg = args[1]?.toLowerCase();
    let bet = 10;
    if (rawBetArg === 'all' || rawBetArg === 'allin') {
      bet = Math.max(1, Math.min(maxBet, currentPoints));
    } else {
      const parsedBet = rawBetArg ? Number.parseInt(rawBetArg, 10) : 10;
      if (rawBetArg && (isNaN(parsedBet) || !isFinite(parsedBet))) {
        const displayMax = isFinite(maxBet) ? `${maxBet} poin` : 'Tanpa Batas';
        await send(sock, jid, messageObj, `❌ Format taruhan tidak valid: *${rawBetArg}*\n\nGunakan angka atau 'all'. Contoh: \`.slot 10\` atau \`.slot all\`\nMaksimal taruhan: *${displayMax}*`);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, Math.abs(isNaN(parsedBet) ? 10 : parsedBet)));
    }

    const deductRes = await db.deductGamePoints(senderNumber, bet);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu butuh *${bet} poin*, tapi sisa poinmu hanya *${deductRes.currentPoints || currentPoints} poin*.\n\nKetik \`.daily\` untuk mengambil poin gratis harian!`);
      return true;
    }

    const spin = entertainment.playSlotMachine(bet);
    let newPoints = deductRes.newPoints;
    if (spin.isWin && spin.winAmount > 0) {
      const updatedProf = await db.addGamePoints(senderNumber, spin.winAmount);
      newPoints = updatedProf.points;
    }

    let msg = `🎰 *CASINO SLOT MACHINE* 🎰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `   [ ${spin.reels.join(' | ')} ]\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (spin.isWin) {
      msg += `🎉 *MENANG!* ${spin.winType}\n`;
      msg += `💰 Taruhan: *${bet} poin*\n`;
      msg += `🎁 Hadiah: *+${spin.winAmount} poin*\n`;
    } else {
      msg += `💸 *RUNGKAD!* Sayang sekali belum beruntung.\n`;
      msg += `💰 Taruhan: *-${bet} poin*\n`;
    }
    msg += `💳 Sisa Poin: *${newPoints} poin*`;

    await send(sock, jid, messageObj, msg, {
      buttons: [
        { type: 'reply', text: `🎰 Spin Lagi (${bet} Poin)`, id: `.slot ${bet}` }
      ]
    });
    return true;
  }

  if (['torebot', 'tochipmunk', 'todeep', 'toecho'].includes(command)) {
    if (isOnCooldown(`${scope}:voiceeffect`, 5000)) return true;
    const quoted = messageObj.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const audioMsg = quoted?.audioMessage || messageObj.message?.audioMessage;

    if (!audioMsg) {
      await send(sock, jid, messageObj, '⚠️ *Format Salah:* Balas (reply) sebuah Voice Note / Pesan Suara dengan perintah ini!\n\n_Contoh:_ Reply VN dengan `.torebot` atau `.tochipmunk`');
      return true;
    }

    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadMediaMessage(
        { message: quoted ? { audioMessage: quoted.audioMessage } : messageObj },
        'buffer',
        {}
      );

      if (stream) {
        const res = await entertainment.convertVoiceEffect(stream, command);
        if (res.success && res.buffer) {
          await sock.sendMessage(jid, {
            audio: res.buffer,
            ptt: true,
            mimetype: 'audio/mp4'
          }, { quoted: messageObj });
          return true;
        }
      }
    } catch (e) {
      console.error('[VOICE_EFFECT_ERR]', e.message);
    }
    await send(sock, jid, messageObj, '❌ Gagal mengubah efek suara Voice Note. Pastikan media audio valid.');
    return true;
  }

  // --- GAME: Tebak Angka Pot Progresif 1-100 (.tebakangka / .tebak) ---
  if (command === 'tebakangka') {
    const gameKey = jid + '_angka';
    const isAlreadyActive = entertainment.activeGames.has(gameKey);

    // Jika game sudah berjalan dan user langsung menebak (contoh: .tebakangka 45)
    if (isAlreadyActive && args[1] && !isNaN(parseInt(args[1], 10))) {
      const game = entertainment.activeGames.get(gameKey);
      const guess = parseInt(args[1], 10);
      if (guess < 1 || guess > 100) {
        await send(sock, jid, messageObj, "⚠️ Masukkan angka yang valid antara *1 s/d 100*.\n\n*Contoh:* `.tebakangka 45`");
        return true;
      }

      const deductRes = await db.deductGamePoints(senderNumber, 10);
      if (!deductRes.success && !isAdmin && !isOwner) {
        await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu membutuhkan minimal *10 poin* untuk menebak (Poin kamu: *${deductRes.currentPoints || 0} poin*).`);
        return true;
      }

      game.pot = (game.pot || 200) + 10;
      game.guesses = (game.guesses || 0) + 1;

      if (guess === game.target) {
        game.isAnswered = true;
        if (game.timeout) clearTimeout(game.timeout);
        entertainment.activeGames.delete(gameKey);
        const winPot = game.pot;
        const winnerProfile = await db.addGamePoints(senderNumber, winPot);
        const finalPoints = winnerProfile?.points || 0;
        await send(sock, jid, messageObj, `🎉 *JACKPOT!!! TEBAKAN BENAR!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 Pemenang: *@${senderNumber.split('@')[0]}* (${messageObj.pushName || 'Pelanggan'})\n🔢 Angka Rahasia: *${game.target}*\n💰 Hadiah Jackpot: *+${winPot} Poin*\n📉 Total Tebakan Grup: *${game.guesses} kali*\n🏆 Total Poin Kamu: *${finalPoints} Poin*`, { mentions: [senderNumber] });
        try { await sock.sendMessage(jid, { react: { text: '🎉', key: messageObj.key } }); } catch (e) {}
      } else {
        const diff = guess < game.target ? "terlalu KECIL 📉" : "terlalu BESAR 📈";
        await send(sock, jid, messageObj, `❌ Tebakan *@${senderNumber.split('@')[0]}* (*${guess}*) *${diff}*!\n\n💰 Pot Jackpot bertambah menjadi: *${game.pot} Poin*`, { mentions: [senderNumber] });
      }
      return true;
    }

    if (isAlreadyActive) {
      const game = entertainment.activeGames.get(gameKey);
      await send(sock, jid, messageObj, `🎮 *GAME TEBAK ANGKA AKTIF* 🎮\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n💰 Pot Jackpot Saat Ini: *${game.pot || 200} Poin*\n👥 Jumlah Tebakan: *${game.guesses || 0} kali*\n\n👉 Ketik langsung angka di chat (misal: \`45\`) atau gunakan \`.tebak [angka]\`!`);
      return true;
    }

    const targetNumber = Math.floor(Math.random() * 100) + 1;
    entertainment.activeGames.set(gameKey, {
      answer: targetNumber.toString(),
      target: targetNumber,
      type: 'tebakangka',
      pot: 200,
      guesses: 0,
      startTime: Date.now(),
      isAnswered: false,
      timeout: setTimeout(async () => {
        const g = entertainment.activeGames.get(gameKey);
        if (!g || g.isAnswered) return;
        entertainment.activeGames.delete(gameKey);
        await send(sock, jid, messageObj, `⏳ *WAKTU TEBAK ANGKA HABIS!*\n\nAngka yang benar adalah *${targetNumber}*.\nPot Jackpot tersimpan: *${g.pot || 200} Poin*.\nKetik \`.tebakangka\` untuk memulai game baru.`);
      }, 10 * 60 * 1000)
    });

    await send(sock, jid, messageObj, `🎮 *GAME TEBAK ANGKA DIMULAI!* 🎮\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nBot telah menentukan angka rahasia antara *1 s/d 100*.\n\n💰 *Pot Jackpot Awal:* 200 Poin\n💸 *Biaya Menebak:* 10 Poin per tebakan (langsung masuk ke Pot Jackpot)\n\n👉 *Cara Bermain:*\n• Langsung ketik angka tebakan di chat (misal: \`45\`)\n• Atau ketik \`.tebak 45\`\n• Ketik \`.nyerah\` jika menyerah\n\nSiapa cepat dan tepat, bawa pulang seluruh Pot Jackpot! 🏆`);
    return true;
  }

  if (command === 'tebak') {
    const gameKey = jid + '_angka';
    const game = entertainment.activeGames.get(gameKey);
    if (!game) {
      await send(sock, jid, messageObj, "❌ Tidak ada game Tebak Angka yang sedang aktif di chat ini. Ketik *.tebakangka* untuk memulainya!");
      return true;
    }

    const guess = parseInt(args[1], 10);
    if (isNaN(guess) || guess < 1 || guess > 100) {
      await send(sock, jid, messageObj, "⚠️ Masukkan angka yang valid antara *1 s/d 100*.\n\n*Contoh:* `.tebak 45`");
      return true;
    }

    const deductRes = await db.deductGamePoints(senderNumber, 10);
    if (!deductRes.success && !isAdmin && !isOwner) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu membutuhkan minimal *10 poin* untuk menebak (Poin kamu: *${deductRes.currentPoints || 0} poin*).`);
      return true;
    }

    game.pot = (game.pot || 200) + 10;
    game.guesses = (game.guesses || 0) + 1;

    if (guess === game.target) {
      game.isAnswered = true;
      if (game.timeout) clearTimeout(game.timeout);
      entertainment.activeGames.delete(gameKey);
      const winPot = game.pot;
      const winnerProfile = await db.addGamePoints(senderNumber, winPot);
      const finalPoints = winnerProfile?.points || 0;
      await send(sock, jid, messageObj, `🎉 *JACKPOT!!! TEBAKAN BENAR!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 Pemenang: *@${senderNumber.split('@')[0]}* (${messageObj.pushName || 'Pelanggan'})\n🔢 Angka Rahasia: *${game.target}*\n💰 Hadiah Jackpot: *+${winPot} Poin*\n📉 Total Tebakan Grup: *${game.guesses} kali*\n🏆 Total Poin Kamu: *${finalPoints} Poin*`, { mentions: [senderNumber] });
      try { await sock.sendMessage(jid, { react: { text: '🎉', key: messageObj.key } }); } catch (e) {}
    } else {
      const diff = guess < game.target ? "terlalu KECIL 📉" : "terlalu BESAR 📈";
      await send(sock, jid, messageObj, `❌ Tebakan *@${senderNumber.split('@')[0]}* (*${guess}*) *${diff}*!\n\n💰 Pot Jackpot bertambah menjadi: *${game.pot} Poin*`, { mentions: [senderNumber] });
    }
    return true;
  }

  // --- GAME: Lucky Spin ---
  if (command === 'spin' || command === 'luckyspin') {
    const rawBet = args[1]?.toLowerCase();
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    let bet = 100;
    if (rawBet === 'all' || rawBet === 'allin') {
      bet = Math.max(1, currentPoints);
    } else if (rawBet) {
      const parsedBet = parseInt(rawBet, 10);
      if (isNaN(parsedBet) || !isFinite(parsedBet) || parsedBet <= 0) {
        await send(sock, jid, messageObj, "⚠️ Taruhan tidak valid! Gunakan angka atau 'all'.\n\n*Contoh:* `.spin 100` atau `.spin all`");
        return true;
      }
      bet = Math.min(1_000_000, parsedBet);
    }

    const deductRes = await db.deductGamePoints(senderNumber, bet);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi untuk melakukan spin sebesar *${bet} Poin* (Poin kamu: *${deductRes.currentPoints || currentPoints} Poin*).`);
      return true;
    }

    const animFrames = [
      "🎡 *WHEEL OF FORTUNE* 🎡\n\n[ 🕒 | 🕒 | 🕒 ]\n\n_Sedang memutar roda keberuntungan..._",
      "🎡 *WHEEL OF FORTUNE* 🎡\n\n[ 🕕 | 🕕 | 🕕 ]\n\n_Sedang memutar roda keberuntungan..._",
      "🎡 *WHEEL OF FORTUNE* 🎡\n\n[ 🕘 | 🕘 | 🕘 ]\n\n_Sedang memutar roda keberuntungan..._"
    ];

    const spinMsg = await sock.sendMessage(jid, { text: animFrames[0] }, { quoted: messageObj });

    setTimeout(async () => {
      await sock.sendMessage(jid, { text: animFrames[1], edit: spinMsg.key });
    }, 600);

    setTimeout(async () => {
      await sock.sendMessage(jid, { text: animFrames[2], edit: spinMsg.key });
    }, 1200);

    setTimeout(async () => {
      const roll = Math.random() * 100;
      let outcome = "";
      let winAmount = 0;

      if (roll < 45) {
        outcome = "💥 *ZONK!* Poin taruhanmu hangus. Tetap semangat, coba lagi! 💪";
        winAmount = 0;
      } else if (roll < 65) {
        outcome = "💵 *Kembali Setengah!* Kamu mendapat kembali 0.5x taruhan.";
        winAmount = Math.floor(bet * 0.5);
      } else if (roll < 85) {
        outcome = "💰 *Menang Kecil!* Kamu memenangkan 1.5x taruhan.";
        winAmount = Math.floor(bet * 1.5);
      } else if (roll < 95) {
        outcome = "🔥 *DOUBLE WIN!* Kamu memenangkan 2x taruhan!";
        winAmount = Math.floor(bet * 2);
      } else if (roll < 99) {
        outcome = "👑 *JACKPOT 10X!!!* Selamat, kamu memenangkan 10x lipat taruhan! 🎉🎉";
        winAmount = Math.floor(bet * 10);
      } else {
        // Hadiah puncak dulunya kupon diskon toko (bernilai rupiah asli). Diganti
        // jackpot poin supaya Akbar Poin tidak bisa dicetak jadi uang.
        outcome = "🌟 *MEGA JACKPOT 25X!!!* 🌟\n\nRoda berhenti tepat di kotak emas! Kamu memenangkan *25x lipat* taruhan!";
        winAmount = Math.floor(bet * 25);
      }

      if (winAmount > 0) {
        await db.addGamePoints(senderNumber, winAmount);
      }
      const finalProf = await db.getGameProfile(senderNumber);
      const newPoints = finalProf.points;

      let resultText = `🎡 *WHEEL OF FORTUNE* 🎡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      resultText += `👤 Player: *@${senderNumber.split('@')[0]}*\n`;
      resultText += `💸 Taruhan: *${bet} Poin*\n\n`;
      resultText += `${outcome}\n\n`;
      resultText += `💰 Perubahan Poin: *${winAmount >= bet ? '+' : ''}${winAmount - bet} Poin*\n`;
      resultText += `🏆 Sisa Poin Sekarang: *${newPoints} Poin*`;

      await sock.sendMessage(jid, { text: resultText, edit: spinMsg.key, mentions: [senderNumber] });
    }, 1800);

    return true;
  }

  // --- GAME: Multiplayer Suit ---
  if (command === 'suit') {
    if (!isFromGroup) {
      await send(sock, jid, messageObj, "⚠️ Perintah suit hanya dapat dilakukan di dalam Grup WhatsApp!");
      return true;
    }

    const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const challengedJid = mentions[0];
    const rawBet = args[2] || args[1];

    let targetJid = challengedJid;
    let betStr = "";

    if (args[1] && !args[1].startsWith('@') && isNaN(parseInt(args[1], 10)) === false) {
      betStr = args[1];
    } else if (args[2] && !args[2].startsWith('@') && isNaN(parseInt(args[2], 10)) === false) {
      betStr = args[2];
    } else if (args[1] === 'all' || args[2] === 'all') {
      betStr = 'all';
    }

    if (!targetJid) {
      const argUser = args.find(a => a.startsWith('@') || /^\d{7,}$/.test(a));
      if (argUser) {
        const res = await db.resolveTargetJid(argUser);
        if (res?.ditemukan && res.jid) targetJid = res.jid;
        else {
          const cleanNum = argUser.replace(/[^0-9]/g, '');
          if (cleanNum.length > 5) targetJid = `${cleanNum}@s.whatsapp.net`;
        }
      }
    } else {
      const res = await db.resolveTargetJid(targetJid);
      if (res?.ditemukan && res.jid) targetJid = res.jid;
    }

    if (!targetJid || targetJid === senderNumber || db.isPhoneMatch(targetJid, senderNumber)) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Salah!* Gunakan:\n▫️ `.suit @member [taruhan]`\n\n*Contoh:* `.suit @628123456789 100` atau `.suit @628123456789 all`");
      return true;
    }

    // Membandingkan hanya dengan `sock.user.id` tidak cukup: di grup ber-LID,
    // men-tag bot menghasilkan @lid yang angkanya bukan nomor HP bot.
    if (adalahJidBot(sock, targetJid)) {
      await send(sock, jid, messageObj, "❌ Kamu tidak bisa menantang bot! Untuk bermain melawan bot gunakan game lain.");
      return true;
    }

    const challengerProfile = await db.getGameProfile(senderNumber);
    const challengedProfile = await db.getGameProfile(targetJid);

    let bet = 50;
    if (betStr === 'all' || betStr === 'allin') {
      bet = Math.min(challengerProfile.points || 0, challengedProfile.points || 0);
      bet = Math.max(10, bet);
    } else if (betStr) {
      bet = parseInt(betStr, 10);
    }

    if (isNaN(bet) || bet <= 0) {
      await send(sock, jid, messageObj, "⚠️ Poin taruhan tidak valid! Harus berupa angka di atas 0.");
      return true;
    }

    if (challengerProfile.points < bet) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi! Poin kamu: *${challengerProfile.points} Poin* (Taruhan: *${bet} Poin*).`);
      return true;
    }

    if (challengedProfile.points < bet) {
      const name = `@${targetJid.split('@')[0]}`;
      await send(sock, jid, messageObj, `❌ Poin ${name} tidak mencukupi untuk menerima taruhan sebesar *${bet} Poin* (Poin lawan: *${challengedProfile.points} Poin*).`, {
        mentions: [targetJid]
      });
      return true;
    }

    try {
      const challengeId = await db.createSuitChallenge(senderNumber, targetJid, jid, bet);
      const oppPhone = targetJid.split('@')[0];

      let startMsg = `⚔️ *TANTANGAN SUIT MULTIPLAYER* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      startMsg += `👤 Penantang: *@${senderNumber.split('@')[0]}*\n`;
      startMsg += `🎯 Ditantang: *@${oppPhone}*\n`;
      startMsg += `💰 Poin Taruhan: *${bet} Poin*\n\n`;
      startMsg += `*CARA BERMAIN:* Kedua pemain harus mengirimkan pilihan secara RAHASIA lewat pesan pribadi (DM) ke Bot.\n\n`;
      startMsg += `👉 *Silakan kedua pemain buka DM Bot sekarang dan ketik:*\n`;
      startMsg += `▫️ *.pilihsuit gunting*\n`;
      startMsg += `▫️ *.pilihsuit batu*\n`;
      startMsg += `▫️ *.pilihsuit kertas*\n\n`;
      startMsg += `_Taruhan ${bet} poin telah dikunci dari masing-masing akun._`;

      await send(sock, jid, messageObj, startMsg, { mentions: [senderNumber, targetJid] });

      await sock.sendMessage(senderNumber, { text: `⚔️ Kamu menantang @${oppPhone} bermain Suit sebesar *${bet} poin*.\n\nKetik *.pilihsuit gunting/batu/kertas* di sini untuk mengirim pilihanmu!` });
      await sock.sendMessage(targetJid, { text: `⚔️ Kamu ditantang oleh @${senderNumber.split('@')[0]} bermain Suit sebesar *${bet} poin* di grup.\n\nKetik *.pilihsuit gunting/batu/kertas* di sini untuk menerima taruhan & mengirim pilihanmu!` });
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Gagal memulai tantangan suit: ${err.message}`);
    }
    return true;
  }

  if (command === 'pilihsuit') {
    if (isFromGroup) {
      await send(sock, jid, messageObj, "❌ Pilihan suit harus dikirimkan secara rahasia via DM ke Bot agar lawan tidak tahu!");
      return true;
    }

    const choice = args[1]?.toLowerCase();
    if (!['gunting', 'batu', 'kertas', 'scissors', 'rock', 'paper'].includes(choice)) {
      await send(sock, jid, messageObj, "⚠️ Pilihan tidak valid! Gunakan: `.pilihsuit gunting`, `.pilihsuit batu`, atau `.pilihsuit kertas`.");
      return true;
    }

    const normalizedChoice = ['scissors', 'gunting'].includes(choice) ? 'gunting' :
                               ['rock', 'batu'].includes(choice) ? 'batu' : 'kertas';

    const challenge = await db.getPendingSuitChallenge(senderNumber);
    if (!challenge) {
      await send(sock, jid, messageObj, "❌ Kamu tidak memiliki tantangan suit aktif yang menunggumu saat ini.");
      return true;
    }

    try {
      const updated = await db.saveSuitChoice(challenge.id, senderNumber, normalizedChoice);
      await send(sock, jid, messageObj, `✅ Pilihanmu (*${normalizedChoice.toUpperCase()}*) berhasil dikirim secara rahasia! Menunggu lawan menentukan pilihan...`);

      const isChallenger = challenge.challenger_jid === senderNumber;
      const opponentJid = isChallenger ? challenge.challenged_jid : challenge.challenger_jid;

      await sock.sendMessage(opponentJid, { text: `🔔 Lawanmu (@${senderNumber.split('@')[0]}) sudah menentukan pilihannya! Ayo kirim pilihanmu sekarang.` });

      if (updated && updated.challenger_choice && updated.challenged_choice) {
        const choiceA = updated.challenger_choice;
        const choiceB = updated.challenged_choice;
        const playerA = updated.challenger_jid;
        const playerB = updated.challenged_jid;
        const bet = updated.bet;

        let winner = null;
        if (choiceA === choiceB) {
          winner = null;
        } else if (
          (choiceA === 'batu' && choiceB === 'gunting') ||
          (choiceA === 'gunting' && choiceB === 'kertas') ||
          (choiceA === 'kertas' && choiceB === 'batu')
        ) {
          winner = 'A';
        } else {
          winner = 'B';
        }

        let resultText = `🏁 *HASIL SUIT MULTIPLAYER* 🏁\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        resultText += `💰 Taruhan: *${bet} Poin*\n\n`;

        const choiceEmojis = { batu: '✊ BATU', gunting: '✌️ GUNTING', kertas: '✋ KERTAS' };
        resultText += `👤 Penantang (@${playerA.split('@')[0]}): ${choiceEmojis[choiceA]}\n`;
        resultText += `🎯 Lawan (@${playerB.split('@')[0]}): ${choiceEmojis[choiceB]}\n\n`;

        if (winner === null) {
          await db.refundSuitChallenge(challenge.id, true, true);
          resultText += `🤝 *HASIL SERI (DRAW)!* 🤝\nTaruhan poin dikembalikan ke masing-masing akun.`;
        } else if (winner === 'A') {
          const profileA = await db.addGamePoints(playerA, bet * 2);
          await db.completeSuitChallenge(challenge.id, 'CHALLENGER_WON');
          resultText += `🏆 *PEMENANG:* *@${playerA.split('@')[0]}* 🎉\n💰 Hadiah: *+${bet * 2} Poin*`;
        } else {
          const profileB = await db.addGamePoints(playerB, bet * 2);
          await db.completeSuitChallenge(challenge.id, 'CHALLENGED_WON');
          resultText += `🏆 *PEMENANG:* *@${playerB.split('@')[0]}* 🎉\n💰 Hadiah: *+${bet * 2} Poin*`;
        }

        await sock.sendMessage(updated.group_jid, { text: resultText, mentions: [playerA, playerB] });

        const endDmText = `🏁 Permainan Suit selesai!\n\nHasil pertandingan diumumkan di grup. Silakan cek grup WhatsApp!`;
        await sock.sendMessage(playerA, { text: endDmText });
        await sock.sendMessage(playerB, { text: endDmText });
      }
    } catch (err) {
      if (err.message === 'INSUFFICIENT_POINTS') {
        await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi untuk menerima taruhan ini (${challenge.bet} Poin). Tantangan dibatalkan.`);
        await db.refundSuitChallenge(challenge.id, true, false);
      } else {
        await send(sock, jid, messageObj, `❌ Gagal menyimpan pilihan: ${err.message}`);
      }
    }
    return true;
  }

  if (command === 'cancelsuit' || command === 'batalsuit') {
    const challenge = await db.getPendingSuitChallenge(senderNumber);
    if (!challenge) {
      await send(sock, jid, messageObj, "❌ Kamu tidak memiliki tantangan suit aktif yang menunggumu saat ini.");
      return true;
    }

    try {
      await db.refundSuitChallenge(challenge.id, true, true);
      await send(sock, jid, messageObj, `✅ Tantangan suit berhasil dibatalkan. Poin taruhan dikembalikan ke pemiliknya.`);
      
      const opponentJid = challenge.challenger_jid === senderNumber ? challenge.challenged_jid : challenge.challenger_jid;
      await sock.sendMessage(opponentJid, { text: `🔔 Tantangan suit dengan @${senderNumber.split('@')[0]} telah dibatalkan.` });
      
      await sock.sendMessage(challenge.group_jid, { text: `🔔 Tantangan suit antara @${challenge.challenger_jid.split('@')[0]} dan @${challenge.challenged_jid.split('@')[0]} telah dibatalkan. Poin direfund.`, mentions: [challenge.challenger_jid, challenge.challenged_jid] });
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Gagal membatalkan tantangan suit: ${err.message}`);
    }
    return true;
  }

  // --- TOKO POWER-UP: tukar Akbar Poin jadi buff dalam game ---
  // Poin sengaja TIDAK bisa ditukar jadi kupon atau premium lagi. Premium hanya
  // dibeli dengan uang asli lewat saldo deposit (.deposit), jadi Akbar Poin murni
  // jadi skor + power-up dan tidak punya nilai rupiah sama sekali.
  if (command === 'tukar' || command === 'pointshop' || command === 'penukaran') {
    const option = parseInt(args[1], 10);
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = Math.max(0, Math.floor(Number(profile?.points) || 0));
    const JAM = 60 * 60 * 1000;

    const powerUps = [
      {
        id: 1,
        name: '⚡ XP Booster 2x',
        cost: 500,
        buff: 'XP_BOOST',
        multiplier: 2,
        durationMs: 24 * JAM,
        desc: 'Semua XP dari chat grup & kemenangan game jadi 2x lipat selama 24 jam. Naik level jauh lebih cepat.'
      },
      {
        id: 2,
        name: '🎁 Daily Boost 3x',
        cost: 300,
        buff: 'DAILY_BOOST',
        multiplier: 3,
        uses: 1,
        desc: 'Klaim `.daily` berikutnya dikali 3 (sekali pakai, bisa ditumpuk dengan bonus premium).'
      },
      {
        id: 3,
        name: '🛡️ Perisai Anti-Maling',
        cost: 400,
        buff: 'STEAL_SHIELD',
        multiplier: 1,
        durationMs: 24 * JAM,
        desc: 'Kebal dari `.steal` / `.rampok` member lain selama 24 jam.'
      },
      {
        id: 4,
        name: '🔓 Surat Bebas Penjara',
        cost: 350,
        instant: 'FREE_JAIL',
        desc: 'Langsung bebas dari penjara game tanpa menunggu masa tahanan habis.'
      }
    ];

    const sisaWaktu = (expiresAt) => {
      const ms = Number(expiresAt) - Date.now();
      if (!isFinite(ms) || ms <= 0) return 'habis';
      const jam = Math.floor(ms / JAM);
      const menit = Math.ceil((ms % JAM) / 60000);
      return jam > 0 ? `${jam} jam ${menit} menit` : `${menit} menit`;
    };

    if (isNaN(option) || option < 1 || option > powerUps.length) {
      let shopText = `🛒 *TOKO POWER-UP — TUKAR AKBAR POIN* 🛒\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      shopText += `👤 Akun: *@${senderNumber.split('@')[0]}*\n`;
      shopText += `💰 Saldo Poin: *${currentPoints.toLocaleString('id-ID')} Poin*\n\n`;
      shopText += `*Daftar Power-Up:*\n`;

      powerUps.forEach(item => {
        shopText += `*${item.id}. ${item.name}*\n`;
        shopText += `▫️ Harga: *${item.cost} Poin*\n`;
        shopText += `▫️ ${item.desc}\n\n`;
      });

      let aktif = [];
      try {
        aktif = await db.listActiveBuffs(senderNumber);
      } catch (e) {
        aktif = [];
      }

      if (aktif.length > 0) {
        shopText += `⚡ *Power-Up Aktif Kamu:*\n`;
        aktif.forEach(row => {
          const nama = powerUps.find(u => u.buff === row.buff_type)?.name || row.buff_type;
          const detail = row.expires_at
            ? `sisa ${sisaWaktu(row.expires_at)}`
            : `sisa ${Math.max(0, Number(row.uses_left) || 0)}x pakai`;
          shopText += `• ${nama} — _${detail}_\n`;
        });
        shopText += `\n`;
      }

      shopText += `💡 *Cara Menukar:* Ketik \`.tukar [nomor]\`\n*Contoh:* \`.tukar 1\` untuk membeli XP Booster.\n\n`;
      shopText += `_Catatan: Akbar Poin hanya untuk power-up dalam game. Membership Premium dibeli terpisah dengan saldo deposit — ketik *.premium*._`;

      await send(sock, jid, messageObj, shopText, { mentions: [senderNumber] });
      return true;
    }

    const selected = powerUps[option - 1];

    // Cek prasyarat SEBELUM poin dipotong supaya user tidak kehilangan poin
    // untuk item yang memang tidak bisa dipakai saat ini.
    if (selected.instant === 'FREE_JAIL') {
      const jailStatus = await db.isPlayerJailed(senderNumber);
      if (!jailStatus.isJailed) {
        await send(sock, jid, messageObj, `⚠️ Kamu sedang *tidak dipenjara*, jadi Surat Bebas Penjara belum ada gunanya. Poin kamu tidak dipotong.`);
        return true;
      }
    }

    const deductRes = await db.deductGamePoints(senderNumber, selected.cost);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membeli *${selected.name}*.\n\n💰 Poin kamu: *${currentPoints.toLocaleString('id-ID')} Poin*\n🏷️ Dibutuhkan: *${selected.cost} Poin*\n📉 Kurang: *${Math.max(0, selected.cost - currentPoints).toLocaleString('id-ID')} Poin*`);
      return true;
    }

    const sisaPoin = Math.max(0, currentPoints - selected.cost);

    try {
      if (selected.instant === 'FREE_JAIL') {
        await db.clearGameJail(senderNumber);
        await send(sock, jid, messageObj, `🔓 *SURAT BEBAS PENJARA DIPAKAI!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nKamu resmi bebas dari penjara game dan bisa langsung main lagi.\n\n💰 Sisa Poin: *${sisaPoin.toLocaleString('id-ID')} Poin*`);
        return true;
      }

      const granted = await db.grantUserBuff(senderNumber, selected.buff, {
        multiplier: selected.multiplier || 1,
        durationMs: selected.durationMs || 0,
        uses: selected.uses || 0
      });

      const durasiText = granted.expiresAt
        ? `⏳ Aktif selama: *${sisaWaktu(granted.expiresAt)}*`
        : `🎫 Jatah pakai: *${granted.usesLeft}x*`;

      await send(sock, jid, messageObj, `✅ *POWER-UP AKTIF!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${selected.name}\n${selected.desc}\n\n${durasiText}\n💰 Sisa Poin: *${sisaPoin.toLocaleString('id-ID')} Poin*\n\n_Cek power-up aktif kapan saja dengan_ \`.tukar\``);
    } catch (err) {
      // Kembalikan poin kalau buff gagal disimpan — jangan sampai user bayar
      // tapi tidak dapat apa-apa.
      await db.addGamePoints(senderNumber, selected.cost);
      await send(sock, jid, messageObj, `❌ Gagal mengaktifkan *${selected.name}*: ${err.message}\n\n💰 Poin kamu sudah dikembalikan.`);
    }
    return true;
  }

  if (['game', 'games'].includes(command) && args.length === 1) {
    const gameMenu = buildCommandMenu('game');
    if (gameMenu) {
      await send(sock, jid, messageObj, gameMenu);
      return true;
    }
  }

  if (['fun', 'hiburan'].includes(command) && args.length === 1) {
    const hiburanMenu = buildCommandMenu('hiburan');
    if (hiburanMenu) {
      await send(sock, jid, messageObj, hiburanMenu);
      return true;
    }
  }

  return false;
}

export async function triggerAutoQuiz(sock, jid) {
  const types = ['quiz', 'tebakemoji', 'word'];
  const type = types[Math.floor(Math.random() * types.length)];
  return startRound({ sock, jid, senderNumber: 'SYSTEM', messageObj: null, isFromGroup: true, type });
}

export * from './helpers.js';
export * from './family100.js';
export * from './duelRoulette.js';
export * from './blackjack.js';
export * from './bankHeist.js';
export * from './umaDerby.js';
export * from './bankEconomy.js';
export * from './triviaEngine.js';
export * from './rpgSystem.js';
export * from './mysteryAuction.js';
export * from './minesGame.js';
export * from './raidBoss.js';
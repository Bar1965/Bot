import * as db from '../../database.js';
import { send, randomItem, normalizeAnswer, scopeKey } from './helpers.js';

export const activeRounds = new Map();
const ROUND_DURATION_MS = 2 * 60 * 1000;

import { quizQuestions, emojiQuestions, wordQuestions, flagQuestions, tebakLaguQuestions } from './triviaData.js';

function maskSongTitle(title) {
  return title.split(' ').map(word => {
    if (word.length <= 2) return word;
    const first = word[0];
    const last = word[word.length - 1];
    const middle = '_'.repeat(word.length - 2);
    return first + middle + last;
  }).join(' ');
}

function scheduleRoundExpiry({ sock, jid, messageObj, key, round, duration = ROUND_DURATION_MS }) {
  round.timeout = setTimeout(async () => {
    if (round.isAnswered || round.cancelled) return;
    if (activeRounds.get(key) !== round) return;
    activeRounds.delete(key);
    await send(sock, jid, messageObj, `⏰ Waktu habis! Jawaban yang benar: *${round.answer || round.lastWord}*\n\nKetik .quiz, .tebakemoji, atau .tebakkata untuk ronde baru.`);
  }, duration);
  round.timeout.unref?.();
}

async function handleRoundCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd, isFromGroup }) {
  const key = scopeKey(jid, senderNumber, isFromGroup);
  const round = activeRounds.get(key);
  if (!round) {
    await send(sock, jid, messageObj, 'Tidak ada game aktif. Ketik `.quiz`, `.tebakemoji`, atau `.tebakkata` terlebih dahulu.');
    return true;
  }
  if (round.isAnswered || round.expiresAt < Date.now()) {
    if (round.timeout) clearTimeout(round.timeout);
    activeRounds.delete(key);
    await send(sock, jid, messageObj, `⏰ Waktu habis. Jawaban yang benar: *${round.answer}*`);
    return true;
  }
  if (cleanCmd === 'hint') {
    await send(sock, jid, messageObj, `💡 Petunjuk: ${round.hint}`);
    return true;
  }
  if (['nyerah', 'surrender', 'menyerah'].includes(cleanCmd)) {
    round.isAnswered = true;
    if (round.timeout) clearTimeout(round.timeout);
    activeRounds.delete(key);

    let surrenderMsg = '';
    if (round.type === 'tebaklagu') {
      surrenderMsg = `🏳️ *MENYERAH — TEBAK LAGU* 🎵\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎤 Artis: *${round.artist}*\n🎼 Judul Lagu: *${round.answer}*\n\n_Ketik \`.tebaklagu\` untuk memainkan lagu lain._`;
    } else if (round.type === 'tebakbendera') {
      surrenderMsg = `🏳️ *MENYERAH — TEBAK BENDERA* 🚩\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚩 Bendera: *${round.flag}*\n🏛️ Negara: *${round.country}* (*${round.answer}*)\n\n_Ketik \`.tebakbendera\` untuk tebak negara lain._`;
    } else {
      surrenderMsg = `🏳️ *KAMU MENYERAH!* 🏳️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Jawaban yang benar adalah: *${round.answer}*\n\n_Ketik \`.${round.type || 'quiz'}\` untuk bermain lagi._`;
    }
    await send(sock, jid, messageObj, surrenderMsg);
    return true;
  }
  const submitted = normalizeAnswer(args.slice(1).join(' '));
  if (!submitted) {
    await send(sock, jid, messageObj, 'Gunakan format `.jawab <jawaban>`.');
    return true;
  }
  const isMatch = (round.alias && Array.isArray(round.alias))
    ? round.alias.some(a => normalizeAnswer(a) === submitted)
    : (submitted === normalizeAnswer(round.answer));

  if (isMatch) {
    round.isAnswered = true;
    if (round.timeout) clearTimeout(round.timeout);
    activeRounds.delete(key);
    
    const pointsReward = round.type === 'tebaklagu' ? 25 : (round.type === 'tebakbendera' ? 20 : 20);
    const xpReward = round.type === 'tebaklagu' ? 50 : (round.type === 'tebakbendera' ? 35 : 30);
    
    const profile = await db.awardGamePoints(senderNumber, pointsReward, true);
    await db.grantXp(senderNumber, xpReward);
    
    const userTag = `@${senderNumber.split('@')[0]}`;
    let congratsMsg = '';
    if (round.type === 'tebaklagu') {
      congratsMsg = `🎉 *TEBAKAN LAGU TEPAT SEKALI!* 🎵\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSelamat ${userTag}! Jawaban yang benar adalah: *${round.answer}* (${round.artist})\n\n🎁 *Hadiah:* +${pointsReward} Poin Game & +${xpReward} XP!\n💰 Total Poin Kamu: *${profile.points}*\n\nKetik \`.tebaklagu\` untuk ronde musik selanjutnya!`;
    } else if (round.type === 'tebakbendera') {
      congratsMsg = `🎉 *TEBAKAN BENDERA BENAR!* 🚩\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSelamat ${userTag}! Negara yang tepat adalah: *${round.flag} ${round.country}*\n\n🎁 *Hadiah:* +${pointsReward} Poin Game & +${xpReward} XP!\n💰 Total Poin Kamu: *${profile.points}*\n\nKetik \`.tebakbendera\` untuk tebak negara berikutnya!`;
    } else {
      congratsMsg = `🎉 *Jawaban benar!*\nSelamat ${userTag}, +${pointsReward} poin & +${xpReward} XP untuk kamu. Total poin: *${profile.points}*\n\nKetik .quiz untuk ronde berikutnya.`;
    }
      
    await sock.sendMessage(jid, { text: congratsMsg, mentions: [senderNumber] }, { quoted: messageObj });
  } else {
    await send(sock, jid, messageObj, '❌ Belum tepat. Coba lagi atau ketik `.hint`.');
  }
  return true;
}

async function startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type }) {
  const key = scopeKey(jid, senderNumber, isFromGroup);
  if (activeRounds.has(key)) {
    await send(sock, jid, messageObj, 'Masih ada game aktif. Jawab dulu dengan `.jawab <jawaban>` atau ketik `.hint`.');
    return true;
  }

  if (type === 'tebakbendera') {
    const item = randomItem(flagQuestions);
    const round = {
      type: 'tebakbendera',
      flag: item.flag,
      country: item.country,
      answer: item.country,
      alias: item.alias,
      clue: item.clue,
      hint: item.hint,
      expiresAt: Date.now() + ROUND_DURATION_MS
    };
    activeRounds.set(key, round);
    scheduleRoundExpiry({ sock, jid, messageObj, key, round });

    const promptText = 
`🌍 *GAME TEBAK BENDERA & NEGARA* 🚩
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tebak nama negara dari bendera dan petunjuk berikut!

🚩 *Bendera:* ${item.flag}
📝 *Petunjuk:* ${item.clue}
💡 *Pola Huruf:* \`${item.hint}\`
⏳ *Waktu:* 2 Menit
🎁 *Hadiah:* +35 XP & +20 Poin Game

👉 *Cara Menjawab:* Ketik \`.jawab <nama negara>\` atau langsung ketik nama negaranya di grup!
👉 *Petunjuk Tambahan:* Ketik \`.hint\``;

    await send(sock, jid, messageObj, promptText);
    return true;
  }

  if (type === 'tebaklagu') {
    const song = randomItem(tebakLaguQuestions);
    const round = { 
      type: 'tebaklagu',
      artist: song.artist,
      answer: song.answer,
      hint: song.hint,
      audioUrl: song.audioUrl,
      expiresAt: Date.now() + ROUND_DURATION_MS 
    };
    activeRounds.set(key, round);
    scheduleRoundExpiry({ sock, jid, messageObj, key, round });

    const masked = maskSongTitle(song.answer);
    const promptText = 
`🎵 *GAME TEBAK LAGU (MUSIC QUIZ)* 🎵
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dengarkan potongan musik audio di atas dan tebak judul lagunya!

🎤 *Artis/Penyanyi:* ${song.artist}
💡 *Pola Judul:* \`${masked}\` (${song.answer.replace(/[^A-Z0-9]/gi, '').length} huruf)
⏳ *Waktu:* 2 Menit
🎁 *Hadiah:* +50 XP & +25 Poin Game

👉 *Cara Menjawab:* Ketik \`.jawab <judul lagu>\` atau langsung ketik judulnya di grup!
👉 *Petunjuk Tambahan:* Ketik \`.hint\``;

    try {
      if (song.audioUrl) {
        await sock.sendMessage(jid, { 
          audio: { url: song.audioUrl }, 
          mimetype: 'audio/mp4', 
          ptt: true 
        }, { quoted: messageObj });
      }
    } catch (e) {
      console.error('[TEBAK_LAGU_AUDIO_ERR]', e.message);
    }

    await send(sock, jid, messageObj, promptText);
    return true;
  }

  const source = type === 'quiz' ? randomItem(quizQuestions) : type === 'tebakemoji' ? randomItem(emojiQuestions) : randomItem(wordQuestions);
  const round = { ...source, expiresAt: Date.now() + ROUND_DURATION_MS };
  activeRounds.set(key, round);
  scheduleRoundExpiry({ sock, jid, messageObj, key, round });
  const options = source.options ? `\n\n${source.options.join('\n')}` : '';
  await send(sock, jid, messageObj, `🎮 *${type === 'quiz' ? 'QUIZ' : type === 'tebakemoji' ? 'TEBAK EMOJI' : 'TEBAK KATA'}*\n\n${source.question}${options}\n\n⏳ Waktu: 2 menit\nKetik .jawab <jawaban> untuk menjawab.`);
  return true;
}

async function surrenderRound({ sock, jid, senderNumber, messageObj, isFromGroup }) {
  const key = scopeKey(jid, senderNumber, isFromGroup);
  const round = activeRounds.get(key);
  if (!round) return false;

  round.isAnswered = true;
  if (round.timeout) clearTimeout(round.timeout);
  activeRounds.delete(key);

  let surrenderMsg = '';
  if (round.type === 'tebaklagu') {
    surrenderMsg = `🏳️ *MENYERAH — TEBAK LAGU* 🎵\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎤 Artis: *${round.artist}*\n🎼 Judul Lagu: *${round.answer}*\n\n_Ketik \`.tebaklagu\` untuk memainkan lagu lain._`;
  } else if (round.type === 'tebakbendera') {
    surrenderMsg = `🏳️ *MENYERAH — TEBAK BENDERA* 🚩\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🚩 Bendera: *${round.flag}*\n🏛️ Negara: *${round.country}* (*${round.answer}*)\n\n_Ketik \`.tebakbendera\` untuk tebak negara lain._`;
  } else {
    surrenderMsg = `🏳️ *KAMU MENYERAH!* 🏳️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Jawaban yang benar adalah: *${round.answer}*\n\n_Ketik \`.${round.type || 'quiz'}\` untuk bermain lagi._`;
  }
  await send(sock, jid, messageObj, surrenderMsg);
  return true;
}

export { ROUND_DURATION_MS, scheduleRoundExpiry, startRound, handleRoundCommand, surrenderRound, maskSongTitle, quizQuestions, emojiQuestions, wordQuestions, flagQuestions, tebakLaguQuestions };
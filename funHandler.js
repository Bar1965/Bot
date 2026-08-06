import * as db from './database.js';
import * as entertainment from './entertainmentHandler.js';
import { sendInteractiveButtons } from './bot.js';

const activeRounds = new Map();
const cooldowns = new Map();
const ROUND_DURATION_MS = 2 * 60 * 1000;

const quizQuestions = [
  { question: 'Planet terbesar di tata surya adalah?', options: ['A. Mars', 'B. Jupiter', 'C. Venus', 'D. Saturnus'], answer: 'B', hint: 'Namanya diawali huruf J.' },
  { question: 'Ibukota Indonesia adalah?', options: ['A. Bandung', 'B. Surabaya', 'C. Jakarta', 'D. Medan'], answer: 'C', hint: 'Kota metropolitan di Pulau Jawa.' },
  { question: 'Hewan tercepat di darat adalah?', options: ['A. Singa', 'B. Cheetah', 'C. Kuda', 'D. Serigala'], answer: 'B', hint: 'Namanya juga sering disebut cheetah.' },
  { question: 'Berapa jumlah sisi segitiga?', options: ['A. 2', 'B. 3', 'C. 4', 'D. 5'], answer: 'B', hint: 'Bentuk paling sederhana dengan sudut.' },
  { question: 'Bahasa pemrograman yang dipakai bot ini adalah?', options: ['A. JavaScript', 'B. Pascal', 'C. Ruby', 'D. Swift'], answer: 'A', hint: 'Runtime yang digunakan adalah Node.js.' }
];

const emojiQuestions = [
  { question: 'Tebak film dari emoji: 🦁👑', answer: 'THE LION KING', hint: 'Raja hutan.' },
  { question: 'Tebak makanan dari emoji: 🍚🍗', answer: 'NASI AYAM', hint: 'Menu makan siang populer.' },
  { question: 'Tebak profesi dari emoji: 👨‍⚕️💉', answer: 'DOKTER', hint: 'Bekerja di rumah sakit.' },
  { question: 'Tebak tempat dari emoji: 🏖️🌊', answer: 'PANTAI', hint: 'Tempat bermain pasir dan ombak.' },
  { question: 'Tebak kegiatan dari emoji: 🎬🍿', answer: 'NONTON FILM', hint: 'Biasanya dilakukan di bioskop.' }
];

const wordQuestions = [
  { question: 'Sesuatu yang dipakai saat hujan', answer: 'PAYUNG', hint: 'Bisa dilipat dan dibawa.' },
  { question: 'Benda untuk melihat waktu', answer: 'JAM', hint: 'Ada jarum atau angka digital.' },
  { question: 'Tempat menyimpan banyak buku', answer: 'PERPUSTAKAAN', hint: 'Tempat membaca dan belajar.' },
  { question: 'Hewan yang menghasilkan susu', answer: 'SAPI', hint: 'Sering tinggal di peternakan.' },
  { question: 'Alat untuk memotret', answer: 'KAMERA', hint: 'Bisa berupa ponsel atau DSLR.' }
];

const missionList = [
  'Menangkan 1 quiz hari ini untuk mendapat bonus XP.',
  'Ajak teman mencoba `.daily` dan kumpulkan streak.',
  'Mainkan `.sambungkata` bersama grup.',
  'Gunakan reaction terbaikmu pada pesan bot hari ini.',
  'Coba satu command media dan satu command game.'
];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function normalizeAnswer(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function scopeKey(jid, senderNumber, isFromGroup) {
  return isFromGroup ? jid : senderNumber;
}

function isOnCooldown(key, duration = 3000) {
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < duration) return true;
  cooldowns.set(key, now);
  return false;
}

async function send(sock, jid, messageObj, text, options = {}) {
  if (options.buttons || options.sections) {
    await sendInteractiveButtons(sock, jid, {
      text,
      title: options.title,
      footer: options.footer || 'Akbar Store Bot',
      buttons: options.buttons,
      sections: options.sections
    });
  } else {
    await sock.sendMessage(jid, { text }, messageObj ? { quoted: messageObj } : undefined);
  }
}

function scheduleRoundExpiry({ sock, jid, messageObj, key, round, duration = ROUND_DURATION_MS }) {
  round.timeout = setTimeout(async () => {
    if (activeRounds.get(key) !== round) return;
    activeRounds.delete(key);
    await send(sock, jid, messageObj, `Waktu habis! Jawaban yang benar: *${round.answer || round.lastWord}*\n\nKetik .quiz, .tebakgambar, atau .tebakkata untuk ronde baru.`);
  }, duration);
  round.timeout.unref?.();
}

function profileText(profile, name) {
  const winRate = profile.games_played > 0
    ? Math.round((profile.games_won / profile.games_played) * 100)
    : 0;
  return `🏆 *PROFILE GAME*\n\n👤 ${name || 'Pelanggan'}\n💰 Poin: *${profile.points}*\n⭐ Level: *${profile.level}* (${profile.xp} XP)\n🎮 Game dimainkan: *${profile.games_played}*\n🥇 Menang: *${profile.games_won}* (${winRate}%)\n🔥 Streak harian: *${profile.daily_streak || 0}*`;
}

async function handleRoundCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd, isFromGroup }) {
  const key = scopeKey(jid, senderNumber, isFromGroup);
  const round = activeRounds.get(key);
  if (!round) {
    await send(sock, jid, messageObj, 'Tidak ada game aktif. Ketik `.quiz`, `.tebakemoji`, atau `.tebakkata` terlebih dahulu.');
    return true;
  }
  if (round.expiresAt < Date.now()) {
    if (round.timeout) clearTimeout(round.timeout);
    activeRounds.delete(key);
    await send(sock, jid, messageObj, `⏰ Waktu habis. Jawaban yang benar: *${round.answer}*`);
    return true;
  }
  if (cleanCmd === 'hint') {
    await send(sock, jid, messageObj, `💡 Petunjuk: ${round.hint}`);
    return true;
  }
  const submitted = normalizeAnswer(args.slice(1).join(' '));
  if (!submitted) {
    await send(sock, jid, messageObj, 'Gunakan format `.jawab <jawaban>`.');
    return true;
  }
  if (submitted === normalizeAnswer(round.answer)) {
    if (round.timeout) clearTimeout(round.timeout);
    activeRounds.delete(key);
    const profile = await db.awardGamePoints(senderNumber, 20, true);
    await send(sock, jid, messageObj, `🎉 *Jawaban benar!*\n+20 poin untuk kamu. Total poin: *${profile.points}*\n\nKetik .quiz untuk ronde berikutnya.`);
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
  const source = type === 'quiz' ? randomItem(quizQuestions) : type === 'tebakemoji' ? randomItem(emojiQuestions) : randomItem(wordQuestions);
  const round = { ...source, expiresAt: Date.now() + ROUND_DURATION_MS };
  activeRounds.set(key, round);
  scheduleRoundExpiry({ sock, jid, messageObj, key, round });
  const options = source.options ? `\n\n${source.options.join('\n')}` : '';
  await send(sock, jid, messageObj, `🎮 *${type === 'quiz' ? 'QUIZ' : type === 'tebakemoji' ? 'TEBAK EMOJI' : 'TEBAK KATA'}*\n\n${source.question}${options}\n\n⏳ Waktu: 2 menit\nKetik .jawab <jawaban> untuk menjawab.`);
  return true;
}

export async function handleFunCommand({ sock, jid, senderNumber, messageObj, text, args, cleanCmd, isFromGroup = false }) {
  const command = String(cleanCmd || '').toLowerCase();
  const scope = scopeKey(jid, senderNumber, isFromGroup);
  const roundCommands = ['jawab', 'answer', 'hint'];
  if (roundCommands.includes(command)) {
    return await handleRoundCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd: command, isFromGroup });
  }

  if (isFromGroup && ['quiz', 'trivia', 'tebakquiz', 'tebakemoji', 'emoji', 'tebakkata', 'hangman', 'kata', 'sambungkata', 'wordchain', 'truth', 'dare', 'tod', 'dadu', 'dice', 'coinflip', 'koin', 'coin', 'poll', 'voting', 'vote', 'love', 'jodoh', 'compatibility'].includes(command)) {
    const groupSettings = await db.getGroupSettings(jid);
    if (groupSettings.bot_mode === 'sales') return false;
  }

  if (['quiz', 'trivia', 'tebakquiz'].includes(command)) return startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'quiz' });
  if (['tebakemoji', 'emoji'].includes(command)) return startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebakemoji' });
  if (['tebakkata', 'hangman', 'kata'].includes(command)) return startRound({ sock, jid, senderNumber, messageObj, isFromGroup, type: 'tebakkata' });

  if (['truth', 'dare', 'tod'].includes(command)) {
    if (isOnCooldown(`${scope}:truth`, 5000)) return true;
    await send(sock, jid, messageObj, entertainment.getTruthOrDare(command));
    return true;
  }

  if (['dadu', 'dice'].includes(command)) {
    if (isOnCooldown(`${scope}:dice`)) return true;
    const value = Math.floor(Math.random() * 6) + 1;
    const profile = await db.awardGamePoints(senderNumber, 2);
    await send(sock, jid, messageObj, `🎲 Dadu jatuh di angka *${value}*. Kamu mendapat 2 poin. Total: *${profile.points}*`);
    return true;
  }

  if (['coinflip', 'koin', 'coin'].includes(command)) {
    if (isOnCooldown(`${scope}:coin`)) return true;
    const result = Math.random() < 0.5 ? 'HEADS 🪙' : 'TAILS 🪙';
    const profile = await db.awardGamePoints(senderNumber, 2);
    await send(sock, jid, messageObj, `🪙 Hasil lempar koin: *${result}*\n+2 poin untukmu. Total: *${profile.points}*`);
    return true;
  }

  if (['sambungkata', 'wordchain'].includes(command)) {
    const word = normalizeAnswer(args.slice(1).join(' '));
    const round = activeRounds.get(scope);
    if (!word && !round) {
      const starter = randomItem(['AKBAR', 'TOKO', 'DIGITAL', 'PROMO', 'GAME']);
      const round = { type: 'wordchain', lastWord: starter, answer: '', expiresAt: Date.now() + ROUND_DURATION_MS };
      activeRounds.set(scope, round);
      scheduleRoundExpiry({ sock, jid, messageObj, key: scope, round });
      await send(sock, jid, messageObj, `🔗 *SAMBUNG KATA*\n\nKata awal: *${starter}*\nKirim `.sambungkata <kata>` yang diawali huruf *${starter.slice(-1)}*.`);
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
    round.lastWord = word;
    const profile = await db.awardGamePoints(senderNumber, 5, true);
    await send(sock, jid, messageObj, `✅ *${word}* diterima! Lanjutkan dengan kata berawalan *${word.slice(-1)}*.\n+5 poin untukmu. Total: *${profile.points}*`);
    return true;
  }

  if (['daily', 'hadian', 'reward'].includes(command)) {
    const today = new Date().toISOString().slice(0, 10);
    const result = await db.claimGameDaily(senderNumber, today);
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
    await send(sock, jid, messageObj, `🎁 Hadiah harian berhasil diklaim: *+${result.reward} poin*\n🔥 Streak: *${result.streak} hari*\n💰 Total poin: *${result.profile.points}*`, {
      title: '🎁 HADIAH HARIAN TERKLAIM',
      buttons: [
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '👤 Profil Saya', id: '.poin' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ]
    });
    return true;
  }

  if (['poin', 'point', 'profile', 'level', 'me'].includes(command)) {
    const profile = await db.getGameProfile(senderNumber);
    await send(sock, jid, messageObj, profileText(profile, messageObj?.pushName), {
      title: '👤 PROFIL & POIN GAME',
      buttons: [
        { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ]
    });
    return true;
  }

  if (['rank', 'leaderboard', 'top'].includes(command)) {
    const rows = await db.getGameLeaderboard(10);
    if (rows.length === 0) {
      await send(sock, jid, messageObj, 'Belum ada pemain di leaderboard. Ketik `.daily` untuk mulai.', {
        title: '🏆 LEADERBOARD',
        buttons: [
          { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
          { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
        ]
      });
      return true;
    }
    const lines = rows.map((row, index) => `${index + 1}. *${row.customer_nama || 'Pelanggan'}* — ${row.points} poin (Lv.${row.level})`);
    await send(sock, jid, messageObj, `🏆 *LEADERBOARD AKBAR STORE*\n\n${lines.join('\n')}\n\nMain lagi untuk naik peringkat!`, {
      title: '🏆 LEADERBOARD POIN',
      buttons: [
        { type: 'reply', text: '🎁 Klaim Daily', id: '.daily' },
        { type: 'reply', text: '👤 Profil Saya', id: '.poin' },
        { type: 'reply', text: '📋 Menu Utama', id: '.menu' }
      ]
    });
    return true;
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

  if (['redeem', 'tukarpoin', 'tukar'].includes(command)) {
    const points = Number.parseInt(args[1], 10);
    const result = await db.redeemGamePoints(senderNumber, points);
    if (!result.success) {
      await send(sock, jid, messageObj, `❌ ${result.message}`);
      return true;
    }
    const couponCode = `GAME${Date.now().toString(36).toUpperCase().slice(-8)}`;
    await db.addCoupon(couponCode, 'fixed', result.discount, 0, 1, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
    await send(sock, jid, messageObj, `🎁 Penukaran berhasil!\n\nKupon: *${couponCode}*\nNilai: *Rp${result.discount.toLocaleString('id-ID')}*\nSisa poin: *${result.remainingPoints}*\n\nGunakan dengan .kupon ${couponCode} dalam 7 hari.`);
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

  if (['poll', 'voting', 'vote'].includes(command)) {
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
    const isTagAllRequested = command === 'freegamestag' || args[1] === 'tag' || args[1] === 'tagall';
    const platform = isTagAllRequested ? (args[2] || 'pc') : (args[1] || 'pc');

    const res = await entertainment.fetchFreeGames(platform);
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

      await send(sock, jid, messageObj, res.text, {
        title: '🎮 FREE GAMES ALERT (STEAM / EPIC / GOG)',
        buttons: [
          { type: 'reply', text: '🎮 Steam', id: '.freegames steam' },
          { type: 'reply', text: '🎁 Epic Games', id: '.freegames epic' },
          { type: 'reply', text: '📢 TagAll Group', id: '.freegames tag' }
        ]
      });
    } else {
      await send(sock, jid, messageObj, `❌ ${res.message}`);
    }
    return true;
  }

  if (['slot', 'slots', 'judi'].includes(command)) {
    if (isOnCooldown(`${scope}:slot`, 4000)) return true;
    const bet = Math.max(1, Math.min(1000, Number.parseInt(args[1] || '10', 10)));
    const profile = await db.getGameProfile(senderNumber);

    if (profile.points < bet) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu butuh *${bet} poin*, tapi sisa poinmu hanya *${profile.points} poin*.\n\nKetik \`.daily\` untuk mengambil poin gratis harian!`);
      return true;
    }

    const spin = entertainment.playSlotMachine(bet);
    const pointDelta = spin.winAmount - bet;
    const newPoints = Math.max(0, profile.points + pointDelta);

    await db.updateGameProfile(senderNumber, { points: newPoints });

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

  if (['fun', 'game', 'games', 'hiburan'].includes(command) && args.length === 1) {
    await send(sock, jid, messageObj, '🎮 *MENU HIBURAN*\n\n.freegames · .slot · .zodiak · .jodoh\n.quiz · .tebakemoji · .tebakkata\n.jawab · .hint · .sambungkata\n.truth · .dare · .dadu · .coinflip\n.torebot · .tochipmunk · .todeep\n.daily · .poin · .rank · .misi\n.poll · .love\n\nKetik `.menu hiburan` untuk panduan lengkap.');
    return true;
  }

  return false;
}

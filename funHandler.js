import * as db from './database.js';
import * as entertainment from './entertainmentHandler.js';
import { sendInteractiveButtons } from './bot.js';
import { getPremiumBenefits } from './premiumHandler.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import * as ww from './werewolfGame.js';


const activeRounds = new Map();
const cooldowns = new Map();
const tebakAngkaGames = new Map();
const rampokCooldowns = new Map();
const victimImmunity = new Map();
const easterEggCooldowns = new Map();
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

const flagQuestions = [
  { flag: '🇮🇩', country: 'INDONESIA', alias: ['INDONESIA'], hint: 'I _ _ _ _ _ S _ A', clue: 'Negara kepulauan terbesar di dunia, beribukota Jakarta/IKN, bersemboyan Bhinneka Tunggal Ika.' },
  { flag: '🇯🇵', country: 'JEPANG', alias: ['JEPANG', 'JAPAN'], hint: 'J _ _ _ N G', clue: 'Negara di Asia Timur beribukota Tokyo, terkenal dengan julukan Negeri Sakura dan Gunung Fuji.' },
  { flag: '🇰🇷', country: 'KOREA SELATAN', alias: ['KOREA SELATAN', 'SOUTH KOREA', 'KORSEL'], hint: 'K _ _ E A   S _ _ _ T _ N', clue: 'Negara asal K-Pop, drama Korea, dan kuliner Kimchi, beribukota di Seoul.' },
  { flag: '🇩🇪', country: 'JERMAN', alias: ['JERMAN', 'GERMANY'], hint: 'J _ _ M _ N', clue: 'Negara di Eropa Barat beribukota Berlin, terkenal dengan industri otomotif dan festival Oktoberfest.' },
  { flag: '🇫🇷', country: 'PRANCIS', alias: ['PRANCIS', 'PERANCIS', 'FRANCE'], hint: 'P _ _ N C _ S', clue: 'Negara di Eropa Barat dengan ikon Menara Eiffel dan Museum Louvre di Paris.' },
  { flag: '🇧🇷', country: 'BRASIL', alias: ['BRASIL', 'BRAZIL'], hint: 'B _ _ S _ L', clue: 'Negara terbesar di Amerika Selatan, terkenal dengan tarian Samba dan hutan hujan Amazon.' },
  { flag: '🇦🇷', country: 'ARGENTINA', alias: ['ARGENTINA'], hint: 'A _ G _ N _ _ N A', clue: 'Negara di Amerika Selatan beribukota Buenos Aires, tanah kelahiran Lionel Messi & Diego Maradona.' },
  { flag: '🇸🇦', country: 'ARAB SAUDI', alias: ['ARAB SAUDI', 'SAUDI ARABIA', 'SAUDI'], hint: 'A _ _ B   S _ _ D I', clue: 'Negara di Timur Tengah tempat berdirinya dua kota suci Makkah dan Madinah.' },
  { flag: '🇬🇧', country: 'INGGRIS', alias: ['INGGRIS', 'UNITED KINGDOM', 'BRITANIA RAYA', 'UK'], hint: 'I _ G _ R _ S', clue: 'Negara di Eropa beribukota London dengan ikon jam raksasa Big Ben dan Tower Bridge.' },
  { flag: '🇺🇸', country: 'AMERIKA SERIKAT', alias: ['AMERIKA SERIKAT', 'AMERIKA', 'USA', 'US'], hint: 'A _ E _ _ K A   S _ R _ K _ T', clue: 'Negara adidaya di Amerika Utara dengan ikon Patung Liberty dan Gedung Putih (White House).' },
  { flag: '🇨🇦', country: 'KANADA', alias: ['KANADA', 'CANADA'], hint: 'K _ N _ D A', clue: 'Negara di Amerika Utara yang benderanya memiliki lambang Daun Maple merah, beribukota Ottawa.' },
  { flag: '🇮🇹', country: 'ITALIA', alias: ['ITALIA', 'ITALY'], hint: 'I _ A _ I A', clue: 'Negara berbentuk sepatu bot di Eropa Selatan, asal muasal Pizza, Pasta, dan Colosseum di Roma.' },
  { flag: '🇪🇸', country: 'SPANYOL', alias: ['SPANYOL', 'SPAIN'], hint: 'S _ A _ Y _ L', clue: 'Negara di Eropa Selatan beribukota Madrid, terkenal dengan tarian Flamenco dan adu banteng Matador.' },
  { flag: '🇳🇱', country: 'BELANDA', alias: ['BELANDA', 'NETHERLANDS', 'HOLLAND'], hint: 'B _ L _ N _ A', clue: 'Negara di Eropa yang dijuluki Negeri Kincir Angin dan Bunga Tulip, beribukota Amsterdam.' },
  { flag: '🇦🇺', country: 'AUSTRALIA', alias: ['AUSTRALIA'], hint: 'A _ S _ R _ L _ A', clue: 'Negara benua di selatan Indonesia yang terkenal dengan hewan Kangguru dan Sydney Opera House.' },
  { flag: '🇪🇬', country: 'MESIR', alias: ['MESIR', 'EGYPT'], hint: 'M _ S _ R', clue: 'Negara di Afrika Utara beribukota Kairo, terkenal dengan Piramida Giza, Sphinx, dan Sungai Nil.' },
  { flag: '🇷🇺', country: 'RUSIA', alias: ['RUSIA', 'RUSSIA'], hint: 'R _ S _ A', clue: 'Negara terluas di dunia yang membentang di Eropa Timur dan Asia Utara, beribukota Moskow.' },
  { flag: '🇮🇳', country: 'INDIA', alias: ['INDIA'], hint: 'I _ D _ A', clue: 'Negara di Asia Selatan beribukota New Delhi dengan monumen megah Taj Mahal dan industri film Bollywood.' },
  { flag: '🇲🇾', country: 'MALAYSIA', alias: ['MALAYSIA'], hint: 'M _ L _ Y _ I A', clue: 'Negara tetangga serumpun Indonesia beribukota Kuala Lumpur dengan ikon Menara Kembar Petronas.' },
  { flag: '🇸🇬', country: 'SINGAPURA', alias: ['SINGAPURA', 'SINGAPORE'], hint: 'S _ N _ A _ U _ A', clue: 'Negara pulau modern di Asia Tenggara yang terkenal dengan patung Merlion dan Marina Bay Sands.' },
  { flag: '🇹🇭', country: 'THAILAND', alias: ['THAILAND'], hint: 'T _ A _ L _ N D', clue: 'Negara di Asia Tenggara beribukota Bangkok yang dijuluki Negeri Gajah Putih.' },
  { flag: '🇻🇳', country: 'VIETNAM', alias: ['VIETNAM'], hint: 'V _ E _ N _ M', clue: 'Negara di Asia Tenggara beribukota Hanoi, terkenal dengan kuliner mie Pho dan Teluk Ha Long.' },
  { flag: '🇵🇭', country: 'FILIPINA', alias: ['FILIPINA', 'PHILIPPINES'], hint: 'F _ L _ P _ N A', clue: 'Negara kepulauan di Asia Tenggara beribukota Manila, terkenal dengan kendaraan khas Jeepney.' },
  { flag: '🇹🇷', country: 'TURKI', alias: ['TURKI', 'TURKEY', 'TURKIYE'], hint: 'T _ R _ I', clue: 'Negara lintas benua Eurasia beribukota Ankara, terkenal dengan kota Istanbul dan balon udara Cappadocia.' },
  { flag: '🇲🇽', country: 'MEKSIKO', alias: ['MEKSIKO', 'MEXICO'], hint: 'M _ K _ I _ O', clue: 'Negara di Amerika Utara beribukota Mexico City, terkenal dengan kuliner Taco dan topi Sombrero.' },
  { flag: '🇨🇭', country: 'SWISS', alias: ['SWISS', 'SWITZERLAND'], hint: 'S _ I _ S', clue: 'Negara netral di Eropa beribukota Bern, terkenal dengan Pegunungan Alpen, Cokelat, dan Jam Tangan mewah.' },
  { flag: '🇿🇦', country: 'AFRIKA SELATAN', alias: ['AFRIKA SELATAN', 'SOUTH AFRICA'], hint: 'A _ R _ K A   S _ L _ T _ N', clue: 'Negara di ujung selatan benua Afrika berjuluk Rainbow Nation, tempat asal Nelson Mandela.' },
  { flag: '🇨🇳', country: 'CHINA', alias: ['CHINA', 'TIONGKOK', 'TIONGHOA'], hint: 'C _ I _ A', clue: 'Negara di Asia Timur beribukota Beijing yang memiliki keajaiban dunia Tembok Raksasa (Great Wall).' },
  { flag: '🇬🇷', country: 'YUNANI', alias: ['YUNANI', 'GREECE'], hint: 'Y _ N _ N I', clue: 'Negara di Eropa Selatan beribukota Athena, tempat lahirnya peradaban barat, filsafat, dan Olimpiade kuno.' },
  { flag: '🇵🇹', country: 'PORTUGAL', alias: ['PORTUGAL'], hint: 'P _ R _ U _ A L', clue: 'Negara di Semenanjung Iberia Eropa beribukota Lisabon, tanah kelahiran pesepakbola Cristiano Ronaldo.' },
  { flag: '🇦🇪', country: 'UNI EMIRAT ARAB', alias: ['UNI EMIRAT ARAB', 'UEA', 'UAE'], hint: 'U _ I   E _ I _ A T   A _ A B', clue: 'Negara federasi di Timur Tengah beribukota Abu Dhabi, rumah bagi gedung tertinggi di dunia Burj Khalifa.' },
  { flag: '🇵🇱', country: 'POLANDIA', alias: ['POLANDIA', 'POLAND'], hint: 'P _ L _ N _ I A', clue: 'Negara di Eropa Tengah beribukota Warsawa dengan bendera putih-merah terbalik dari Indonesia.' },
  { flag: '🇲🇨', country: 'MONAKO', alias: ['MONAKO', 'MONACO'], hint: 'M _ N _ K O', clue: 'Negara kota terkecil kedua di dunia dengan bendera merah-putih serupa Indonesia, terkenal dengan kasino & F1.' },
  { flag: '🇳🇿', country: 'SELANDIA BARU', alias: ['SELANDIA BARU', 'NEW ZEALAND'], hint: 'S _ L _ N _ I A   B _ R U', clue: 'Negara kepulauan di Oseania beribukota Wellington, terkenal dengan suku Maori dan burung Kiwi.' },
  { flag: '🇲🇦', country: 'MAROKO', alias: ['MAROKO', 'MOROCCO'], hint: 'M _ R _ K O', clue: 'Negara kerajaan di Afrika Utara beribukota Rabat, berjuluk Negeri Matahari Terbenam (Al-Maghrib).' },
  { flag: '🇸🇪', country: 'SWEDIA', alias: ['SWEDIA', 'SWEDEN'], hint: 'S _ E _ I A', clue: 'Negara Skandinavia di Eropa Utara beribukota Stockholm, asal perusahaan IKEA dan Spotify.' },
  { flag: '🇳🇴', country: 'NORWEGIA', alias: ['NORWEGIA', 'NORWAY'], hint: 'N _ R _ E _ I A', clue: 'Negara Nordik di Eropa Utara beribukota Oslo, terkenal dengan keindahan Fjord dan Midnight Sun.' }
];

const tebakLaguQuestions = [
  {
    artist: 'Sheila On 7',
    answer: 'DAN',
    hint: 'Lagu hits 1999 dengan lirik "Dan bila esok datang kembali..."',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/sheila_on_7_dan.mp3'
  },
  {
    artist: 'Dewa 19',
    answer: 'KANGEN',
    hint: 'Lagu legendaris ciptaan Ahmad Dhani rilisan tahun 1992',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/dewa19_kangen.mp3'
  },
  {
    artist: 'Tulus',
    answer: 'HATI HATI DI JALAN',
    hint: 'Lagu viral 2022 dari album Manusia tentang perpisahan baik-baik',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/tulus_hati_hati_di_jalan.mp3'
  },
  {
    artist: 'Mahalini',
    answer: 'SIAL',
    hint: 'Lagu galau dengan lirik "Sial-sialnya ku bertemu dengan cinta seperti ini"',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/mahalini_sial.mp3'
  },
  {
    artist: 'Hindia',
    answer: 'EVALUASI',
    hint: 'Lagu motivasi Baskara Putra: "Bilas muka, gosok gigi, evaluasi..."',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/hindia_evaluasi.mp3'
  },
  {
    artist: 'Denny Caknan',
    answer: 'KARTONYONO MEDOT JANJI',
    hint: 'Lagu pop Jawa mega-hits yang menceritakan patah hati di Kartonyono Ngawi',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/denny_caknan_kartonyono.mp3'
  },
  {
    artist: 'Juicy Luicy',
    answer: 'LANTAS',
    hint: 'Lagu tentang menjadi orang ketiga: "Lantas mengapa ku masih menaruh hati..."',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/juicy_luicy_lantas.mp3'
  },
  {
    artist: 'Noah / Peterpan',
    answer: 'SEPARUH AKU',
    hint: 'Single pertama setelah Peterpan resmi berganti nama jadi NOAH',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/noah_separuh_aku.mp3'
  },
  {
    artist: 'Peterpan',
    answer: 'MENGHAPUS JEJAKMU',
    hint: 'Lagu ikonik dengan video klip legendaris Ariel dan Dian Sastro',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/peterpan_menghapus_jejakmu.mp3'
  },
  {
    artist: 'Vierra',
    answer: 'RASA INI',
    hint: 'Lagu pop band Kevin Aprilio & Widy dengan lirik "Ku tak bisa jauh, jauh darimu..."',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/vierra_rasa_ini.mp3'
  },
  {
    artist: 'YOASOBI',
    answer: 'IDOL',
    hint: 'Opening anime Oshi no Ko yang memecahkan rekor Billboard Global',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/yoasobi_idol.mp3'
  },
  {
    artist: 'LiSA',
    answer: 'GURENGE',
    hint: 'Opening Anime Kimetsu no Yaiba (Demon Slayer) Season 1',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/lisa_gurenge.mp3'
  },
  {
    artist: 'Kenshi Yonezu',
    answer: 'KICK BACK',
    hint: 'Opening anime Chainsaw Man yang sangat energetik',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/kenshi_yonezu_kickback.mp3'
  },
  {
    artist: 'Bruno Mars',
    answer: 'THAT S WHAT I LIKE',
    hint: 'Lagu R&B Funk Bruno Mars dengan lirik "Gold jewelry shining so bright..."',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/bruno_mars_thats_what_i_like.mp3'
  },
  {
    artist: 'Coldplay',
    answer: 'VIVA LA VIDA',
    hint: 'Lagu legendaris Coldplay bernuansa orkestra tentang kejatuhan seorang raja',
    audioUrl: 'https://cdn.jsdelivr.net/gh/Bar1965/assets@main/audio/coldplay_viva_la_vida.mp3'
  }
];

function maskSongTitle(title) {
  return String(title || '').split('').map(char => {
    if (char === ' ') return '  ';
    if (/[A-Z0-9]/i.test(char)) return '_';
    return char;
  }).join(' ');
}


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
  const mentions = Array.isArray(options) ? options : (options.mentions || []);
  if (options && (options.buttons || options.sections)) {
    await sendInteractiveButtons(sock, jid, {
      text,
      title: options.title,
      footer: options.footer || 'Akbar Store Bot',
      buttons: options.buttons,
      sections: options.sections
    });
  } else {
    await sock.sendMessage(jid, { text, mentions: mentions.length > 0 ? mentions : undefined }, messageObj ? { quoted: messageObj } : undefined);
  }
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
    await db.addMessageXp(senderNumber, xpReward);
    
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

export async function handleFunCommand({ sock, jid, senderNumber, messageObj, text, args, cleanCmd, isFromGroup = false, isAdmin = false, isOwner = false, isPrefixCmd }) {
  const command = String(cleanCmd || '').toLowerCase();
  const scope = scopeKey(jid, senderNumber, isFromGroup);

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
      await db.addMessageXp(senderNumber, xpReward);
      
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
    'afk', 'rampok', 'curi', 'rob', 'ww', 'werewolf',
    'jawab', 'answer', 'hint',
    'quiz', 'trivia', 'tebakquiz', 'tebakemoji', 'emoji', 'tebakkata', 'hangman', 'kata',
    'tebaklagu', 'lagu', 'musicquiz', 'tebakmusik',
    'tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag',
    'truth', 'dare', 'tod', 'dadu', 'dice', 'coinflip', 'koin', 'coin',
    'sambungkata', 'wordchain', 'daily', 'harian', 'reward',
    'addpoint', 'addpoints', 'tambahpoin',
    'kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin',
    'transfer', 'kirimpoin', 'transferpoin',
    'poin', 'point', 'profile', 'level', 'me',
    'rank', 'leaderboard', 'top', 'misi', 'mission', 'challenge',
    'giveaway', 'setpoints', 'bagipoin', 'kompensasi',
    'badge', 'badges', 'achievement', 'achievements',
    'rekomendasi', 'recommend', 'saranproduk',
    'poll', 'voting', 'vote', 'love', 'jodoh', 'compatibility',
    'zodiak', 'zodiac', 'horoscope',
    'freegames', 'freegame', 'gamegratis', 'freegamestag',
    'slot', 'slots', 'judi',
    'torebot', 'tochipmunk', 'todeep', 'toecho',
    'tebakangka', 'tebak', 'spin', 'luckyspin',
    'suit', 'pilihsuit', 'cancelsuit', 'batalsuit',
    'tukar', 'pointshop', 'penukaran',
    'fun', 'game', 'games', 'hiburan'
  ];

  if (!knownFunCmds.includes(command)) {
    return false;
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

  // Heist / Rampok System
  if (['rampok', 'curi', 'rob'].includes(command)) {
    let targetNumber = '';
    const mentionRegex = /@([0-9]{10,15})/g;
    const mentions = [...text.matchAll(mentionRegex)].map(m => m[1] + '@s.whatsapp.net');
    
    if (mentions.length > 0) {
      targetNumber = mentions[0];
    } else if (messageObj?.message?.extendedTextMessage?.contextInfo?.participant) {
      targetNumber = messageObj.message.extendedTextMessage.contextInfo.participant;
    } else if (args[1]) {
      targetNumber = args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }

    await handleRampok(sock, jid, messageObj, senderNumber, targetNumber);
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


  const roundCommands = ['jawab', 'answer', 'hint'];
  if (roundCommands.includes(command)) {
    return await handleRoundCommand({ sock, jid, senderNumber, messageObj, args, cleanCmd: command, isFromGroup });
  }

  if (isFromGroup && ['quiz', 'trivia', 'tebakquiz', 'tebakemoji', 'emoji', 'tebakkata', 'hangman', 'kata', 'tebaklagu', 'tebakbendera', 'tebaknegara', 'bendera', 'negara', 'flag', 'sambungkata', 'wordchain', 'truth', 'dare', 'tod', 'dadu', 'dice', 'coinflip', 'koin', 'coin', 'poll', 'voting', 'vote', 'love', 'jodoh', 'compatibility', 'slot', 'daily', 'spin', 'luckyspin', 'suit', 'pilihsuit', 'cancelsuit', 'batalsuit', 'tebakangka', 'tebak', 'tukar', 'pointshop', 'penukaran'].includes(command)) {
    const groupSettings = await db.getGroupSettings(jid);
    if (groupSettings.bot_mode === 'sales') return false;
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
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : benefits.slotMaxBet;

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
      bet = Math.max(1, currentPoints);
    } else {
      const parsedBet = rawBet ? Number.parseInt(rawBet, 10) : 10;
      if (rawBet && (isNaN(parsedBet) || !isFinite(parsedBet) || parsedBet <= 0)) {
        await send(sock, jid, messageObj, `❌ Jumlah taruhan tidak valid: *${rawBet}*\n\nGunakan angka positif minimal 1 atau 'all'. Contoh: \`.dadu besar 50\` atau \`.dadu besar all\``);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, parsedBet || 10));
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
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : benefits.slotMaxBet;

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
      bet = Math.max(1, currentPoints);
    } else {
      const parsedBet = rawBet ? Number.parseInt(rawBet, 10) : 10;
      if (rawBet && (isNaN(parsedBet) || !isFinite(parsedBet) || parsedBet <= 0)) {
        await send(sock, jid, messageObj, `❌ Jumlah taruhan tidak valid: *${rawBet}*\n\nGunakan angka positif minimal 1 atau 'all'. Contoh: \`.coinflip heads 50\` atau \`.coinflip heads all\``);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, parsedBet || 10));
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
      const round = { type: 'wordchain', lastWord: starter, answer: '', expiresAt: Date.now() + ROUND_DURATION_MS };
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
    if (round.lastPlayer === senderNumber && isFromGroup) {
      await send(sock, jid, messageObj, `⚠️ Tunggu giliran member lain untuk menyambung kata selanjutnya!`);
      return true;
    }
    round.lastWord = word;
    round.lastPlayer = senderNumber;
    const profile = await db.awardGamePoints(senderNumber, 5, true);
    await send(sock, jid, messageObj, `✅ *${word}* diterima! Lanjutkan dengan kata berawalan *${word.slice(-1)}*.\n+5 poin untukmu. Total: *${profile.points}*`);
    return true;
  }

  if (['daily', 'hadian', 'reward'].includes(command)) {
    const today = new Date().toISOString().slice(0, 10);
    // Cek premium multiplier
    const premiumTier = await db.getPremiumTier(senderNumber);
    const benefits = getPremiumBenefits(premiumTier);
    const baseReward = 25;
    const finalReward = Math.floor(baseReward * benefits.dailyRewardMult);
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
    const bonusLabel = benefits.dailyRewardMult > 1 ? ` (${premiumTier} Bonus ${benefits.dailyRewardMult}x 🚀)` : '';
    const safeDailyPoints = Math.max(0, Math.floor(Number(result.profile?.points) || 0));
    await send(sock, jid, messageObj, `🎁 Hadiah harian berhasil diklaim: *+${result.reward} poin*${bonusLabel}\n🔥 Streak: *${result.streak} hari*\n💰 Total poin: *${safeDailyPoints}*`, {
      title: '🎁 HADIAH HARIAN TERKLAIM',
      buttons: [
        { type: 'reply', text: '🏆 Leaderboard', id: '.rank' },
        { type: 'reply', text: '👤 Profil Saya', id: '.poin' },
        { type: 'reply', text: '🛍️ Katalog Produk', id: '.produk' }
      ]
    });
    return true;
  }

  if (['addpoint', 'addpoints', 'tambahpoin'].includes(command)) {
    if (!isAdmin && !isOwner) {
      await send(sock, jid, messageObj, "❌ Perintah ini hanya dapat dijalankan oleh Admin atau Owner.");
      return true;
    }
    const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let targetJid = mentions[0];
    let amount = NaN;

    if (mentions.length > 0) {
      amount = parseInt(args[2], 10);
    } else {
      const arg1 = args[1]?.toLowerCase();
      const arg2 = args[2];

      if (arg1 === 'me' || arg1 === 'self' || arg1 === 'saya') {
        targetJid = senderNumber;
        amount = parseInt(arg2, 10);
      } else if (arg1 && arg2) {
        // Format: .addpoint nomor jumlah
        const cleanNum = arg1.replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) {
          targetJid = `${cleanNum}@s.whatsapp.net`;
        }
        amount = parseInt(arg2, 10);
      } else if (arg1 && !arg2) {
        // Format: .addpoint jumlah (auto-target diri sendiri)
        targetJid = senderNumber;
        amount = parseInt(arg1, 10);
      }
    }

    if (!targetJid || isNaN(amount)) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Salah!* Gunakan:\n▫️ `.addpoint [jumlah]` (untuk diri sendiri)\n▫️ `.addpoint @member [jumlah]` (tag orang)\n▫️ `.addpoint [nomor] [jumlah]` (ketik nomor)\n\n*Contoh:* `.addpoint 500` atau `.addpoint @628123456789 500`");
      return true;
    }

    try {
      const profile = await db.addGamePoints(targetJid, amount);
      const targetPhone = targetJid.split('@')[0];
      const targetCust = await db.getCustomerByPhone(targetJid);
      const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;
      await send(sock, jid, messageObj, `✅ Berhasil menambahkan *${amount} poin* ke ${targetLabel}.\n💰 Total Poin Sekarang: *${profile.points} poin*`, {
        mentions: [targetJid]
      });
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Gagal menambahkan poin: ${err.message}`);
    }
    return true;
  }

  // ─── OWNER ONLY: KURANGI POIN MEMBER LAIN (.kurangpoin / .delpoint) ───
  if (['kurangpoin', 'kurangipoin', 'delpoint', 'delpoints', 'deductpoint', 'potongpoin'].includes(command)) {
    if (!isOwner) {
      await send(sock, jid, messageObj, "❌ Fitur pengurangan poin ini khusus untuk Pemilik (Owner) bot.");
      return true;
    }
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

      if (arg1 === 'me' || arg1 === 'self' || arg1 === 'saya') {
        targetJid = senderNumber;
        amount = parseInt(arg2, 10);
      } else if (arg1 && arg2) {
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

    if (!targetJid || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Kurangi Poin (Khusus Owner):*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n▫️ `.kurangpoin @member [jumlah]` (tag orang)\n▫️ `.kurangpoin [nomor] [jumlah]` (ketik nomor)\n▫️ Balas/Quote pesan member lalu ketik `.kurangpoin [jumlah]`\n\n*Contoh:* `.kurangpoin @628123456789 500`");
      return true;
    }

    try {
      const currentProfile = await db.getGameProfile(targetJid);
      const safeCurrent = Math.max(0, currentProfile?.points || 0);
      const deductAmt = Math.min(safeCurrent, amount);
      await db.deductGamePoints(targetJid, deductAmt);
      
      const newProfile = await db.getGameProfile(targetJid);
      const targetPhone = targetJid.split('@')[0];
      const targetCust = await db.getCustomerByPhone(targetJid);
      const targetLabel = targetCust?.nama ? `*${targetCust.nama}* (@${targetPhone})` : `@${targetPhone}`;
      await send(sock, jid, messageObj, `✅ *Berhasil Mengurangi Poin!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Target: ${targetLabel}\n🔻 Poin Dikurangi: *${amount} poin*\n💰 Sisa Poin Sekarang: *${newProfile.points || 0} poin*`, {
        mentions: [targetJid]
      });
      await db.addLog('ADMIN', `Owner mengurangi ${amount} poin dari ${targetLabel}. Sisa: ${newProfile.points || 0}`);
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

    if (!targetJid || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "💸 *TRANSFER POIN GAME*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Format Perintah:*\n▫️ `.transfer @member [jumlah]` (tag orang)\n▫️ `.transfer [nomor] [jumlah]` (ketik nomor)\n▫️ Balas/Quote pesan member lalu ketik `.transfer [jumlah]`\n\n*Contoh:* `.transfer @628123456789 100`\n\n_Catatan: Dikenakan pajak transfer 1%._");
      return true;
    }

    if (targetJid === senderNumber) {
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

  if (['poin', 'point', 'profile', 'level', 'me', 'cekpoin'].includes(command)) {
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    let targetJid = mentions[0] || contextInfo?.participant;
    if (!targetJid && args[1]) {
      const cleanNum = args[1].replace(/[^0-9]/g, '');
      if (cleanNum.length > 5) targetJid = `${cleanNum}@s.whatsapp.net`;
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

  // ─── GIVEAWAY / SETPOINTS ALL ─────────────────────────────────
  if (['giveaway', 'setpoints', 'bagipoin', 'kompensasi'].includes(command)) {
    if (!isAdmin && !isOwner) {
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

    const isTagAllRequested = command === 'freegamestag' || args[1] === 'tag' || args[1] === 'tagall';

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

      const buttons = isFromGroup ? [{ type: 'reply', text: '📢 TagAll Group', id: '.freegames tag' }] : [];
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
    const maxBet = (isOwner || isAdmin) ? 1_000_000 : benefits.slotMaxBet;

    // Ambil profil & pastikan points tidak null/NaN
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    // Validasi input bet — mendukung input 'all' atau 'allin'
    const rawBetArg = args[1]?.toLowerCase();
    let bet = 10;
    if (rawBetArg === 'all' || rawBetArg === 'allin') {
      bet = Math.max(1, currentPoints);
    } else {
      const parsedBet = rawBetArg ? Number.parseInt(rawBetArg, 10) : 10;
      if (rawBetArg && (isNaN(parsedBet) || !isFinite(parsedBet))) {
        const displayMax = isFinite(maxBet) ? `${maxBet} poin` : 'Tanpa Batas';
        await send(sock, jid, messageObj, `❌ Format taruhan tidak valid: *${rawBetArg}*\n\nGunakan angka atau 'all'. Contoh: \`.slot 10\` atau \`.slot all\`\nMaksimal taruhan: *${displayMax}*`);
        return true;
      }
      bet = Math.max(1, Math.min(maxBet, Math.abs(parsedBet || 10)));
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

  // --- GAME: Tebak Angka Progresif ---
  if (command === 'tebakangka') {
    if (!isFromGroup) {
      await send(sock, jid, messageObj, "⚠️ Game Tebak Angka hanya dapat dimainkan di dalam Grup WhatsApp!");
      return true;
    }
    let game = tebakAngkaGames.get(jid);
    if (!game) {
      const secret = Math.floor(Math.random() * 100) + 1;
      game = { secret, pot: 200, guesses: 0 };
      tebakAngkaGames.set(jid, game);
      await send(sock, jid, messageObj, `🎮 *GAME TEBAK ANGKA DIMULAI!* 🎮\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nBot telah menentukan angka rahasia antara *1 s/d 100*.\n\n💰 Pot Jackpot Awal: *200 Poin*\n💸 Biaya Menebak: *10 Poin* per tebakan (akan ditambahkan langsung ke Pot Jackpot)\n\n👉 Ketik *.tebak [angka]* untuk mulai menebak!`);
    } else {
      await send(sock, jid, messageObj, `🎮 *GAME TEBAK ANGKA AKTIF* 🎮\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n💰 Pot Jackpot Saat Ini: *${game.pot} Poin*\n👥 Jumlah Tebakan: *${game.guesses} kali*\n\n👉 Ketik *.tebak [angka]* untuk menebak!`);
    }
    return true;
  }

  if (command === 'tebak') {
    if (!isFromGroup) {
      await send(sock, jid, messageObj, "⚠️ Game Tebak Angka hanya dapat dimainkan di dalam Grup WhatsApp!");
      return true;
    }
    const game = tebakAngkaGames.get(jid);
    if (!game) {
      await send(sock, jid, messageObj, "❌ Tidak ada game Tebak Angka yang sedang aktif di grup ini. Ketik *.tebakangka* untuk memulainya!");
      return true;
    }

    const guess = parseInt(args[1], 10);
    if (isNaN(guess) || guess < 1 || guess > 100) {
      await send(sock, jid, messageObj, "⚠️ Tebakan tidak valid! Masukkan angka antara *1 s/d 100*.\n\n*Contoh:* `.tebak 45`");
      return true;
    }

    const deductRes = await db.deductGamePoints(senderNumber, 10);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup! Kamu membutuhkan minimal *10 poin* untuk menebak (Poin kamu: *${deductRes.currentPoints || 0} poin*).`);
      return true;
    }

    game.pot += 10;
    game.guesses += 1;

    if (guess === game.secret) {
      const winPot = game.pot;
      const winnerProfile = await db.addGamePoints(senderNumber, winPot);
      const finalPoints = winnerProfile.points;
      tebakAngkaGames.delete(jid);
      
      const winnerName = messageObj.pushName || 'Player';
      await send(sock, jid, messageObj, `🎉 *JACKPOT!!! BENAR SEKALI!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👤 Pemenang: *@${senderNumber.split('@')[0]}* (${winnerName})\n🔢 Angka Rahasia: *${game.secret}*\n💰 Hadiah Jackpot: *+${winPot} Poin*\n📉 Total Tebakan Grup: *${game.guesses} kali*\n\nTotal poin kamu sekarang: *${finalPoints} poin* 🏆`, {
        mentions: [senderNumber]
      });
    } else {
      const diff = guess < game.secret ? "terlalu KECIL 📉" : "terlalu BESAR 📈";
      await send(sock, jid, messageObj, `❌ Tebakan *@${senderNumber.split('@')[0]}* (${guess}) *${diff}*!\n\n💰 Pot Jackpot bertambah menjadi: *${game.pot} Poin*`, {
        mentions: [senderNumber]
      });
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
      let isCoupon = false;
      let couponCode = "";

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
        isCoupon = true;
        winAmount = bet;
        outcome = "🎟️ *GRAND PRIZE: VOUCHER BELANJA!!!* 🎟️\n\nSelamat! Kamu memenangkan *Voucher Diskon Belanja 10%* secara GRATIS! Kode voucher belanja unik telah dikirimkan ke DM kamu. Silakan cek chat pribadi bot!";
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
      if (!isCoupon) {
        resultText += `💰 Perubahan Poin: *${winAmount >= bet ? '+' : ''}${winAmount - bet} Poin*\n`;
        resultText += `🏆 Sisa Poin Sekarang: *${newPoints} Poin*`;
      } else {
        resultText += `🏆 Poin Kamu Dikembalikan: *+${bet} Poin*`;
      }

      await sock.sendMessage(jid, { text: resultText, edit: spinMsg.key, mentions: [senderNumber] });

      if (isCoupon) {
        try {
          const rand = Math.floor(1000 + Math.random() * 9000);
          couponCode = `SPIN10-${rand}`;
          const expires = new Date();
          expires.setDate(expires.getDate() + 3); // 3 hari
          await db.addCoupon(couponCode, 'percent', 10, 20000, 1, expires.toISOString());

          const dmText = `🎟️ *VOUCHER DISKON WHEEL OF FORTUNE AKBAR STORE* 🎟️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Selamat! Kamu mendapatkan kupon diskon eksklusif dari memutar Lucky Spin:

👉 Kode Kupon: *${couponCode}*
📈 Diskon: *10%*
🛡️ Minimal Belanja: *Rp20.000*
⏳ Masa Berlaku: *3 Hari* (s/d ${expires.toLocaleDateString('id-ID')})

Gunakan kupon ini saat checkout belanja di bot dengan mengetik:
*.kupon ${couponCode}* sebelum melakukan tagihan pembayaran!`;

          await sock.sendMessage(senderNumber, { text: dmText });
        } catch (couponErr) {
          console.error("Gagal membuat kupon spin:", couponErr);
        }
      }
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
      const argUser = args.find(a => a.startsWith('@'));
      if (argUser) {
        const cleanNum = argUser.replace(/[^0-9]/g, '');
        targetJid = `${cleanNum}@s.whatsapp.net`;
      }
    }

    if (!targetJid || targetJid === senderNumber) {
      await send(sock, jid, messageObj, "⚠️ *Format Perintah Salah!* Gunakan:\n▫️ `.suit @member [taruhan]`\n\n*Contoh:* `.suit @628123456789 100` atau `.suit @628123456789 all`");
      return true;
    }

    if (targetJid === jidNormalizedUser(sock.user.id)) {
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

  // --- REWARD SHOP: Point Exchange ---
  if (command === 'tukar' || command === 'pointshop' || command === 'penukaran') {
    const option = parseInt(args[1], 10);
    const profile = await db.getGameProfile(senderNumber);
    const currentPoints = profile.points || 0;

    const exchangeRates = [
      { id: 1, name: "🎟️ Kupon Diskon Belanja 10%", cost: 2000, desc: "Potongan diskon 10% untuk transaksi produk (Min Belanja Rp20k, Maks Potongan Rp10k)." },
      { id: 2, name: "🥈 Status Premium Silver (3 Hari)", cost: 3000, desc: "Meningkatkan limit all-in game & bonus harian." },
      { id: 3, name: "🥇 Status Premium Gold (7 Hari)", cost: 6000, desc: "Meningkatkan bonus harian dan benefit premium lebih tinggi." },
      { id: 4, name: "💎 Status Premium Diamond (30 Hari)", cost: 20000, desc: "Akses premium benefit paling tinggi." }
    ];

    if (isNaN(option) || option < 1 || option > exchangeRates.length) {
      let shopText = `🛒 *POINT EXCHANGE / PENUKARAN REWARD* 🛒\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      shopText += `👤 Akun Kamu: *@${senderNumber.split('@')[0]}*\n`;
      shopText += `💰 Saldo Poin: *${currentPoints} Poin*\n\n`;
      shopText += `*Daftar Hadiah Yang Tersedia:*\n`;
      
      exchangeRates.forEach(r => {
        shopText += `*${r.id}. ${r.name}*\n`;
        shopText += `▫️ Harga: *${r.cost} Poin*\n`;
        shopText += `▫️ Deskripsi: ${r.desc}\n\n`;
      });

      shopText += `💡 *Cara Menukar:* Ketik \`.tukar [nomor]\`\n*Contoh:* \`.tukar 1\` untuk menukarkan kupon diskon.`;

      await send(sock, jid, messageObj, shopText, { mentions: [senderNumber] });
      return true;
    }

    const selected = exchangeRates[option - 1];
    const deductRes = await db.deductGamePoints(senderNumber, selected.cost);
    if (!deductRes.success) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi untuk menukar *${selected.name}* (Poin kamu: *${currentPoints} Poin*, Dibutuhkan: *${selected.cost} Poin*).`);
      return true;
    }

    try {


      if (option === 1) {
        const rand = Math.floor(10000 + Math.random() * 90000);
        const code = `SHOP10-${rand}`;
        const expires = new Date();
        expires.setDate(expires.getDate() + 7); // 7 hari
        await db.addCoupon(code, 'percent', 10, 20000, 1, expires.toISOString());

        const dmText = `🎟️ *KUPON BELANJA PENUKARAN POIN* 🎟️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Selamat! Kamu berhasil menukarkan ${selected.cost} poin dengan kupon belanja:

👉 Kode Kupon: *${code}*
📈 Diskon: *10%*
🛡️ Minimal Belanja: *Rp20.000*
⏳ Masa Berlaku: *7 Hari* (s/d ${expires.toLocaleDateString('id-ID')})

Gunakan kupon ini saat checkout belanja di bot dengan mengetik:
*.kupon ${code}* sebelum melakukan tagihan pembayaran!`;

        await sock.sendMessage(senderNumber, { text: dmText });
        await send(sock, jid, messageObj, `✅ Penukaran berhasil! Kode Kupon Belanja unik diskon 10% telah dikirimkan secara pribadi ke DM kamu. Silakan periksa!`);

      } else {
        let tier = "Silver";
        let days = 3;
        if (option === 3) {
          tier = "Gold";
          days = 7;
        } else if (option === 4) {
          tier = "Diamond";
          days = 30;
        }

        const res = await db.grantPremium(senderNumber, tier, days, 'POINT_SHOP');
        await send(sock, jid, messageObj, `✅ *PENUKARAN BERHASIL!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nSelamat, akun kamu berhasil ditingkatkan menjadi *Premium ${tier}* selama *${days} hari*!\n\n📅 Berlaku s/d: *${new Date(res.expiresAt).toLocaleDateString('id-ID')}*\n💰 Sisa Poin Sekarang: *${currentPoints - selected.cost} Poin*`);
      }
    } catch (err) {
      await send(sock, jid, messageObj, `❌ Terjadi kesalahan saat melakukan penukaran: ${err.message}`);
    }
    return true;
  }

  if (['fun', 'game', 'games', 'hiburan'].includes(command) && args.length === 1) {
    await send(sock, jid, messageObj, '🎮 *MENU HIBURAN*\n\n.freegames · .slot · .zodiak · .jodoh\n.quiz · .tebakemoji · .tebakkata\n.jawab · .hint · .sambungkata\n.truth · .dare · .dadu · .coinflip\n.torebot · .tochipmunk · .todeep\n.daily · .poin · .rank · .misi\n.poll · .love\n\nKetik `.menu hiburan` untuk panduan lengkap.');
    return true;
  }

  return false;
}

export async function triggerAutoQuiz(sock, jid) {
  const types = ['quiz', 'tebakemoji', 'word'];
  const type = types[Math.floor(Math.random() * types.length)];
  return startRound({ sock, jid, senderNumber: 'SYSTEM', messageObj: null, isFromGroup: true, type });
}

export async function handleRampok(sock, jid, m, senderNumber, targetNumber) {
  if (!targetNumber) {
    await send(sock, jid, m, "⚠️ *Format Salah*\nBalas (reply) pesan target atau tag orangnya!\n_Contoh: .rampok @user_");
    return true;
  }

  if (senderNumber === targetNumber) {
    await send(sock, jid, m, "⚠️ Kamu tidak bisa merampok dirimu sendiri!");
    return true;
  }

  const isTargetReg = await db.isCustomerRegistered(targetNumber);
  if (!isTargetReg) {
    await send(sock, jid, m, "❌ Target belum terdaftar di database (guest).");
    return true;
  }

  const now = Date.now();
  const immExpires = victimImmunity.get(targetNumber) || 0;
  if (now < immExpires) {
    const sisaMenit = Math.ceil((immExpires - now) / 60000);
    await send(sock, jid, m, `🛡️ *GAGAL!*\nTarget sedang dilindungi oleh Polisi (Immunity) selama ${sisaMenit} menit ke depan.`);
    return true;
  }

  const cdExpires = rampokCooldowns.get(senderNumber) || 0;
  if (now < cdExpires) {
    const sisaMenit = Math.ceil((cdExpires - now) / 60000);
    await send(sock, jid, m, `🚨 *BURONAN!*\nKamu sedang dalam masa buron. Sembunyi dulu selama ${sisaMenit} menit sebelum merampok lagi.`);
    return true;
  }

  const profilePerampok = await db.getGameProfile(senderNumber);
  const profileKorban = await db.getGameProfile(targetNumber);

  if (!profilePerampok || profilePerampok.points < 500) {
    await send(sock, jid, m, "❌ Modal kamu kurang! Kamu butuh minimal *500 Poin* sebagai modal jaminan penalti jika tertangkap.");
    return true;
  }

  if (!profileKorban || profileKorban.points < 1000) {
    await send(sock, jid, m, "❌ Gagal merampok! Target terlalu miskin (Poin < 1000). Jangan mem-bully rakyat jelata!");
    return true;
  }

  // 40% chance of success
  const isSuccess = Math.random() < 0.40;

  // Set Cooldown (2 hours) & Immunity (4 hours)
  rampokCooldowns.set(senderNumber, now + (2 * 60 * 60 * 1000));
  victimImmunity.set(targetNumber, now + (4 * 60 * 60 * 1000));

  if (isSuccess) {
    const percentStolen = Math.floor(Math.random() * 11) + 10; // 10% to 20%
    const amountStolen = Math.floor((profileKorban.points * percentStolen) / 100);

    const deductRes = await db.deductGamePoints(targetNumber, amountStolen);
    if (!deductRes.success) {
       await send(sock, jid, m, "❌ Terjadi kesalahan pada brankas target (Transaksi gagal).");
       return true;
    }
    await db.addGamePoints(senderNumber, amountStolen);

    await sock.sendMessage(jid, {
        text: `🥷 *PERAMPOKAN BERHASIL!*\n\nKamu berhasil menyelinap dan mencuri *${amountStolen} Poin* (${percentStolen}%) dari brankas @${targetNumber.split('@')[0]}!\n\n💰 Saldo kamu sekarang: *${profilePerampok.points + amountStolen} Poin*\n⏳ Kamu buron selama 2 jam.`,
        mentions: [targetNumber]
    }, { quoted: m });
  } else {
    // Failed: 30% penalty
    const denda = Math.floor((profilePerampok.points * 30) / 100);
    const kompensasi = Math.floor(denda / 2);

    const deductRes = await db.deductGamePoints(senderNumber, denda);
    if (!deductRes.success) {
        await send(sock, jid, m, "❌ Terjadi kesalahan sistem saat menjatuhkan denda.");
        return true;
    }
    await db.addGamePoints(targetNumber, kompensasi);

    await sock.sendMessage(jid, {
        text: `🚨 *TERTANGKAP POLISI!*\n\nAksi kamu ketahuan! Polisi menyita *${denda} Poin* (30%) dari dompetmu sebagai denda.\n\nSebagai kompensasi kaget, @${targetNumber.split('@')[0]} mendapatkan perlindungan polisi selama 4 jam dan *${kompensasi} Poin* dari uang dendamu.\n\n💸 Saldo kamu sekarang: *${profilePerampok.points - denda} Poin*`,
        mentions: [targetNumber]
    }, { quoted: m });
  }
  return true;
}

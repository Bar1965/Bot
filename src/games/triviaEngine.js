import * as db from '../../database.js';
import { send, randomItem, normalizeAnswer, scopeKey } from './helpers.js';

export const activeRounds = new Map();
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
import * as db from '../../database.js';
import { send, normalizeAnswer, randomItem } from './helpers.js';

export const activeQuizTournaments = new Map();
const QUESTION_TIMEOUT_MS = 25 * 1000;

const TOURNAMENT_QUESTIONS = [
  { question: "Apa nama mata uang resmi negara Jepang?", answer: "YEN", hint: "Diawali huruf Y (3 huruf)" },
  { question: "Siapakah penemu bola lampu pijar modern?", answer: "THOMAS ALVA EDISON", alias: ["THOMAS EDISON", "EDISON"], hint: "Nama depannya Thomas" },
  { question: "Organ tubuh manusia yang berfungsi memompa darah ke seluruh tubuh adalah?", answer: "JANTUNG", hint: "Terletak di rongga dada sebelah kiri" },
  { question: "Pulau terbesar di Indonesia (dan terbagi 3 negara) adalah?", answer: "KALIMANTAN", alias: ["BORNEO"], hint: "Pulau yang memiliki hutan tropis luas" },
  { question: "Berapa hasil dari 15 dikali 8?", answer: "120", hint: "Seratus dua puluh" },
  { question: "Hewan mamalia terbesar yang hidup di muka bumi adalah?", answer: "PAUS BIRU", alias: ["PAUS"], hint: "Hidup di samudera luas" },
  { question: "Gas yang paling banyak terkandung di dalam atmosfer bumi adalah?", answer: "NITROGEN", hint: "Unsur dengan simbol N (sekitar 78%)" },
  { question: "Ibukota dari negara Australia adalah?", answer: "CANBERRA", hint: "Bukan Sydney atau Melbourne, diawali huruf C" },
  { question: "Candi Borobudur terletak di provinsi mana?", answer: "JAWA TENGAH", hint: "Provinsi di tengah pulau Jawa" },
  { question: "Berapakah jumlah kaki pada seekor laba-laba?", answer: "8", alias: ["DELAPAN"], hint: "Termasuk arachnida (bukan 6)" },
  { question: "Zat hijau daun pada tumbuhan yang berfungsi untuk fotosintesis disebut?", answer: "KLOROFIL", hint: "Diawali huruf K (8 huruf)" },
  { question: "Siapa presiden pertama Republik Indonesia?", answer: "SOEKARNO", alias: ["SUKARNO", "IR SOEKARNO"], hint: "Bung Karno" },
  { question: "Planet terdekat dari matahari dalam tata surya adalah?", answer: "MERKURIUS", hint: "Diawali huruf M" },
  { question: "Alat pengukur gempa bumi dinamakan?", answer: "SEISMOGRAF", alias: ["SEISMOMETER"], hint: "Diawali huruf S" },
  { question: "Lagu kebangsaan Indonesia Raya diciptakan oleh?", answer: "WR SUPRATMAN", alias: ["WAGE RUDOLF SUPRATMAN", "W R SUPRATMAN"], hint: "Pahlawan nasional berinisial WR" }
];

export async function handleQuizTournament(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Turnamen Cerdas Cermat hanya bisa dimainkan di dalam grup!");
    return true;
  }

  const subCmd = (args[1] || '').toLowerCase();

  if (['join', 'ikut'].includes(subCmd) || command === 'joincerdascermat') {
    return await joinQuizTournamentLobby(sock, jid, senderNumber, messageObj);
  }

  if (['start', 'mulai', 'startgame'].includes(subCmd) || command === 'startcerdascermat') {
    return await startQuizTournamentGame(sock, jid, senderNumber, messageObj);
  }

  if (['cancel', 'batal'].includes(subCmd)) {
    const session = activeQuizTournaments.get(jid);
    if (!session) {
      await send(sock, jid, messageObj, "❌ Tidak ada turnamen kuis aktif di grup ini.");
      return true;
    }
    if (session.host !== senderNumber) {
      await send(sock, jid, messageObj, "❌ Hanya host pembuat lobi yang dapat membatalkan turnamen!");
      return true;
    }
    if (session.timeout) clearTimeout(session.timeout);
    activeQuizTournaments.delete(jid);
    await send(sock, jid, messageObj, "🛑 Turnamen Cerdas Cermat berhasil dibatalkan.");
    return true;
  }

  if (activeQuizTournaments.has(jid)) {
    const s = activeQuizTournaments.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sedang ada lobi Cerdas Cermat aktif di grup ini!\n👥 Peserta (${s.players.length}/10): ${s.playerLabels.join(', ')}\n\nKetik \`.joincerdascermat\` untuk bergabung atau \`.startcerdascermat\` untuk mulai!`);
    } else {
      await send(sock, jid, messageObj, `⚠️ Turnamen Cerdas Cermat sedang berlangsung di grup ini!`);
    }
    return true;
  }

  const buyIn = parseInt(args[1], 10) || 30;
  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Modal poin kamu kurang! Butuh tiket minimal *${buyIn} Poin* untuk membuka turnamen.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const hostLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  const session = {
    jid,
    host: senderNumber,
    buyIn,
    status: 'LOBBY',
    roundNumber: 0,
    players: [senderNumber],
    playerLabels: [hostLabel],
    playerLives: new Map(), // jid -> lives (2)
    roundSafePlayers: new Set(),
    currentQuestion: null,
    usedQuestions: new Set(),
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    if (!activeQuizTournaments.has(jid)) return;
    const cur = activeQuizTournaments.get(jid);
    if (cur.status === 'LOBBY') {
      activeQuizTournaments.delete(jid);
      await send(sock, jid, messageObj, `⌛ *LOBI CERDAS CERMAT KEDALUWARSA!* Turnamen dibatalkan karena tidak dimulai dalam 90 detik.`);
    }
  }, 90 * 1000);

  activeQuizTournaments.set(jid, session);

  const lobbyMsg = 
`🧠 *TURNAMEN BATTLE ROYALE CERDAS CERMAT* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 Host: ${hostLabel}
👥 Peserta (1/10): ${hostLabel}
💰 Tiket Masuk: *${buyIn} Poin* / orang
❤️ Nyawa Tiap Peserta: *2 Nyawa (❤️❤️)*

📌 *Aturan Pertandingan:*
• Sistem eliminasi gugur (Knockout).
• Tiap ronde ada 1 pertanyaan dengan batas waktu 25 detik.
• Yang salah / tidak menjawab kehilangan 1 nyawa (💔).
• Pemain terakhir yang bertahan membawa pulang seluruh Total Prizepool!

👉 Ketik \`.joincerdascermat\` untuk mendaftar!
🚀 Host ketik \`.startcerdascermat\` jika sudah siap (Minimal 2 peserta).`;

  await send(sock, jid, messageObj, lobbyMsg, { mentions: [senderNumber] });
  return true;
}

async function joinQuizTournamentLobby(sock, jid, senderNumber, messageObj) {
  const session = activeQuizTournaments.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Tidak ada lobi Cerdas Cermat aktif. Ketik `.cerdascermat [tiket]` untuk membuka turnamen baru!");
    return true;
  }

  if (session.players.includes(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sudah terdaftar di dalam turnamen ini!");
    return true;
  }

  if (session.players.length >= 10) {
    await send(sock, jid, messageObj, "❌ Kuota turnamen sudah penuh (Maksimal 10 peserta)!");
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < session.buyIn) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membayar tiket masuk *${session.buyIn} Poin*!`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const userLabel = cust?.nama ? `*${cust.nama}* (@${senderNumber.split('@')[0]})` : `@${senderNumber.split('@')[0]}`;

  session.players.push(senderNumber);
  session.playerLabels.push(userLabel);

  await send(sock, jid, messageObj, `✅ ${userLabel} berhasil membeli tiket turnamen Cerdas Cermat!\n👥 Total Peserta (${session.players.length}/10): ${session.playerLabels.join(', ')}\n\nKetik \`.startcerdascermat\` untuk memulai!`, { mentions: session.players });
  return true;
}

async function startQuizTournamentGame(sock, jid, senderNumber, messageObj) {
  const session = activeQuizTournaments.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.length < 2) {
    await send(sock, jid, messageObj, "❌ Butuh minimal *2 peserta* untuk memulai turnamen!");
    return true;
  }

  if (session.timeout) clearTimeout(session.timeout);

  for (const p of session.players) {
    await db.deductGamePoints(p, session.buyIn);
    session.playerLives.set(p, 2);
  }

  const totalPrize = session.buyIn * session.players.length;

  const startMsg = 
`🏁 *TURNAMEN CERDAS CERMAT RESMI DIMULAI!* 🏁
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 Total Peserta: *${session.players.length} Orang*
💰 Prizepool Juara: *${totalPrize.toLocaleString('id-ID')} Poin*
❤️ Status Awal: Seluruh peserta memiliki *2 Nyawa (❤️❤️)*

Bersiaplah! Pertanyaan Ronde 1 akan muncul dalam 3 detik...`;

  await send(sock, jid, messageObj, startMsg, { mentions: session.players });

  setTimeout(async () => {
    await nextTournamentRound(sock, jid, messageObj);
  }, 3000);

  return true;
}

async function nextTournamentRound(sock, jid, messageObj) {
  const session = activeQuizTournaments.get(jid);
  if (!session) return;

  session.roundNumber++;
  session.status = 'ROUND_ACTIVE';
  session.roundSafePlayers.clear();

  // Ambil pertanyaan yang belum dipakai
  const availableQ = TOURNAMENT_QUESTIONS.filter((_, idx) => !session.usedQuestions.has(idx));
  const qIndex = availableQ.length > 0 
    ? TOURNAMENT_QUESTIONS.indexOf(availableQ[Math.floor(Math.random() * availableQ.length)])
    : Math.floor(Math.random() * TOURNAMENT_QUESTIONS.length);

  session.usedQuestions.add(qIndex);
  const q = TOURNAMENT_QUESTIONS[qIndex];
  session.currentQuestion = q;

  const alivePlayers = session.players.filter(p => (session.playerLives.get(p) || 0) > 0);

  let scoreboard = `🏆 *CERDAS CERMAT — RONDE ${session.roundNumber}* 🧠\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  alivePlayers.forEach(p => {
    const lives = session.playerLives.get(p) || 0;
    const hearts = '❤️'.repeat(lives);
    scoreboard += `▫️ @${p.split('@')[0]}: [ ${hearts} ]\n`;
  });

  scoreboard += `\n❓ *Pertanyaan:*
${q.question}

💡 *Petunjuk:* ${q.hint}
⏳ *Waktu Menjawab:* 25 Detik
👉 *Ketik jawabanmu langsung di chat!*`;

  session.timeout = setTimeout(async () => {
    if (!activeQuizTournaments.has(jid)) return;
    const cur = activeQuizTournaments.get(jid);
    if (cur.status === 'ROUND_ACTIVE') {
      await endTournamentRound(sock, jid, messageObj);
    }
  }, QUESTION_TIMEOUT_MS);

  await send(sock, jid, messageObj, scoreboard, { mentions: alivePlayers });
}

export async function handleTournamentAnswer(sock, jid, senderNumber, messageObj, text) {
  const session = activeQuizTournaments.get(jid);
  if (!session || session.status !== 'ROUND_ACTIVE') return false;

  const lives = session.playerLives.get(senderNumber) || 0;
  if (lives <= 0) return false;

  if (session.roundSafePlayers.has(senderNumber)) {
    return false; // Sudah aman di ronde ini
  }

  const submitted = normalizeAnswer(text);
  const q = session.currentQuestion;
  if (!q) return false;

  const isMatch = (q.alias && Array.isArray(q.alias))
    ? q.alias.some(a => normalizeAnswer(a) === submitted)
    : (submitted === normalizeAnswer(q.answer));

  if (isMatch) {
    session.roundSafePlayers.add(senderNumber);
    const aliveCount = session.players.filter(p => (session.playerLives.get(p) || 0) > 0).length;

    await send(sock, jid, messageObj, `✅ @${senderNumber.split('@')[0]} berhasil menjawab dengan benar dan *AMAN* di ronde ini! (${session.roundSafePlayers.size}/${aliveCount} aman)`, { mentions: [senderNumber] });

    if (session.roundSafePlayers.size >= aliveCount) {
      if (session.timeout) clearTimeout(session.timeout);
      await endTournamentRound(sock, jid, messageObj);
    }
    return true;
  }
  return false;
}

async function endTournamentRound(sock, jid, messageObj) {
  const session = activeQuizTournaments.get(jid);
  if (!session) return;

  session.status = 'ROUND_RESULT';
  const q = session.currentQuestion;

  let report = `⏰ *WAKTU RONDE ${session.roundNumber} HABIS!* ⏰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Jawaban yang Benar: *${q.answer}*\n\n📊 *Evaluasi Nyawa Peserta:*\n`;

  const aliveBefore = session.players.filter(p => (session.playerLives.get(p) || 0) > 0);

  for (const p of aliveBefore) {
    const isSafe = session.roundSafePlayers.has(p);
    let curLives = session.playerLives.get(p) || 0;
    if (!isSafe) {
      curLives -= 1;
      session.playerLives.set(p, curLives);
      report += `💔 @${p.split('@')[0]} (Salah/Tidak menjawab ➔ Sisa ${curLives > 0 ? '❤️'.repeat(curLives) : '☠️ GUGUR'})\n`;
    } else {
      report += `✨ @${p.split('@')[0]} (Aman ➔ ${'❤️'.repeat(curLives)})\n`;
    }
  }

  const aliveAfter = session.players.filter(p => (session.playerLives.get(p) || 0) > 0);
  const totalPrize = session.buyIn * session.players.length;

  if (aliveAfter.length === 1) {
    // 🏆 JUARA TUNGGAL DITEMUKAN!
    const winner = aliveAfter[0];
    await db.addGamePoints(winner, totalPrize);
    await db.grantXp(winner, 100);

    const winMsg = report + `\n👑 *SELAMAT KEPADA JUARA TURNAMEN!* 🏆\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎉 Pemenang: *@${winner.split('@')[0]}*\n💰 Hadiah Juara: *+${totalPrize.toLocaleString('id-ID')} Poin* & *+100 XP*!\n\n_Piala turnamen resmi ditutup! Ketik .cerdascermat untuk turnamen baru._`;

    activeQuizTournaments.delete(jid);
    await send(sock, jid, messageObj, winMsg, { mentions: [winner] });
    return;
  }

  if (aliveAfter.length === 0) {
    // Seluruh pemain gugur bersamaan di ronde yang sama ➔ Bagi rata ke yang gugur di ronde ini
    const splitPrize = Math.floor(totalPrize / aliveBefore.length);
    for (const p of aliveBefore) {
      await db.addGamePoints(p, splitPrize);
      await db.grantXp(p, 40);
    }

    const drawMsg = report + `\n⚖️ *SEMUA PESERTA GUGUR BERSAMAAN!* ⚖️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nHadiah prizepool dibagi rata ke peserta ronde terakhir (*+${splitPrize} Poin* tiap orang).\n\n_Turnamen berakhir seri._`;

    activeQuizTournaments.delete(jid);
    await send(sock, jid, messageObj, drawMsg, { mentions: aliveBefore });
    return;
  }

  // Masih ada > 1 pemain yang bertahan ➔ Masuk ronde berikutnya
  report += `\n⚔️ *${aliveAfter.length} Peserta Bertahan!* Ronde selanjutnya dimulai dalam 4 detik...`;
  await send(sock, jid, messageObj, report, { mentions: session.players });

  setTimeout(async () => {
    await nextTournamentRound(sock, jid, messageObj);
  }, 4000);
}

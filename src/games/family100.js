import * as db from '../../database.js';
import { send } from './helpers.js';
import { scopeKey, normalizeAnswer } from './helpers.js';

export const activeFamily100 = new Map();
export const activeCakLontong = new Map();


const family100Questions = [
  {
    question: "Apa yang biasa dicari orang saat mati lampu?",
    answers: [
      { name: "Lilin", score: 35, aliases: ["LILIN"] },
      { name: "Senter", score: 25, aliases: ["SENTER", "FLASHLIGHT"] },
      { name: "Korek Api", score: 20, aliases: ["KOREK", "KOREK API", "MATCHES"] },
      { name: "HP / Ponsel", score: 15, aliases: ["HP", "PONSEL", "HANDPHONE", "SMARTPHONE"] },
      { name: "Kipas", score: 5, aliases: ["KIPAS", "KIPAS ANGIN"] }
    ]
  },
  {
    question: "Sebutkan makanan khas Indonesia yang populer!",
    answers: [
      { name: "Nasi Goreng", score: 35, aliases: ["NASI GORENG", "NASGOR"] },
      { name: "Rendang", score: 25, aliases: ["RENDANG"] },
      { name: "Sate", score: 20, aliases: ["SATE", "SATE AYAM", "SATE KAMBING"] },
      { name: "Bakso", score: 15, aliases: ["BAKSO", "BASO"] },
      { name: "Soto", score: 5, aliases: ["SOTO", "SOTO AYAM"] }
    ]
  },
  {
    question: "Benda apa yang selalu dibawa saat bepergian?",
    answers: [
      { name: "HP / Ponsel", score: 35, aliases: ["HP", "PONSEL", "HANDPHONE"] },
      { name: "Dompet", score: 30, aliases: ["DOMPET", "WALLET"] },
      { name: "Kunci", score: 15, aliases: ["KUNCI", "KUNCI MOTOR", "KUNCI RUMAH"] },
      { name: "Uang", score: 10, aliases: ["UANG", "DUIT"] },
      { name: "KTP / Identitas", score: 10, aliases: ["KTP", "IDENTITAS", "SIM"] }
    ]
  },
  {
    question: "Aktivitas apa yang biasa dilakukan di pantai?",
    answers: [
      { name: "Berenang", score: 35, aliases: ["BERENANG", "RENANG", "MAIN AIR"] },
      { name: "Foto-foto", score: 25, aliases: ["FOTO", "FOTO FOTO", "SELFIE"] },
      { name: "Main Pasir", score: 20, aliases: ["MAIN PASIR", "PASIR"] },
      { name: "Melihat Sunset", score: 15, aliases: ["SUNSET", "LIHAT SUNSET", "MATAHARI TERBENAM"] },
      { name: "Makan / Minum Kelapa", score: 5, aliases: ["MINUM KELAPA", "KELAPA", "KELAPA MUDA", "MAKAN KELAPA"] }
    ]
  },
  {
    question: "Hewan apa yang sering dijadikan peliharaan di rumah?",
    answers: [
      { name: "Kucing", score: 40, aliases: ["KUCING", "CAT"] },
      { name: "Anjing", score: 30, aliases: ["ANJING", "DOG"] },
      { name: "Ikan", score: 15, aliases: ["IKAN", "FISH"] },
      { name: "Burung", score: 10, aliases: ["BURUNG", "BIRD"] },
      { name: "Hamster", score: 5, aliases: ["HAMSTER", "KELINCI"] }
    ]
  },
  {
    question: "Apa yang biasa dilakukan orang saat bangun tidur di pagi hari?",
    answers: [
      { name: "Cek HP", score: 40, aliases: ["CEK HP", "LIHAT HP", "MAIN HP", "HP"] },
      { name: "Minum Air", score: 25, aliases: ["MINUM", "MINUM AIR", "MINUM AIR PUTIH"] },
      { name: "Mandi", score: 15, aliases: ["MANDI"] },
      { name: "Cuci Muka", score: 10, aliases: ["CUCI MUKA", "GOSOK GIGI"] },
      { name: "Tidur Lagi", score: 10, aliases: ["TIDUR LAGI", "REBAHAN", "MEREM LAGI"] }
    ]
  }
];

const cakLontongQuestions = [
  {
    question: "Makan di piring menggunakan...",
    clue: "P _ N _ E K",
    answer: "PENDEK",
    reason: "Kalau sendoknya kepanjangan susah nyuapnya ke mulut.",
    aliases: ["PENDEK"]
  },
  {
    question: "Sebelum dioperasi, dokter biasanya...",
    clue: "M _ N _ N _ G _ U",
    answer: "MENUNGGU",
    reason: "Menunggu pasiennya siap dan sadar di ruang operasi.",
    aliases: ["MENUNGGU"]
  },
  {
    question: "Burung bisa terbang karena memiliki...",
    clue: "B _ K _ T",
    answer: "BAKAT",
    reason: "Kalau burungnya gak berbakat terbang, ya jalan kaki kayak penguin.",
    aliases: ["BAKAT"]
  },
  {
    question: "Orang menyeberang jalan saat lampu lalu lintas...",
    clue: "N _ A _ A",
    answer: "NYALA",
    reason: "Kalau lampunya mati ya gelap, gak kelihatan menyeberangnya.",
    aliases: ["NYALA"]
  },
  {
    question: "Supaya bersih, lantai harus di...",
    clue: "S _ P _",
    answer: "SAPU",
    reason: "Ya emang disapu, masa dimakan.",
    aliases: ["SAPU", "DI SAPU", "DISAPU"]
  },
  {
    question: "Banteng warna merah takut sama...",
    clue: "B _ Y _ N _ N _ A",
    answer: "BAYANGANNYA",
    reason: "Bayangan sendiri aja gede serem, apalagi banteng.",
    aliases: ["BAYANGANNYA", "BAYANGAN"]
  },
  {
    question: "Orang yang bekerja membantu dokter di rumah sakit adalah...",
    clue: "P _ S _ E N",
    answer: "PASIEN",
    reason: "Kalau gak ada pasien, dokternya gak ada kerjaan kan?",
    aliases: ["PASIEN"]
  },
  {
    question: "Matahari terbit dari sebelah...",
    clue: "L _ A _",
    answer: "LUAR",
    reason: "Matahari terbitnya dari luar angkasa, bukan dari dalam rumah.",
    aliases: ["LUAR"]
  },
  {
    question: "Kucing kalau tidur biasanya...",
    clue: "M _ R _ M",
    answer: "MEREM",
    reason: "Masa tidur sambil melek, serem dong.",
    aliases: ["MEREM"]
  },
  {
    question: "Ketika hujan lebat turun, jalanan menjadi...",
    clue: "B _ S _ H",
    answer: "BASAH",
    reason: "Ya basah kena air hujan.",
    aliases: ["BASAH"]
  },
  {
    question: "Sepeda motor bisa jalan karena ada...",
    clue: "R _ D _",
    answer: "RODA",
    reason: "Kalau rodanya kotak gak bisa jalan.",
    aliases: ["RODA"]
  },
  {
    question: "Kalau kita lapar, biasanya kita...",
    clue: "K _ R _ N _",
    answer: "KURANG",
    reason: "Kurang makan, makanya lapar.",
    aliases: ["KURANG"]
  },
  {
    question: "Orang memancing biasanya duduk di...",
    clue: "D _ K _ T",
    answer: "DEKAT",
    reason: "Kalau jauh-jauh ya ga nyampe kailnya ke air.",
    aliases: ["DEKAT"]
  }
];

// ─── 1. FAMILY 100 SYSTEM ────────────────────────────────────
function renderFamily100Board(session) {
  let text = `👪 *FAMILY 100 INDONESIA* 👪\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 Soal: *${session.question}*\n\n`;
  session.answers.forEach((ans, idx) => {
    if (ans.revealed) {
      text += `${idx + 1}. *${ans.name}* [${ans.score} Poin] — (Dijawab oleh ${ans.solverTag})\n`;
    } else {
      text += `${idx + 1}. [ ? ? ? ? ? ? ? ? ] [${ans.score} Poin]\n`;
    }
  });
  text += `\n💬 *Ketik jawabanmu langsung di grup!*\n⏰ Sisa waktu: ${Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000))} detik`;
  return text;
}

async function startFamily100(sock, jid, senderNumber, messageObj, isFromGroup) {
  const scope = scopeKey(jid, senderNumber, isFromGroup);
  if (activeFamily100.has(scope)) {
    const session = activeFamily100.get(scope);
    await send(sock, jid, messageObj, renderFamily100Board(session));
    return true;
  }

  const q = family100Questions[Math.floor(Math.random() * family100Questions.length)];
  const answers = q.answers.map(a => ({
    name: a.name,
    score: a.score,
    aliases: a.aliases,
    revealed: false,
    solver: null,
    solverTag: null
  }));

  const session = {
    jid,
    question: q.question,
    answers,
    scores: new Map(),
    expiresAt: Date.now() + 3 * 60 * 1000,
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    if (!activeFamily100.has(scope)) return;
    activeFamily100.delete(scope);
    let endMsg = `⏰ *WAKTU FAMILY 100 HABIS!* ⏰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 Soal: *${session.question}*\n\n*Kunci Jawaban Lengkap:*\n`;
    session.answers.forEach((a, i) => {
      endMsg += `${i + 1}. ${a.name} [${a.score} Poin] ${a.revealed ? `(✅ ${a.solverTag})` : '❌'}\n`;
    });
    await send(sock, jid, messageObj, endMsg);
  }, 3 * 60 * 1000);

  activeFamily100.set(scope, session);
  await send(sock, jid, messageObj, renderFamily100Board(session));
  return true;
}

async function handleFamily100Answer(sock, jid, messageObj, senderNumber, text, scope) {
  const session = activeFamily100.get(scope);
  if (!session) return false;

  const cleanAns = normalizeAnswer(text);
  if (!cleanAns) return false;

  const foundIndex = session.answers.findIndex(a => !a.revealed && a.aliases.some(alias => normalizeAnswer(alias) === cleanAns));
  if (foundIndex === -1) return false;

  const ans = session.answers[foundIndex];
  ans.revealed = true;
  const senderPhone = senderNumber.split('@')[0];
  const cust = await db.getCustomerByPhone(senderNumber);
  const userTag = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;
  ans.solver = senderNumber;
  ans.solverTag = userTag;

  await db.awardGamePoints(senderNumber, ans.score, true);
  await db.addMessageXp(senderNumber, 25);

  const curScore = session.scores.get(senderNumber) || 0;
  session.scores.set(senderNumber, curScore + ans.score);

  const allRevealed = session.answers.every(a => a.revealed);
  if (allRevealed) {
    if (session.timeout) clearTimeout(session.timeout);
    activeFamily100.delete(scope);

    let winMsg = `🎉 *SEMUA JAWABAN FAMILY 100 TERTEBAK!* 🏆\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 Soal: *${session.question}*\n\n`;
    session.answers.forEach((a, i) => {
      winMsg += `${i + 1}. *${a.name}* [${a.score} Poin] — ${a.solverTag}\n`;
    });
    winMsg += `\n👏 Selamat kepada semua penjawab! Poin telah ditambahkan ke profil game kalian.`;
    await send(sock, jid, messageObj, winMsg, { mentions: Array.from(session.scores.keys()) });
    return true;
  } else {
    await send(sock, jid, messageObj, `✅ *JAWABAN BENAR!* (+${ans.score} Poin)\n\n${renderFamily100Board(session)}`, { mentions: [senderNumber] });
    return true;
  }
}

// ─── 2. TEKA-TEKI CAK LONTONG ─────────────────────────────────
async function startCakLontong(sock, jid, senderNumber, messageObj, isFromGroup) {
  const scope = scopeKey(jid, senderNumber, isFromGroup);
  if (activeCakLontong.has(scope)) {
    const cur = activeCakLontong.get(scope);
    await send(sock, jid, messageObj, `🤔 *KUIS CAK LONTONG AKTIF*\n\nSoal: *${cur.question}*\nClue: *[ ${cur.clue} ]*\n\nKetik jawabanmu langsung di grup!`);
    return true;
  }

  const q = cakLontongQuestions[Math.floor(Math.random() * cakLontongQuestions.length)];
  const session = {
    jid,
    question: q.question,
    clue: q.clue,
    answer: q.answer,
    reason: q.reason,
    aliases: q.aliases,
    expiresAt: Date.now() + 2 * 60 * 1000,
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    if (!activeCakLontong.has(scope)) return;
    activeCakLontong.delete(scope);
    await send(sock, jid, messageObj, `⏰ *WAKTU CAK LONTONG HABIS!* ⏰\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSoal: *${session.question}*\n💡 Jawaban: *${session.answer}*\n🤣 *Alasan Cak Lontong:* ${session.reason}`);
  }, 2 * 60 * 1000);

  activeCakLontong.set(scope, session);
  await send(sock, jid, messageObj, `🧠 *TEKA-TEKI CAK LONTONG* 🧐\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❓ Soal: *${session.question}*\n🔍 Clue: *[ ${session.clue} ]*\n\n💬 *Ketik jawabanmu langsung di grup!*`);
  return true;
}

async function handleCakLontongAnswer(sock, jid, messageObj, senderNumber, text, scope) {
  const session = activeCakLontong.get(scope);
  if (!session) return false;

  const cleanAns = normalizeAnswer(text);
  const isMatch = session.aliases.some(a => normalizeAnswer(a) === cleanAns) || cleanAns === normalizeAnswer(session.answer);
  if (!isMatch) return false;

  if (session.timeout) clearTimeout(session.timeout);
  activeCakLontong.delete(scope);

  const pointsReward = 30;
  const xpReward = 40;
  await db.awardGamePoints(senderNumber, pointsReward, true);
  await db.addMessageXp(senderNumber, xpReward);

  const senderPhone = senderNumber.split('@')[0];
  const cust = await db.getCustomerByPhone(senderNumber);
  const userTag = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;

  const msg = 
`🎉 *TEBAKAN CAK LONTONG BENAR!* 🤣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Pemenang: ${userTag}
💡 Jawaban: *${session.answer}*
💬 *Alasan Cak Lontong:*
"${session.reason}"

🎁 Hadiah: *+${pointsReward} Poin* & *+${xpReward} XP*!`;

  await send(sock, jid, messageObj, msg, { mentions: [senderNumber] });
  return true;
}


export { startFamily100, handleFamily100Answer, startCakLontong, handleCakLontongAnswer };
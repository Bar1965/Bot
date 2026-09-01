import * as db from '../../database.js';
import { send } from './helpers.js';
import { scopeKey, normalizeAnswer } from './helpers.js';

export const activeFamily100 = new Map();
export const activeCakLontong = new Map();


import { family100Questions, cakLontongQuestions } from './family100Data.js';

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
  await db.grantXp(senderNumber, 25);

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
  await db.grantXp(senderNumber, xpReward);

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


async function surrenderFamily100(sock, jid, messageObj, scope) {
  const session = activeFamily100.get(scope);
  if (!session) return false;
  if (session.timeout) clearTimeout(session.timeout);
  activeFamily100.delete(scope);

  let msg = `🏳️ *MENYERAH — FAMILY 100* 🏳️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📋 Soal: *${session.question}*\n\n*Semua Jawaban:*\n`;
  session.answers.forEach((a, i) => {
    const status = a.revealed ? `✅ (${a.solverTag})` : '❌';
    msg += `${i + 1}. *${a.name}* [${a.score} Poin] ${status}\n`;
  });
  msg += `\n_Ketik \`.family100\` untuk bermain ronde baru._`;
  await send(sock, jid, messageObj, msg);
  return true;
}

async function surrenderCakLontong(sock, jid, messageObj, scope) {
  const session = activeCakLontong.get(scope);
  if (!session) return false;
  if (session.timeout) clearTimeout(session.timeout);
  activeCakLontong.delete(scope);

  const msg = `🏳️ *MENYERAH — CAK LONTONG* 🤣\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❓ Soal: *${session.question}*\n💡 Jawaban: *${session.answer}*\n💬 *Alasan Cak Lontong:*\n"${session.reason}"\n\n_Ketik \`.caklontong\` untuk bermain lagi._`;
  await send(sock, jid, messageObj, msg);
  return true;
}

export { startFamily100, handleFamily100Answer, surrenderFamily100, startCakLontong, handleCakLontongAnswer, surrenderCakLontong };
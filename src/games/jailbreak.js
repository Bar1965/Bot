import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeJailbreakSessions = new Map();
export const jailbreakCooldowns = new Map();
const JAILBREAK_TIMEOUT_MS = 35 * 1000;

function generateJailLockChallenge() {
  const types = ['math', 'code', 'color'];
  const type = types[Math.floor(Math.random() * types.length)];

  if (type === 'math') {
    const n1 = Math.floor(Math.random() * 40) + 15;
    const n2 = Math.floor(Math.random() * 30) + 10;
    const ans = (n1 + n2).toString();
    return {
      title: 'Kombinasi Pin Gembok Elektronik',
      description: `Hitung kombinasi kode PIN sel: *${n1} + ${n2}*`,
      answer: ans,
      hint: `Hasil penjumlahan ${n1} dan ${n2}`
    };
  }

  if (type === 'code') {
    const words = ['VENTILASI', 'TEROWONGAN', 'KUNCI', 'SIPIR', 'BORGOL', 'GERBANG', 'HAPUSJEJAK'];
    const word = words[Math.floor(Math.random() * words.length)];
    const scrambled = word.split('').sort(() => 0.5 - Math.random()).join('');
    return {
      title: 'Pecahkan Kode Kawat Sel Elektrik',
      description: `Susun kata sandi kunci sel tahanan: *${scrambled}*`,
      answer: word,
      hint: `Kata sandi berkaitan dengan pelarian (${word.length} huruf)`
    };
  }

  const colors = [
    { seq: 'MERAH - BIRU - KUNING', ans: 'MBK' },
    { seq: 'HIJAU - PUTIH - HITAM', ans: 'HPH' },
    { seq: 'BIRU - KUNING - MERAH', ans: 'BKM' },
    { seq: 'KUNING - HIJAU - BIRU', ans: 'KHB' }
  ];
  const selected = colors[Math.floor(Math.random() * colors.length)];
  return {
    title: 'Gunting Kabel Sirkuit Alarm',
    description: `Potong inisial warna kabel secara berurutan: *${selected.seq}*\n_(Ketik inisial 3 huruf, misal: \`${selected.ans}\`)_`,
    answer: selected.ans,
    hint: `Singkatan 3 huruf depan warna: ${selected.ans}`
  };
}

export async function handleJailbreak(sock, jid, senderNumber, messageObj) {
  const jailStatus = await db.isPlayerJailed(senderNumber);
  if (!jailStatus.isJailed) {
    await send(sock, jid, messageObj, "❌ Kamu tidak sedang di dalam penjara! Status akun kamu bebas berkeliaran.");
    return true;
  }

  if (activeJailbreakSessions.has(senderNumber)) {
    await send(sock, jid, messageObj, "⚠️ Kamu sedang melakukan aksi pembobolan sel! Selesaikan tantangan yang ada sekarang.");
    return true;
  }

  const now = Date.now();
  const cdExpires = jailbreakCooldowns.get(senderNumber) || 0;
  if (now < cdExpires) {
    const sisaMenit = Math.ceil((cdExpires - now) / 60000);
    await send(sock, jid, messageObj, `🚨 *SIPIR SEDANG BERJAGA KETAT!* Kamu baru saja gagal kabur. Tunggu *${sisaMenit} menit* lagi sebelum mencoba membobol sel.`);
    return true;
  }

  const challenge = generateJailLockChallenge();
  const expiresAt = now + JAILBREAK_TIMEOUT_MS;

  const session = {
    senderNumber,
    jid,
    challenge,
    expiresAt,
    timeout: setTimeout(async () => {
      if (!activeJailbreakSessions.has(senderNumber)) return;
      activeJailbreakSessions.delete(senderNumber);
      jailbreakCooldowns.set(senderNumber, Date.now() + 5 * 60 * 1000);

      await db.addGameJailDuration(senderNumber, 15);
      await db.deductGamePoints(senderNumber, 25);

      const failMsg = 
`⏰ *WAKTU PEMBOBOLAN HABIS — TERTANGKAP SIPIR!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Waktu 35 detikmu habis! Penjaga patroli mendapati kamu sedang mengutak-atik sel gembok!

⚖️ *Hukuman Tambahan:*
▫️ Masa Tahanan: *+15 Menit*
▫️ Denda Sipir: *-25 Poin*
▫️ Jawaban Gembok: *${challenge.answer}*

_Jangan sembarangan berbuat onar di dalam sel!_`;

      await send(sock, jid, messageObj, failMsg);
    }, JAILBREAK_TIMEOUT_MS)
  };

  activeJailbreakSessions.set(senderNumber, session);

  const startMsg = 
`🚨 *MISI PELARIAN PENJARA (JAILBREAK)* 🏃‍♂️💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kamu menyelinap ke dekat pintu sel saat sipir sedang tertidur...

🔒 *Tantangan:* ${challenge.title}
📝 *Tugas:* ${challenge.description}
⏳ *Waktu Eksekusi:* 35 Detik
💡 *Petunjuk:* ${challenge.hint}

👉 *Ketik jawabanmu langsung di chat untuk membobol gembok!*
⚠️ _Jika salah atau waktu habis, hukuman penjara bertambah +15 menit!_`;

  await send(sock, jid, messageObj, startMsg);
  return true;
}

export async function handleJailbreakAnswer(sock, jid, senderNumber, messageObj, text) {
  const session = activeJailbreakSessions.get(senderNumber);
  if (!session) return false;

  const submitted = normalizeAnswer(text);
  const correct = normalizeAnswer(session.challenge.answer);

  if (session.timeout) clearTimeout(session.timeout);
  activeJailbreakSessions.delete(senderNumber);

  if (submitted === correct) {
    await db.clearGameJail(senderNumber);
    await db.addMessageXp(senderNumber, 50);

    const senderPhone = senderNumber.split('@')[0];
    const cust = await db.getCustomerByPhone(senderNumber);
    const userTag = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;

    const winMsg = 
`🎉 *BERHASIL KABUR DARI PENJARA! (PRISON BREAK)* 🏃‍♂️💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Gembok sel berhasil terbuka tanpa bunyi! ${userTag} merayap melewati pipa ventilasi dan berhasil keluar ke tempat aman!

✨ *Status:* **BEBAS DARI PENJARA** 🟢
🎁 *Reward:* +50 XP Keberanian!

_Kamu sekarang bisa kembali bermain game, judi, dan transaksi seperti biasa!_`;

    await send(sock, jid, messageObj, winMsg, { mentions: [senderNumber] });
    return true;
  } else {
    jailbreakCooldowns.set(senderNumber, Date.now() + 5 * 60 * 1000);
    await db.addGameJailDuration(senderNumber, 15);
    await db.deductGamePoints(senderNumber, 25);

    const failMsg = 
`🚨 *ALARM BERBUNYI — TERTANGKAP BASAH!* 👮‍♂️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kunci yang kamu masukkan SALAH! Sirkuit sel meledak dan membangunkan seluruh regu sipir!

⚖️ *Vonis Tambahan:*
▫️ Jawaban yang benar: *${session.challenge.answer}*
▫️ Masa Tahanan: *+15 Menit*
▫️ Denda Tindakan Disiplin: *-25 Poin*
▫️ Cooldown Kabur: *5 Menit*`;

    await send(sock, jid, messageObj, failMsg);
    return true;
  }
}

export async function handleTebusNapi(sock, jid, senderNumber, messageObj, targetNumber) {
  if (!targetNumber) {
    await send(sock, jid, messageObj, "⚠️ *Format Perintah Salah!*\nTag atau sertakan nomor tahanan yang ingin ditebus!\n_Contoh:_ `.tebus @member` atau `.bebasinnapi @member`");
    return true;
  }

  if (senderNumber === targetNumber) {
    await send(sock, jid, messageObj, "⚠️ Kamu tidak bisa menebus dirimu sendiri! Gunakan `.jailbreak` untuk mencoba membobol sel.");
    return true;
  }

  const senderJail = await db.isPlayerJailed(senderNumber);
  if (senderJail.isJailed) {
    await send(sock, jid, messageObj, "❌ Kamu sendiri sedang berada di dalam penjara! Selesaikan hukumanmu dulu.");
    return true;
  }

  const targetJail = await db.isPlayerJailed(targetNumber);
  if (!targetJail.isJailed) {
    await send(sock, jid, messageObj, "❌ Target tidak sedang berada di dalam penjara.");
    return true;
  }

  const tebusCost = 100;
  const senderProf = await db.getGameProfile(senderNumber);
  if ((senderProf?.points || 0) < tebusCost) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membayar jaminan pengacara! Butuh *${tebusCost} Poin* (Poin kamu: *${senderProf?.points || 0}*).`);
    return true;
  }

  await db.deductGamePoints(senderNumber, tebusCost);
  await db.clearGameJail(targetNumber);
  await db.addMessageXp(senderNumber, 40);

  const senderPhone = senderNumber.split('@')[0];
  const targetPhone = targetNumber.split('@')[0];

  const custSender = await db.getCustomerByPhone(senderNumber);
  const custTarget = await db.getCustomerByPhone(targetNumber);

  const senderTag = custSender?.nama ? `*${custSender.nama}* (@${senderPhone})` : `@${senderPhone}`;
  const targetTag = custTarget?.nama ? `*${custTarget.nama}* (@${targetPhone})` : `@${targetPhone}`;

  const successMsg = 
`⚖️ *SURAT PEMBEBASAN BERSYARAT DITERBITKAN!* 🏛️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pahlawan penyelamat ${senderTag} telah membayar uang jaminan pengacara sebesar *${tebusCost} Poin* untuk membebaskan ${targetTag}!

✨ *Status Napi:* **BEBAS SEKETIKA** 🟢
🎁 *Kebaikan:* +40 XP untuk penjamin!

_Terima kasih atas solidaritas sesama member!_`;

  await send(sock, jid, messageObj, successMsg, { mentions: [senderNumber, targetNumber] });
  return true;
}

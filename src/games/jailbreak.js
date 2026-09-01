import * as db from '../../database.js';
import { send, normalizeAnswer } from './helpers.js';

export const activeJailbreakSessions = new Map();
export const jailbreakCooldowns = new Map();
const STAGE_TIMEOUT_MS = 25 * 1000;

function generateStageChallenge(stage) {
  if (stage === 1) {
    // TAHAP 1: Gembok Pintu Sel (Lockpick / Matematika PIN)
    const n1 = Math.floor(Math.random() * 45) + 15;
    const n2 = Math.floor(Math.random() * 35) + 12;
    const ans = (n1 + n2).toString();
    return {
      stage: 1,
      title: 'Tahap 1/3: Bobol PIN Gembok Pintu Sel 🔒',
      story: 'Kamu menggunakan jarum kecil untuk meretas keypad pintu sel...',
      description: `Hitung kombinasi kode PIN sel: *${n1} + ${n2}*`,
      answer: ans,
      hint: `Jumlah dari ${n1} dan ${n2}`
    };
  }

  if (stage === 2) {
    // TAHAP 2: Hindari Sensor & Anjing Pelacak (Kode Arah Terowongan)
    const routes = [
      { path: 'UTARA - TIMUR - SELATAN', ans: 'UTS', hint: 'Inisial 3 arah mata angin' },
      { path: 'BARAT - UTARA - TIMUR', ans: 'BUT', hint: 'Inisial 3 arah mata angin' },
      { path: 'TIMUR - SELATAN - BARAT', ans: 'TSB', hint: 'Inisial 3 arah mata angin' },
      { path: 'SELATAN - BARAT - UTARA', ans: 'SBU', hint: 'Inisial 3 arah mata angin' }
    ];
    const selected = routes[Math.floor(Math.random() * routes.length)];
    return {
      stage: 2,
      title: 'Tahap 2/3: Menghindari Patroli Anjing Pelacak 🐕',
      story: 'Pintu sel terbuka! Kamu menyelinap ke lorong bawah tanah...',
      description: `Ketik inisial 3 arah rute terowongan aman: *${selected.path}*\n_(Contoh format: \`${selected.ans}\`)_`,
      answer: selected.ans,
      hint: selected.hint
    };
  }

  // TAHAP 3: Potong Sirkuit Alarm Tembok Utama (Final Escape)
  const colors = [
    { seq: 'MERAH - BIRU - KUNING', ans: 'MBK' },
    { seq: 'HIJAU - PUTIH - HITAM', ans: 'HPH' },
    { seq: 'BIRU - KUNING - MERAH', ans: 'BKM' },
    { seq: 'KUNING - HIJAU - BIRU', ans: 'KHB' }
  ];
  const selectedColor = colors[Math.floor(Math.random() * colors.length)];
  return {
    stage: 3,
    title: 'Tahap 3/3 (FINAL): Potong Sirkuit Alarm Gerbang Utama ⚡',
    story: 'Kamu sudah sampai di tembok pagar berduri gerbang luar!',
    description: `Potong inisial warna kabel alarm sebelum sensor menyala: *${selectedColor.seq}*\n_(Ketik inisial 3 huruf, misal: \`${selectedColor.ans}\`)_`,
    answer: selectedColor.ans,
    hint: `Singkatan 3 huruf depan warna: ${selectedColor.ans}`
  };
}

export async function handleJailbreak(sock, jid, senderNumber, messageObj) {
  const jailStatus = await db.isPlayerJailed(senderNumber);
  if (!jailStatus.isJailed) {
    await send(sock, jid, messageObj, "❌ Kamu tidak sedang di dalam penjara! Akun kamu bebas berkeliaran.");
    return true;
  }

  if (activeJailbreakSessions.has(senderNumber)) {
    const s = activeJailbreakSessions.get(senderNumber);
    await send(sock, jid, messageObj, `⚠️ Kamu sedang dalam misi pelarian (${s.challenge.title})! Selesaikan tantangan sekarang.`);
    return true;
  }

  const now = Date.now();
  const cdExpires = jailbreakCooldowns.get(senderNumber) || 0;
  if (now < cdExpires) {
    const sisaMenit = Math.ceil((cdExpires - now) / 60000);
    await send(sock, jid, messageObj, `🚨 *SIPIR SEDANG BERJAGA KETAT!* Kamu baru saja gagal kabur. Tunggu *${sisaMenit} menit* lagi sebelum mencoba membobol sel.`);
    return true;
  }

  const challenge = generateStageChallenge(1);
  const session = {
    senderNumber,
    jid,
    stage: 1,
    challenge,
    timeout: null
  };

  session.timeout = setTimeout(async () => {
    await handleJailbreakTimeout(sock, jid, senderNumber, messageObj);
  }, STAGE_TIMEOUT_MS);

  activeJailbreakSessions.set(senderNumber, session);

  const startMsg = 
`🚨 *MISI PELARIAN PENJARA 3 TAHAP (PRISON BREAK)* 🏃‍♂️💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${challenge.story}

📌 *${challenge.title}*
📝 *Tugas:* ${challenge.description}
⏳ *Waktu:* 25 Detik per tahap
💡 *Petunjuk:* ${challenge.hint}

👉 *Ketik jawabanmu langsung di chat!*
⚠️ _Kamu harus menuntaskan 3 tahap berturut-turut untuk bisa bebas! Jika gagal, hukuman bertambah +15 menit._`;

  await send(sock, jid, messageObj, startMsg);
  return true;
}

export async function handleJailbreakAnswer(sock, jid, senderNumber, messageObj, text) {
  const session = activeJailbreakSessions.get(senderNumber);
  if (!session) return false;

  const submitted = normalizeAnswer(text);
  const correct = normalizeAnswer(session.challenge.answer);

  if (session.timeout) clearTimeout(session.timeout);

  if (submitted === correct) {
    if (session.stage === 1) {
      // LOLOS TAHAP 1 ➔ MASUK TAHAP 2
      session.stage = 2;
      const nextChallenge = generateStageChallenge(2);
      session.challenge = nextChallenge;

      session.timeout = setTimeout(async () => {
        await handleJailbreakTimeout(sock, jid, senderNumber, messageObj);
      }, STAGE_TIMEOUT_MS);

      const passMsg = 
`🔓 *TAHAP 1 LOLOS!* Gembok sel berhasil terbuka tanpa suara! 👏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${nextChallenge.story}

📌 *${nextChallenge.title}*
📝 *Tugas:* ${nextChallenge.description}
⏳ *Waktu:* 25 Detik
💡 *Petunjuk:* ${nextChallenge.hint}

👉 *Ketik jawaban rute sekarang!*`;

      await send(sock, jid, messageObj, passMsg);
      return true;
    } else if (session.stage === 2) {
      // LOLOS TAHAP 2 ➔ MASUK TAHAP 3 (FINAL)
      session.stage = 3;
      const finalChallenge = generateStageChallenge(3);
      session.challenge = finalChallenge;

      session.timeout = setTimeout(async () => {
        await handleJailbreakTimeout(sock, jid, senderNumber, messageObj);
      }, STAGE_TIMEOUT_MS);

      const passMsg = 
`🐾 *TAHAP 2 LOLOS!* Anjing pelacak terkecoh dan tidak mencium bau jejakmu! 🔥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${finalChallenge.story}

📌 *${finalChallenge.title}*
📝 *Tugas:* ${finalChallenge.description}
⏳ *Waktu:* 25 Detik
💡 *Petunjuk:* ${finalChallenge.hint}

👉 *Ketik urutan warna kabel untuk membuka gerbang akhir!*`;

      await send(sock, jid, messageObj, passMsg);
      return true;
    } else {
      // 🎉 LOLOS SELURUH 3 TAHAP (KEMENANGAN MUTLAK)
      activeJailbreakSessions.delete(senderNumber);
      await db.clearGameJail(senderNumber);
      await db.grantXp(senderNumber, 100);
      await db.addGamePoints(senderNumber, 50);

      const senderPhone = senderNumber.split('@')[0];
      const cust = await db.getCustomerByPhone(senderNumber);
      const userTag = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;

      const winMsg = 
`🏆 *PELARIAN PENJARA SUKSES TOTAL! (MASTER PRISON ESCAPE)* 🏃‍♂️💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 *LUAR BIASA!* ${userTag} berhasil melewati ketiga pos rintangan penjara dan kabur ke hutan bebas!

✨ *Status Akun:* **BEBAS SEPENUHNYA DARI PENJARA** 🟢
🎁 *Hadiah Keberanian:* *+100 XP* & *+50 Poin Bonus*!

_Seluruh fitur game, judi, dan transaksi kamu telah aktif kembali!_`;

      await send(sock, jid, messageObj, winMsg, { mentions: [senderNumber] });
      return true;
    }
  } else {
    // JAWABAN SALAH ➔ GAGAL & TERTANGKAP
    activeJailbreakSessions.delete(senderNumber);
    jailbreakCooldowns.set(senderNumber, Date.now() + 5 * 60 * 1000);
    await db.addGameJailDuration(senderNumber, 15);
    await db.deductGamePoints(senderNumber, 30);

    const failMsg = 
`🚨 *SIRENE ALARM PENJARA BERBUNYI — TERTANGKAP BASAH!* 👮‍♂️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aksi kamu di *${session.challenge.title}* GAGAL karena jawaban salah (*${text}*)!
Regu sipir dan anjing pelacak mengepungmu seketika!

⚖️ *Vonis Hukuman:*
▫️ Jawaban yang benar: *${session.challenge.answer}*
▫️ Masa Tahanan: Bertambah *+15 Menit*
▫️ Denda Sipir: *-30 Poin*
▫️ Cooldown Kabur: *5 Menit*

_Ketik \`.tebus @kamu\` jika ada teman berbaik hati yang mau menebus jaminan pengacara (1.000 Poin)._`;

    await send(sock, jid, messageObj, failMsg);
    return true;
  }
}

async function handleJailbreakTimeout(sock, jid, senderNumber, messageObj) {
  if (!activeJailbreakSessions.has(senderNumber)) return;
  const session = activeJailbreakSessions.get(senderNumber);
  activeJailbreakSessions.delete(senderNumber);
  jailbreakCooldowns.set(senderNumber, Date.now() + 5 * 60 * 1000);

  await db.addGameJailDuration(senderNumber, 15);
  await db.deductGamePoints(senderNumber, 30);

  const failMsg = 
`⏰ *WAKTU TAHAP HABIS — TERTANGKAP PATROLI!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Waktu 25 detikmu di *${session.challenge.title}* habis! Sorotan lampu menara penjara menyorot tubuhmu!

⚖️ *Hukuman:*
▫️ Jawaban yang benar: *${session.challenge.answer}*
▫️ Masa Tahanan: *+15 Menit*
▫️ Denda Sipir: *-30 Poin*
▫️ Cooldown Kabur: *5 Menit*`;

  await send(sock, jid, messageObj, failMsg);
}

export async function handleTebusNapi(sock, jid, senderNumber, messageObj, targetRaw) {
  if (!targetRaw) {
    await send(sock, jid, messageObj, "⚠️ *Format Perintah Salah!*\nTag atau sertakan nomor tahanan yang ingin ditebus!\n_Contoh:_ `.tebus @member` atau `.bebasinnapi @member`");
    return true;
  }

  let targetNumber = targetRaw;
  if (!targetNumber.endsWith('@s.whatsapp.net') && !targetNumber.endsWith('@lid')) {
    const res = await db.resolveTargetJid(targetNumber);
    if (res?.ditemukan && res.jid) targetNumber = res.jid;
    else {
      const cleanNum = targetNumber.replace(/[^0-9]/g, '');
      if (cleanNum.length > 5) targetNumber = `${cleanNum}@s.whatsapp.net`;
    }
  }

  if (senderNumber === targetNumber || db.isPhoneMatch(senderNumber, targetNumber)) {
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

  const tebusCost = 1000;
  const senderProf = await db.getGameProfile(senderNumber);
  if ((senderProf?.points || 0) < tebusCost) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak cukup untuk membayar uang jaminan pengacara! Butuh *${tebusCost.toLocaleString('id-ID')} Poin* (Poin kamu: *${(senderProf?.points || 0).toLocaleString('id-ID')}*).`);
    return true;
  }

  await db.deductGamePoints(senderNumber, tebusCost);
  await db.clearGameJail(targetNumber);
  await db.grantXp(senderNumber, 100);

  const senderPhone = senderNumber.split('@')[0];
  const targetPhone = targetNumber.split('@')[0];

  const custSender = await db.getCustomerByPhone(senderNumber);
  const custTarget = await db.getCustomerByPhone(targetNumber);

  const senderTag = custSender?.nama ? `*${custSender.nama}* (@${senderPhone})` : `@${senderPhone}`;
  const targetTag = custTarget?.nama ? `*${custTarget.nama}* (@${targetPhone})` : `@${targetPhone}`;

  const successMsg = 
`⚖️ *SURAT PEMBEBASAN BERSYARAT DITERBITKAN!* 🏛️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pahlawan penyelamat ${senderTag} telah membayar uang jaminan pengacara sebesar *${tebusCost.toLocaleString('id-ID')} Poin* untuk membebaskan ${targetTag}!

✨ *Status Napi:* **BEBAS SEKETIKA** 🟢
🎁 *Kebaikan Penjamin:* +100 XP & Penghormatan Grup!

_Terima kasih atas solidaritas sesama member!_`;

  await send(sock, jid, messageObj, successMsg, { mentions: [senderNumber, targetNumber] });
  return true;
}

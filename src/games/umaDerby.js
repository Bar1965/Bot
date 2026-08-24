import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeHorseRaces = new Map();

// ─── 6. BALAP KUDA MULTI-BETTING ──────────────────────────────
const ALL_UMA_MUSUME_POOL = [
  { name: "Special Week", emoji: "🌸", nickname: "Spica" },
  { name: "Silence Suzuka", emoji: "⚡", nickname: "Escape" },
  { name: "Tokai Teio", emoji: "👑", nickname: "Step" },
  { name: "Gold Ship", emoji: "⚓", nickname: "Warp" },
  { name: "Mayano Top Gun", emoji: "✈️", nickname: "Top Gun" },
  { name: "Mejiro McQueen", emoji: "🍨", nickname: "Stamina" },
  { name: "Oguri Cap", emoji: "🍙", nickname: "Beast" },
  { name: "Haru Urara", emoji: "🎀", nickname: "Miracle" },
  { name: "Rice Shower", emoji: "🌹", nickname: "Assassin" },
  { name: "Symboli Rudolf", emoji: "🎓", nickname: "Emperor" },
  { name: "Daiwa Scarlet", emoji: "🎀", nickname: "Miss Perfect" },
  { name: "Vodka", emoji: "🥃", nickname: "Wild Top" },
  { name: "Twin Turbo", emoji: "🏎️", nickname: "Full Throttle" },
  { name: "Kitasan Black", emoji: "🌟", nickname: "Festival Queen" },
  { name: "Satono Diamond", emoji: "💎", nickname: "Diamond Rush" },
  { name: "Grass Wonder", emoji: "🍃", nickname: "Calm Breeze" },
  { name: "El Condor Pasa", emoji: "🦅", nickname: "Masked Eagle" },
  { name: "Seiun Sky", emoji: "☁️", nickname: "Trickster" },
  { name: "King Halo", emoji: "👑", nickname: "First Class" },
  { name: "Agnes Tachyon", emoji: "🧪", nickname: "Mad Scientist" },
  { name: "Manhattan Cafe", emoji: "☕", nickname: "Shadow Runner" },
  { name: "Tamamo Cross", emoji: "⚡", nickname: "White Lightning" },
  { name: "Super Creek", emoji: "🍼", nickname: "Gentle Breeze" },
  { name: "Inari One", emoji: "🦊", nickname: "Edo Spirit" },
  { name: "Nice Nature", emoji: "🥉", nickname: "Bronze Lover" },
  { name: "Machikane Tannhauser", emoji: "🎩", nickname: "Hard Worker" },
  { name: "Matikanefukukitaru", emoji: "🔮", nickname: "Fortune Seeker" },
  { name: "Maruzensky", emoji: "🚗", nickname: "Supercar" },
  { name: "Narita Taishin", emoji: "🌙", nickname: "Lone Wolf" },
  { name: "Winning Ticket", emoji: "🎫", nickname: "Emotional Runner" },
  { name: "Mejiro Dober", emoji: "🐕", nickname: "Cool Beauty" },
  { name: "Smart Falcon", emoji: "🎤", nickname: "Top Idol" },
  { name: "Curren Chan", emoji: "📱", nickname: "Cute Influencer" },
  { name: "Copano Rickey", emoji: "🪙", nickname: "Lucky Star" },
  { name: "Hokko Tarumae", emoji: "🏮", nickname: "Tomakomai Idol" },
  { name: "Mihono Bourbon", emoji: "🤖", nickname: "Cyborg Runner" }
];

function getRandomUmaMusumeRoster(count = 8) {
  const safeCount = Math.max(4, Math.min(count, 8));
  const shuffled = [...ALL_UMA_MUSUME_POOL];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, safeCount).map((uma, index) => ({
    id: index + 1,
    name: uma.name,
    emoji: uma.emoji,
    nickname: uma.nickname
  }));
}

async function handleHorseRace(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ Permainan Balap Kuda Uma Musume Derby hanya bisa dimainkan di grup!");
    return true;
  }

  const bettingCommands = ['pasangkuda', 'betkuda', 'pasang', 'bet', 'kuda'];
  const isDirectBetCmd = bettingCommands.includes(command);

  let session = activeHorseRaces.get(jid);

  if (['startbalap', 'startrace'].includes(command)) {
    if (!session) {
      await send(sock, jid, messageObj, "❌ Tidak ada bursa balap kuda yang sedang aktif. Ketik `.balapkuda` untuk membuka bursa taruhan!");
      return true;
    }
    if (session.bets.length === 0) {
      await send(sock, jid, messageObj, "⚠️ Belum ada taruhan yang dipasang! Pasang minimal 1 taruhan sebelum memulai.");
      return true;
    }
    if (session.timeout) clearTimeout(session.timeout);
    await runHorseRace(sock, jid, messageObj, session);
    return true;
  }

  if (['cancelbalap'].includes(command)) {
    if (!session) return true;
    if (session.timeout) clearTimeout(session.timeout);
    for (const b of session.bets) {
      await db.addGamePoints(b.sender, b.amount);
    }
    activeHorseRaces.delete(jid);
    await send(sock, jid, messageObj, "🏳️ Bursa balap kuda dibatalkan. Seluruh poin taruhan telah dikembalikan ke dompet pemain.");
    return true;
  }

  let directHorseId = null;
  let directBetAmount = null;

  if (isDirectBetCmd && args[1]) {
    directHorseId = parseInt(args[1], 10);
    directBetAmount = parseInt(args[2], 10);
  } else if (['balapkuda', 'race'].includes(command) && args[1] && !isNaN(parseInt(args[1], 10)) && args[2]) {
    directHorseId = parseInt(args[1], 10);
    directBetAmount = parseInt(args[2], 10);
  }

  if (!session) {
    const horseCount = (args[1] && parseInt(args[1], 10) >= 4 && parseInt(args[1], 10) <= 8 && !args[2]) 
      ? parseInt(args[1], 10) 
      : 8;

    const racers = getRandomUmaMusumeRoster(horseCount);
    const payoutMultiplier = Number((horseCount - 0.5).toFixed(1));

    session = {
      jid,
      racers,
      payoutMultiplier,
      bets: [],
      startAt: Date.now() + 2 * 60 * 1000,
      timeout: null
    };

    session.timeout = setTimeout(async () => {
      if (!activeHorseRaces.has(jid)) return;
      await runHorseRace(sock, jid, messageObj, session);
    }, 2 * 60 * 1000);

    activeHorseRaces.set(jid, session);

    if (directHorseId && directBetAmount) {
      await processHorseBet(sock, jid, senderNumber, messageObj, session, directHorseId, directBetAmount);
    } else {
      let rosterText = racers.map(h => `${h.id}. ${h.emoji} *${h.name}*`).join('\n');
      const bursaMsg = 
`🏇 *UMA MUSUME TOKYO RACECOURSE DERBY* 🏁
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bursa taruhan dibuka selama **2 MENIT**!
Peluang seluruh kuda berlari adalah **SETARA (FAIR)** dengan hadiah payout pemenang **${session.payoutMultiplier}x Lipat**!

*Daftar Kuda Uma Musume:*
${rosterText}

📌 *Cara Pasang Taruhan:*
Ketik: \`.pasang [1-${session.racers.length}] [jumlah]\`
_Contoh:_ \`.pasang 4 100\` atau \`.balapkuda 2 50\`

⏰ Balapan akan otomatis dimulai dalam **2 Menit** (atau ketik \`.startbalap\` jika semua sudah pasang)!`;

      await send(sock, jid, messageObj, bursaMsg);
    }
    return true;
  }

  if (directHorseId && directBetAmount) {
    await processHorseBet(sock, jid, senderNumber, messageObj, session, directHorseId, directBetAmount);
    return true;
  }

  if (['balapkuda', 'race'].includes(command)) {
    const remSec = Math.max(1, Math.ceil((session.startAt - Date.now()) / 1000));
    let betSummary = session.bets.length > 0
      ? session.bets.map(b => `▫️ ${b.label}: ${b.horseName} (${b.amount.toLocaleString('id-ID')} Poin)`).join('\n')
      : '_Belum ada taruhan masuk._';

    const infoMsg = 
`🏇 *BURSA BALAP UMA MUSUME SEDANG AKTIF!* 🏁
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏰ Sisa Waktu Pasang: *${remSec} Detik*
💰 Hadiah Kemenangan: *${session.payoutMultiplier}x Lipat*

📊 *Taruhan Terpasang (${session.bets.length}):*
${betSummary}

📌 *Pasang Taruhan:*
Ketik: \`.pasang [1-${session.racers.length}] [jumlah_poin]\`
_Contoh:_ \`.pasang 1 100\``;

    await send(sock, jid, messageObj, infoMsg);
    return true;
  }

  if (isDirectBetCmd) {
    await send(sock, jid, messageObj, `⚠️ *Format Pasang Salah!*\nGunakan: \`.pasang [1-${session.racers.length}] [jumlah_poin]\`\n_Contoh:_ \`.pasang 3 50\``);
    return true;
  }

  return false;
}

async function processHorseBet(sock, jid, senderNumber, messageObj, session, horseId, amount) {
  if (isNaN(horseId) || horseId < 1 || horseId > session.racers.length || isNaN(amount) || amount <= 0) {
    await send(sock, jid, messageObj, `⚠️ *Pilihan Kuda Salah!*\nPilih nomor kuda 1 sampai ${session.racers.length}.\n_Contoh:_ \`.pasang 1 50\``);
    return;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < amount) {
    await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi! (Poinmu: ${prof?.points || 0})`);
    return;
  }

  await db.deductGamePoints(senderNumber, amount);

  const horse = session.racers.find(h => h.id === horseId);
  const cust = await db.getCustomerByPhone(senderNumber);
  const senderPhone = senderNumber.split('@')[0];
  const senderLabel = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;

  session.bets.push({
    sender: senderNumber,
    label: senderLabel,
    horseId,
    horseName: `${horse.emoji} ${horse.name}`,
    amount
  });

  const remSec = Math.max(1, Math.ceil((session.startAt - Date.now()) / 1000));
  await send(sock, jid, messageObj, `✅ *TARUHAN DITERIMA!* 🎫\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Pemain: ${senderLabel}\n🏇 Kuda Pilihan: *${horse.emoji} ${horse.name}* (No. ${horse.id})\n💰 Taruhan: *${amount.toLocaleString('id-ID')} Poin* (Potensi Menang: *${Math.floor(amount * session.payoutMultiplier).toLocaleString('id-ID')} Poin*)\n\n⏰ Sisa Waktu Pasang: *${remSec} Detik*`, { mentions: [senderNumber] });
}

async function runHorseRace(sock, jid, messageObj, session) {
  activeHorseRaces.delete(jid);

  if (session.bets.length === 0) {
    await send(sock, jid, messageObj, `🏇 *BALAPAN DIBATALKAN!* Tidak ada member yang memasang taruhan dalam 2 menit.`);
    return;
  }

  const winningIndex = Math.floor(Math.random() * session.racers.length);
  const winningHorse = session.racers[winningIndex];

  const trackLength = 6;
  const generateTrack = (step) => {
    let lines = [];
    session.racers.forEach((r, idx) => {
      let progress = 0;
      if (step === 1) {
        progress = Math.floor(Math.random() * 2) + 1;
      } else if (step === 2) {
        progress = Math.floor(Math.random() * 2) + 3;
      } else {
        progress = (idx === winningIndex) ? trackLength : Math.min(trackLength - 1, Math.floor(Math.random() * 2) + 4);
      }

      let trackStr = "";
      if (step === 3 && idx === winningIndex) {
        trackStr = `🟩🟩🟩🟩🟩🟩 🏆🥇 *JUARA!*`;
      } else {
        const green = "🟩".repeat(progress);
        const white = "⬜".repeat(Math.max(0, trackLength - progress));
        trackStr = `${green}🏃‍♀️${white} 🏁`;
      }

      lines.push(`*${r.id}. ${r.emoji} ${r.name}*\n└ ${trackStr}`);
    });
    return lines.join('\n\n');
  };

  const frame1 = 
`🏁 *GERBANG START TERBUKA — UMA MUSUME DERBY!* 🏇💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seluruh Uma Musume melesat kencang dari garis start!

${generateTrack(1)}

_Status: Lap 1/3 (Start Dash)_`;

  const frame2 = 
`🔥 *TIKUNGAN TERAKHIR MENDEKATI FINISH!* 💨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Persaingan sengit memperebutkan posisi terdepan!

${generateTrack(2)}

_Status: Lap 2/3 (Final Corner)_`;

  // Kirim Pesan Frame 1 (Single Live Message)
  let liveMsg = null;
  try {
    liveMsg = await sock.sendMessage(jid, { text: frame1 }, messageObj ? { quoted: messageObj } : undefined);
  } catch (e) {
    console.error("[HORSE_RACE] Gagal kirim frame 1:", e);
  }

  await new Promise(r => setTimeout(r, 2500));

  // Edit ke Frame 2
  if (liveMsg?.key) {
    try {
      await sock.sendMessage(jid, { text: frame2, edit: liveMsg.key });
    } catch (e) {
      liveMsg = await sock.sendMessage(jid, { text: frame2 });
    }
  }

  await new Promise(r => setTimeout(r, 2500));

  // Hasil Akhir & Pembagian Hadiah
  const winners = session.bets.filter(b => b.horseId === winningHorse.id);
  const mentionList = [];

  let winSummary = '';
  if (winners.length > 0) {
    for (const w of winners) {
      const payout = Math.floor(w.amount * session.payoutMultiplier);
      await db.addGamePoints(w.sender, payout);
      await db.addMessageXp(w.sender, 50);
      mentionList.push(w.sender);
      winSummary += `▫️ ${w.label} — Menang *+${payout.toLocaleString('id-ID')} Poin* (Taruhan: ${w.amount.toLocaleString('id-ID')} Poin)\n`;
    }
  } else {
    winSummary = `_Tidak ada pemain yang bertaruh pada ${winningHorse.name}. Seluruh taruhan masuk ke kas bandar._\n`;
  }

  const finalResult = 
`🏆 *HASIL AKHIR UMA MUSUME DERBY* 🏁
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${generateTrack(3)}

🥇 *JUARA 1:* ${winningHorse.emoji} *${winningHorse.name}* (No. ${winningHorse.id})!
💰 Payout Pemenang: *${session.payoutMultiplier}x Lipat*

🎉 *Daftar Pemenang Taruhan:*
${winSummary}
👏 Selamat kepada para pemenang! Ketik \`.balapkuda\` untuk membuka bursa balapan berikutnya!`;

  if (liveMsg?.key) {
    try {
      await sock.sendMessage(jid, { text: finalResult, edit: liveMsg.key, mentions: mentionList });
    } catch (e) {
      await send(sock, jid, messageObj, finalResult, { mentions: mentionList });
    }
  } else {
    await send(sock, jid, messageObj, finalResult, { mentions: mentionList });
  }
}


export { handleHorseRace };
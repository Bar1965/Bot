import * as db from '../../database.js';
import { send } from './helpers.js';

export const activeBlackjack = new Map();
export const activeBlackjackGames = activeBlackjack;

// ─── 4. BLACKJACK 21 ──────────────────────────────────────────
function calculateHandValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (['K', 'Q', 'J'].includes(c.rank)) {
      total += 10;
    } else {
      total += parseInt(c.rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function drawCard() {
  const suits = ['♠️', '♥️', '♦️', '♣️'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const suit = suits[Math.floor(Math.random() * suits.length)];
  const rank = ranks[Math.floor(Math.random() * ranks.length)];
  return { rank, suit, str: `${rank}${suit}` };
}

async function resolveSenderProfile(senderNumber) {
  let resolved = senderNumber;
  let prof = await db.getGameProfile(resolved);
  if (!prof || (prof.points <= 0 && prof.games_played <= 0)) {
    const digits = resolved.replace(/[^0-9]/g, '');
    if (digits.length > 5) {
      const altProf = await db.getQuery(
        "SELECT * FROM game_profiles WHERE (customer_jid LIKE ? OR customer_jid LIKE ?) AND points > 0 ORDER BY points DESC LIMIT 1",
        [`%${digits}%`, `${digits}@%`]
      );
      if (altProf) {
        resolved = altProf.customer_jid;
        prof = altProf;
      }
    }
  }
  return { resolvedJid: resolved, profile: prof };
}

async function handleBlackjack(sock, jid, senderNumber, messageObj, args, command) {
  const { resolvedJid, profile } = await resolveSenderProfile(senderNumber);

  if (['blackjack', 'bj'].includes(command)) {
    if (activeBlackjack.has(resolvedJid) || activeBlackjack.has(senderNumber)) {
      await send(sock, jid, messageObj, "⚠️ Kamu sedang memiliki game Blackjack aktif! Ketik `.hit` untuk ambil kartu atau `.stand` untuk tahan.");
      return true;
    }

    let bet = 20;
    if (args[1]) {
      if (args[1].toLowerCase() === 'all') {
        bet = Math.max(1, profile?.points || 20);
      } else {
        const parsed = parseInt(args[1], 10);
        if (!isNaN(parsed) && parsed > 0) bet = parsed;
      }
    }

    if ((profile?.points || 0) < bet) {
      await send(sock, jid, messageObj, `❌ Poin kamu tidak mencukupi untuk taruhan *${bet} Poin*! (Sisa Poinmu: ${profile?.points || 0})\n\nKetik \`.daily\` untuk klaim poin gratis!`);
      return true;
    }

    await db.deductGamePoints(resolvedJid, bet);

    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];

    const playerVal = calculateHandValue(playerCards);
    const dealerVisibleVal = calculateHandValue([dealerCards[0]]);

    const session = {
      jid,
      senderJid: resolvedJid,
      bet,
      playerCards,
      dealerCards,
      timeout: null
    };

    if (playerVal === 21) {
      const winPayout = Math.floor(bet * 2.5);
      await db.addGamePoints(resolvedJid, winPayout);
      await db.addMessageXp(resolvedJid, 40);
      const winMsg = 
`🃏 *BLACKJACK ALAMI (NATURAL 21)!* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${playerCards.map(c => c.str).join(', ')} ] (Nilai: 21)
🤖 Kartu Dealer: [ ${dealerCards.map(c => c.str).join(', ')} ]
💰 Taruhan: *${bet} Poin*

🎉 *MENANG BLACKJACK!* Payout 2.5x
🎁 Hadiah: *+${winPayout} Poin* & *+40 XP*!`;
      await send(sock, jid, messageObj, winMsg, {
        buttons: [
          { type: 'reply', text: `🔁 Main Lagi (${bet} Poin)`, id: `.bj ${bet}` },
          { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
        ]
      });
      return true;
    }

    activeBlackjack.set(resolvedJid, session);
    if (resolvedJid !== senderNumber) {
      activeBlackjack.set(senderNumber, session);
    }

    const msg = 
`🃏 *BLACKJACK 21* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${playerCards.map(c => c.str).join(', ')} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${dealerCards[0].str}, 🂠 ??? ] (Terlihat: *${dealerVisibleVal}*)
💰 Taruhan: *${bet} Poin*

👉 Pilih tindakan:
▫️ \`.hit\` - Ambil 1 kartu tambahan
▫️ \`.stand\` - Tahan nilai kartu & giliran Dealer
▫️ \`.double\` - Gandakan taruhan & ambil tepat 1 kartu`;

    await send(sock, jid, messageObj, msg, {
      buttons: [
        { type: 'reply', text: '🃏 Hit (+1 Kartu)', id: '.hit' },
        { type: 'reply', text: '🛑 Stand (Tahan)', id: '.stand' },
        { type: 'reply', text: '💰 Double Down (2x)', id: '.double' }
      ]
    });
    return true;
  }

  if (['hit'].includes(command)) {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;

    session.playerCards.push(drawCard());
    const playerVal = calculateHandValue(session.playerCards);

    if (playerVal > 21) {
      activeBlackjack.delete(session.senderJid);
      activeBlackjack.delete(senderNumber);
      const bustMsg = 
`💥 *BUST! KARTU MELEBIHI 21!* 💥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${session.playerCards.map(c => c.str).join(', ')} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${session.dealerCards.map(c => c.str).join(', ')} ]

💸 Kamu kalah! Taruhan *${session.bet} Poin* hangus.`;
      await send(sock, jid, messageObj, bustMsg, {
        buttons: [
          { type: 'reply', text: `🔁 Main Lagi (${session.bet} Poin)`, id: `.bj ${session.bet}` },
          { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
        ]
      });
      return true;
    }

    const hitMsg = 
`🃏 *BLACKJACK - HIT* 🃏
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${session.playerCards.map(c => c.str).join(', ')} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${session.dealerCards[0].str}, 🂠 ??? ]
💰 Taruhan: *${session.bet} Poin*

Pilih tindakan selanjutnya:`;
    await send(sock, jid, messageObj, hitMsg, {
      buttons: [
        { type: 'reply', text: '🃏 Hit (+1 Kartu)', id: '.hit' },
        { type: 'reply', text: '🛑 Stand (Tahan)', id: '.stand' }
      ]
    });
    return true;
  }

  if (['double'].includes(command)) {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;

    const prof = await db.getGameProfile(session.senderJid);
    if ((prof?.points || 0) < session.bet) {
      await send(sock, jid, messageObj, "❌ Poin kamu tidak cukup untuk Double!");
      return true;
    }

    await db.deductGamePoints(session.senderJid, session.bet);
    session.bet *= 2;
    session.playerCards.push(drawCard());
    return await executeBlackjackDealer(sock, jid, session.senderJid, messageObj, session);
  }

  if (['stand'].includes(command)) {
    const session = activeBlackjack.get(resolvedJid) || activeBlackjack.get(senderNumber);
    if (!session) return false;
    return await executeBlackjackDealer(sock, jid, session.senderJid, messageObj, session);
  }

  return false;
}

async function executeBlackjackDealer(sock, jid, senderNumber, messageObj, session) {
  activeBlackjack.delete(session.senderJid);
  activeBlackjack.delete(senderNumber);

  const playerVal = calculateHandValue(session.playerCards);
  if (playerVal > 21) {
    const bustMsg = `💥 *BUST!* Kartu kamu: [ ${session.playerCards.map(c => c.str).join(', ')} ] (Total: *${playerVal}*)\n💸 Taruhan *${session.bet} Poin* hangus.`;
    await send(sock, jid, messageObj, bustMsg, {
      buttons: [
        { type: 'reply', text: `🔁 Main Lagi (${session.bet} Poin)`, id: `.bj ${session.bet}` },
        { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
      ]
    });
    return true;
  }

  while (calculateHandValue(session.dealerCards) < 17) {
    session.dealerCards.push(drawCard());
  }

  const dealerVal = calculateHandValue(session.dealerCards);

  let resultTitle = '';
  let resultMsg = '';
  let payout = 0;

  if (dealerVal > 21) {
    resultTitle = '🎉 *DEALER BUST! KAMU MENANG!* 🏆';
    payout = session.bet * 2;
    resultMsg = `Dealer melewati 21 (${dealerVal})! Kamu menang *+${payout} Poin* & *+35 XP*!`;
  } else if (playerVal > dealerVal) {
    resultTitle = '🎉 *KAMU MENANG!* 🏆';
    payout = session.bet * 2;
    resultMsg = `Nilai kartu kamu (${playerVal}) mengalahkan Dealer (${dealerVal})! Menang *+${payout} Poin* & *+35 XP*!`;
  } else if (playerVal === dealerVal) {
    resultTitle = '🤝 *DRAW / PUSH!* 🤝';
    payout = session.bet;
    resultMsg = `Nilai sama (${playerVal}). Taruhan *${payout} Poin* dikembalikan ke dompet.`;
  } else {
    resultTitle = '💸 *DEALER MENANG!* 💸';
    payout = 0;
    resultMsg = `Kartu Dealer (${dealerVal}) lebih tinggi dari kamu (${playerVal}). Taruhan *${session.bet} Poin* hangus.`;
  }

  if (payout > 0) {
    await db.addGamePoints(session.senderJid, payout);
    if (payout > session.bet) await db.addMessageXp(session.senderJid, 35);
  }

  const finalMsg = 
`${resultTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Kartu Kamu: [ ${session.playerCards.map(c => c.str).join(', ')} ] (Total: *${playerVal}*)
🤖 Kartu Dealer: [ ${session.dealerCards.map(c => c.str).join(', ')} ] (Total: *${dealerVal}*)
💰 Taruhan: *${session.bet} Poin*

${resultMsg}`;

  await send(sock, jid, messageObj, finalMsg, {
    buttons: [
      { type: 'reply', text: `🔁 Main Lagi (${session.bet} Poin)`, id: `.bj ${session.bet}` },
      { type: 'reply', text: '👤 Profil Poin', id: '.poin' }
    ]
  });
  return true;
}

export { handleBlackjack };
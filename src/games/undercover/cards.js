// ─── 🃏 TOKO KARTU AKSI UNDERCOVER (.undercover card) ────────────────

import * as db from '../../../database.js';
import { send } from '../helpers.js';
import { CARD_DEFS } from './constants.js';
import {
  activeUndercoverGames, saveUndercoverSessions, samePlayer, isAlive,
  cardPrice, tag, dm, getPlayerRoleData, isUndercoverRole,
  resolveTargetInSession
} from './state.js';

export async function chargeCard(session, buyer, price) {
  const deduct = await db.deductGamePoints(buyer, price);
  if (!deduct?.success) return false;
  if (!Array.isArray(session.cardPurchases)) session.cardPurchases = [];
  session.cardPurchases.push({ jid: buyer, price });
  return true;
}

export async function handleUndercoverCardShop(sock, jid, senderNumber, messageObj, args) {
  const session = activeUndercoverGames.get(jid);
  const cardType = (args[2] || '').toLowerCase();
  const ref = session || { buyIn: 30 };

  const shopGuide =
`🃏 *TOKO KARTU AKSI UNDERCOVER (POWER CARDS)* ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *ATURAN BARU:* Maksimal *1 kartu per pemain per game*, dan harga mengikuti taruhan lobi.

*KARTU PRA-GAME* (wajib dibeli saat masih di LOBI):
1. 🛡️ *Rompi Anti-Peluru (Shield)* — *${cardPrice(ref, CARD_DEFS.shield)} Poin*
   • Kebal dari 1x eliminasi voting grup.
   • Beli: \`.undercover card shield\`

2. 🌟 *Golden Vote (Double Suara)* — *${cardPrice(ref, CARD_DEFS.gold)} Poin*
   • Suara votingmu dihitung **2 suara**.
   • Beli: \`.undercover card gold\`

*KARTU DALAM PERMAINAN* (fase petunjuk/diskusi, TIDAK saat voting):
3. 🤐 *Kartu Lakban (Silence)* — *${cardPrice(ref, CARD_DEFS.silence)} Poin*
   • Target hanya boleh memberi petunjuk **1 KATA** di ronde BERIKUTNYA.
   • Beli: \`.undercover card silence @target\`

4. 🔮 *Radar Sensor (Clue Spy)* — *${cardPrice(ref, CARD_DEFS.radar)} Poin*
   • (Khusus kubu Penyamar / Mr. White) Bocoran kategori & huruf depan kata warga via DM.
   • Beli: \`.undercover card radar\`

💡 _Kartu Shield & Golden Vote sengaja dikunci di lobi supaya tidak bisa dibeli mendadak saat kamu hampir dieksekusi._`;

  if (!cardType) {
    await send(sock, jid, messageObj, shopGuide);
    return true;
  }

  const def = CARD_DEFS[cardType];
  if (!def) {
    await send(sock, jid, messageObj, shopGuide);
    return true;
  }

  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Undercover di grup ini. Buka lobi dulu dengan `.undercover [taruhan]`!");
    return true;
  }

  const buyer = session.players.find(p => samePlayer(p, senderNumber));
  if (!buyer) {
    await send(sock, jid, messageObj, "❌ Kamu bukan peserta sesi Undercover ini!");
    return true;
  }

  if (def.phase === 'LOBBY' && session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, `❌ *${def.name}* hanya bisa dibeli saat masih di LOBI (sebelum game dimulai)!`);
    return true;
  }

  if (def.phase === 'GAME' && !['CLUE_PHASE', 'ANON_CLUE_PHASE', 'DISCUSSION_PHASE'].includes(session.status)) {
    await send(sock, jid, messageObj, `❌ *${def.name}* hanya bisa dibeli saat fase petunjuk atau diskusi — tidak saat fase voting!`);
    return true;
  }

  if (session.status !== 'LOBBY' && !isAlive(session, buyer)) {
    await send(sock, jid, messageObj, "❌ Pemain yang sudah gugur tidak bisa membeli kartu aksi!");
    return true;
  }

  if (session.cardOwners?.has(buyer)) {
    await send(sock, jid, messageObj, "❌ *Batas 1 kartu per pemain!* Kamu sudah membeli kartu aksi di game ini.");
    return true;
  }

  const price = cardPrice(session, def);
  const prof = await db.getGameProfile(buyer);
  if ((prof?.points || 0) < price) {
    await send(sock, jid, messageObj, `❌ Poin tidak cukup! Butuh *${price} Poin* untuk ${def.name}.`);
    return true;
  }

  if (cardType === 'silence') {
    const rawTarget = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[3];
    const resolvedTarget = resolveTargetInSession(session, rawTarget);
    if (!resolvedTarget || !isAlive(session, resolvedTarget)) {
      await send(sock, jid, messageObj, `⚠️ Tentukan target lakban yang masih hidup!\n👉 Format: \`.undercover card silence @target\` atau \`.undercover card silence [1-${session.alivePlayers.length}]\``);
      return true;
    }
    if (samePlayer(resolvedTarget, buyer)) {
      await send(sock, jid, messageObj, "⚠️ Tidak bisa melakban diri sendiri!");
      return true;
    }
    const charged = await chargeCard(session, buyer, price);
    if (!charged) {
      await send(sock, jid, messageObj, `❌ Gagal memotong poin untuk ${def.name}.`);
      return true;
    }
    session.cardOwners.add(buyer);
    session.pendingSilence.add(resolvedTarget);
    saveUndercoverSessions();
    await send(sock, jid, messageObj, `🤐 ${tag(buyer)} melakban ${tag(resolvedTarget)} dengan *Kartu Lakban* (-${price} Poin)!\n📌 Efek aktif *mulai Ronde ${session.round + 1}*: korban hanya boleh menulis *1 KATA*.`, { mentions: [buyer, resolvedTarget] });
    return true;
  }

  if (cardType === 'radar') {
    const roleData = getPlayerRoleData(session, buyer);
    if (!roleData || (!isUndercoverRole(roleData.role) && roleData.role !== 'MRWHITE')) {
      await send(sock, jid, messageObj, "❌ Kartu Radar hanya bisa digunakan oleh kubu Penyamar atau Mr. White!");
      return true;
    }
    const charged = await chargeCard(session, buyer, price);
    if (!charged) {
      await send(sock, jid, messageObj, `❌ Gagal memotong poin untuk ${def.name}.`);
      return true;
    }
    session.cardOwners.add(buyer);
    saveUndercoverSessions();
    const civWord = session.pair.civilian;
    await dm(sock, buyer, `🔮 *RADAR SENSOR AKTIF!* 📡\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷️ Kategori Kata Warga: *${session.pair.category}*\n🔤 Huruf Depan: *"${civWord.charAt(0).toUpperCase()}"*\n📏 Panjang Kata: *${civWord.length} karakter*\n\n_Gunakan bocoran ini untuk mengecoh mereka!_`);
    await send(sock, jid, messageObj, `🔮 ${tag(buyer)} mengaktifkan *Radar Sensor* (-${price} Poin). Info rahasia dikirim ke DM!`, { mentions: [buyer] });
    return true;
  }

  const charged = await chargeCard(session, buyer, price);
  if (!charged) {
    await send(sock, jid, messageObj, `❌ Gagal memotong poin untuk ${def.name}.`);
    return true;
  }
  session.cardOwners.add(buyer);

  if (cardType === 'shield') {
    session.shieldedPlayers.add(buyer);
    await send(sock, jid, messageObj, `🛡️ ${tag(buyer)} membeli *Rompi Anti-Peluru* (-${price} Poin)! Kebal dari 1x eksekusi voting sepanjang game.`, { mentions: [buyer] });
  } else {
    session.goldenVoters.add(buyer);
    await send(sock, jid, messageObj, `🌟 ${tag(buyer)} membeli *Golden Vote* (-${price} Poin)! Suaranya bernilai 2x di setiap fase voting.`, { mentions: [buyer] });
  }
  saveUndercoverSessions();
  return true;
}


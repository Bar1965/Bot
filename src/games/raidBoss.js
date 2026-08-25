import * as db from '../../database.js';
import { send, isOnCooldown, randomItem } from './helpers.js';

export const activeRaids = new Map();
export const raidCooldowns = new Map();

const LOBBY_DURATION_MS = 60 * 1000;
const TURN_DURATION_MS = 35 * 1000;

// ─── 1. DAFTAR WORLD BOSS MONSTER ─────────────────────────────
export const BOSS_TEMPLATES = {
  ignis: {
    id: 'ignis',
    name: 'Naga Api Ignis (Fire Drake)',
    emoji: '🐲',
    maxHp: 12000,
    element: 'Api 🔥',
    attack: 280,
    prizepool: 2500,
    xpReward: 600,
    desc: 'Naga purba raksasa bernapas api magma dari kawah gunung berapi.',
    ultimateName: 'Cataclysm Meteor ☄️',
    ultimateDesc: 'Hujan batu meteor dahsyat (600 DMG ke semua anggota tim)'
  },
  malakor: {
    id: 'malakor',
    name: 'Lord Malakor (Necromancer King)',
    emoji: '💀',
    maxHp: 24000,
    element: 'Kegelapan 🌑',
    attack: 420,
    prizepool: 5000,
    xpReward: 1200,
    desc: 'Raja iblis kegelapan yang mampu menyerap jiwa untuk meregenerasi HP.',
    ultimateName: 'Death Sentence ⚡💀',
    ultimateDesc: 'Kutukan maut instan (1000 DMG ke target tanpa perisai)'
  },
  raijin: {
    id: 'raijin',
    name: 'Thunder Titan Raijin (Raksasa Petir)',
    emoji: '⚡',
    maxHp: 45000,
    element: 'Petir ⚡',
    attack: 650,
    prizepool: 9000,
    xpReward: 2000,
    desc: 'Dewa raksasa petir pembawa badai topan bertegangan tinggi.',
    ultimateName: 'Gigavolt Storm ⚡💥',
    ultimateDesc: 'Sambaran badai petir pemusnah massal (900 DMG ke seluruh regu)'
  },
  leviathan: {
    id: 'leviathan',
    name: 'Abyssal Leviathan (Raja Laut Keramat)',
    emoji: '👑',
    maxHp: 80000,
    element: 'Samudra 🌊',
    attack: 950,
    prizepool: 16000,
    xpReward: 4000,
    desc: 'Monster mitologi kuno penguasa palung samudra terdalam.',
    ultimateName: 'Tsunami of Oblivion 🌊🌊',
    ultimateDesc: 'Gelombang tsunami pemusnah massal (1400 DMG ke seluruh tim)'
  }
};

// ─── 2. DAFTAR KELAS & STATS KARAKTER ────────────────────────
export const ROLE_STATS = {
  dps: {
    id: 'dps',
    name: 'Attacker (DPS)',
    emoji: '⚔️',
    hp: 1000,
    desc: 'Damage fisik besar & potensi serangan kritikal.',
    skills: '`.serang` / `.berserk`'
  },
  tank: {
    id: 'tank',
    name: 'Guardian (Tank)',
    emoji: '🛡️',
    hp: 1800,
    desc: 'Darah tebal, pasang perisai penahan damage & taunt boss.',
    skills: '`.tameng` / `.benteng`'
  },
  heal: {
    id: 'heal',
    name: 'Cleric (Healer)',
    emoji: '💖',
    hp: 850,
    desc: 'Penyembuh HP teman, revive teman gugur, & mass heal.',
    skills: '`.heal @teman` / `.massheal` / `.revive @teman`'
  },
  mage: {
    id: 'mage',
    name: 'Archmage (Mage)',
    emoji: '🔮',
    hp: 750,
    desc: 'Sihir penghancur armor & jurus freeze untuk gagalkan ultimate boss.',
    skills: '`.sihir` / `.freeze`'
  }
};

/**
 * Render HP Bar Visual Emoji
 */
function renderHpBar(current, max, length = 12) {
  const safeCurrent = Math.max(0, current);
  const percent = Math.max(0, Math.min(100, Math.round((safeCurrent / max) * 100)));
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}% (${safeCurrent.toLocaleString('id-ID')} / ${max.toLocaleString('id-ID')} HP)`;
}

/**
 * Handle Command Utama Raid Boss
 */
export async function handleRaidCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin = false, isOwner = false) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ *Game Raid World Boss* hanya bisa dimainkan di dalam grup WhatsApp!");
    return true;
  }

  // 1. BATALKAN RAID (.cancelraid / .batalraid)
  if (['cancelraid', 'batalraid'].includes(command)) {
    return await cancelRaid(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  // 2. GABUNG REGU (.joinraid <role>)
  if (['joinraid', 'joinr', 'pilihrole'].includes(command)) {
    return await joinRaid(sock, jid, senderNumber, messageObj, args);
  }

  // 3. MULAI PERTEMPURAN DINI (.startraid / .gasraid)
  if (['startraid', 'gasraid', 'mulairaid'].includes(command)) {
    return await startRaidBattle(sock, jid, senderNumber, messageObj);
  }

  // 4. AKSI PERTEMPURAN (.serang, .atk, .berserk, .tameng, .shield, .benteng, .heal, .massheal, .revive, .sihir, .cast, .freeze, .stun)
  if (['serang', 'atk', 'berserk', 'tameng', 'shield', 'benteng', 'heal', 'massheal', 'revive', 'sihir', 'cast', 'freeze', 'stun'].includes(command)) {
    return await submitPlayerAction(sock, jid, senderNumber, messageObj, args, command);
  }

  // 5. BUKA LOBBY RAID BARU (.raid [boss] / .worldboss [boss])
  if (['raid', 'worldboss', 'bos'].includes(command)) {
    return await openRaidLobby(sock, jid, senderNumber, messageObj, args);
  }

  return false;
}

/**
 * Membuka Lobby Pendaftaran Raid di Grup
 */
async function openRaidLobby(sock, jid, senderNumber, messageObj, args) {
  if (activeRaids.has(jid)) {
    const active = activeRaids.get(jid);
    if (active.status === 'LOBBY') {
      const sisa = Math.max(1, Math.ceil((active.lobbyEndTime - Date.now()) / 1000));
      const pList = Array.from(active.players.values()).map((p, i) => `${i + 1}. ${p.emoji} *${p.name}* (${p.roleName})`).join('\n') || '_Belum ada anggota_';
      await send(sock, jid, messageObj, 
        `⚠️ *LOBBY RAID SUDAH DIBUKA DI GRUP INI!* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🐉 *Target Boss:* ${active.boss.emoji} *${active.boss.name}*\n` +
        `⏳ Sisa Waktu Pendaftaran: *${sisa} detik*\n\n` +
        `👥 *Anggota Regu Terdaftar (${active.players.size} Pemain):*\n${pList}\n\n` +
        `👉 Ketik \`.joinraid <dps/tank/heal/mage>\` untuk bergabung!\n` +
        `👉 Host ketik \`.startraid\` untuk segera memulai.`
      );
      return true;
    } else {
      await send(sock, jid, messageObj, `⚠️ Sedang ada pertempuran Raid yang berlangsung di grup ini melawan ${active.boss.emoji} *${active.boss.name}*! Tunggu hingga selesai.`);
      return true;
    }
  }

  const now = Date.now();
  const lastRaid = raidCooldowns.get(jid) || 0;
  if (now - lastRaid < 20 * 1000) {
    const sisa = Math.ceil((20 * 1000 - (now - lastRaid)) / 1000);
    await send(sock, jid, messageObj, `⏳ Mohon tunggu *${sisa} detik* sebelum membuka pertempuran Raid berikutnya.`);
    return true;
  }

  let chosenBossKey = 'ignis';
  const param = (args[1] || '').toLowerCase();
  if (['ignis', 'naga', 'api', '1'].includes(param)) chosenBossKey = 'ignis';
  else if (['malakor', 'iblis', 'necro', '2'].includes(param)) chosenBossKey = 'malakor';
  else if (['raijin', 'petir', 'titan', '3'].includes(param)) chosenBossKey = 'raijin';
  else if (['leviathan', 'laut', 'levi', '4'].includes(param)) chosenBossKey = 'leviathan';
  else {
    const keys = Object.keys(BOSS_TEMPLATES);
    chosenBossKey = randomItem(keys);
  }

  const bossTemplate = BOSS_TEMPLATES[chosenBossKey];
  const hostCust = await db.getCustomerByPhone(senderNumber);
  const hostName = hostCust?.nama ? hostCust.nama : `@${senderNumber.split('@')[0]}`;

  const session = {
    groupJid: jid,
    hostJid: senderNumber,
    hostName,
    boss: {
      ...bossTemplate,
      hp: bossTemplate.maxHp,
      charge: 0,
      frozen: false,
      armorBreakTurns: 0
    },
    status: 'LOBBY',
    players: new Map(),
    round: 1,
    turnTimer: null,
    lobbyTimer: null,
    lobbyEndTime: Date.now() + LOBBY_DURATION_MS,
    turnEndTime: 0
  };

  // Host otomatis join sebagai Tank/DPS awal atau bebas pilih
  session.lobbyTimer = setTimeout(async () => {
    try {
      if (activeRaids.get(jid)?.status === 'LOBBY') {
        await startRaidBattle(sock, jid, 'SYSTEM', null);
      }
    } catch (e) {
      console.error('[RAID LOBBY TIMEOUT ERROR]', e);
    }
  }, LOBBY_DURATION_MS);

  activeRaids.set(jid, session);

  const lobbyMsg = 
`🐉 *LOBBY RAID WORLD BOSS DIBUKA!* ⚔️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Panggilan untuk seluruh pahlawan grup! Bos monster kuno telah bangkit!

${bossTemplate.emoji} *Target:* *${bossTemplate.name}*
❤️ *Total Darah:* *${bossTemplate.maxHp.toLocaleString('id-ID')} HP* (${bossTemplate.element})
⚔️ *Daya Serang:* *${bossTemplate.attack} ATK*
⚡ *Jurus Maut:* ${bossTemplate.ultimateName}
🎁 *Total Prizepool:* *+${bossTemplate.prizepool.toLocaleString('id-ID')} Poin* & *+${bossTemplate.xpReward} XP*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *PILIHAN KELAS / ROLE PEMAIN:*
1. ⚔️ *Attacker (DPS)* — \`.joinraid dps\` (Damage Tinggi & Crit)
2. 🛡️ *Guardian (Tank)* — \`.joinraid tank\` (Serap 70% Serangan Boss)
3. 💖 *Cleric (Healer)* — \`.joinraid heal\` (Pulihkan HP & Revive)
4. 🔮 *Archmage (Mage)* — \`.joinraid mage\` (Hancurkan Armor & Freeze Boss)

⏳ *Waktu Pendaftaran:* *60 Detik* (Minimal 2 Pemain)
👉 Ketik \`.joinraid <role>\` untuk mendaftar!`;

  await send(sock, jid, messageObj, lobbyMsg, {
    title: '🐉 LOBBY RAID BOSS',
    buttons: [
      { type: 'reply', text: '⚔️ Join DPS (Attacker)', id: '.joinraid dps' },
      { type: 'reply', text: '🛡️ Join Tanker', id: '.joinraid tank' },
      { type: 'reply', text: '💖 Join Healer', id: '.joinraid heal' }
    ]
  });

  return true;
}

/**
 * Handle Pemain Bergabung ke Regu
 */
async function joinRaid(sock, jid, senderNumber, messageObj, args) {
  const session = activeRaids.get(jid);
  if (!session || session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Belum ada lobby Raid yang dibuka di grup ini.\nKetik *.raid* untuk membuka pendaftaran boss battle!");
    return true;
  }

  let roleKey = 'dps';
  const param = (args[1] || '').toLowerCase();
  if (['dps', 'attacker', 'atk', 'warrior', 'serang', '1'].includes(param)) roleKey = 'dps';
  else if (['tank', 'tanker', 'guardian', 'paladin', 'tameng', '2'].includes(param)) roleKey = 'tank';
  else if (['heal', 'healer', 'cleric', 'priest', 'dokter', 'obat', '3'].includes(param)) roleKey = 'heal';
  else if (['mage', 'sihir', 'archmage', 'wizard', 'debuff', '4'].includes(param)) roleKey = 'mage';
  else {
    await send(sock, jid, messageObj, "⚠️ Pilihan role tidak valid! Gunakan: `.joinraid dps`, `.joinraid tank`, `.joinraid heal`, atau `.joinraid mage`.");
    return true;
  }

  const roleData = ROLE_STATS[roleKey];
  const cust = await db.getCustomerByPhone(senderNumber);
  const playerName = cust?.nama ? cust.nama : `@${senderNumber.split('@')[0]}`;

  session.players.set(senderNumber, {
    jid: senderNumber,
    name: playerName,
    roleKey,
    roleName: roleData.name,
    emoji: roleData.emoji,
    hp: roleData.hp,
    maxHp: roleData.hp,
    isAlive: true,
    action: null,
    actionTarget: null,
    cooldowns: { berserk: 0, massheal: 0, revive: 0, freeze: 0, benteng: 0 },
    shieldActive: false,
    bentengActive: false,
    damageDealt: 0,
    healingDone: 0,
    damageAbsorbed: 0
  });

  const pCount = session.players.size;
  await send(sock, jid, messageObj, `✅ @${senderNumber.split('@')[0]} berhasil bergabung sebagai ${roleData.emoji} *${roleData.name}*!\n👥 *Total Anggota Regu:* *${pCount} Pemain*`, {
    mentions: [senderNumber]
  });

  return true;
}

/**
 * Memulai Pertempuran Boss (Start Battle)
 */
async function startRaidBattle(sock, jid, senderNumber, messageObj) {
  const session = activeRaids.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.size < 1) {
    if (senderNumber !== 'SYSTEM') {
      await send(sock, jid, messageObj, "⚠️ Minimal harus ada 1 pemain yang bergabung untuk memulai Raid!");
    }
    return true;
  }

  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
  session.status = 'BATTLE';
  session.round = 1;

  const playerList = Array.from(session.players.values())
    .map((p, i) => `${i + 1}. ${p.emoji} *${p.name}* — HP: ${p.hp}/${p.maxHp} [${p.roleName}]`)
    .join('\n');

  const startMsg = 
`⚔️ *PERTEMPURAN RAID DIMULAI!* 🐲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Regu pahlawan telah memasuki arena sarang ${session.boss.emoji} *${session.boss.name}*!

❤️ *Boss HP:* ${renderHpBar(session.boss.hp, session.boss.maxHp)}
⚔️ *Serangan Boss:* ${session.boss.attack} ATK

👥 *REGU RAID (${session.players.size} Pemain):*
${playerList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Ketik Perintah Aksimu Sekarang (35 Detik):*
• ⚔️ DPS: \`.serang\` (Serangan Fisik) atau \`.berserk\`
• 🛡️ Tank: \`.tameng\` (Serap 70% Serangan Tim) atau \`.benteng\`
• 💖 Healer: \`.heal @teman\` / \`.heal\` atau \`.massheal\`
• 🔮 Mage: \`.sihir\` (Pecahkan Armor) atau \`.freeze\` (Gagalkan Ulti)`;

  await send(sock, jid, null, startMsg, {
    title: '⚔️ RONDE 1 DIMULAI',
    buttons: [
      { type: 'reply', text: '⚔️ Serang Boss (.serang)', id: '.serang' },
      { type: 'reply', text: '🛡️ Pasang Tameng (.tameng)', id: '.tameng' },
      { type: 'reply', text: '💖 Pulihkan Tim (.heal)', id: '.heal' }
    ]
  });

  scheduleTurnResolution(sock, session);
  return true;
}

/**
 * Handle Pengiriman Aksi Pemain di Setiap Ronde
 */
async function submitPlayerAction(sock, jid, senderNumber, messageObj, args, command) {
  const session = activeRaids.get(jid);
  if (!session || session.status !== 'BATTLE') return false;

  const player = session.players.get(senderNumber);
  if (!player) {
    await send(sock, jid, messageObj, "⚠️ Kamu bukan anggota regu pertempuran Raid ini.");
    return true;
  }

  if (!player.isAlive) {
    await send(sock, jid, messageObj, `💀 Kamu sedang gugur (K.O.)! Tunggu Healer menggunakan \`.revive @kamu\` untuk bangkit kembali.`);
    return true;
  }

  // Cek Cooldown Skill
  if (command === 'berserk' && player.cooldowns.berserk > 0) {
    await send(sock, jid, messageObj, `⏳ Skill Berserk sedang cooldown selama *${player.cooldowns.berserk} ronde* lagi.`);
    return true;
  }
  if (command === 'massheal' && player.cooldowns.massheal > 0) {
    await send(sock, jid, messageObj, `⏳ Skill Mass Heal sedang cooldown selama *${player.cooldowns.massheal} ronde* lagi.`);
    return true;
  }
  if (command === 'revive' && player.cooldowns.revive > 0) {
    await send(sock, jid, messageObj, `⏳ Skill Revive sedang cooldown selama *${player.cooldowns.revive} ronde* lagi.`);
    return true;
  }
  if (['freeze', 'stun'].includes(command) && player.cooldowns.freeze > 0) {
    await send(sock, jid, messageObj, `⏳ Skill Freeze sedang cooldown selama *${player.cooldowns.freeze} ronde* lagi.`);
    return true;
  }
  if (command === 'benteng' && player.cooldowns.benteng > 0) {
    await send(sock, jid, messageObj, `⏳ Skill Benteng Pertahanan sedang cooldown selama *${player.cooldowns.benteng} ronde* lagi.`);
    return true;
  }

  // Parse Target jika Heal / Revive
  let targetJid = null;
  if (['heal', 'revive'].includes(command)) {
    const contextInfo = messageObj?.message?.extendedTextMessage?.contextInfo;
    const mentions = contextInfo?.mentionedJid || [];
    targetJid = mentions[0] || contextInfo?.participant;

    if (!targetJid && args[1]) {
      const cleanNum = args[1].replace(/[^0-9]/g, '');
      if (cleanNum.length > 5) targetJid = `${cleanNum}@s.whatsapp.net`;
    }
  }

  player.action = command;
  player.actionTarget = targetJid;

  await send(sock, jid, messageObj, `✨ *AKSI DICATAT:* ${player.emoji} *${player.name}* bersiap melakukan \`.${command}\` pada akhir ronde!`, {
    mentions: [senderNumber]
  });

  // Cek apakah seluruh pemain hidup sudah mengirim aksi
  const alivePlayers = Array.from(session.players.values()).filter(p => p.isAlive);
  const allActed = alivePlayers.every(p => p.action !== null);

  if (allActed) {
    if (session.turnTimer) clearTimeout(session.turnTimer);
    await executeRoundResolution(sock, session);
  }

  return true;
}

/**
 * Jadwalkan Timeout Ronde (35 Detik)
 */
function scheduleTurnResolution(sock, session) {
  if (session.turnTimer) clearTimeout(session.turnTimer);
  session.turnEndTime = Date.now() + TURN_DURATION_MS;

  session.turnTimer = setTimeout(async () => {
    try {
      if (activeRaids.get(session.groupJid)?.status === 'BATTLE') {
        await executeRoundResolution(sock, session);
      }
    } catch (e) {
      console.error('[RAID TURN RESOLUTION ERROR]', e);
    }
  }, TURN_DURATION_MS);
}

/**
 * Eksekusi Perhitungan Hasil Ronde
 */
async function executeRoundResolution(sock, session) {
  const { boss, players, groupJid } = session;
  const logs = [];

  logs.push(`⚔️ *HASIL PERTEMPURAN — RONDE ${session.round}* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // 1. Eksekusi Aksi Pemain Terlebih Dahulu
  for (const player of players.values()) {
    if (!player.isAlive) continue;

    // Fallback jika AFK / tidak memilih aksi
    const action = player.action || (player.roleKey === 'tank' ? 'tameng' : (player.roleKey === 'heal' ? 'heal' : 'serang'));

    if (action === 'serang' || action === 'atk') {
      const isCrit = Math.random() < 0.25;
      let dmg = Math.floor(Math.random() * 350) + 400; // 400 - 750
      if (isCrit) dmg = Math.floor(dmg * 1.5);
      if (boss.armorBreakTurns > 0) dmg = Math.floor(dmg * 1.25);

      boss.hp -= dmg;
      player.damageDealt += dmg;
      logs.push(`🗡️ ${player.emoji} *${player.name}* menebaskan pedang! *-${dmg.toLocaleString('id-ID')} HP* ${isCrit ? '💥 *(CRITICAL!)*' : ''}`);

    } else if (action === 'berserk') {
      let dmg = Math.floor(Math.random() * 650) + 850; // 850 - 1500
      if (boss.armorBreakTurns > 0) dmg = Math.floor(dmg * 1.25);

      boss.hp -= dmg;
      player.hp = Math.max(1, player.hp - 150);
      player.damageDealt += dmg;
      player.cooldowns.berserk = 3;
      logs.push(`🔥 ${player.emoji} *${player.name}* mengamuk dalam mode *BERSERK*! *-${dmg.toLocaleString('id-ID')} HP* ke Boss (Recoil -150 HP).`);

    } else if (action === 'tameng' || action === 'shield') {
      player.shieldActive = true;
      const dmg = Math.floor(Math.random() * 150) + 150;
      boss.hp -= dmg;
      player.damageDealt += dmg;
      logs.push(`🛡️ ${player.emoji} *${player.name}* membentangkan perisai baja suci! *(Menahan 70% damage ke tim)*`);

    } else if (action === 'benteng') {
      player.bentengActive = true;
      player.cooldowns.benteng = 3;
      logs.push(`🏰 ${player.emoji} *${player.name}* mendirikan *Benteng Kekebalan Absolut* untuk tim ronde ini!`);

    } else if (action === 'heal') {
      // Cari target: dari mention atau cari teman dengan HP terendah
      let target = players.get(player.actionTarget);
      if (!target || !target.isAlive) {
        const alives = Array.from(players.values()).filter(p => p.isAlive).sort((a, b) => a.hp - b.hp);
        target = alives[0] || player;
      }

      const healAmt = Math.floor(Math.random() * 400) + 450; // 450 - 850
      const oldHp = target.hp;
      target.hp = Math.min(target.maxHp, target.hp + healAmt);
      const actualHeal = target.hp - oldHp;
      player.healingDone += actualHeal;

      // Beri sedikit holy damage
      boss.hp -= 150;
      logs.push(`💖 ${player.emoji} *${player.name}* memulihkan *+${actualHeal} HP* untuk *${target.name}* (HP: ${target.hp}/${target.maxHp}).`);

    } else if (action === 'massheal') {
      let totalMass = 0;
      for (const p of players.values()) {
        if (p.isAlive) {
          const old = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + 300);
          totalMass += (p.hp - old);
        }
      }
      player.healingDone += totalMass;
      player.cooldowns.massheal = 3;
      logs.push(`✨ ${player.emoji} *${player.name}* melantunkan *Doa Penyembuhan Massal*! *+300 HP* ke seluruh tim.`);

    } else if (action === 'revive') {
      let target = players.get(player.actionTarget);
      if (!target || target.isAlive) {
        const deads = Array.from(players.values()).filter(p => !p.isAlive);
        target = deads[0];
      }

      if (target) {
        target.isAlive = true;
        target.hp = 500;
        player.cooldowns.revive = 4;
        logs.push(`🕊️ ${player.emoji} *${player.name}* membangkitkan *${target.name}* dari kematian dengan 500 HP!`);
      } else {
        logs.push(`💖 ${player.emoji} *${player.name}* menyalurkan energi suci (tidak ada teman gugur).`);
      }

    } else if (action === 'sihir' || action === 'cast') {
      let dmg = Math.floor(Math.random() * 400) + 500; // 500 - 900
      boss.hp -= dmg;
      boss.armorBreakTurns = 2;
      player.damageDealt += dmg;
      logs.push(`🔮 ${player.emoji} *${player.name}* menembakkan *Meteor Arcane*! *-${dmg.toLocaleString('id-ID')} HP* & Armor Boss Pecah *(Armor Break +25% DMG)*.`);

    } else if (action === 'freeze' || action === 'stun') {
      boss.frozen = true;
      boss.charge = 0;
      player.cooldowns.freeze = 3;
      const dmg = 350;
      boss.hp -= dmg;
      player.damageDealt += dmg;
      logs.push(`❄️ ${player.emoji} *${player.name}* membekukan Boss dengan *Frostbite Stun*! *(Ultimate Charge Boss Digagalkan!)*`);
    }
  }

  // 2. CEK APAKAH BOSS SUDAH MATI
  if (boss.hp <= 0) {
    boss.hp = 0;
    activeRaids.delete(groupJid);
    raidCooldowns.set(groupJid, Date.now());
    await resolveVictory(sock, session, logs);
    return;
  }

  logs.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👹 *GILIRAN SERANGAN BALIK BOSS:*');

  // 3. Serangan Balik Boss
  if (boss.frozen) {
    logs.push(`❄️ ${boss.emoji} *${boss.name}* membeku dan tidak dapat bergerak ronde ini!`);
    boss.frozen = false;
  } else {
    // Cek apakah ada Tanker dengan benteng aktif
    const hasBenteng = Array.from(players.values()).some(p => p.isAlive && p.bentengActive);
    const hasShieldTank = Array.from(players.values()).find(p => p.isAlive && p.shieldActive);

    // KONDISI ULTIMATE
    if (boss.charge >= 1) {
      logs.push(`💥 ${boss.emoji} *${boss.name}* MELEPASKAN JURUS PAMUNGKAS: *${boss.ultimateName}*!`);
      let ultDmg = boss.attack * 2;

      if (hasBenteng) {
        logs.push(`🏰 Benteng pertahanan tim menahan seluruh ledakan ultimate! (0 Damage).`);
      } else {
        if (hasShieldTank) {
          ultDmg = Math.floor(ultDmg * 0.35); // Berkurang drastis
          hasShieldTank.damageAbsorbed += ultDmg;
          logs.push(`🛡️ Perisai *${hasShieldTank.name}* menyerap sebagian besar ledakan ultimate!`);
        }

        for (const p of players.values()) {
          if (p.isAlive) {
            p.hp -= ultDmg;
            if (p.hp <= 0) {
              p.hp = 0;
              p.isAlive = false;
              logs.push(`💀 *${p.name}* terkena ${ultDmg} DMG dan GUGUR (K.O.)!`);
            } else {
              logs.push(`💢 *${p.name}* terkena *-${ultDmg} HP* (Sisa: ${p.hp}/${p.maxHp}).`);
            }
          }
        }
      }
      boss.charge = 0;

    } else {
      // Regular Attack / Charging Ultimate
      const shouldCharge = Math.random() < 0.35 && session.round > 1;
      if (shouldCharge) {
        boss.charge = 1;
        logs.push(`⚠️ ${boss.emoji} *${boss.name}* mulai menghimpun energi kuno! 🔥 *Bersiap melancarkan ${boss.ultimateName} pada ronde berikutnya!*`);
      } else {
        let baseDmg = boss.attack;
        if (hasBenteng) {
          logs.push(`🏰 Serangan biasa boss terpental oleh Benteng Pertahanan!`);
        } else {
          if (hasShieldTank) {
            baseDmg = Math.floor(baseDmg * 0.35);
            hasShieldTank.damageAbsorbed += baseDmg;
            logs.push(`🛡️ Perisai *${hasShieldTank.name}* menyerap 65% damage serangan boss!`);
          }

          // Serang semua pemain hidup dengan split damage
          for (const p of players.values()) {
            if (p.isAlive) {
              const personalDmg = Math.floor(baseDmg * (0.8 + Math.random() * 0.4));
              p.hp -= personalDmg;
              if (p.hp <= 0) {
                p.hp = 0;
                p.isAlive = false;
                logs.push(`💀 *${p.name}* terkena ${personalDmg} DMG dan GUGUR!`);
              } else {
                logs.push(`💢 *${p.name}* menerima *-${personalDmg} HP* (Sisa: ${p.hp}/${p.maxHp}).`);
              }
            }
          }
        }
      }
    }
  }

  // 4. CEK APAKAH SELURUH ANGGOTA REGU MATI
  const stillAlive = Array.from(players.values()).filter(p => p.isAlive);
  if (stillAlive.length === 0) {
    activeRaids.delete(groupJid);
    raidCooldowns.set(groupJid, Date.now());
    await resolveDefeat(sock, session, logs);
    return;
  }

  // 5. Kurangi Cooldown Skill & Reset Status Turn
  for (const p of players.values()) {
    p.action = null;
    p.actionTarget = null;
    p.shieldActive = false;
    p.bentengActive = false;
    for (const k in p.cooldowns) {
      if (p.cooldowns[k] > 0) p.cooldowns[k]--;
    }
  }
  if (boss.armorBreakTurns > 0) boss.armorBreakTurns--;
  session.round++;

  // 6. Tampilkan Status Update Ronde Berikutnya
  const playerStatus = Array.from(players.values())
    .map(p => `${p.emoji} *${p.name}* — ${p.isAlive ? `HP: *${p.hp}/${p.maxHp}*` : '💀 *K.O.*'}`)
    .join('\n');

  const roundSummary = 
`${logs.join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🐲 *STATUS TERKINI BOS:*
${renderHpBar(boss.hp, boss.maxHp)}
${boss.charge > 0 ? '⚠️ 🔥 *PERINGATAN: BOS SEDANG MENGUMPULKAN ENERGI ULTIMATE!*' : ''}

👥 *STATUS REGU:*
${playerStatus}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Kirim Aksi Ronde ${session.round} Sekarang (35 Detik):*
• DPS: \`.serang\` / \`.berserk\`
• Tank: \`.tameng\` / \`.benteng\`
• Healer: \`.heal @teman\` / \`.massheal\` / \`.revive @teman\`
• Mage: \`.sihir\` / \`.freeze\``;

  await send(sock, groupJid, null, roundSummary, {
    title: `⚔️ RONDE ${session.round}`,
    buttons: [
      { type: 'reply', text: '⚔️ Serang (.serang)', id: '.serang' },
      { type: 'reply', text: '🛡️ Tameng (.tameng)', id: '.tameng' },
      { type: 'reply', text: '💖 Heal (.heal)', id: '.heal' }
    ]
  });

  scheduleTurnResolution(sock, session);
}

/**
 * Handle Kemenangan Raid (Boss Kalah)
 */
async function resolveVictory(sock, session, battleLogs) {
  const { boss, players, groupJid } = session;
  const mentions = Array.from(players.keys());

  // Hitung MVP Damager & MVP Supporter
  let topDamager = null;
  let topSupport = null;
  let maxDmg = -1;
  let maxSupp = -1;

  for (const p of players.values()) {
    if (p.damageDealt > maxDmg) {
      maxDmg = p.damageDealt;
      topDamager = p;
    }
    const suppScore = p.healingDone + p.damageAbsorbed;
    if (suppScore > maxSupp && suppScore > 0) {
      maxSupp = suppScore;
      topSupport = p;
    }
  }

  const baseReward = Math.floor(boss.prizepool / Math.max(1, players.size));
  const baseExp = Math.floor(boss.xpReward / Math.max(1, players.size));

  for (const p of players.values()) {
    let finalPoin = baseReward;
    let finalXp = baseExp;

    if (topDamager && p.jid === topDamager.jid) finalPoin += Math.floor(baseReward * 0.35);
    if (topSupport && p.jid === topSupport.jid) finalPoin += Math.floor(baseReward * 0.25);

    await db.awardGamePoints(p.jid, finalPoin, true);
    await db.addMessageXp(p.jid, finalXp);
  }

  const victoryMsg = 
`${battleLogs.join('\n')}

🏆 *VICTORY! WORLD BOSS BERHASIL DITUMBANGKAN!* 🎉
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selamat kepada seluruh regu pahlawan! ${boss.emoji} *${boss.name}* telah binasa!

🎁 *Total Prizepool Dibagikan:* *+${boss.prizepool.toLocaleString('id-ID')} Akbar Poin*
⭐ *Total XP Regu:* *+${boss.xpReward.toLocaleString('id-ID')} XP*

👑 *PENGHARGAAN GELAR MVP:*
🥇 *MVP Top Damager:* ${topDamager ? `${topDamager.emoji} *${topDamager.name}* (*${topDamager.damageDealt.toLocaleString('id-ID')} Total DMG*)` : '-'}
💖 *MVP Best Support:* ${topSupport ? `${topSupport.emoji} *${topSupport.name}* (*${(topSupport.healingDone + topSupport.damageAbsorbed).toLocaleString('id-ID')} Heal/Absorb*)` : '-'}

_Semua poin & bonus XP telah masuk ke profil masing-masing anggota. Ketik \`.raid\` untuk tantangan berikutnya!_`;

  await send(sock, groupJid, null, victoryMsg, {
    title: '🏆 VICTORY WORLD BOSS',
    buttons: [
      { type: 'reply', text: '🐉 Main Raid Lagi', id: '.raid' },
      { type: 'reply', text: '👤 Cek Poin', id: '.poin' },
      { type: 'reply', text: '🎮 Menu Game', id: '.menu game' }
    ],
    mentions
  });
}

/**
 * Handle Kekalahan Regu (Seluruh Pemain Gugur)
 */
async function resolveDefeat(sock, session, battleLogs) {
  const { boss, groupJid, players } = session;
  const mentions = Array.from(players.keys());

  // Berikan sedikit XP hiburan
  for (const p of players.values()) {
    await db.addMessageXp(p.jid, 50);
  }

  const defeatMsg = 
`${battleLogs.join('\n')}

💀 *DEFEAT — SELURUH REGU TELAH GUGUR!* 🪦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kekuatan ${boss.emoji} *${boss.name}* terlalu dahsyat! Seluruh pahlawan telah terkapar dan boss kembali ke sarangnya.

🎁 *Kompensasi Pengalaman:* +50 XP per pemain.
💡 *Evaluasi Tim:* Pastikan regu memiliki kombinasi seimbang antara *Tanker (penahan damage)*, *Healer (pemulih)*, dan *Mage (penggagalkan ultimate)*!

_Ketik \`.raid\` kapan saja untuk mencoba kembali dengan strategi baru._`;

  await send(sock, groupJid, null, defeatMsg, {
    title: '💀 DEFEAT',
    buttons: [
      { type: 'reply', text: '🔄 Buka Lobby Baru', id: '.raid' },
      { type: 'reply', text: '🎮 Menu Game', id: '.menu game' }
    ],
    mentions
  });
}

/**
 * Batalkan Sesi Raid
 */
async function cancelRaid(sock, jid, senderNumber, messageObj, isAdmin, isOwner) {
  const session = activeRaids.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi pertempuran Raid yang aktif di grup ini.");
    return true;
  }

  const isHost = session.hostJid === senderNumber;
  if (!isHost && !isAdmin && !isOwner) {
    await send(sock, jid, messageObj, "⚠️ Hanya Host pembuka lobby atau Admin grup yang dapat membatalkan sesi Raid!");
    return true;
  }

  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
  if (session.turnTimer) clearTimeout(session.turnTimer);
  activeRaids.delete(jid);

  await send(sock, jid, messageObj, `🛑 *RAID DIBATALKAN!* Pertempuran melawan ${session.boss.emoji} *${session.boss.name}* telah dibatalkan.`);
  return true;
}

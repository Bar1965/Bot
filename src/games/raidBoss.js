/**
 * RAID WORLD BOSS — pertempuran co-op 4 kelas di grup.
 *
 * Catatan desain penting (dipakai saat menyetel ulang angka):
 *
 * 1. `baseHp` setiap boss dikalibrasi untuk regu 4 pemain. Jumlah pemain
 *    sebenarnya mengubah HP & serangan boss lewat `faktorHp()`/`faktorAtk()`,
 *    supaya duo tidak menghadapi tembok 80.000 HP dan grup ramai tidak
 *    membunuh boss di ronde pertama.
 * 2. Hadiah dihitung PER PEMAIN (`poinPemain`), bukan membagi satu prizepool.
 *    Membagi prizepool menghukum grup ramai padahal grup ramai justru menang
 *    lebih mudah — dan sekarang HP boss sudah ikut naik, jadi tidak ada
 *    alasan memotong hadiah lagi.
 * 3. Setiap hadiah dikalikan rasio partisipasi (aksi yang benar-benar dikirim
 *    dibagi ronde yang diikuti). Ikut lobby lalu diam tidak lagi dibayar penuh.
 * 4. Pertempuran punya batas: mulai `ENRAGE_ROUND` boss mengamuk dan pada
 *    `MAX_ROUND` regu otomatis kalah. Tanpa ini regu bertahan bisa memutar
 *    `.benteng`/`.tameng` selamanya.
 *
 * Sesi yang sedang bertempur disimpan ke `data/raid_state.json` dan dipulihkan
 * saat bot kembali online, mengikuti pola yang sama dengan Undercover.
 */

import fs from 'fs';
import path from 'path';
import * as db from '../../database.js';
import { send, randomItem } from './helpers.js';

export const activeRaids = new Map();
/** Disimpan untuk kompatibilitas; cooldown asli sekarang ada di DB. */
export const raidCooldowns = new Map();

const STATE_FILE = path.join(process.cwd(), 'data', 'raid_state.json');

// ─── KONSTANTA BALANCE (semua tuas penyetelan ada di sini) ───────────
const LOBBY_DURATION_MS = 60 * 1000;
const TURN_DURATION_MS = 35 * 1000;
const MIN_PLAYERS = 2;              // lobby memang menjanjikan minimal 2
const LOBBY_COOLDOWN_MS = 60 * 1000; // jeda antar lobby di grup yang sama

const ENRAGE_ROUND = 8;             // mulai ronde ini serangan boss menanjak
const ENRAGE_STEP = 0.20;           // +20% damage boss per ronde setelahnya
const MAX_ROUND = 15;               // lewat ini regu dianggap gugur kehabisan tenaga
const PHASE2_RATIO = 0.30;          // HP boss <30% -> mode MURKA

const SHIELD_CAP_RATIO = 0.60;      // shield maksimum 60% dari maxHp pemain
const SHIELD_DECAY = 0.50;          // sisa shield luruh 50% tiap akhir ronde
const TAMENG_SHIELD = 500;

const ROLE_CAP_RATIO = 0.60;        // satu role maksimal 60% regu (mulai 4 pemain)
const FORMASI_MIN_ROLE = 3;         // >=3 role berbeda -> bonus Formasi Lengkap
const FORMASI_DMG_BONUS = 1.15;
const FORMASI_TAHAN_BONUS = 0.90;

const JOIN_TENGAH_HP_RATIO = 0.70;  // HP pendatang di tengah pertempuran
const PARTISIPASI_MIN = 0.25;       // lantai rasio anti-leech

const SIHIR_UNGGUL = 1.60;
const SIHIR_NETRAL = 1.00;
const SIHIR_TAHAN = 0.45;

// ─── 1. ELEMEN SIHIR MAGE ────────────────────────────────────────────
export const SIHIR_ELEMEN = {
  api: { nama: 'Api', emoji: '🔥' },
  air: { nama: 'Air', emoji: '💧' },
  petir: { nama: 'Petir', emoji: '⚡' },
  tanah: { nama: 'Tanah', emoji: '🌿' },
  cahaya: { nama: 'Cahaya', emoji: '✨' }
};

const ALIAS_ELEMEN = {
  api: 'api', fire: 'api', bara: 'api',
  air: 'air', water: 'air', es: 'air', ice: 'air', frost: 'air',
  petir: 'petir', listrik: 'petir', thunder: 'petir', lightning: 'petir',
  tanah: 'tanah', bumi: 'tanah', earth: 'tanah', batu: 'tanah',
  cahaya: 'cahaya', terang: 'cahaya', suci: 'cahaya', holy: 'cahaya', light: 'cahaya'
};

// ─── 2. DAFTAR WORLD BOSS MONSTER ────────────────────────────────────
// `baseHp` & `attack` dikalibrasi untuk regu 4 pemain (lihat catatan di atas).
export const BOSS_TEMPLATES = {
  ignis: {
    id: 'ignis',
    name: 'Naga Api Ignis (Fire Drake)',
    emoji: '🐲',
    tier: 1,
    baseHp: 20000,
    attack: 300,
    element: 'Api 🔥',
    lemah: 'air',
    tahan: 'api',
    targetRonde: 5,
    cooldownMenit: 5,
    poinPemain: 400,
    xpPemain: 120,
    desc: 'Naga purba raksasa bernapas api magma dari kawah gunung berapi.',
    ultimateName: 'Cataclysm Meteor ☄️',
    ultimateDesc: 'Hujan batu meteor dahsyat ke seluruh anggota regu',
    mekanik: 'bara',
    mekanikNama: 'Bara Membakar 🔥',
    mekanikDesc: 'Serangan Ignis meninggalkan luka bakar *-140 HP tiap ronde* sampai disembuhkan Healer.',
    loot: { peluang: 0.30, rarity: ['COMMON', 'COMMON', 'RARE'], mvp: 'RARE' }
  },
  malakor: {
    id: 'malakor',
    name: 'Lord Malakor (Necromancer King)',
    emoji: '💀',
    tier: 2,
    baseHp: 30000,
    attack: 420,
    element: 'Kegelapan 🌑',
    lemah: 'cahaya',
    tahan: 'tanah',
    targetRonde: 7,
    cooldownMenit: 15,
    poinPemain: 850,
    xpPemain: 250,
    desc: 'Raja iblis kegelapan yang mampu menyerap jiwa untuk meregenerasi HP.',
    ultimateName: 'Death Sentence ⚡💀',
    ultimateDesc: 'Kutukan maut instan ke seluruh regu',
    mekanik: 'lifesteal',
    mekanikNama: 'Serapan Jiwa 🩸',
    mekanikDesc: 'Malakor menyerap *25% damage* yang diterimanya menjadi HP. Regu harus burst, bukan mengulur.',
    loot: { peluang: 0.40, rarity: ['COMMON', 'RARE', 'RARE'], mvp: 'EPIC' }
  },
  raijin: {
    id: 'raijin',
    name: 'Thunder Titan Raijin (Raksasa Petir)',
    emoji: '⚡',
    tier: 3,
    baseHp: 40000,
    attack: 560,
    element: 'Petir ⚡',
    lemah: 'tanah',
    tahan: 'petir',
    targetRonde: 9,
    cooldownMenit: 30,
    poinPemain: 1500,
    xpPemain: 420,
    desc: 'Dewa raksasa petir pembawa badai topan bertegangan tinggi.',
    ultimateName: 'Gigavolt Storm ⚡💥',
    ultimateDesc: 'Sambaran badai petir pemusnah massal',
    mekanik: 'chain',
    mekanikNama: 'Chain Lightning ⚡⛓️',
    mekanikDesc: 'Serangan biasa hanya menyambar *2 pemain acak* tapi *menembus perisai* dengan damage 1,5x.',
    loot: { peluang: 0.50, rarity: ['RARE', 'RARE', 'EPIC'], mvp: 'EPIC' }
  },
  leviathan: {
    id: 'leviathan',
    name: 'Abyssal Leviathan (Raja Laut Keramat)',
    emoji: '👑',
    tier: 4,
    baseHp: 52000,
    attack: 700,
    element: 'Samudra 🌊',
    lemah: 'petir',
    tahan: 'air',
    targetRonde: 11,
    cooldownMenit: 60,
    poinPemain: 2400,
    xpPemain: 650,
    desc: 'Monster mitologi kuno penguasa palung samudra terdalam.',
    ultimateName: 'Tsunami of Oblivion 🌊🌊',
    ultimateDesc: 'Gelombang tsunami pemusnah massal',
    mekanik: 'cengkeram',
    mekanikNama: 'Tentakel Cengkeram 🐙',
    mekanikDesc: 'Satu pemain dicengkeram (tidak bisa beraksi & -180 HP/ronde) sampai rekan lain menyerang untuk melepaskannya.',
    loot: { peluang: 0.60, rarity: ['RARE', 'EPIC', 'EPIC'], mvp: 'LEGENDARY' }
  },
  erebus: {
    id: 'erebus',
    name: 'Erebus Sang Kehampaan (NIGHTMARE)',
    emoji: '🕳️',
    tier: 5,
    baseHp: 65000,
    attack: 850,
    element: 'Kehampaan 🕳️',
    lemah: null,          // kelemahan berganti tiap ronde (lihat elemenAcak)
    tahan: null,
    elemenAcak: true,
    unlock: 'leviathan',  // hanya terbuka kalau grup pernah menumbangkan Leviathan
    targetRonde: 13,
    cooldownMenit: 90,
    poinPemain: 3800,
    xpPemain: 1000,
    desc: 'Entitas tanpa wujud dari celah antar dunia. Hukumnya sendiri, berubah tiap ronde.',
    ultimateName: 'Void Collapse 🕳️💥',
    ultimateDesc: 'Keruntuhan ruang hampa yang melumat seluruh regu',
    mekanik: 'kacau',
    mekanikNama: 'Hukum Yang Berubah 🎲',
    mekanikDesc: 'Kelemahan elemennya berganti tiap ronde dan mekanik boss lain dipinjam secara acak.',
    loot: { peluang: 0.75, rarity: ['EPIC', 'EPIC', 'LEGENDARY'], mvp: 'MYTHIC' }
  }
};

const MEKANIK_PINJAMAN = ['bara', 'lifesteal', 'chain', 'cengkeram'];

/**
 * Setiap skill terkunci ke kelasnya.
 *
 * Dulu semua command terbuka untuk semua role, jadi strategi paling optimal
 * adalah seluruh regu mengetik `.serang` — Healer sekalipun. Dengan batas
 * komposisi role dan bonus Formasi Lengkap, kunci ini yang membuat pemilihan
 * kelas benar-benar berarti.
 */
const SKILL_ROLE = {
  serang: 'dps', atk: 'dps', berserk: 'dps',
  tameng: 'tank', shield: 'tank', taunt: 'tank', provokasi: 'tank', provoke: 'tank', benteng: 'tank',
  heal: 'heal', massheal: 'heal', revive: 'heal',
  sihir: 'mage', cast: 'mage', freeze: 'mage', stun: 'mage'
};

// ─── 3. DAFTAR KELAS & STATS KARAKTER ────────────────────────────────
export const ROLE_STATS = {
  dps: {
    id: 'dps',
    name: 'Attacker (DPS)',
    emoji: '⚔️',
    hp: 1400,
    desc: 'Damage fisik monster & potensi serangan kritikal mematikan (800 - 1300 DMG).',
    skills: '`.serang` / `.berserk`'
  },
  tank: {
    id: 'tank',
    name: 'Guardian (Tank)',
    emoji: '🛡️',
    hp: 2600,
    desc: 'Darah tebal, pasif Iron Skin (-40% DMG), perisai tim & skill Taunt pasang badan.',
    skills: '`.tameng` / `.taunt` / `.benteng`'
  },
  heal: {
    id: 'heal',
    name: 'Cleric (Healer)',
    emoji: '💖',
    hp: 1200,
    desc: 'Penyembuh HP andal (600 - 1100 HP), pembersih luka bakar, revive teman gugur & mass heal.',
    skills: '`.heal @teman` / `.massheal` / `.revive @teman`'
  },
  mage: {
    id: 'mage',
    name: 'Archmage (Mage)',
    emoji: '🔮',
    hp: 1100,
    desc: 'Sihir elemental penghancur armor (+35% DMG Fisik) & jurus freeze gagalkan ultimate boss.',
    skills: '`.sihir <elemen>` / `.freeze`'
  }
};

// ─── 4. UTILITAS ─────────────────────────────────────────────────────

/** HP boss dikalibrasi untuk 4 pemain; 1 pemain 0,55x, 8 pemain 1,60x. */
function faktorHp(jumlahPemain) {
  const n = Math.max(1, Math.min(12, jumlahPemain));
  return 0.40 + 0.15 * n;
}

/** Serangan boss ikut naik tipis supaya regu besar tidak jadi kebal. */
function faktorAtk(jumlahPemain) {
  const n = Math.max(1, Math.min(12, jumlahPemain));
  return Math.min(1.35, 0.85 + 0.0375 * n);
}

function normalisasiElemen(teks) {
  const key = String(teks || '').toLowerCase().trim();
  return ALIAS_ELEMEN[key] || null;
}

/**
 * Konteks raid di sebuah grup untuk keperluan routing command.
 *
 * `.heal` dan `.revive` dipakai bersama oleh Healer Raid Boss dan Dokter
 * Undercover. Router memakai fungsi ini untuk tahu apakah command itu memang
 * ditujukan ke raid, tanpa mengirim pesan apa pun.
 */
export function getRaidContext(jid, senderNumber) {
  const session = activeRaids.get(jid);
  if (!session) return { adaSesi: false, anggota: false, status: null };
  return {
    adaSesi: true,
    anggota: session.players?.has(senderNumber) === true,
    status: session.status
  };
}

/** Render HP Bar Visual Emoji */
function renderHpBar(current, max, length = 12) {
  const safeCurrent = Math.max(0, current);
  const safeMax = Math.max(1, max);
  const percent = Math.max(0, Math.min(100, Math.round((safeCurrent / safeMax) * 100)));
  const filled = Math.round((percent / 100) * length);
  const empty = Math.max(0, length - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}% (${safeCurrent.toLocaleString('id-ID')} / ${safeMax.toLocaleString('id-ID')} HP)`;
}

function fmtMenit(ms) {
  const totalDetik = Math.ceil(ms / 1000);
  if (totalDetik < 60) return `${totalDetik} detik`;
  const menit = Math.floor(totalDetik / 60);
  const detik = totalDetik % 60;
  return detik > 0 ? `${menit} menit ${detik} detik` : `${menit} menit`;
}

/** Hitung ulang bonus Formasi Lengkap (>=3 role berbeda dalam regu). */
function hitungFormasi(session) {
  const roles = new Set(Array.from(session.players.values()).map(p => p.roleKey));
  const lengkap = roles.size >= FORMASI_MIN_ROLE;
  session.formasi = {
    lengkap,
    jumlahRole: roles.size,
    dmgMult: lengkap ? FORMASI_DMG_BONUS : 1,
    tahanMult: lengkap ? FORMASI_TAHAN_BONUS : 1
  };
  return session.formasi;
}

/** Batas jumlah pemain per role, hanya berlaku mulai regu 4 orang. */
function bolehAmbilRole(session, senderNumber, roleKey) {
  const ukuranBaru = session.players.has(senderNumber) ? session.players.size : session.players.size + 1;
  if (ukuranBaru < 4) return { boleh: true };

  let jumlahRole = 0;
  for (const [jid, p] of session.players.entries()) {
    if (jid === senderNumber) continue;
    if (p.roleKey === roleKey) jumlahRole++;
  }
  const maks = Math.max(1, Math.ceil(ukuranBaru * ROLE_CAP_RATIO));
  if (jumlahRole + 1 > maks) {
    return { boleh: false, maks };
  }
  return { boleh: true };
}

function buatPemain(jid, nama, roleKey, { hpRatio = 1, joinedRound = 1 } = {}) {
  const roleData = ROLE_STATS[roleKey];
  return {
    jid,
    name: nama,
    roleKey,
    roleName: roleData.name,
    emoji: roleData.emoji,
    hp: Math.max(1, Math.floor(roleData.hp * hpRatio)),
    maxHp: roleData.hp,
    shield: 0,
    isAlive: true,
    action: null,
    actionTarget: null,
    actionArg: null,
    cooldowns: { berserk: 0, massheal: 0, revive: 0, freeze: 0, benteng: 0, taunt: 0 },
    shieldActive: false,
    tauntActive: false,
    bentengActive: false,
    burn: 0,
    damageDealt: 0,
    healingDone: 0,
    damageAbsorbed: 0,
    aksiDikirim: 0,
    rondeHadir: 0,
    kaliKo: 0,
    joinedRound
  };
}

/** Rasio hadiah anti-leech: aktif berapa ronde dari ronde yang dia ikuti. */
function rasioPartisipasi(player, totalRonde) {
  const hadir = Math.max(1, Math.min(totalRonde, player.rondeHadir || 0));
  const rasioAksi = Math.min(1, (player.aksiDikirim || 0) / hadir);
  const rasioHadir = Math.min(1, hadir / Math.max(1, totalRonde));
  return Math.max(PARTISIPASI_MIN, rasioAksi * rasioHadir);
}

// ─── 5. PERSISTENSI SESI (tahan restart) ─────────────────────────────

export function saveRaidSessions() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serialized = [];
    for (const [jid, s] of activeRaids.entries()) {
      // Lobby sengaja tidak disimpan: umurnya cuma 60 detik dan tidak ada
      // kemajuan yang hilang kalau pemain harus membuka ulang.
      if (s.status !== 'BATTLE') continue;
      serialized.push({
        groupJid: jid,
        hostJid: s.hostJid,
        hostName: s.hostName,
        boss: s.boss,
        status: s.status,
        round: s.round,
        formasi: s.formasi,
        grabbed: s.grabbed || null,
        startedAt: s.startedAt || Date.now(),
        savedAt: Date.now(),
        players: Array.from(s.players.entries())
      });
    }

    if (serialized.length === 0) {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
      return;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.error('[RAID] Gagal menyimpan state raid:', err.message);
  }
}

export async function restoreRaidSessions(sock) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    if (!content) return;
    const data = JSON.parse(content);
    if (!Array.isArray(data) || data.length === 0) return;

    for (const item of data) {
      const umur = Date.now() - (item.savedAt || 0);
      if (umur > 15 * 60 * 1000) {
        try {
          await send(sock, item.groupJid, null,
            `🕳️ Pertempuran melawan ${item.boss?.emoji || ''} *${item.boss?.name || 'World Boss'}* terlalu lama menggantung setelah bot restart, jadi dibatalkan.\n👉 Ketik \`.raid\` untuk membuka lobby baru.`);
        } catch { /* grup mungkin sudah tidak dapat dikirimi pesan */ }
        continue;
      }

      const session = {
        groupJid: item.groupJid,
        hostJid: item.hostJid,
        hostName: item.hostName,
        boss: item.boss,
        status: 'BATTLE',
        players: new Map(item.players || []),
        round: item.round || 1,
        formasi: item.formasi || { lengkap: false, jumlahRole: 0, dmgMult: 1, tahanMult: 1 },
        grabbed: item.grabbed || null,
        startedAt: item.startedAt || Date.now(),
        turnTimer: null,
        lobbyTimer: null,
        lobbyEndTime: 0,
        turnEndTime: 0
      };

      // Aksi yang belum sempat dieksekusi sebelum restart dibuang, biar tidak
      // ada pemain yang "kehilangan" giliran tanpa penjelasan.
      for (const p of session.players.values()) {
        p.action = null;
        p.actionTarget = null;
        p.actionArg = null;
      }

      activeRaids.set(item.groupJid, session);

      await send(sock, item.groupJid, null,
        `🔄 *PERTEMPURAN RAID DIPULIHKAN DARI RESTART!* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${session.boss.emoji} *${session.boss.name}*\n${renderHpBar(session.boss.hp, session.boss.maxHp)}\n\n` +
        `Ronde *${session.round}* dilanjutkan. Kirim aksimu sekarang (35 detik)!`);

      scheduleTurnResolution(sock, session);
    }

    fs.unlinkSync(STATE_FILE);
  } catch (err) {
    console.error('[RAID] Gagal memulihkan state raid:', err.message);
  }
}

// ─── 6. ROUTER COMMAND ───────────────────────────────────────────────

export async function handleRaidCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin = false, isOwner = false) {
  // Statistik & papan peringkat boleh dibuka di DM — tidak butuh sesi grup.
  if (['raidtop', 'topraid', 'raidleaderboard'].includes(command)) {
    return await showRaidLeaderboard(sock, jid, messageObj);
  }
  if (['raidstats', 'statraid', 'raidstat'].includes(command)) {
    return await showRaidStats(sock, jid, senderNumber, messageObj, args);
  }

  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ *Game Raid World Boss* hanya bisa dimainkan di dalam grup WhatsApp!\n💡 Di DM kamu tetap bisa cek `.raidstats` dan `.raidtop`.");
    return true;
  }

  if (['cancelraid', 'batalraid'].includes(command)) {
    return await cancelRaid(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  if (['statusraid', 'raidstatus', 'statusr', 'inforaid'].includes(command)) {
    return await showRaidStatus(sock, jid, senderNumber, messageObj);
  }

  if (['joinraid', 'joinr', 'pilihrole'].includes(command)) {
    return await joinRaid(sock, jid, senderNumber, messageObj, args);
  }

  if (['startraid', 'gasraid', 'mulairaid'].includes(command)) {
    return await startRaidBattle(sock, jid, senderNumber, messageObj);
  }

  if (['serang', 'atk', 'berserk', 'tameng', 'shield', 'taunt', 'provokasi', 'provoke', 'benteng', 'heal', 'massheal', 'revive', 'sihir', 'cast', 'freeze', 'stun'].includes(command)) {
    return await submitPlayerAction(sock, jid, senderNumber, messageObj, args, command);
  }

  if (['raid', 'worldboss', 'bos'].includes(command)) {
    const sub = (args[1] || '').toLowerCase();
    if (['list', 'daftar', 'boss', 'info'].includes(sub)) {
      return await showBossList(sock, jid, messageObj);
    }
    return await openRaidLobby(sock, jid, senderNumber, messageObj, args);
  }

  return false;
}

// ─── 7. DAFTAR BOSS & COOLDOWN ───────────────────────────────────────

async function showBossList(sock, jid, messageObj) {
  const progress = await db.getRaidGroupProgress(jid);
  const baris = [];

  for (const key of Object.keys(BOSS_TEMPLATES)) {
    const b = BOSS_TEMPLATES[key];
    const terkunci = b.unlock && !(progress?.[`kill_${b.unlock}`] > 0);
    const sisaCd = await db.getCooldownMs(jid, `RAID:${b.id}`);
    const kill = progress?.[`kill_${b.id}`] || 0;

    let status;
    if (terkunci) status = `🔒 _Terkunci — tumbangkan ${BOSS_TEMPLATES[b.unlock].name} dulu_`;
    else if (sisaCd > 0) status = `⏳ _Cooldown ${fmtMenit(sisaCd)}_`;
    else status = '✅ _Siap ditantang_';

    baris.push(
      `${b.emoji} *${b.name}*\n` +
      `   ❤️ ${b.baseHp.toLocaleString('id-ID')} HP (skala 4 pemain) • ⚔️ ${b.attack} ATK\n` +
      `   🧬 Elemen: ${b.element}${b.lemah ? ` • Lemah: ${SIHIR_ELEMEN[b.lemah].emoji} ${SIHIR_ELEMEN[b.lemah].nama}` : ' • Lemah: _berubah tiap ronde_'}\n` +
      `   🎯 ${b.mekanikNama}\n` +
      `   🎁 *+${b.poinPemain.toLocaleString('id-ID')} Poin* & *+${b.xpPemain} XP* per pemain\n` +
      `   🏆 Tumbang oleh grup ini: *${kill}x*\n` +
      `   ${status}`
    );
  }

  await send(sock, jid, messageObj,
    `🐉 *DAFTAR WORLD BOSS* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${baris.join('\n\n')}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👉 Ketik \`.raid <nama boss>\` untuk membuka lobby.\n` +
    `👉 \`.raid\` saja = boss acak yang sedang tidak cooldown.`);
  return true;
}

// ─── 8. MEMBUKA LOBBY ────────────────────────────────────────────────

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
    }
    await send(sock, jid, messageObj, `⚠️ Sedang ada pertempuran Raid yang berlangsung di grup ini melawan ${active.boss.emoji} *${active.boss.name}*! Ketik \`.statusraid\` untuk melihat kondisi terkini.`);
    return true;
  }

  const sisaLobby = await db.getCooldownMs(jid, 'RAID:LOBBY');
  if (sisaLobby > 0) {
    await send(sock, jid, messageObj, `⏳ Mohon tunggu *${fmtMenit(sisaLobby)}* sebelum membuka pertempuran Raid berikutnya.`);
    return true;
  }

  const progress = await db.getRaidGroupProgress(jid);
  const param = (args[1] || '').toLowerCase();

  let chosenBossKey = null;
  if (['ignis', 'naga', 'api', '1'].includes(param)) chosenBossKey = 'ignis';
  else if (['malakor', 'iblis', 'necro', '2'].includes(param)) chosenBossKey = 'malakor';
  else if (['raijin', 'petir', 'titan', '3'].includes(param)) chosenBossKey = 'raijin';
  else if (['leviathan', 'laut', 'levi', '4'].includes(param)) chosenBossKey = 'leviathan';
  else if (['erebus', 'nightmare', 'void', 'kehampaan', '5'].includes(param)) chosenBossKey = 'erebus';

  if (chosenBossKey) {
    const b = BOSS_TEMPLATES[chosenBossKey];
    if (b.unlock && !(progress?.[`kill_${b.unlock}`] > 0)) {
      await send(sock, jid, messageObj,
        `🔒 *${b.name}* masih tersegel!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Grup ini harus menumbangkan ${BOSS_TEMPLATES[b.unlock].emoji} *${BOSS_TEMPLATES[b.unlock].name}* minimal sekali untuk membuka Nightmare Mode.\n\n👉 Ketik \`.raid list\` untuk melihat progres grup.`);
      return true;
    }
    const sisaCd = await db.getCooldownMs(jid, `RAID:${b.id}`);
    if (sisaCd > 0) {
      await send(sock, jid, messageObj, `⏳ ${b.emoji} *${b.name}* baru saja ditantang grup ini.\nBoss ini kembali muncul dalam *${fmtMenit(sisaCd)}*.\n\n👉 Ketik \`.raid list\` untuk melihat boss lain yang siap ditantang.`);
      return true;
    }
  } else {
    // Boss acak: hanya dari yang terbuka dan tidak sedang cooldown.
    const kandidat = [];
    for (const key of Object.keys(BOSS_TEMPLATES)) {
      const b = BOSS_TEMPLATES[key];
      if (b.unlock && !(progress?.[`kill_${b.unlock}`] > 0)) continue;
      if (b.id === 'erebus') continue; // Nightmare harus dipilih sadar, bukan hasil undian
      const sisaCd = await db.getCooldownMs(jid, `RAID:${b.id}`);
      if (sisaCd <= 0) kandidat.push(key);
    }
    if (kandidat.length === 0) {
      await send(sock, jid, messageObj, `😴 Semua World Boss sedang pulih dari pertempuran terakhir grup ini.\n👉 Ketik \`.raid list\` untuk melihat sisa waktu masing-masing boss.`);
      return true;
    }
    chosenBossKey = randomItem(kandidat);
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
      hp: bossTemplate.baseHp,
      maxHp: bossTemplate.baseHp,
      atk: bossTemplate.attack,
      charge: 0,
      frozen: false,
      armorBreakTurns: 0,
      fase2: false
    },
    status: 'LOBBY',
    players: new Map(),
    round: 1,
    formasi: { lengkap: false, jumlahRole: 0, dmgMult: 1, tahanMult: 1 },
    grabbed: null,
    turnTimer: null,
    lobbyTimer: null,
    startedAt: 0,
    lobbyEndTime: Date.now() + LOBBY_DURATION_MS,
    turnEndTime: 0
  };

  session.lobbyTimer = setTimeout(async () => {
    try {
      const s = activeRaids.get(jid);
      if (s?.status !== 'LOBBY') return;
      if (s.players.size < MIN_PLAYERS) {
        activeRaids.delete(jid);
        await db.setCooldown(jid, 'RAID:LOBBY', LOBBY_COOLDOWN_MS);
        await send(sock, jid, null, `😔 *LOBBY RAID DIBATALKAN.*\nHanya *${s.players.size}* pahlawan yang mendaftar, minimal *${MIN_PLAYERS}* pemain dibutuhkan untuk menantang ${s.boss.emoji} *${s.boss.name}*.\n\n👉 Ketik \`.raid\` untuk mencoba lagi.`);
        return;
      }
      await startRaidBattle(sock, jid, 'SYSTEM', null);
    } catch (e) {
      console.error('[RAID LOBBY TIMEOUT ERROR]', e);
    }
  }, LOBBY_DURATION_MS);

  activeRaids.set(jid, session);

  const lemahTxt = bossTemplate.lemah
    ? `${SIHIR_ELEMEN[bossTemplate.lemah].emoji} *${SIHIR_ELEMEN[bossTemplate.lemah].nama}* (Mage: \`.sihir ${bossTemplate.lemah}\` = damage 1,6x)`
    : `_berubah setiap ronde — Mage wajib menyimak pengumuman!_`;

  const lobbyMsg =
`🐉 *LOBBY RAID WORLD BOSS DIBUKA!* ⚔️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Panggilan untuk seluruh pahlawan grup! Bos monster kuno telah bangkit!

${bossTemplate.emoji} *Target:* *${bossTemplate.name}*
📜 _${bossTemplate.desc}_

❤️ *HP Dasar:* *${bossTemplate.baseHp.toLocaleString('id-ID')} HP* _(patokan regu 4 pemain — ikut naik kalau regunya lebih ramai)_
⚔️ *Daya Serang:* *${bossTemplate.attack} ATK*
🧬 *Elemen Boss:* ${bossTemplate.element}
⚠️ *Kelemahan:* ${lemahTxt}
⚡ *Jurus Maut:* ${bossTemplate.ultimateName} — _${bossTemplate.ultimateDesc}_
🎯 *Mekanik Khas:* *${bossTemplate.mekanikNama}*
   _${bossTemplate.mekanikDesc}_
🎁 *Hadiah:* *+${bossTemplate.poinPemain.toLocaleString('id-ID')} Poin* & *+${bossTemplate.xpPemain} XP* per pemain (+bonus MVP & clear cepat)
🃏 *Loot:* peluang drop kartu TCG & ransum energi Arena untuk seluruh regu, MVP dijamin dapat.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *PILIH KELASMU:*
1. ⚔️ *Attacker (DPS)* — \`.joinraid dps\` (Damage Tinggi & Crit)
2. 🛡️ *Guardian (Tank)* — \`.joinraid tank\` (Perisai Tim & Pasang Badan)
3. 💖 *Cleric (Healer)* — \`.joinraid heal\` (Pulihkan HP, Bersihkan Luka Bakar & Revive)
4. 🔮 *Archmage (Mage)* — \`.joinraid mage\` (Sihir Elemental & Freeze Boss)

✨ *Bonus Formasi Lengkap:* regu dengan *3 role berbeda* atau lebih dapat *+15% damage* & *-10% damage diterima*.
⏳ *Waktu Pendaftaran:* *60 Detik* (Minimal ${MIN_PLAYERS} Pemain)
👉 Ketik \`.joinraid <role>\` untuk mendaftar!`;

  await send(sock, jid, messageObj, lobbyMsg, {
    buttons: [
      { type: 'reply', text: '⚔️ Gabung DPS', id: '.joinraid dps' },
      { type: 'reply', text: '🛡️ Gabung Tank', id: '.joinraid tank' },
      { type: 'reply', text: '💖 Gabung Healer', id: '.joinraid heal' },
      { type: 'reply', text: '🔮 Gabung Mage', id: '.joinraid mage' },
      { type: 'reply', text: '🚀 Mulai Sekarang', id: '.startraid' }
    ]
  });

  return true;
}

// ─── 9. GABUNG REGU (lobby & tengah pertempuran) ─────────────────────

async function joinRaid(sock, jid, senderNumber, messageObj, args) {
  const session = activeRaids.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Belum ada lobby Raid yang dibuka di grup ini.\nKetik *.raid* untuk membuka pendaftaran boss battle!");
    return true;
  }

  let roleKey = null;
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
  const izin = bolehAmbilRole(session, senderNumber, roleKey);
  if (!izin.boleh) {
    await send(sock, jid, messageObj,
      `⚠️ Regu sudah kelebihan ${roleData.emoji} *${roleData.name}*!\n` +
      `Maksimal *${izin.maks} pemain* per role untuk ukuran regu ini (batas 60%).\n\n` +
      `💡 Regu dengan 3 role berbeda dapat bonus *Formasi Lengkap* (+15% damage, -10% damage diterima). Coba role lain!`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const playerName = cust?.nama ? cust.nama : `@${senderNumber.split('@')[0]}`;

  // ── Bergabung di tengah pertempuran ──
  if (session.status === 'BATTLE') {
    if (session.players.has(senderNumber)) {
      await send(sock, jid, messageObj, "⚠️ Kamu sudah jadi anggota regu ini. Role tidak bisa diganti saat pertempuran berlangsung.");
      return true;
    }
    if (session.round > ENRAGE_ROUND) {
      await send(sock, jid, messageObj, `⚠️ Pertempuran sudah masuk fase mengamuk (ronde ${session.round}). Pendatang baru tidak lagi diterima — tunggu raid berikutnya!`);
      return true;
    }

    const pemain = buatPemain(senderNumber, playerName, roleKey, {
      hpRatio: JOIN_TENGAH_HP_RATIO,
      joinedRound: session.round
    });
    session.players.set(senderNumber, pemain);
    hitungFormasi(session);
    saveRaidSessions();

    await send(sock, jid, messageObj,
      `🏃 *BALA BANTUAN DATANG!*\n@${senderNumber.split('@')[0]} terjun ke arena sebagai ${roleData.emoji} *${roleData.name}* dengan *${pemain.hp}/${pemain.maxHp} HP* (kelelahan perjalanan -30%).\n` +
      `⚔️ Langsung kirim aksimu untuk ronde ${session.round}!\n` +
      `${session.formasi.lengkap ? '✨ Regu kini memenuhi *Formasi Lengkap*!' : ''}`,
      { mentions: [senderNumber] });
    return true;
  }

  if (session.status !== 'LOBBY') {
    await send(sock, jid, messageObj, "❌ Sesi Raid di grup ini sudah tidak menerima pendaftaran.");
    return true;
  }

  const sudahAda = session.players.get(senderNumber);
  session.players.set(senderNumber, buatPemain(senderNumber, playerName, roleKey));
  hitungFormasi(session);

  const pCount = session.players.size;
  const gantiTxt = sudahAda && sudahAda.roleKey !== roleKey
    ? `🔁 Role diganti dari ${sudahAda.emoji} *${sudahAda.roleName}* menjadi `
    : `✅ @${senderNumber.split('@')[0]} berhasil bergabung sebagai `;

  await send(sock, jid, messageObj,
    `${gantiTxt}${roleData.emoji} *${roleData.name}*!\n` +
    `👥 *Total Anggota Regu:* *${pCount} Pemain* (${session.formasi.jumlahRole} role berbeda)\n` +
    `${session.formasi.lengkap ? '✨ *Formasi Lengkap aktif:* +15% damage tim, -10% damage diterima.' : `💡 Butuh *${FORMASI_MIN_ROLE - session.formasi.jumlahRole}* role berbeda lagi untuk bonus Formasi Lengkap.`}`,
    { mentions: [senderNumber] });

  return true;
}

// ─── 10. MULAI PERTEMPURAN ───────────────────────────────────────────

async function startRaidBattle(sock, jid, senderNumber, messageObj) {
  const session = activeRaids.get(jid);
  if (!session || session.status !== 'LOBBY') return false;

  if (session.players.size < MIN_PLAYERS) {
    if (senderNumber !== 'SYSTEM') {
      await send(sock, jid, messageObj, `⚠️ Minimal *${MIN_PLAYERS} pemain* harus bergabung untuk memulai Raid! Saat ini baru *${session.players.size}* pemain.`);
    }
    return true;
  }

  if (session.lobbyTimer) clearTimeout(session.lobbyTimer);
  session.status = 'BATTLE';
  session.round = 1;
  session.startedAt = Date.now();

  // Skala boss mengikuti ukuran regu final.
  const n = session.players.size;
  const hpSkala = Math.round(session.boss.baseHp * faktorHp(n));
  session.boss.maxHp = hpSkala;
  session.boss.hp = hpSkala;
  session.boss.atk = Math.round(session.boss.attack * faktorAtk(n));

  hitungFormasi(session);
  for (const p of session.players.values()) p.rondeHadir = 0;

  if (session.boss.elemenAcak) putarElemenAcak(session);

  const playerList = Array.from(session.players.values())
    .map((p, i) => `${i + 1}. ${p.emoji} *${p.name}* — HP: ${p.hp}/${p.maxHp} [${p.roleName}]`)
    .join('\n');

  const lemahTxt = session.boss.lemah
    ? `${SIHIR_ELEMEN[session.boss.lemah].emoji} *${SIHIR_ELEMEN[session.boss.lemah].nama}*`
    : '_belum terbaca_';

  const startMsg =
`⚔️ *PERTEMPURAN RAID DIMULAI!* 🐲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Regu pahlawan telah memasuki arena sarang ${session.boss.emoji} *${session.boss.name}*!

❤️ *Boss HP:* ${renderHpBar(session.boss.hp, session.boss.maxHp)}
   _(skala ${n} pemain: ${Math.round(faktorHp(n) * 100)}% dari HP dasar)_
⚔️ *Serangan Boss:* ${session.boss.atk} ATK
🎯 *Mekanik:* ${session.boss.mekanikNama}
🧬 *Kelemahan Elemen:* ${lemahTxt}
${session.formasi.lengkap ? '✨ *FORMASI LENGKAP AKTIF:* +15% damage tim, -10% damage diterima!' : '⚠️ Formasi belum lengkap — regu tidak dapat bonus komposisi.'}

👥 *REGU RAID (${n} Pemain):*
${playerList}

⏱️ *Batas Pertempuran:* ronde *${MAX_ROUND}*. Mulai ronde *${ENRAGE_ROUND}* boss MENGAMUK (+20% damage tiap ronde).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Ketik Perintah Aksimu Sekarang (35 Detik):*
• ⚔️ DPS: \`.serang\` atau \`.berserk\`
• 🛡️ Tank: \`.tameng\` / \`.taunt\` / \`.benteng\`
• 💖 Healer: \`.heal @teman\` / \`.massheal\` / \`.revive @teman\`
• 🔮 Mage: \`.sihir ${session.boss.lemah || '<elemen>'}\` / \`.freeze\``;

  await send(sock, jid, null, startMsg, { buttons: tombolAksi(session) });

  saveRaidSessions();
  scheduleTurnResolution(sock, session);
  return true;
}

function putarElemenAcak(session) {
  const keys = Object.keys(SIHIR_ELEMEN);
  const lemah = randomItem(keys);
  let tahan = randomItem(keys);
  let guard = 0;
  while (tahan === lemah && guard++ < 10) tahan = randomItem(keys);
  session.boss.lemah = lemah;
  session.boss.tahan = tahan;
}

// ─── 11. STATUS RAID ─────────────────────────────────────────────────

async function showRaidStatus(sock, jid, senderNumber, messageObj) {
  const session = activeRaids.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi Raid di grup ini.\n👉 Ketik `.raid` untuk membuka lobby atau `.raid list` untuk melihat daftar boss.");
    return true;
  }

  if (session.status === 'LOBBY') {
    const sisa = Math.max(1, Math.ceil((session.lobbyEndTime - Date.now()) / 1000));
    const pList = Array.from(session.players.values()).map((p, i) => `${i + 1}. ${p.emoji} *${p.name}* (${p.roleName})`).join('\n') || '_Belum ada anggota_';
    await send(sock, jid, messageObj,
      `🐉 *STATUS LOBBY RAID*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Target: ${session.boss.emoji} *${session.boss.name}*\n⏳ Sisa pendaftaran: *${sisa} detik*\n\n` +
      `👥 *Regu (${session.players.size}/${MIN_PLAYERS} minimal):*\n${pList}`);
    return true;
  }

  const sisaRonde = Math.max(0, Math.ceil((session.turnEndTime - Date.now()) / 1000));
  const playerStatus = Array.from(session.players.values())
    .map(p => {
      if (!p.isAlive) return `${p.emoji} *${p.name}* — 💀 *K.O.* _(butuh .revive)_`;
      const tanda = [];
      if (p.shield > 0) tanda.push(`🛡️+${p.shield}`);
      if (p.burn > 0) tanda.push(`🔥 bakar ${p.burn} ronde`);
      if (session.grabbed === p.jid) tanda.push('🐙 dicengkeram');
      if (p.action) tanda.push(`✅ .${p.action}`);
      else tanda.push('⌛ belum beraksi');
      return `${p.emoji} *${p.name}* — ${p.hp}/${p.maxHp} HP ${tanda.length ? `_(${tanda.join(', ')})_` : ''}`;
    })
    .join('\n');

  const me = session.players.get(senderNumber);
  let cdTxt = '';
  if (me) {
    const aktif = Object.entries(me.cooldowns).filter(([, v]) => v > 0);
    cdTxt = aktif.length
      ? `\n\n⏳ *Cooldown Skill-mu:*\n${aktif.map(([k, v]) => `• \`.${k}\` — ${v} ronde lagi`).join('\n')}`
      : '\n\n✅ *Semua skill-mu siap dipakai.*';
  }

  await send(sock, jid, messageObj,
    `⚔️ *STATUS PERTEMPURAN — RONDE ${session.round}/${MAX_ROUND}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${session.boss.emoji} *${session.boss.name}*\n${renderHpBar(session.boss.hp, session.boss.maxHp)}\n` +
    `⚔️ ATK: ${session.boss.atk}${session.boss.fase2 ? ' • 😡 *MODE MURKA*' : ''}${session.round >= ENRAGE_ROUND ? ' • 🔥 *MENGAMUK*' : ''}\n` +
    `🧬 Lemah terhadap: ${session.boss.lemah ? `${SIHIR_ELEMEN[session.boss.lemah].emoji} *${SIHIR_ELEMEN[session.boss.lemah].nama}*` : '_?_'}\n` +
    `${session.boss.charge > 0 ? `⚠️ *Bersiap melepas ${session.boss.ultimateName}!*\n` : ''}` +
    `${session.boss.armorBreakTurns > 0 ? `💥 Armor pecah (${session.boss.armorBreakTurns} ronde)\n` : ''}` +
    `\n👥 *STATUS REGU:*\n${playerStatus}` +
    `${cdTxt}\n\n⏱️ Sisa waktu ronde ini: *${sisaRonde} detik*`);
  return true;
}

// ─── 12. AKSI PEMAIN ─────────────────────────────────────────────────

async function submitPlayerAction(sock, jid, senderNumber, messageObj, args, command) {
  const session = activeRaids.get(jid);
  if (!session) return false;

  if (session.status !== 'BATTLE') {
    await send(sock, jid, messageObj, `⏳ Pertempuran belum dimulai! Regu masih di lobby.
👉 Ketik \`.joinraid <dps/tank/heal/mage>\` untuk bergabung, atau \`.startraid\` untuk memulai lebih cepat.`);
    return true;
  }

  const player = session.players.get(senderNumber);
  if (!player) {
    await send(sock, jid, messageObj, `⚠️ Kamu bukan anggota regu pertempuran Raid ini.\n${session.round <= ENRAGE_ROUND ? '👉 Masih sempat! Ketik `.joinraid <role>` untuk terjun sebagai bala bantuan.' : ''}`);
    return true;
  }

  if (!player.isAlive) {
    await send(sock, jid, messageObj, `💀 Kamu sedang gugur (K.O.)! Tunggu Healer menggunakan \`.revive @kamu\` untuk bangkit kembali.`);
    return true;
  }

  if (session.grabbed === senderNumber) {
    await send(sock, jid, messageObj, `🐙 Kamu sedang *dicengkeram tentakel* dan tidak bisa bergerak!\n👉 Rekan lain harus menyerang boss (\`.serang\` / \`.berserk\`) ronde ini untuk melepaskanmu.`);
    return true;
  }

  const roleSkill = SKILL_ROLE[command];
  if (roleSkill && roleSkill !== player.roleKey) {
    const pemilik = ROLE_STATS[roleSkill];
    const milikku = ROLE_STATS[player.roleKey];
    await send(sock, jid, messageObj,
      `⚠️ \`.${command}\` adalah skill ${pemilik.emoji} *${pemilik.name}*, bukan kelasmu!\n` +
      `Kamu bertarung sebagai ${milikku.emoji} *${milikku.name}*.\n\n` +
      `👉 *Skill kelasmu:* ${milikku.skills}`,
      { mentions: [senderNumber] });
    return true;
  }

  const cdLabel = {
    berserk: 'Berserk', massheal: 'Mass Heal', revive: 'Revive',
    freeze: 'Freeze', benteng: 'Benteng Pertahanan', taunt: 'Taunt'
  };
  const cdKey = ['freeze', 'stun'].includes(command) ? 'freeze'
    : (['taunt', 'provokasi', 'provoke'].includes(command) ? 'taunt' : command);
  if (cdLabel[cdKey] && player.cooldowns[cdKey] > 0) {
    await send(sock, jid, messageObj, `⏳ Skill ${cdLabel[cdKey]} sedang cooldown selama *${player.cooldowns[cdKey]} ronde* lagi.`);
    return true;
  }

  // Parse target untuk heal/revive
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

  // Parse elemen untuk sihir
  let elemen = null;
  let catatanElemen = '';
  if (['sihir', 'cast'].includes(command)) {
    if (args[1]) {
      elemen = normalisasiElemen(args[1]);
      if (!elemen) {
        await send(sock, jid, messageObj,
          `⚠️ Elemen sihir tidak dikenal: *${args[1]}*\n` +
          `Pilihan: ${Object.entries(SIHIR_ELEMEN).map(([k, v]) => `${v.emoji} \`${k}\``).join(' • ')}\n\n` +
          `💡 ${session.boss.emoji} *${session.boss.name}* lemah terhadap ${session.boss.lemah ? `${SIHIR_ELEMEN[session.boss.lemah].emoji} *${SIHIR_ELEMEN[session.boss.lemah].nama}*` : '_elemen yang berganti tiap ronde_'}.`);
        return true;
      }
      if (elemen === session.boss.lemah) catatanElemen = ' 🎯 _(elemen unggul — 1,6x damage!)_';
      else if (elemen === session.boss.tahan) catatanElemen = ' 🚫 _(boss tahan elemen ini — damage 0,45x)_';
      else catatanElemen = ' ⚪ _(netral)_';
    } else {
      catatanElemen = `\n💡 Tanpa elemen sihirmu cuma netral. Coba \`.sihir ${session.boss.lemah || '<elemen>'}\` untuk damage 1,6x.`;
    }
  }

  const aksiBaru = player.action === null;
  player.action = command;
  player.actionTarget = targetJid;
  player.actionArg = elemen;
  if (aksiBaru) player.aksiDikirim++;

  await send(sock, jid, messageObj, `✨ *AKSI DICATAT:* ${player.emoji} *${player.name}* bersiap melakukan \`.${command}${elemen ? ' ' + elemen : ''}\` pada akhir ronde!${catatanElemen}`, {
    mentions: [senderNumber]
  });

  // Cek apakah seluruh pemain hidup (dan tidak dicengkeram) sudah mengirim aksi
  const menunggu = Array.from(session.players.values())
    .filter(p => p.isAlive && p.jid !== session.grabbed && p.action === null);

  if (menunggu.length === 0) {
    if (session.turnTimer) clearTimeout(session.turnTimer);
    await executeRoundResolution(sock, session);
  }

  return true;
}

/** Jadwalkan Timeout Ronde (35 Detik) */
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

// ─── 13. RESOLUSI RONDE ──────────────────────────────────────────────

async function executeRoundResolution(sock, session) {
  const { boss, players, groupJid } = session;
  const logs = [];
  const formasi = session.formasi || { dmgMult: 1, tahanMult: 1 };

  logs.push(`⚔️ *HASIL PERTEMPURAN — RONDE ${session.round}* ⚔️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  for (const p of players.values()) {
    p.rondeHadir++;
    // Pemain yang sedang gugur memang tidak bisa mengirim aksi. Anti-leech
    // menyasar yang diam padahal hidup, bukan yang tumbang membela regu.
    if (!p.isAlive) p.aksiDikirim++;
  }

  // Mekanik Erebus meminjam mekanik boss lain tiap ronde.
  const mekanikRonde = boss.mekanik === 'kacau' ? randomItem(MEKANIK_PINJAMAN) : boss.mekanik;
  if (boss.mekanik === 'kacau') {
    logs.push(`🎲 *Hukum Kehampaan berubah!* Ronde ini Erebus meminjam mekanik: *${namaMekanik(mekanikRonde)}*.`);
  }

  // ── 1. Efek awal ronde: luka bakar & cengkeraman ──
  for (const p of players.values()) {
    if (!p.isAlive || p.burn <= 0) continue;
    const bakar = 140;
    p.hp -= bakar;
    p.burn--;
    if (p.hp <= 0) {
      p.hp = 0;
      p.isAlive = false;
      p.kaliKo++;
      logs.push(`🔥 *${p.name}* hangus oleh luka bakar (-${bakar} HP) dan GUGUR!`);
    } else {
      logs.push(`🔥 *${p.name}* tersiksa luka bakar *-${bakar} HP* (sisa ${p.burn} ronde).`);
    }
  }

  if (session.grabbed) {
    const korban = players.get(session.grabbed);
    if (korban?.isAlive) {
      // Dia tidak bisa mengirim aksi ronde ini, jadi jangan sampai rasio
      // partisipasinya (anti-leech) ikut jatuh karena mekanik boss.
      korban.aksiDikirim++;
      korban.hp -= 180;
      if (korban.hp <= 0) {
        korban.hp = 0;
        korban.isAlive = false;
        korban.kaliKo++;
        session.grabbed = null;
        logs.push(`🐙 *${korban.name}* diremas tentakel sampai GUGUR!`);
      } else {
        logs.push(`🐙 *${korban.name}* diremas tentakel *-180 HP* dan tidak bisa beraksi ronde ini.`);
      }
    } else {
      session.grabbed = null;
    }
  }

  // ── 2. Aksi pemain ──
  let damageRonde = 0;
  let adaSerangan = false;

  for (const player of players.values()) {
    if (!player.isAlive) continue;
    if (session.grabbed === player.jid) continue;

    // Fallback AFK per role. Mage sengaja jatuh ke `sihir`, bukan `serang`:
    // dulu mage yang diam justru memukul lebih keras daripada mage yang main.
    const action = player.action || (
      player.roleKey === 'tank' ? 'tameng'
        : player.roleKey === 'heal' ? 'heal'
          : player.roleKey === 'mage' ? 'sihir'
            : 'serang'
    );

    if (action === 'serang' || action === 'atk') {
      adaSerangan = true;
      const isCrit = Math.random() < 0.35;
      let dmg = Math.floor(Math.random() * 500) + 800; // 800 - 1300
      if (isCrit) dmg = Math.floor(dmg * 2.0);
      if (boss.armorBreakTurns > 0) dmg = Math.floor(dmg * 1.35);
      dmg = Math.floor(dmg * formasi.dmgMult);

      boss.hp -= dmg;
      damageRonde += dmg;
      player.damageDealt += dmg;
      logs.push(`🗡️ *${player.name}* menebaskan pedang maut! *-${dmg.toLocaleString('id-ID')} HP*${isCrit ? ' 💥 *(KRITIKAL 2x!)*' : ''}`);

    } else if (action === 'berserk') {
      adaSerangan = true;
      let dmg = Math.floor(Math.random() * 1500) + 2000; // 2000 - 3500
      if (boss.armorBreakTurns > 0) dmg = Math.floor(dmg * 1.35);
      dmg = Math.floor(dmg * formasi.dmgMult);

      const recoil = Math.floor(player.maxHp * 0.08);
      boss.hp -= dmg;
      player.hp = Math.max(1, player.hp - recoil);
      damageRonde += dmg;
      player.damageDealt += dmg;
      player.cooldowns.berserk = 3;
      logs.push(`🔥 *${player.name}* mengamuk dalam mode *BERSERK*! *-${dmg.toLocaleString('id-ID')} HP* ke Boss (Recoil -${recoil} HP).`);

    } else if (action === 'tameng' || action === 'shield') {
      player.shieldActive = true;
      let dmg = Math.floor(Math.random() * 150) + 200;
      dmg = Math.floor(dmg * formasi.dmgMult);
      boss.hp -= dmg;
      damageRonde += dmg;
      player.damageDealt += dmg;

      // Shield sekarang punya plafon & meluruh tiap ronde. Sebelumnya angka ini
      // menumpuk tanpa batas sehingga satu Tank yang spam `.tameng` membuat
      // seluruh regu praktis kebal.
      let penuh = 0;
      for (const p of players.values()) {
        if (!p.isAlive) continue;
        const cap = Math.floor(p.maxHp * SHIELD_CAP_RATIO);
        const sebelum = p.shield || 0;
        p.shield = Math.min(cap, sebelum + TAMENG_SHIELD);
        if (p.shield === cap && sebelum >= cap) penuh++;
      }
      logs.push(`🛡️ *${player.name}* membentangkan *Perisai Suci Aegis*! *+${TAMENG_SHIELD} Shield* untuk seluruh regu & Boss *-${dmg} HP*.${penuh > 0 ? ` _(${penuh} pemain perisainya sudah mentok)_` : ''}`);

    } else if (['taunt', 'provokasi', 'provoke'].includes(action)) {
      player.tauntActive = true;
      player.cooldowns.taunt = 2;
      let dmg = Math.floor(Math.random() * 100) + 200;
      dmg = Math.floor(dmg * formasi.dmgMult);
      boss.hp -= dmg;
      damageRonde += dmg;
      player.damageDealt += dmg;
      logs.push(`📢 *${player.name}* melancarkan *Tantangan Provokasi (TAUNT)*! Seluruh serangan Boss ronde ini dipaksa menghajar dirinya!`);

    } else if (action === 'benteng') {
      player.bentengActive = true;
      player.cooldowns.benteng = 4;
      logs.push(`🏰 *${player.name}* mendirikan *Benteng Pertahanan*! Serangan biasa Boss ditangkis *85%*, ultimate ditahan *70%*.`);

    } else if (action === 'heal') {
      let target = players.get(player.actionTarget);
      if (!target || !target.isAlive) {
        const alives = Array.from(players.values()).filter(p => p.isAlive).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
        target = alives[0] || player;
      }

      const healAmt = Math.floor(Math.random() * 500) + 600; // 600 - 1100
      const oldHp = target.hp;
      target.hp = Math.min(target.maxHp, target.hp + healAmt);
      const actualHeal = target.hp - oldHp;
      player.healingDone += actualHeal;

      const bakarHilang = target.burn > 0;
      target.burn = 0;

      if (actualHeal === 0 && !bakarHilang) {
        // Tidak ada yang terluka. Menampilkan "+0 HP" membuat giliran Healer
        // terasa terbuang, jadi energinya dialihkan jadi serangan suci.
        const smite = Math.floor(600 * formasi.dmgMult);
        boss.hp -= smite;
        damageRonde += smite;
        player.damageDealt += smite;
        logs.push(`✝️ *${player.name}* melihat regu masih bugar dan mengalihkan doanya jadi *Holy Smite*! *-${smite.toLocaleString('id-ID')} HP* ke Boss.`);
      } else {
        const holy = Math.floor(200 * formasi.dmgMult);
        boss.hp -= holy;
        damageRonde += holy;
        player.damageDealt += holy;
        const sasaranTxt = target.jid === player.jid ? 'dirinya sendiri' : `*${target.name}*`;
        logs.push(`💖 *${player.name}* memulihkan ${sasaranTxt} *+${actualHeal} HP* (HP: ${target.hp}/${target.maxHp})${bakarHilang ? ' 🧯 _luka bakar dipadamkan_' : ''}.`);
      }

    } else if (action === 'massheal') {
      let totalMass = 0;
      let bakarHilang = 0;
      for (const p of players.values()) {
        if (!p.isAlive) continue;
        const old = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + 600);
        totalMass += (p.hp - old);
        if (p.burn > 0) { p.burn = 0; bakarHilang++; }
      }
      player.healingDone += totalMass;
      player.cooldowns.massheal = 3;
      logs.push(`✨ *${player.name}* melantunkan *Doa Penyembuhan Massal*! *+600 HP* ke seluruh tim${bakarHilang > 0 ? ` & memadamkan luka bakar ${bakarHilang} pemain` : ''}.`);

    } else if (action === 'revive') {
      let target = players.get(player.actionTarget);
      if (!target || target.isAlive) {
        const deads = Array.from(players.values()).filter(p => !p.isAlive);
        target = deads[0];
      }

      if (target) {
        target.isAlive = true;
        target.hp = Math.floor(target.maxHp * 0.60);
        target.shield = 0;
        target.burn = 0;
        player.cooldowns.revive = 4;
        logs.push(`🕊️ *${player.name}* membangkitkan *${target.name}* dari kematian dengan *${target.hp} HP* (60% maxHP)!`);
      } else {
        logs.push(`💖 *${player.name}* menyalurkan energi suci (tidak ada teman gugur).`);
      }

    } else if (action === 'sihir' || action === 'cast') {
      adaSerangan = true;
      let dmg = Math.floor(Math.random() * 300) + 700; // 700 - 1000

      let pengali = SIHIR_NETRAL;
      let elemenTxt = '⚪ netral';
      const el = player.actionArg;
      if (el) {
        if (el === boss.lemah) { pengali = SIHIR_UNGGUL; elemenTxt = `${SIHIR_ELEMEN[el].emoji} *UNGGUL 1,6x*`; }
        else if (el === boss.tahan) { pengali = SIHIR_TAHAN; elemenTxt = `${SIHIR_ELEMEN[el].emoji} 🚫 *DITAHAN 0,45x*`; }
        else { elemenTxt = `${SIHIR_ELEMEN[el].emoji} netral`; }
      }
      dmg = Math.floor(dmg * pengali * formasi.dmgMult);

      boss.hp -= dmg;
      damageRonde += dmg;
      boss.armorBreakTurns = 2;
      player.damageDealt += dmg;
      logs.push(`🔮 *${player.name}* menembakkan *Meteor Arcane* [${elemenTxt}]! *-${dmg.toLocaleString('id-ID')} HP* & Armor Boss Pecah *(+35% DMG Fisik)*.`);

    } else if (action === 'freeze' || action === 'stun') {
      player.cooldowns.freeze = 3;
      let dmg = Math.floor(350 * formasi.dmgMult);
      boss.hp -= dmg;
      damageRonde += dmg;
      player.damageDealt += dmg;

      // Dalam mode Murka boss tidak lagi otomatis bisa dibekukan — kalau tidak,
      // dua Mage bergantian bisa mengunci fase akhir sepenuhnya.
      const berhasil = !boss.fase2 || Math.random() < 0.65;
      if (berhasil) {
        boss.frozen = true;
        boss.charge = 0;
        logs.push(`❄️ *${player.name}* membekukan Boss dengan *Frostbite Stun*! *(Ultimate Charge Boss Digagalkan!)*`);
      } else {
        logs.push(`❄️💢 *${player.name}* mencoba membekukan Boss tapi *AMUKAN MURKA MEMATAHKAN ES*! (-${dmg} HP saja)`);
      }
    }
  }

  // Cengkeraman terlepas kalau ada rekan yang menyerang.
  if (session.grabbed && adaSerangan) {
    const korban = players.get(session.grabbed);
    if (korban) logs.push(`🗡️ Serangan regu memaksa tentakel melepaskan *${korban.name}*!`);
    session.grabbed = null;
  }

  // ── 3. Serapan jiwa (Malakor) ──
  if (mekanikRonde === 'lifesteal' && damageRonde > 0 && boss.hp > 0) {
    const serap = Math.floor(damageRonde * 0.25);
    const sebelum = boss.hp;
    boss.hp = Math.min(boss.maxHp, boss.hp + serap);
    const nyata = boss.hp - sebelum;
    if (nyata > 0) logs.push(`🩸 *Serapan Jiwa!* ${boss.emoji} *${boss.name}* meneguk 25% damage yang diterimanya: *+${nyata.toLocaleString('id-ID')} HP*.`);
  }

  // ── 4. Boss tumbang? ──
  if (boss.hp <= 0) {
    boss.hp = 0;
    if (session.turnTimer) clearTimeout(session.turnTimer);
    activeRaids.delete(groupJid);
    saveRaidSessions();
    await resolveVictory(sock, session, logs);
    return;
  }

  // ── 5. Fase 2 (MURKA) ──
  if (!boss.fase2 && boss.hp <= boss.maxHp * PHASE2_RATIO) {
    boss.fase2 = true;
    boss.atk = Math.round(boss.atk * 1.5);
    logs.push(`\n😡 *${boss.name.toUpperCase()} MEMASUKI MODE MURKA!*\nDarahnya tinggal di bawah 30% — *serangan +50%*, ultimate jauh lebih sering, dan es Mage tidak selalu mempan!`);
  }

  logs.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👹 *GILIRAN SERANGAN BALIK BOSS:*');

  // ── 6. Serangan balik boss ──
  const enrageMult = session.round >= ENRAGE_ROUND
    ? 1 + ENRAGE_STEP * (session.round - ENRAGE_ROUND + 1)
    : 1;
  if (enrageMult > 1) {
    logs.push(`🔥 *AMUKAN RONDE ${session.round}:* damage Boss dilipat *${enrageMult.toFixed(2).replace('.', ',')}x* — regu harus segera mengakhiri pertempuran!`);
  }

  if (boss.frozen) {
    logs.push(`❄️ ${boss.emoji} *${boss.name}* membeku dan tidak dapat bergerak ronde ini!`);
    boss.frozen = false;
  } else {
    const bentengTank = Array.from(players.values()).find(p => p.isAlive && p.bentengActive);
    const tauntTank = Array.from(players.values()).find(p => p.isAlive && p.tauntActive);
    const isUlt = boss.charge >= 1;

    // Pengali damage global (amukan, formasi, benteng)
    const potongBenteng = bentengTank ? (isUlt ? 0.30 : 0.15) : 1;
    if (bentengTank) {
      logs.push(`🏰 *Benteng ${bentengTank.name}* menangkis sebagian besar serangan Boss! _(sisa damage ${Math.round(potongBenteng * 100)}%)_`);
    }

    const kaliUmum = enrageMult * formasi.tahanMult * potongBenteng;

    if (isUlt) {
      logs.push(`💥 ${boss.emoji} *${boss.name}* MELEPASKAN JURUS PAMUNGKAS: *${boss.ultimateName}*!`);
      boss.charge = 0;

      if (tauntTank) {
        const raw = Math.floor(boss.atk * 2 * kaliUmum * 0.6); // pasif Iron Skin
        terapkanDamage(tauntTank, raw, logs, { pasangBadan: true });
        logs.push(`✨ Seluruh rekan tim lainnya 100% AMAN (0 Damage)!`);
      } else {
        for (const p of players.values()) {
          if (!p.isAlive) continue;
          let pDmg = Math.floor(boss.atk * 2 * kaliUmum * (p.roleKey === 'tank' ? 0.6 : 1));
          terapkanDamage(p, pDmg, logs);
        }
      }
      terapkanEfekMekanik(session, mekanikRonde, logs, players);

    } else {
      const peluangCharge = boss.fase2 ? 0.55 : 0.35;
      const shouldCharge = Math.random() < peluangCharge && session.round > 1;

      if (shouldCharge) {
        boss.charge = 1;
        logs.push(`⚠️ ${boss.emoji} *${boss.name}* mulai menghimpun energi kuno! 🔥 *Bersiap melancarkan ${boss.ultimateName} pada ronde berikutnya!*`);
        if (bentengTank) logs.push(`ℹ️ _Benteng tidak menghalangi proses charge — Mage siapkan \`.freeze\`._`);

      } else if (tauntTank) {
        const raw = Math.floor(boss.atk * 1.3 * kaliUmum * 0.6);
        terapkanDamage(tauntTank, raw, logs, { pasangBadan: true });
        logs.push(`✨ Seluruh rekan tim lainnya 100% AMAN (0 Damage)!`);
        terapkanEfekMekanik(session, mekanikRonde, logs, players);

      } else if (mekanikRonde === 'chain') {
        // Raijin hanya menyambar 2 pemain, tapi menembus perisai.
        const hidup = Array.from(players.values()).filter(p => p.isAlive);
        const sasaran = [];
        const pool = [...hidup];
        for (let i = 0; i < Math.min(2, pool.length); i++) {
          const idx = Math.floor(Math.random() * pool.length);
          sasaran.push(pool.splice(idx, 1)[0]);
        }
        logs.push(`⚡⛓️ *CHAIN LIGHTNING!* Petir bercabang menyambar *${sasaran.length} pemain* dan *menembus perisai*!`);
        for (const p of sasaran) {
          let pDmg = Math.floor(boss.atk * 1.5 * kaliUmum * (p.roleKey === 'tank' ? 0.6 : 1));
          terapkanDamage(p, pDmg, logs, { tembusPerisai: true });
        }
        terapkanEfekMekanik(session, mekanikRonde, logs, players);

      } else {
        for (const p of players.values()) {
          if (!p.isAlive) continue;
          let pDmg = Math.floor(boss.atk * (0.8 + Math.random() * 0.4) * kaliUmum * (p.roleKey === 'tank' ? 0.6 : 1));
          terapkanDamage(p, pDmg, logs);
        }
        terapkanEfekMekanik(session, mekanikRonde, logs, players);
      }
    }
  }

  // ── 7. Wipe? ──
  const stillAlive = Array.from(players.values()).filter(p => p.isAlive);
  if (stillAlive.length === 0) {
    if (session.turnTimer) clearTimeout(session.turnTimer);
    activeRaids.delete(groupJid);
    saveRaidSessions();
    await resolveDefeat(sock, session, logs, 'wipe');
    return;
  }

  // ── 8. Reset status ronde ──
  for (const p of players.values()) {
    p.action = null;
    p.actionTarget = null;
    p.actionArg = null;
    p.shieldActive = false;
    p.tauntActive = false;
    p.bentengActive = false;
    if (p.shield > 0) p.shield = Math.floor(p.shield * SHIELD_DECAY);
    for (const k in p.cooldowns) {
      if (p.cooldowns[k] > 0) p.cooldowns[k]--;
    }
  }
  if (boss.armorBreakTurns > 0) boss.armorBreakTurns--;
  session.round++;

  // ── 9. Batas keras pertempuran ──
  if (session.round > MAX_ROUND) {
    if (session.turnTimer) clearTimeout(session.turnTimer);
    activeRaids.delete(groupJid);
    saveRaidSessions();
    await resolveDefeat(sock, session, logs, 'timeout');
    return;
  }

  if (boss.elemenAcak) {
    putarElemenAcak(session);
    logs.push(`\n🎲 *Kelemahan elemen Erebus bergeser!* Ronde berikutnya ia lemah terhadap ${SIHIR_ELEMEN[boss.lemah].emoji} *${SIHIR_ELEMEN[boss.lemah].nama}* dan menahan ${SIHIR_ELEMEN[boss.tahan].emoji} *${SIHIR_ELEMEN[boss.tahan].nama}*.`);
  }

  // ── 10. Ringkasan & ronde berikutnya ──
  const playerStatus = Array.from(players.values())
    .map(p => {
      if (!p.isAlive) return `${p.emoji} *${p.name}* — 💀 *K.O.*`;
      const tanda = [];
      if (p.shield > 0) tanda.push(`🛡️+${p.shield}`);
      if (p.burn > 0) tanda.push(`🔥 bakar ${p.burn} ronde`);
      if (session.grabbed === p.jid) tanda.push('🐙');
      return `${p.emoji} *${p.name}* — HP: *${p.hp}/${p.maxHp}* ${tanda.length ? `_(${tanda.join(' ')})_` : ''}`;
    })
    .join('\n');

  const peringatanList = [];
  if (boss.charge > 0) peringatanList.push('⚠️ 🔥 *BOS SEDANG MENGUMPULKAN ENERGI ULTIMATE!*');
  if (boss.fase2) peringatanList.push('😡 *MODE MURKA AKTIF* — serangan +50%.');
  if (session.round >= ENRAGE_ROUND) peringatanList.push(`🔥 *AMUKAN* — damage boss naik tiap ronde. Sisa *${MAX_ROUND - session.round + 1} ronde* sebelum regu kehabisan tenaga!`);

  const peringatanTxt = peringatanList.length ? `\n${peringatanList.join('\n')}` : '';

  const roundSummary =
`${logs.join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🐲 *STATUS TERKINI BOS:*
${renderHpBar(boss.hp, boss.maxHp)}
🧬 Lemah: ${boss.lemah ? `${SIHIR_ELEMEN[boss.lemah].emoji} *${SIHIR_ELEMEN[boss.lemah].nama}*` : '_?_'} • Tahan: ${boss.tahan ? `${SIHIR_ELEMEN[boss.tahan].emoji} ${SIHIR_ELEMEN[boss.tahan].nama}` : '_?_'}${peringatanTxt}

👥 *STATUS REGU:*
${playerStatus}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 *Kirim Aksi Ronde ${session.round}/${MAX_ROUND} Sekarang (35 Detik):*
• DPS: \`.serang\` / \`.berserk\`
• Tank: \`.tameng\` / \`.taunt\` / \`.benteng\`
• Healer: \`.heal @teman\` / \`.massheal\` / \`.revive @teman\`
• Mage: \`.sihir ${boss.lemah || '<elemen>'}\` / \`.freeze\`
_Ketik \`.statusraid\` kapan saja untuk melihat kondisi & cooldown skill-mu._`;

  await send(sock, groupJid, null, roundSummary, { buttons: tombolAksi(session) });

  saveRaidSessions();
  scheduleTurnResolution(sock, session);
}

/**
 * Tombol aksi ronde: satu perintah dasar untuk tiap kelas, plus cek status.
 * Tombol Mage sengaja sudah membawa elemen kelemahan boss ronde ini — selisih
 * damage 1,6x itu yang paling sering terlewat pemain baru.
 */
function tombolAksi(session) {
  const el = session.boss.lemah;
  return [
    { type: 'reply', text: '⚔️ DPS — Serang', id: '.serang' },
    { type: 'reply', text: '🛡️ Tank — Tameng', id: '.tameng' },
    { type: 'reply', text: '💖 Healer — Heal', id: '.heal' },
    { type: 'reply', text: el ? `🔮 Mage — Sihir ${SIHIR_ELEMEN[el].nama}` : '🔮 Mage — Sihir', id: el ? `.sihir ${el}` : '.sihir' },
    { type: 'reply', text: '📊 Cek Status Raid', id: '.statusraid' }
  ];
}

function namaMekanik(key) {
  return {
    bara: 'Bara Membakar 🔥',
    lifesteal: 'Serapan Jiwa 🩸',
    chain: 'Chain Lightning ⚡⛓️',
    cengkeram: 'Tentakel Cengkeram 🐙'
  }[key] || 'Serangan Biasa';
}

/** Terapkan damage ke satu pemain, menghormati perisai & mencatat log. */
function terapkanDamage(p, damage, logs, { tembusPerisai = false, pasangBadan = false } = {}) {
  let pDmg = Math.max(0, Math.floor(damage));
  let absorbed = 0;

  if (!tembusPerisai && p.shield > 0) {
    absorbed = Math.min(p.shield, pDmg);
    p.shield -= absorbed;
    pDmg -= absorbed;
    p.damageAbsorbed += absorbed;
  }
  p.hp -= pDmg;

  const absorbTxt = absorbed > 0 ? ` (🛡️ ${absorbed} diserap perisai)` : (tembusPerisai ? ' _(menembus perisai!)_' : '');
  const prefix = pasangBadan
    ? `📢 *${p.name}* pasang badan menahan seluruh amukan Boss *(Iron Skin -40%)* — `
    : `💢 *${p.name}* `;

  if (p.hp <= 0) {
    p.hp = 0;
    p.isAlive = false;
    p.kaliKo++;
    logs.push(`💀 *${p.name}* menerima *-${pDmg.toLocaleString('id-ID')} HP*${absorbTxt} dan GUGUR${pasangBadan ? ' sebagai pahlawan pembela regu' : ''}!`);
  } else if (pDmg === 0 && absorbed > 0) {
    // Menulis "-0 HP" saat perisai menahan habis serangan terbaca seperti bug.
    logs.push(`🛡️ *${p.name}* — perisai menahan seluruh *${absorbed.toLocaleString('id-ID')} DMG*! _(HP utuh ${p.hp}/${p.maxHp})_`);
  } else {
    logs.push(`${prefix}menerima *-${pDmg.toLocaleString('id-ID')} HP*${absorbTxt} (Sisa: ${p.hp}/${p.maxHp}).`);
  }
}

/** Efek sampingan mekanik boss setelah serangan (bakar / cengkeram). */
function terapkanEfekMekanik(session, mekanik, logs, players) {
  if (mekanik === 'bara') {
    const hidup = Array.from(players.values()).filter(p => p.isAlive && p.burn <= 0);
    if (hidup.length > 0) {
      const korban = randomItem(hidup);
      korban.burn = 2;
      logs.push(`🔥 *Bara Membakar!* Kulit *${korban.name}* menyala — *-140 HP* per ronde selama *2 ronde* sampai Healer memadamkannya.`);
    }
  } else if (mekanik === 'cengkeram' && !session.grabbed) {
    const kandidat = Array.from(players.values()).filter(p => p.isAlive && p.roleKey !== 'tank');
    if (kandidat.length > 0 && Math.random() < 0.40) {
      const korban = randomItem(kandidat);
      session.grabbed = korban.jid;
      logs.push(`🐙 *TENTAKEL MENCENGKERAM!* *${korban.name}* terjerat dan tidak bisa beraksi.\n   👉 Rekan lain harus \`.serang\` ronde depan untuk melepaskannya!`);
    }
  }
}

// ─── 14. KEMENANGAN ──────────────────────────────────────────────────

async function resolveVictory(sock, session, battleLogs) {
  const { boss, players, groupJid } = session;
  const mentions = Array.from(players.keys());
  const totalRonde = session.round;

  let topDamager = null;
  let topSupport = null;
  let maxDmg = -1;
  let maxSupp = -1;

  for (const p of players.values()) {
    if (p.damageDealt > maxDmg) { maxDmg = p.damageDealt; topDamager = p; }
    const suppScore = p.healingDone + p.damageAbsorbed;
    if (suppScore > maxSupp && suppScore > 0) { maxSupp = suppScore; topSupport = p; }
  }

  const cepat = totalRonde <= boss.targetRonde;
  const bonusCepat = cepat ? 1.25 : 1.0;

  const barisHadiah = [];
  const lootLog = [];

  for (const p of players.values()) {
    const rasio = rasioPartisipasi(p, totalRonde);
    let finalPoin = Math.floor(boss.poinPemain * bonusCepat * rasio);
    let finalXp = Math.floor(boss.xpPemain * rasio);
    const label = [];

    if (topDamager && p.jid === topDamager.jid) {
      finalPoin += Math.floor(boss.poinPemain * 0.35);
      label.push('🥇 MVP DMG');
    }
    if (topSupport && p.jid === topSupport.jid) {
      finalPoin += Math.floor(boss.poinPemain * 0.25);
      label.push('💖 MVP SUP');
    }
    if (rasio < 1) label.push(`⚠️ partisipasi ${Math.round(rasio * 100)}%`);

    await db.awardGamePoints(p.jid, finalPoin, true);
    await db.grantXp(p.jid, finalXp);

    await db.recordRaidResult(p.jid, {
      won: true,
      bossId: boss.id,
      damage: p.damageDealt,
      healing: p.healingDone,
      absorbed: p.damageAbsorbed,
      mvpDamage: topDamager && p.jid === topDamager.jid,
      mvpSupport: topSupport && p.jid === topSupport.jid,
      ko: p.kaliKo,
      prize: finalPoin
    });

    barisHadiah.push(`${p.emoji} *${p.name}* — *+${finalPoin.toLocaleString('id-ID')} Poin* / +${finalXp} XP${label.length ? ` _(${label.join(', ')})_` : ''}`);

    // Loot kartu TCG
    const isMvp = (topDamager && p.jid === topDamager.jid) || (topSupport && p.jid === topSupport.jid);
    const kartu = await beriLoot(p.jid, boss, isMvp, rasio);
    if (kartu) lootLog.push(`🃏 *${p.name}* mendapat kartu *${kartu.nama}* [${kartu.rarity}]${isMvp ? ' _(jaminan MVP)_' : ''}`);

    // Ransum energi Arena Kartu. Ini jalur utama menambah energi TCG di luar
    // regen — sengaja lewat aktivitas bersama, bukan lewat saldo poin.
    const ransum = await beriRansum(p.jid, boss, isMvp);
    if (ransum) lootLog.push(`🎒 *${p.name}* mendapat *${ransum.nama}*${isMvp ? ' _(jaminan MVP)_' : ''}`);
  }

  await db.recordRaidGroupKill(groupJid, boss.id, totalRonde);
  await db.setCooldown(groupJid, `RAID:${boss.id}`, boss.cooldownMenit * 60 * 1000);
  await db.setCooldown(groupJid, 'RAID:LOBBY', LOBBY_COOLDOWN_MS);
  raidCooldowns.set(groupJid, Date.now());

  const victoryMsg =
`${battleLogs.join('\n')}

🏆 *VICTORY! WORLD BOSS BERHASIL DITUMBANGKAN!* 🎉
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Selamat kepada seluruh regu pahlawan! ${boss.emoji} *${boss.name}* telah binasa dalam *${totalRonde} ronde*!
${cepat ? `⚡ *CLEAR CEPAT!* (target ${boss.targetRonde} ronde) — seluruh hadiah poin *+25%*!` : `🐢 Selesai di ronde ${totalRonde} (target clear cepat: ${boss.targetRonde} ronde).`}

👑 *PENGHARGAAN GELAR MVP:*
🥇 *MVP Top Damager:* ${topDamager ? `*${topDamager.name}* — *${topDamager.damageDealt.toLocaleString('id-ID')} total damage*` : '-'}
💖 *MVP Best Support:* ${topSupport ? `*${topSupport.name}* — *${(topSupport.healingDone + topSupport.damageAbsorbed).toLocaleString('id-ID')} heal & serapan*` : '-'}

🎁 *PEMBAGIAN HADIAH:*
${barisHadiah.join('\n')}
${lootLog.length ? `\n🃏 *LOOT KARTU ARENA:*\n${lootLog.join('\n')}\n_Cek dengan \`.tcg koleksi\`._` : '\n🃏 _Sayang sekali, tidak ada kartu yang jatuh kali ini._'}

⏳ *${boss.name}* akan bangkit kembali di grup ini dalam *${boss.cooldownMenit} menit*.

_Ketik \`.raid list\` untuk melihat boss lain, atau \`.raidtop\` untuk papan peringkat pemburu boss._`;

  await send(sock, groupJid, null, victoryMsg, {
    buttons: [
      { type: 'reply', text: '🐉 Daftar Boss (.raid list)', id: '.raid list' },
      { type: 'reply', text: '📊 Statistikku (.raidstats)', id: '.raidstats' },
      { type: 'reply', text: '🏅 Papan Peringkat', id: '.raidtop' }
    ],
    mentions
  });
}

/**
 * Drop ransum energi Arena Kartu untuk anggota regu yang menang.
 *
 * Bos yang lebih besar memberi ransum lebih sering dan lebih baik. Dibungkus
 * try/catch dengan alasan yang sama seperti beriLoot: kegagalan modul TCG
 * tidak boleh mengganggu pembagian hadiah raid.
 */
async function beriRansum(jid, boss, isMvp) {
  try {
    const peluang = Math.min(0.9, 0.25 + (boss.tier || 1) * 0.12);
    if (!isMvp && Math.random() > peluang) return null;

    const { TCG_RANSUM, tcgTambahItem } = await import('../database/tcgDb.js');
    // Bekal Agung hanya dari bos tier tinggi atau untuk MVP.
    const kandidat = (isMvp || (boss.tier || 1) >= 3)
      ? ['RANSUM_MENARA', 'RANSUM_GERBANG', 'RANSUM_AGUNG']
      : ['RANSUM_MENARA', 'RANSUM_GERBANG'];

    const pilih = randomItem(kandidat);
    await tcgTambahItem(jid, pilih, 1);
    return TCG_RANSUM[pilih];
  } catch (e) {
    console.warn('[RAID RANSUM] Gagal memberi ransum:', e.message);
    return null;
  }
}

/**
 * Drop kartu TCG. Sengaja dibungkus try/catch: kegagalan arena kartu tidak
 * boleh menggagalkan pembagian hadiah raid.
 */
async function beriLoot(jid, boss, isMvp, rasio) {
  try {
    const cfg = boss.loot;
    if (!cfg) return null;
    if (!isMvp && Math.random() > cfg.peluang * rasio) return null;

    const { getKartuByRarity } = await import('./tcg/cards.js');
    const { tcgTambahKartu } = await import('../database/tcgDb.js');

    const rarity = isMvp ? cfg.mvp : randomItem(cfg.rarity);
    const daftar = getKartuByRarity(rarity);
    if (!daftar || daftar.length === 0) return null;

    const kartu = randomItem(daftar);
    await tcgTambahKartu(jid, kartu.id, 1);
    return { nama: kartu.nama || kartu.name || kartu.id, rarity };
  } catch (e) {
    console.warn('[RAID LOOT] Gagal memberi kartu:', e.message);
    return null;
  }
}

// ─── 15. KEKALAHAN ───────────────────────────────────────────────────

async function resolveDefeat(sock, session, battleLogs, sebab = 'wipe') {
  const { boss, groupJid, players } = session;
  const mentions = Array.from(players.keys());
  const totalRonde = session.round;

  const sisaPersen = Math.max(0, Math.round((boss.hp / boss.maxHp) * 100));
  const barisHadiah = [];

  for (const p of players.values()) {
    const rasio = rasioPartisipasi(p, totalRonde);
    // Kontribusi dihitung dari damage + heal + serapan, bukan damage saja.
    // Healer dan Tank menyumbang kemenangan tanpa angka damage besar; memakai
    // damage saja membuat mereka selalu menerima kompensasi paling kecil.
    const nilaiKontribusi = p.damageDealt + p.healingDone + p.damageAbsorbed;
    const kontribusi = Math.min(1, nilaiKontribusi / Math.max(1, boss.maxHp));
    const poin = Math.floor(boss.poinPemain * 0.10 * rasio * (0.5 + kontribusi));
    const xp = Math.floor(50 + boss.xpPemain * 0.25 * rasio);

    if (poin > 0) await db.awardGamePoints(p.jid, poin, false);
    await db.grantXp(p.jid, xp);

    await db.recordRaidResult(p.jid, {
      won: false,
      bossId: boss.id,
      damage: p.damageDealt,
      healing: p.healingDone,
      absorbed: p.damageAbsorbed,
      mvpDamage: false,
      mvpSupport: false,
      ko: p.kaliKo,
      prize: poin
    });

    barisHadiah.push(`${p.emoji} *${p.name}* — ${p.damageDealt.toLocaleString('id-ID')} DMG • *+${poin} Poin* / +${xp} XP`);
  }

  // Kalah tetap kena cooldown boss, tapi setengahnya saja — regu berhak
  // mencoba ulang lebih cepat daripada setelah menang.
  await db.setCooldown(groupJid, `RAID:${boss.id}`, Math.floor(boss.cooldownMenit * 0.5) * 60 * 1000);
  await db.setCooldown(groupJid, 'RAID:LOBBY', LOBBY_COOLDOWN_MS);
  raidCooldowns.set(groupJid, Date.now());

  const judul = sebab === 'timeout'
    ? `⌛ *DEFEAT — REGU KEHABISAN TENAGA DI RONDE ${MAX_ROUND}!* 🪦`
    : `💀 *DEFEAT — SELURUH REGU TELAH GUGUR!* 🪦`;
  const alasan = sebab === 'timeout'
    ? `Pertempuran melewati batas *${MAX_ROUND} ronde*. Amukan ${boss.emoji} *${boss.name}* memaksa regu mundur dengan boss masih menyisakan *${sisaPersen}% HP*.`
    : `Kekuatan ${boss.emoji} *${boss.name}* terlalu dahsyat! Seluruh pahlawan terkapar saat boss masih menyisakan *${sisaPersen}% HP*.`;

  const saran = sebab === 'timeout'
    ? `💡 *Evaluasi:* regu terlalu bertahan. Perbanyak *DPS/Mage*, pakai \`.berserk\` lebih awal, dan Mage wajib \`.sihir ${boss.lemah || '<elemen lemah>'}\` untuk damage 1,6x.`
    : `💡 *Evaluasi:* pastikan regu punya *3 role berbeda* (bonus Formasi Lengkap), Tank rutin \`.taunt\`, dan Mage \`.freeze\` tepat saat boss charge ultimate.`;

  const defeatMsg =
`${battleLogs.join('\n')}

${judul}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${alasan}

🎁 *KOMPENSASI KONTRIBUSI:*
${barisHadiah.join('\n')}

${saran}

⏳ *${boss.name}* dapat ditantang lagi dalam *${Math.floor(boss.cooldownMenit * 0.5)} menit*.`;

  await send(sock, groupJid, null, defeatMsg, {
    buttons: [
      { type: 'reply', text: '🐉 Daftar Boss (.raid list)', id: '.raid list' },
      { type: 'reply', text: '📊 Statistikku', id: '.raidstats' },
      { type: 'reply', text: '🎮 Menu Game', id: '.menu game' }
    ],
    mentions
  });
}

// ─── 16. STATISTIK & PAPAN PERINGKAT ─────────────────────────────────

const GELAR_BOSS = [
  { field: 'kill_erebus', gelar: '🕳️ Penakluk Kehampaan' },
  { field: 'kill_leviathan', gelar: '👑 Pembantai Leviathan' },
  { field: 'kill_raijin', gelar: '⚡ Peredam Badai' },
  { field: 'kill_malakor', gelar: '💀 Pemburu Iblis' },
  { field: 'kill_ignis', gelar: '🐲 Penjinak Naga' }
];

function gelarRaid(stats) {
  for (const g of GELAR_BOSS) {
    if ((stats[g.field] || 0) > 0) return g.gelar;
  }
  return '🗡️ Pahlawan Pemula';
}

async function showRaidStats(sock, jid, senderNumber, messageObj, args) {
  const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const targetJid = mentions[0] || senderNumber;

  const stats = await db.getRaidStats(targetJid);
  if (!stats || stats.raids_joined === 0) {
    await send(sock, jid, messageObj, `📊 ${targetJid === senderNumber ? 'Kamu' : `@${targetJid.split('@')[0]}`} belum pernah ikut Raid World Boss.\n👉 Ketik \`.raid\` di grup untuk memulai!`, { mentions: [targetJid] });
    return true;
  }

  const cust = await db.getCustomerByPhone(targetJid);
  const nama = cust?.nama || `@${targetJid.split('@')[0]}`;
  const winRate = Math.round((stats.raids_won / Math.max(1, stats.raids_joined)) * 100);

  const rincianBoss = [
    ['🐲 Ignis', stats.kill_ignis],
    ['💀 Malakor', stats.kill_malakor],
    ['⚡ Raijin', stats.kill_raijin],
    ['👑 Leviathan', stats.kill_leviathan],
    ['🕳️ Erebus', stats.kill_erebus]
  ].map(([n, v]) => `   ${n}: *${v || 0}x*`).join('\n');

  await send(sock, jid, messageObj,
`📊 *STATISTIK RAID WORLD BOSS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *${nama}*
🏅 *Gelar:* ${gelarRaid(stats)}

⚔️ Raid diikuti: *${stats.raids_joined}x*
🏆 Boss ditumbangkan: *${stats.raids_won}x* _(win rate ${winRate}%)_
💥 Total damage: *${(stats.total_damage || 0).toLocaleString('id-ID')}*
🔥 Damage terbaik 1 raid: *${(stats.best_damage || 0).toLocaleString('id-ID')}*
💖 Total heal: *${(stats.total_healing || 0).toLocaleString('id-ID')}*
🛡️ Total damage diserap: *${(stats.total_absorbed || 0).toLocaleString('id-ID')}*
🥇 MVP Damager: *${stats.mvp_damage || 0}x* • 💖 MVP Support: *${stats.mvp_support || 0}x*
💀 Kali gugur: *${stats.times_ko || 0}x*
🎁 Total poin dari raid: *${(stats.points_won || 0).toLocaleString('id-ID')}*

🐉 *Rincian Boss Ditumbangkan:*
${rincianBoss}

_Ketik \`.raidtop\` untuk papan peringkat global._`, { mentions: [targetJid] });
  return true;
}

async function showRaidLeaderboard(sock, jid, messageObj) {
  const rows = await db.getRaidLeaderboard(10, 1);
  if (!rows || rows.length === 0) {
    await send(sock, jid, messageObj, "🏅 Belum ada pemburu World Boss yang tercatat.\n👉 Ketik `.raid` di grup untuk jadi yang pertama!");
    return true;
  }

  const medali = ['🥇', '🥈', '🥉'];
  const mentions = [];
  const baris = rows.map((r, i) => {
    let nama;
    if (r.customer_nama && r.customer_nama !== 'Member') {
      nama = r.customer_nama;
    } else {
      nama = `@${String(r.customer_jid).split('@')[0]}`;
      mentions.push(r.customer_jid);
    }
    const wr = Math.round((r.raids_won / Math.max(1, r.raids_joined)) * 100);
    return `${medali[i] || `${i + 1}.`} *${nama}*\n     🏆 ${r.raids_won} boss tumbang • 💥 ${(r.total_damage || 0).toLocaleString('id-ID')} damage • 👑 ${r.mvp_damage || 0}x MVP _(menang ${wr}%)_`;
  }).join('\n');

  await send(sock, jid, messageObj,
    `🏅 *PAPAN PERINGKAT PEMBURU WORLD BOSS* 🐉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${baris}\n\n` +
    `_Urutan: jumlah boss ditumbangkan, lalu total damage._\n👉 Ketik \`.raidstats\` untuk statistik pribadimu.`,
    { mentions });
  return true;
}

// ─── 17. BATALKAN SESI ───────────────────────────────────────────────

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
  saveRaidSessions();
  await db.setCooldown(jid, 'RAID:LOBBY', LOBBY_COOLDOWN_MS);

  await send(sock, jid, messageObj, `🛑 *RAID DIBATALKAN!* Pertempuran melawan ${session.boss.emoji} *${session.boss.name}* telah dibatalkan.\n_Tidak ada hadiah maupun statistik yang dicatat._`);
  return true;
}

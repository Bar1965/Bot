/**
 * ARENA KARTU MONSTER — SISTEM UTAMA (PURE 0, 3V3 DECK, PVE MENARA, PVP DUEL)
 *
 * Semua perintah bersarang di bawah `.tcg` untuk mencegah bentrokan nama command.
 */

import * as db from '../../../database.js';
import { send, isOnCooldown } from '../helpers.js';
import { tcgKey } from './identity.js';
import {
  KARTU, TOTAL_KARTU, getKartu, getKartuByRarity, cariKartu,
  STAT_RARITY, statKartu, ELEMEN, SKILL, PETA_COST, costKartu
} from './cards.js';
import {
  simulate3v3, TOWER_FLOORS, getTowerFloor,
  getActiveDuel, setTcgDuel, deleteTcgDuel
} from './battle.js';

// ============================================================
// PELUANG GACHA & PITY
// ============================================================

const PELUANG_DASAR = [
  ['LEGENDARY', 0.027],
  ['EPIC',      0.100],
  ['RARE',      0.270],
  ['COMMON',    0.603]
];

const PITY_LEGENDARY = 15;   // tarikan ke-15 tanpa Legendary+ dijamin Legendary
const PITY_MYTHIC_LUNAK = 45;
const PITY_MYTHIC_KERAS = 60;
const KENAIKAN_LUNAK = 0.04;

export function peluangMythic(sejakMythic) {
  const n = Math.max(0, Math.floor(sejakMythic) || 0);
  if (n >= PITY_MYTHIC_KERAS) return 1.0;
  if (n < PITY_MYTHIC_LUNAK) return 0.003;
  return Math.min(1, 0.003 + (n - (PITY_MYTHIC_LUNAK - 1)) * KENAIKAN_LUNAK);
}

function undiRarity(pity) {
  const sejakM = pity?.sejak_mythic || 0;
  const sejakL = pity?.sejak_legendary || 0;

  if (sejakM >= PITY_MYTHIC_KERAS) return 'MYTHIC';
  if (sejakL >= PITY_LEGENDARY - 1) return 'LEGENDARY';

  const pM = peluangMythic(sejakM);
  let r = Math.random();
  if (r < pM) return 'MYTHIC';

  r = (r - pM) / (1 - pM);
  let akum = 0;
  for (const [rarity, p] of PELUANG_DASAR) {
    akum += p;
    if (r < akum) return rarity;
  }
  return 'COMMON';
}

function undiKartu(rarity) {
  const daftar = getKartuByRarity(rarity);
  return daftar[Math.floor(Math.random() * daftar.length)];
}

// ============================================================
// TAMPILAN TEKS & FORMATTING
// ============================================================

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const bintang = (rarity) => '★'.repeat(STAT_RARITY[rarity].bintang) + '☆'.repeat(5 - STAT_RARITY[rarity].bintang);

function barisKartu(kartu, level = 1, qty = null) {
  const el = ELEMEN[kartu.elemen];
  const s = statKartu(kartu, level);
  const ekor = qty !== null && qty > 1 ? ` ×${qty}` : '';
  return `${el.emoji} ${kartu.id} ${kartu.nama}${ekor} — ${bintang(kartu.rarity)} Lv.${s.level}`;
}

function kartuPenuh(kartu, level = 1, qty = 1) {
  const el = ELEMEN[kartu.elemen];
  const s = statKartu(kartu, level);
  const cost = costKartu(kartu);
  const baris = [
    '```',
    `${el.emoji} ${kartu.nama.toUpperCase()}`,
    `${bintang(kartu.rarity)} (${cost}★)  ${STAT_RARITY[kartu.rarity].label} · ${el.nama}`,
    '',
    `ATK  ${String(fmt(s.atk)).padEnd(8)}HP  ${fmt(s.hp)}`,
    `Lv.  ${String(s.level).padEnd(8)}Punya  ${qty}`,
  ];
  if (kartu.skill && SKILL[kartu.skill]) {
    baris.push('', `Skill: ${SKILL[kartu.skill].nama}`, SKILL[kartu.skill].teks);
  }
  baris.push('```');
  return baris.join('\n');
}

function hasilTarikan(daftar) {
  const urut = { MYTHIC: 0, LEGENDARY: 1, EPIC: 2, RARE: 3, COMMON: 4 };
  const sorted = [...daftar].sort((a, b) => urut[a.kartu.rarity] - urut[b.kartu.rarity]);
  return sorted.map(x => {
    const el = ELEMEN[x.kartu.elemen];
    const tanda = x.baru ? ' 🆕' : '';
    return `${el.emoji} ${bintang(x.kartu.rarity)} *${x.kartu.nama}* (${x.kartu.id})${tanda}`;
  }).join('\n');
}

async function prosesTarikan(key, jumlah, gratis = false) {
  const hasil = [];
  for (let i = 0; i < jumlah; i++) {
    const pity = await db.tcgGetPity(key);
    const rarity = undiRarity(pity);
    const kartu = undiKartu(rarity);
    const sebelum = await db.tcgGetKartu(key, kartu.id);
    await db.tcgTambahKartu(key, kartu.id, 1);
    await db.tcgCatatTarikan(key, rarity, gratis);
    hasil.push({ kartu, baru: !sebelum || sebelum.qty === 0 });
  }
  return hasil;
}

// ============================================================
// ROUTER PERINTAH (.TCG ...)
// ============================================================

export async function handleTcgCommand({
  sock, jid, senderNumber, messageObj, args,
  isFromGroup = false, isAdmin = false, isOwner = false, isStoreAdmin = false
}) {
  const sub = String(args[1] || '').toLowerCase();
  const key = tcgKey(senderNumber);

  // --- Sakelar per grup ---
  if (['on', 'off'].includes(sub)) {
    if (!isFromGroup) {
      await send(sock, jid, messageObj, '⚠️ Sakelar arena hanya bisa diatur di dalam grup.');
      return true;
    }
    if (!isStoreAdmin && !isOwner) {
      await send(sock, jid, messageObj, '❌ Perintah ini khusus *Admin Toko* atau *Owner*.');
      return true;
    }
    const setelan = await db.getGroupSettings(jid);
    const fitur = setelan.features_config || {};
    fitur['tcg'] = (sub === 'on');
    await db.updateGroupSettings(jid, { features_config: fitur });
    await send(sock, jid, messageObj, `✅ *ARENA KARTU MONSTER* berhasil di-${sub.toUpperCase()}-kan untuk grup ini.`);
    return true;
  }

  if (isFromGroup) {
    const setelan = await db.getGroupSettings(jid);
    const fitur = setelan.features_config || {};
    if (fitur['tcg'] === false) {
      await send(sock, jid, messageObj, '⚠️ Arena Kartu Monster sedang *dimatikan* di grup ini.\nAdmin Toko bisa menyalakannya dengan `.tcg on`.');
      return true;
    }
  }

  if (isOnCooldown(`tcg:${key}`, 800)) return true;

  switch (sub) {
    case '':
    case 'bantuan':
    case 'help':
    case 'menu':
      return await tampilBantuan(sock, jid, messageObj);

    case 'mulai':
    case 'start':
      return await ambilStarter(sock, jid, messageObj, key);

    case 'gacha':
    case 'tarik':
      return await tarik(sock, jid, messageObj, key, 1);

    case 'gacha10':
    case 'tarik10':
      return await tarik(sock, jid, messageObj, key, 10);

    case 'gratis':
    case 'daily':
      return await tarikGratis(sock, jid, messageObj, key);

    case 'koleksi':
    case 'collection':
      return await tampilKoleksi(sock, jid, messageObj, key, args[2]);

    case 'kartu':
    case 'card':
      return await tampilKartu(sock, jid, messageObj, key, args.slice(2).join(' '));

    case 'rate':
    case 'peluang':
      return await tampilRate(sock, jid, messageObj, key);

    case 'keping':
    case 'saldo':
      return await tampilKeping(sock, jid, messageObj, key);

    case 'dek':
    case 'deck':
      return await tampilDek(sock, jid, messageObj, key);

    case 'pasang':
    case 'set':
      return await pasangDek(sock, jid, messageObj, key, args[2], args[3]);

    case 'lepas':
      return await lepasDek(sock, jid, messageObj, key, args[2]);

    case 'menara':
    case 'dungeon':
    case 'tower':
      return await kelolaMenara(sock, jid, messageObj, key, args[2]);

    case 'duel':
    case 'tantang':
      return await tantangDuel(sock, jid, messageObj, key, args, isFromGroup);

    case 'gas':
    case 'terima':
    case 'accept':
      return await terimaDuel(sock, jid, messageObj, key, isFromGroup);

    case 'tolak':
    case 'cancel':
      return await tolakDuel(sock, jid, messageObj, key);

    case 'jual':
      return await jualKartu(sock, jid, messageObj, key, args[2], args[3]);

    case 'serpih':
      return await serpihKartu(sock, jid, messageObj, key, args[2], args[3]);

    case 'serpihan':
    case 'shards':
      return await tampilSerpihan(sock, jid, messageObj, key);

    case 'lebur':
      return await leburSerpihan(sock, jid, messageObj, key, args[2]);

    case 'naik':
    case 'upgrade':
      return await naikLevel(sock, jid, messageObj, key, args[2]);

    case 'give':
    case 'beri':
      return await adminBeri(sock, jid, messageObj, args, isStoreAdmin, isOwner);

    case 'cek':
      return await adminCek(sock, jid, messageObj, args, isStoreAdmin, isOwner);

    default:
      await send(sock, jid, messageObj, `⚠️ Sub-perintah \`${sub}\` tidak dikenal.\nKetik \`.tcg\` untuk melihat daftar perintah.`);
      return true;
  }
}

// ============================================================
// HANDLER PER PERINTAH
// ============================================================

async function tampilBantuan(sock, jid, messageObj) {
  const teks = [
    '🎴 *ARENA KARTU MONSTER (TCG)*',
    `Koleksi ${TOTAL_KARTU} kartu monster nusantara, susun Dek 3v3 (Maks 10★), dan taklukkan arena!`,
    '',
    '*MULAI & HARIAN*',
    `• \`.tcg mulai\` — Ambil Paket Pemula (5 kartu + ${db.TCG_BONUS_STARTER_KEPING} Keping)`,
    `• \`.tcg daily\` — Klaim 1 Gacha Gratis + ${db.TCG_BONUS_HARIAN_KEPING} Keping harian`,
    '',
    '*GACHA & KOLEKSI*',
    `• \`.tcg gacha\` — Tarik 1 kartu (${fmt(db.TCG_HARGA_TARIK)} Keping)`,
    `• \`.tcg gacha10\` — Tarik 10 kartu (${fmt(db.TCG_HARGA_TARIK10)} Keping)`,
    '• \`.tcg rate\` — Cek peluang gacha & status Pity',
    '• \`.tcg koleksi [hal]\` — Lihat kartu koleksimu',
    '• \`.tcg kartu <id>\` — Lihat statistik detail kartu',
    '',
    '*DEK (MAKSIMAL 10★)*',
    '• \`.tcg dek\` — Lihat formasi 3 kartu di dekmumu',
    '• \`.tcg pasang <1-3> <id>\` — Pasang kartu ke Slot 1, 2, atau 3',
    '• \`.tcg lepas <1-3>\` — Lepas kartu dari Slot tertentu',
    '',
    '*PERTARUNGAN (3V3)*',
    '• \`.tcg menara\` — Info progres PvE Menara Monster (30 Lantai)',
    '• \`.tcg menara lawan\` — Tantang lantai menara selanjutnya',
    '• \`.tcg duel @member [n]\` — Tantang duel member grup (Taruhan Keping)',
    '• \`.tcg gas\` — Terima tantangan duel yang masuk',
    '• \`.tcg tolak\` — Tolak tantangan duel',
    '',
    '*PROGRESI & KEPING*',
    '• \`.tcg naik <id>\` — Naikkan level kartu pakai serpihan',
    '• \`.tcg serpih <id> [n]\` — Pecah duplikat jadi serpihan',
    '• \`.tcg lebur <rarity>\` — 5 serpihan ➔ 1 tingkat di atasnya',
    '• \`.tcg jual <id> [n]\` — Jual duplikat jadi Keping',
    '• \`.tcg serpihan\` — Cek jumlah serpihanmu',
    '• \`.tcg keping\` — Cek saldo Keping Arena',
    '',
    '_Ekonomi 100% mandiri (Pure 0). Semua pemain mulai dari garis start yang sama._'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function ambilStarter(sock, jid, messageObj, key) {
  const berhasil = await db.tcgTandaiStarter(key);
  if (!berhasil) {
    await send(sock, jid, messageObj, '⚠️ Kamu sudah pernah mengambil paket pemula.\nCoba `.tcg daily` untuk tarikan harianmu.');
    return true;
  }

  const hasil = [];
  for (let i = 0; i < 4; i++) {
    const kartu = undiKartu(Math.random() < 0.75 ? 'COMMON' : 'RARE');
    await db.tcgTambahKartu(key, kartu.id, 1);
    hasil.push({ kartu, baru: true });
  }
  const rare = undiKartu('RARE');
  await db.tcgTambahKartu(key, rare.id, 1);
  hasil.push({ kartu: rare, baru: true });

  await db.tcgAddKeping(key, db.TCG_BONUS_STARTER_KEPING, 'PAKET_PEMULA', 'starter');

  // Auto pasang 3 kartu pertama ke dek
  await db.tcgSetDeckSlot(key, 1, hasil[0].kartu.id, PETA_COST);
  await db.tcgSetDeckSlot(key, 2, hasil[1].kartu.id, PETA_COST);
  await db.tcgSetDeckSlot(key, 3, rare.id, PETA_COST);

  const teks = [
    '🎁 *PAKET PEMULA DITERIMA!*',
    '',
    hasilTarikan(hasil),
    '',
    `💠 Bonus: *${db.TCG_BONUS_STARTER_KEPING} Keping Arena*`,
    `🃏 *Dek 3v3 pemula sudah otomatis dipasang!*`,
    '',
    'Lanjut: Cek dekmumu dengan `.tcg dek`, atau langsung jajal `.tcg menara lawan`!'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tarik(sock, jid, messageObj, key, jumlah) {
  const sisaHarian = await db.tcgSisaTarikanHarian(key);
  if (sisaHarian < jumlah) {
    await send(sock, jid, messageObj,
      `⚠️ Jatah tarikan harianmu tinggal *${sisaHarian}* dari ${db.TCG_BATAS_TARIK_HARIAN}.\nBatas ini menjaga ekonomi arena tetap adil.`);
    return true;
  }

  const harga = jumlah === 10 ? db.TCG_HARGA_TARIK10 : db.TCG_HARGA_TARIK * jumlah;
  const bayar = await db.tcgSpendKeping(key, harga, 'GACHA', `x${jumlah}`);
  if (!bayar.success) {
    await send(sock, jid, messageObj,
      `💠 Keping tidak cukup.\nButuh *${fmt(harga)}*, kamu punya *${fmt(bayar.keping || 0)}*.\n\nCari Keping: \`.tcg daily\`, \`.tcg menara\`, \`.tcg jual\`, atau duel PvP.`);
    return true;
  }

  const hasil = await prosesTarikan(key, jumlah, false);
  const pity = await db.tcgGetPity(key);
  const baru = hasil.filter(h => h.baru).length;

  const teks = [
    jumlah === 1 ? '🎴 *TARIKAN KARTU*' : `🎴 *TARIKAN ×${jumlah}*`,
    '',
    hasilTarikan(hasil),
    '',
    `💠 Sisa Keping: *${fmt(bayar.keping)}*${baru > 0 ? `   ·   🆕 ${baru} kartu baru` : ''}`,
    `🎯 Menuju jaminan Mythic: *${Math.max(0, PITY_MYTHIC_KERAS - pity.sejak_mythic)}* tarikan lagi`
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tarikGratis(sock, jid, messageObj, key) {
  const res = await db.tcgKlaimGratis(key);
  if (!res.success) {
    await send(sock, jid, messageObj, '⏳ Hadiah gratismu hari ini sudah diambil.\nDatang lagi besok setelah jam 00:00 WIB!');
    return true;
  }

  const hasil = await prosesTarikan(key, 1, true);
  const teks = [
    '🎁 *HADIAH HARIAN ARENA TERKLAIM*',
    '',
    hasilTarikan(hasil),
    '',
    `💠 Bonus Keping: *+${db.TCG_BONUS_HARIAN_KEPING} Keping* (Total: *${fmt(res.kepingTotal)}*)`,
    `⚡ Stamina Menara telah di-refill menjadi *${db.TCG_MAX_STAMINA}/${db.TCG_MAX_STAMINA}*!`
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tampilKoleksi(sock, jid, messageObj, key, halamanArg) {
  const koleksi = await db.tcgGetKoleksi(key);
  if (!koleksi.length) {
    await send(sock, jid, messageObj, '📭 Koleksimu masih kosong.\nMulai dengan `.tcg mulai` untuk mengambil paket pemula.');
    return true;
  }

  const PER_HAL = 15;
  const totalHal = Math.ceil(koleksi.length / PER_HAL);
  const hal = Math.max(1, Math.min(totalHal, parseInt(halamanArg, 10) || 1));
  const potong = koleksi.slice((hal - 1) * PER_HAL, hal * PER_HAL);

  const hitung = await db.tcgHitungKoleksi(key);
  const baris = potong.map(row => {
    const kartu = getKartu(row.card_id);
    if (!kartu) return null;
    return barisKartu(kartu, row.card_lv, row.qty);
  }).filter(Boolean);

  const teks = [
    '📚 *KOLEKSI KARTUMU*',
    `${hitung.unik}/${TOTAL_KARTU} jenis · ${hitung.total} kartu total`,
    '',
    baris.join('\n'),
    '',
    totalHal > 1 ? `Halaman ${hal}/${totalHal} — \`.tcg koleksi ${hal < totalHal ? hal + 1 : 1}\`` : '',
    'Detail: `.tcg kartu <id>`'
  ].filter(Boolean).join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tampilKartu(sock, jid, messageObj, key, kueri) {
  if (!kueri) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg kartu <id atau nama>`\nContoh: `.tcg kartu MYT01`');
    return true;
  }
  const cocok = cariKartu(kueri);
  if (!cocok.length) {
    await send(sock, jid, messageObj, `❌ Kartu *${kueri}* tidak ditemukan.`);
    return true;
  }
  if (cocok.length > 1) {
    await send(sock, jid, messageObj,
      `🔎 Ada ${cocok.length} kartu cocok:\n\n${cocok.slice(0, 10).map(k => barisKartu(k)).join('\n')}\n\nPakai ID-nya untuk melihat detail.`);
    return true;
  }

  const kartu = cocok[0];
  const punya = await db.tcgGetKartu(key, kartu.id);
  if (!punya || punya.qty === 0) {
    await send(sock, jid, messageObj, `${kartuPenuh(kartu, 1, 0)}\n\n_Kamu belum memiliki kartu ini._`);
    return true;
  }
  await send(sock, jid, messageObj, kartuPenuh(kartu, punya.card_lv, punya.qty));
  return true;
}

async function tampilRate(sock, jid, messageObj, key) {
  const pity = await db.tcgGetPity(key);
  const pM = peluangMythic(pity.sejak_mythic);
  const sisaL = Math.max(0, PITY_LEGENDARY - 1 - pity.sejak_legendary);
  const sisaM = Math.max(0, PITY_MYTHIC_KERAS - pity.sejak_mythic);

  const teks = [
    '🎯 *PELUANG & PITY ARENA*',
    '',
    '```',
    'Common      60,0%   ★☆☆☆☆ (1 Cost)',
    'Rare        27,0%   ★★☆☆☆ (2 Cost)',
    'Epic        10,0%   ★★★☆☆ (3 Cost)',
    'Legendary    2,7%   ★★★★☆ (4 Cost)',
    'Mythic       0,3%   ★★★★★ (5 Cost)',
    '```',
    '',
    '*STATUS PITY KAMU*',
    `Total tarikan: *${fmt(pity.total_pull)}*`,
    `Sejak Legendary: *${pity.sejak_legendary}* — dijamin dalam *${sisaL}* tarikan lagi`,
    `Sejak Mythic: *${pity.sejak_mythic}* — dijamin dalam *${sisaM}* tarikan lagi`,
    `Peluang Mythic saat ini: *${(pM * 100).toFixed(2)}%*`,
    pity.sejak_mythic >= PITY_MYTHIC_LUNAK ? '🔥 _Soft pity aktif — peluang naik tiap tarikan!_' : '',
    '',
    `Jatah tarikan hari ini: *${await db.tcgSisaTarikanHarian(key)}/${db.TCG_BATAS_TARIK_HARIAN}*`
  ].filter(Boolean).join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tampilKeping(sock, jid, messageObj, key) {
  const w = await db.tcgGetWallet(key);
  const teks = [
    '💠 *KEPING ARENA*',
    '',
    `Saldo: *${fmt(w.keping)} Keping*`,
    `Setara *${Math.floor(w.keping / db.TCG_HARGA_TARIK)}* tarikan gacha`,
    '',
    '_Keping didapat dari Daily, Menara PvE, Jual Duplikat, dan Menang Duel._'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// DEK MANAGEMENT (3 SLOT, MAKS 10 BINTANG)
// ============================================================

async function tampilDek(sock, jid, messageObj, key) {
  const deck = await db.tcgGetDeck(key);
  let totalCost = 0;
  const baris = [];

  for (let s = 1; s <= 3; s++) {
    const slotData = deck[s];
    if (!slotData) {
      baris.push(`*Slot ${s}:* _(Kosong) — pasang dengan \`.tcg pasang ${s} <id>\`_`);
    } else {
      const kartu = getKartu(slotData.card_id);
      if (kartu) {
        const cost = costKartu(kartu);
        totalCost += cost;
        const el = ELEMEN[kartu.elemen];
        const st = statKartu(kartu, slotData.card_lv);
        baris.push(`*Slot ${s}:* ${el.emoji} *${kartu.nama}* (Lv.${st.level}) — ${bintang(kartu.rarity)} (${cost}★)\n   └ ATK: ${fmt(st.atk)} | HP: ${fmt(st.hp)}${kartu.skill ? ` | Skill: ${SKILL[kartu.skill].nama}` : ''}`);
      }
    }
  }

  const teks = [
    '🃏 *FORMASI DEK 3V3 KAMU*',
    `Beban Biaya Dek: *${totalCost}/${db.TCG_MAX_DECK_COST}★*`,
    '',
    ...baris,
    '',
    '• Pasang: `.tcg pasang <1-3> <id_kartu>`',
    '• Lepas: `.tcg lepas <1-3>`',
    '• Tantang: `.tcg menara lawan` atau `.tcg duel @member`'
  ].join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

async function pasangDek(sock, jid, messageObj, key, slotArg, idArg) {
  const slot = parseInt(slotArg, 10);
  if (![1, 2, 3].includes(slot) || !idArg) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg pasang <slot 1-3> <id_kartu>`\nContoh: `.tcg pasang 1 MYT01`');
    return true;
  }

  const kartu = getKartu(idArg);
  if (!kartu) {
    await send(sock, jid, messageObj, `❌ Kartu dengan ID *${idArg}* tidak ditemukan.`);
    return true;
  }

  const res = await db.tcgSetDeckSlot(key, slot, kartu.id, PETA_COST);
  if (!res.success) {
    const pesan = {
      TIDAK_PUNYA: `❌ Kamu belum memiliki kartu *${kartu.nama}*.`,
      COST_MELEBIHI_BATAS: `⚠️ *Kapasitas Dek Melebihi Batas!*\nTotal bintang dekmumu akan menjadi *${res.totalCost}★* (Maksimal *${res.maxCost}★*).\n\nGunakan kartu dengan bintang lebih rendah agar pas.`,
      SLOT_TIDAK_VALID: '⚠️ Slot harus angka 1, 2, atau 3.'
    }[res.reason] || '❌ Gagal memasang kartu ke dek.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const el = ELEMEN[kartu.elemen];
  await send(sock, jid, messageObj,
    `✅ ${el.emoji} *${kartu.nama}* (Lv.${res.cardLv}) berhasil dipasang ke *Slot ${slot}*!\nTotal Biaya Dek: *${res.totalCost}/${res.maxCost}★*`);
  return true;
}

async function lepasDek(sock, jid, messageObj, key, slotArg) {
  const slot = parseInt(slotArg, 10);
  if (![1, 2, 3].includes(slot)) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg lepas <slot 1-3>`\nContoh: `.tcg lepas 2`');
    return true;
  }
  await db.tcgClearDeckSlot(key, slot);
  await send(sock, jid, messageObj, `✅ Kartu di *Slot ${slot}* berhasil dilepas.`);
  return true;
}

// ============================================================
// PVE: MENARA PENJAGA MONSTER (TOWER)
// ============================================================

async function kelolaMenara(sock, jid, messageObj, key, aksiArg) {
  const tower = await db.tcgGetTower(key);
  const targetFloor = (tower.highest_floor || 0) + 1;

  if (aksiArg !== 'lawan' && aksiArg !== 'gas' && aksiArg !== 'fight') {
    const nextInfo = getTowerFloor(targetFloor);
    const teks = [
      '🏰 *MENARA PENJAGA MONSTER (PVE)*',
      `Lantai Tertinggi Dikuasai: *Lantai ${tower.highest_floor}/30*`,
      `⚡ Stamina Hari Ini: *${tower.stamina}/${db.TCG_MAX_STAMINA}*`,
      '',
      targetFloor <= 30
        ? `*Tantangan Selanjutnya:* Lantai ${targetFloor} — _${nextInfo?.nama || 'Monster Penjaga'}_`
        : '🎉 *Kamu telah menaklukkan seluruh 30 lantai Menara Penjaga!*',
      '',
      'Ketik \`.tcg menara lawan\` untuk menantang lantai berikutnya.'
    ].join('\n');
    await send(sock, jid, messageObj, teks);
    return true;
  }

  if (targetFloor > 30) {
    await send(sock, jid, messageObj, '👑 Selamat! Kamu sudah menamatkan seluruh 30 lantai Menara Penjaga.');
    return true;
  }

  if (tower.stamina <= 0) {
    await send(sock, jid, messageObj, '⚡ Stamina Menara hari ini sudah habis (0/5).\nStamina akan terisi kembali besok setelah jam 00:00 WIB.');
    return true;
  }

  const userDeck = await db.tcgGetDeck(key);
  if (!userDeck[1] && !userDeck[2] && !userDeck[3]) {
    await send(sock, jid, messageObj, '⚠️ Dek kamu masih kosong!\nPasang kartu terlebih dahulu dengan `.tcg pasang <1-3> <id>`.');
    return true;
  }

  const floorData = getTowerFloor(targetFloor);
  if (!floorData) {
    await send(sock, jid, messageObj, '❌ Data lantai tidak ditemukan.');
    return true;
  }

  const sim = simulate3v3(userDeck, floorData.deck, 'Kamu', `Penjaga Lantai ${targetFloor}`);

  if (sim.matchWinner === 1) {
    const prog = await db.tcgProgressTower(key, targetFloor, floorData.rewardKeping, floorData.rewardShards);
    const shardBonus = floorData.rewardShards
      ? `\n✦ Serpihan: *+${floorData.rewardShards.jumlah} ${STAT_RARITY[floorData.rewardShards.rarity].label}*`
      : '';

    const teks = [
      `🏰 *KEMENANGAN DI LANTAI ${targetFloor}!*`,
      `📍 *${floorData.nama}*`,
      '',
      ...sim.roundReports,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🎉 *HASIL: KAMU MENANG (Skor ${sim.scoreA} - ${sim.scoreB})*`,
      `💠 Hadiah: *+${fmt(floorData.rewardKeping)} Keping*${shardBonus}`,
      `⚡ Sisa Stamina: *${prog.sisaStamina}/${db.TCG_MAX_STAMINA}*`
    ].join('\n');

    await send(sock, jid, messageObj, teks);
  } else {
    // Kalah: kurangi 1 stamina
    await db.runQuery("UPDATE tcg_tower SET stamina = stamina - 1 WHERE owner_jid = ?", [key]);
    const updated = await db.tcgGetTower(key);

    const teks = [
      `💀 *KAMU KALAH DI LANTAI ${targetFloor}!*`,
      `📍 *${floorData.nama}*`,
      '',
      ...sim.roundReports,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `❌ *HASIL: KEKALAHAN (Skor ${sim.scoreA} - ${sim.scoreB})*`,
      '💡 _Tips: Evaluasi roda elemen kartu dan naikkan level kartu dengan \`.tcg naik <id>\`!_',
      `⚡ Sisa Stamina: *${updated.stamina}/${db.TCG_MAX_STAMINA}*`
    ].join('\n');

    await send(sock, jid, messageObj, teks);
  }

  return true;
}

// ============================================================
// PVP: DUEL ARENA 3V3 (GRUP)
// ============================================================

async function tantangDuel(sock, jid, messageObj, senderKey, args, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Duel PvP hanya bisa dimainkan di dalam grup WhatsApp.');
    return true;
  }

  const mention = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!mention) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg duel @member [taruhan_keping]`\nContoh: `.tcg duel @budi 100`');
    return true;
  }

  const targetKey = tcgKey(mention);
  if (targetKey === senderKey) {
    await send(sock, jid, messageObj, '❌ Kamu tidak bisa menantang dirimu sendiri.');
    return true;
  }

  const bet = Math.max(0, parseInt(args[args.length - 1], 10) || 0);

  // Validasi dek penantang
  const deckA = await db.tcgGetDeck(senderKey);
  if (!deckA[1] && !deckA[2] && !deckA[3]) {
    await send(sock, jid, messageObj, '⚠️ Dek kamu masih kosong! Pasang kartu dengan `.tcg pasang <1-3> <id>`.');
    return true;
  }

  // Validasi saldo jika ada taruhan
  if (bet > 0) {
    const wA = await db.tcgGetWallet(senderKey);
    if (wA.keping < bet) {
      await send(sock, jid, messageObj, `❌ Keping kamu tidak cukup untuk taruhan *${fmt(bet)} Keping* (Punya: *${fmt(wA.keping)}*).`);
      return true;
    }
  }

  // Hapus duel lama jika ada
  deleteTcgDuel(targetKey);

  const challengerName = messageObj.pushName || senderKey.split('@')[0];
  const targetName = `@${targetKey.split('@')[0]}`;

  const timeout = setTimeout(async () => {
    deleteTcgDuel(targetKey);
  }, 90000);

  setTcgDuel(targetKey, {
    challengerKey: senderKey,
    challengerName,
    targetKey,
    bet,
    jid,
    timeout
  });

  const betInfo = bet > 0 ? `💰 Taruhan: *${fmt(bet)} Keping*` : '🤝 Duel Persahabatan (Tanpa Taruhan)';
  const teks = [
    '⚔️ *TANTANGAN DUEL ARENA KARTU 3V3!*',
    `👤 Penantang: *${challengerName}*`,
    `🎯 Sasaran: ${targetName}`,
    betInfo,
    '',
    `👉 @${targetKey.split('@')[0]}, ketik \`.tcg gas\` untuk menerima tantangan, atau \`.tcg tolak\`!`,
    '_Tantangan otomatis kedaluwarsa dalam 90 detik._'
  ].join('\n');

  await send(sock, jid, messageObj, teks, { mentions: [targetKey, senderKey] });
  return true;
}

async function terimaDuel(sock, jid, messageObj, senderKey, isFromGroup) {
  if (!isFromGroup) return true;

  const duel = getActiveDuel(senderKey);
  if (!duel || duel.jid !== jid) {
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan duel yang ditujukan untukmu saat ini.');
    return true;
  }

  deleteTcgDuel(senderKey);

  const deckA = await db.tcgGetDeck(duel.challengerKey);
  const deckB = await db.tcgGetDeck(duel.targetKey);

  if (!deckB[1] && !deckB[2] && !deckB[3]) {
    await send(sock, jid, messageObj, '⚠️ Dek kamu masih kosong! Pasang kartu terlebih dahulu dengan `.tcg pasang <1-3> <id>`.');
    return true;
  }

  // Validasi saldo kedua pihak jika ada taruhan
  if (duel.bet > 0) {
    const wA = await db.tcgGetWallet(duel.challengerKey);
    const wB = await db.tcgGetWallet(duel.targetKey);

    if (wA.keping < duel.bet) {
      await send(sock, jid, messageObj, `❌ Duel batal: Keping penantang (${duel.challengerName}) sudah tidak mencukupi.`);
      return true;
    }
    if (wB.keping < duel.bet) {
      await send(sock, jid, messageObj, `❌ Duel batal: Keping kamu tidak mencukupi untuk taruhan *${fmt(duel.bet)} Keping*.`);
      return true;
    }

    // Potong keping kedua pihak
    await db.tcgSpendKeping(duel.challengerKey, duel.bet, 'DUEL_BET', `vs ${duel.targetKey}`);
    await db.tcgSpendKeping(duel.targetKey, duel.bet, 'DUEL_BET', `vs ${duel.challengerKey}`);
  }

  const targetName = messageObj.pushName || senderKey.split('@')[0];
  const sim = simulate3v3(deckA, deckB, duel.challengerName, targetName);

  let hasilTaruhan = '';
  if (duel.bet > 0) {
    const totalPot = duel.bet * 2;
    if (sim.matchWinner === 1) {
      await db.tcgAddKeping(duel.challengerKey, totalPot, 'DUEL_WIN', `vs ${duel.targetKey}`);
      hasilTaruhan = `\n💰 *${duel.challengerName}* memenangkan pot taruhan senilai *+${fmt(totalPot)} Keping*!`;
    } else if (sim.matchWinner === 2) {
      await db.tcgAddKeping(duel.targetKey, totalPot, 'DUEL_WIN', `vs ${duel.challengerKey}`);
      hasilTaruhan = `\n💰 *${targetName}* memenangkan pot taruhan senilai *+${fmt(totalPot)} Keping*!`;
    } else {
      // Seri: kembalikan taruhan
      await db.tcgAddKeping(duel.challengerKey, duel.bet, 'DUEL_REFUND');
      await db.tcgAddKeping(duel.targetKey, duel.bet, 'DUEL_REFUND');
      hasilTaruhan = '\n⚖️ Hasil seri! Taruhan dikembalikan ke masing-masing pihak.';
    }
  }

  const teks = [
    '⚔️ *HASIL PERTANDINGAN DUEL ARENA 3V3*',
    `👤 *${duel.challengerName}* VS *${targetName}*`,
    '',
    ...sim.roundReports,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `🏆 *PEMENANG: ${sim.winnerName.toUpperCase()} (Skor ${sim.scoreA} - ${sim.scoreB})*`,
    hasilTaruhan
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks, { mentions: [duel.challengerKey, duel.targetKey] });
  return true;
}

async function tolakDuel(sock, jid, messageObj, senderKey) {
  const duel = getActiveDuel(senderKey);
  if (!duel) {
    await send(sock, jid, messageObj, '❌ Tidak ada tantangan duel yang sedang menunggu konfirmasimu.');
    return true;
  }
  deleteTcgDuel(senderKey);
  await send(sock, jid, messageObj, `🏳️ Tantangan duel dari *${duel.challengerName}* telah ditolak.`);
  return true;
}

// ============================================================
// PROGRESI: JUAL, SERPIH, LEBUR, NAIK LEVEL
// ============================================================

async function jualKartu(sock, jid, messageObj, key, idArg, jumlahArg) {
  const kartu = getKartu(idArg);
  if (!kartu) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg jual <id> [jumlah]`\nContoh: `.tcg jual CMN01 3`');
    return true;
  }
  const n = Math.max(1, parseInt(jumlahArg, 10) || 1);
  const res = await db.tcgJualKartu(key, kartu.id, kartu.rarity, n);
  if (!res.success) {
    await send(sock, jid, messageObj,
      `❌ Duplikat tidak cukup. Kamu punya *${res.qty || 0}* buah *${kartu.nama}*.\n\n_Kartu terakhir tidak bisa dijual — koleksimu tetap aman._`);
    return true;
  }
  await send(sock, jid, messageObj,
    `💰 *${n}× ${kartu.nama}* terjual seharga *${fmt(res.dapat)} Keping*.\n\n💠 Keping: *${fmt(res.keping)}*`);
  return true;
}

async function serpihKartu(sock, jid, messageObj, key, idArg, jumlahArg) {
  const kartu = getKartu(idArg);
  if (!kartu) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg serpih <id> [jumlah]`\nContoh: `.tcg serpih CMN01 2`');
    return true;
  }
  const n = Math.max(1, parseInt(jumlahArg, 10) || 1);
  const res = await db.tcgSerpihKartu(key, kartu.id, kartu.rarity, n);
  if (!res.success) {
    await send(sock, jid, messageObj,
      `❌ Duplikat tidak cukup. Kamu punya *${res.qty || 0}* buah *${kartu.nama}*.\n\n_Kartu terakhir tidak bisa dipecah._`);
    return true;
  }
  await send(sock, jid, messageObj,
    `✦ *${n}× ${kartu.nama}* dipecah jadi *${res.dapat} Serpihan ${STAT_RARITY[kartu.rarity].label}*.\n\nTotal serpihan ${STAT_RARITY[kartu.rarity].label}: *${res.totalSerpihan}*`);
  return true;
}

async function tampilSerpihan(sock, jid, messageObj, key) {
  const s = await db.tcgGetSerpihan(key);
  const baris = db.TCG_RARITY.map(r => {
    const label = STAT_RARITY[r].label.padEnd(10);
    return `${label} ${String(s[r]).padStart(4)}   ${bintang(r)}`;
  });
  const teks = [
    '✦ *SERPIHANMU*',
    '',
    '```',
    ...baris,
    '```',
    '',
    `Naikkan level: \`.tcg naik <id>\``,
    `Lebur ${db.TCG_SERPIHAN_PER_LEBUR} serpihan jadi 1 tingkat di atasnya: \`.tcg lebur <rarity>\``,
    '',
    '_Contoh: `.tcg lebur common`_'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function leburSerpihan(sock, jid, messageObj, key, rarityArg) {
  const rarity = String(rarityArg || '').toUpperCase();
  if (!db.TCG_RARITY.includes(rarity)) {
    await send(sock, jid, messageObj,
      `⚠️ Format: \`.tcg lebur <rarity>\`\nPilihan: ${db.TCG_RARITY.map(r => r.toLowerCase()).join(', ')}`);
    return true;
  }
  const res = await db.tcgLeburSerpihan(key, rarity);
  if (!res.success) {
    const pesan = {
      SUDAH_TERTINGGI: '⚠️ Serpihan Mythic sudah tingkat tertinggi, tidak bisa dilebur lagi.',
      SERPIHAN_KURANG: `❌ Butuh *${res.butuh}* Serpihan ${STAT_RARITY[rarity].label}, kamu punya *${res.punya}*.`
    }[res.reason] || '❌ Gagal melebur serpihan.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }
  await send(sock, jid, messageObj,
    `✨ *${db.TCG_SERPIHAN_PER_LEBUR} Serpihan ${STAT_RARITY[rarity].label}* dilebur jadi *1 Serpihan ${STAT_RARITY[res.rarityTujuan].label}*.`);
  return true;
}

async function naikLevel(sock, jid, messageObj, key, idArg) {
  const kartu = getKartu(idArg);
  if (!kartu) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg naik <id>`\nContoh: `.tcg naik RAR01`');
    return true;
  }
  const res = await db.tcgNaikLevel(key, kartu.id, kartu.rarity);
  if (!res.success) {
    const pesan = {
      TIDAK_PUNYA: `❌ Kamu belum punya *${kartu.nama}*.`,
      SUDAH_MAKS: `⚠️ *${kartu.nama}* sudah level maksimal (5).`,
      SERPIHAN_KURANG: `❌ Butuh *${res.butuh}* Serpihan ${STAT_RARITY[kartu.rarity].label}, kamu punya *${res.punya}*.\n\nPecah duplikat dengan \`.tcg serpih <id>\`.`
    }[res.reason] || '❌ Gagal menaikkan level.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }
  const punya = await db.tcgGetKartu(key, kartu.id);
  await send(sock, jid, messageObj,
    `⬆️ *${kartu.nama}* naik ke *Level ${res.levelBaru}*!\n\n${kartuPenuh(kartu, res.levelBaru, punya.qty)}`);
  return true;
}

// ============================================================
// ADMIN TOKO / OWNER
// ============================================================

function targetDariPesan(args, messageObj) {
  const mention = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (mention) return tcgKey(mention);
  const arg = args.find(a => /^\d{7,}$/.test(String(a || '').replace(/[^0-9]/g, '')) );
  if (arg) return tcgKey(String(arg).replace(/[^0-9]/g, '') + '@s.whatsapp.net');
  return null;
}

async function adminBeri(sock, jid, messageObj, args, isStoreAdmin, isOwner) {
  if (!isStoreAdmin && !isOwner) {
    await send(sock, jid, messageObj, '❌ Perintah ini khusus *Admin Toko* atau *Owner*.');
    return true;
  }
  const target = targetDariPesan(args, messageObj);
  const kartu = getKartu(args.find(a => getKartu(a)));
  if (!target || !kartu) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg give @orang <id> [jumlah]`');
    return true;
  }
  const n = Math.max(1, parseInt(args[args.length - 1], 10) || 1);
  await db.tcgTambahKartu(target, kartu.id, n);
  await send(sock, jid, messageObj, `✅ *${n}× ${kartu.nama}* diberikan ke @${target.split('@')[0]}.`, { mentions: [target] });
  return true;
}

async function adminCek(sock, jid, messageObj, args, isStoreAdmin, isOwner) {
  if (!isStoreAdmin && !isOwner) {
    await send(sock, jid, messageObj, '❌ Perintah ini khusus *Admin Toko* atau *Owner*.');
    return true;
  }
  const target = targetDariPesan(args, messageObj);
  if (!target) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg cek @orang`');
    return true;
  }
  const w = await db.tcgGetWallet(target);
  const hitung = await db.tcgHitungKoleksi(target);
  const ringkas = await db.tcgRingkasLedger(target);
  const tower = await db.tcgGetTower(target);
  const deck = await db.tcgGetDeck(target);

  const deckSummary = [1, 2, 3].map(s => {
    if (!deck[s]) return `Slot ${s}: Kosong`;
    const k = getKartu(deck[s].card_id);
    return `Slot ${s}: ${k?.nama || deck[s].card_id} (Lv.${deck[s].card_lv})`;
  }).join(' | ');

  const teks = [
    `🔍 *AUDIT ARENA* — @${target.split('@')[0]}`,
    '',
    `💠 Keping: *${fmt(w.keping)}*`,
    `📚 Koleksi: *${hitung.unik}/${TOTAL_KARTU}* jenis (${hitung.total} kartu)`,
    `🏰 Menara PvE: Lantai *${tower.highest_floor}/30* (Stamina: ${tower.stamina}/${db.TCG_MAX_STAMINA})`,
    `🃏 Dek: ${deckSummary}`,
    '',
    '*ASAL KEPING*',
    '```',
    ...ringkas.map(r => `${String(r.sumber).padEnd(16)} ${String(r.n).padStart(4)}x  ${String(fmt(r.total)).padStart(9)}`),
    '```',
    '',
    '_Jumlahkan kolom terakhir — kalau tidak sama dengan saldo, ada yang salah._'
  ].join('\n');
  await send(sock, jid, messageObj, teks, { mentions: [target] });
  return true;
}

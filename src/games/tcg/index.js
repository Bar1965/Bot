/**
 * ARENA KARTU MONSTER — SISTEM UTAMA (PURE 0, 3V3 DECK, PVE MENARA, PVP DUEL)
 *
 * Semua perintah bersarang di bawah `.tcg` untuk mencegah bentrokan nama command.
 */

import * as db from '../../../database.js';
import { send, isOnCooldown, randomItem } from '../helpers.js';
import { tcgKey } from './identity.js';
import {
  KARTU, TOTAL_KARTU, getKartu, getKartuByRarity, cariKartu,
  STAT_RARITY, statKartu, ELEMEN, SKILL, PETA_COST, costKartu, getPeran,
  SINERGI, sinergiDek, RAMPING_PER_BINTANG, RAMPING_MAKS_BINTANG,
  pengalahElemen, MAKS_LEVEL, tanggaLevel
} from './cards.js';
import {
  simulate3v3, TOWER_FLOORS, getTowerFloor,
  getActiveDuel, setTcgDuel, deleteTcgDuel
} from './battle.js';
import { bufferKartu, bufferBanyakKartu } from './gambar.js';
import { kirimDrop, resetPenghitung, statusDrop } from './drop.js';

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

const URUT_RARITY = ['MYTHIC', 'LEGENDARY', 'EPIC', 'RARE', 'COMMON'];

// ============================================================
// TAMPILAN TEKS & FORMATTING
// ============================================================

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const bintang = (rarity) => '★'.repeat(STAT_RARITY[rarity].bintang) + '☆'.repeat(5 - STAT_RARITY[rarity].bintang);
const persen = (x) => `${Math.round((x || 0) * 100)}%`;

/** Durasi kasar dalam bahasa manusia: "2j 15m", "45m", "sebentar lagi". */
function fmtDurasi(ms) {
  const detik = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (detik < 60) return `${detik} detik`;
  const menit = Math.floor(detik / 60);
  if (menit < 60) return `${menit} menit`;
  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  return sisaMenit ? `${jam}j ${sisaMenit}m` : `${jam} jam`;
}

/**
 * Mengirim gambar kartu kalau penggambarnya berhasil, dan jatuh ke teks biasa
 * kalau tidak. Render kartu memakai canvas asli, dan itu bisa gagal di mesin
 * tanpa font yang lengkap — kegagalan menggambar tidak boleh membuat perintah
 * yang isinya informasi jadi ikut gagal.
 */
async function kirimGambar(sock, jid, messageObj, buffer, caption, options = {}) {
  if (!buffer) {
    await send(sock, jid, messageObj, caption, options);
    return true;
  }
  try {
    await sock.sendMessage(jid, { image: buffer, caption, ...options }, { quoted: messageObj });
  } catch (e) {
    console.error('[TCG] Gagal mengirim gambar kartu:', e?.message || e);
    await send(sock, jid, messageObj, caption, options);
  }
  return true;
}

function barisKartu(kartu, level = 1, qty = null) {
  const el = ELEMEN[kartu.elemen];
  const s = statKartu(kartu, level);
  const ekor = qty !== null && qty > 1 ? ` ×${qty}` : '';
  return `${el.emoji} ${kartu.id} ${kartu.nama}${ekor} — ${bintang(kartu.rarity)} Lv.${s.level} · CP ${fmt(s.cp)}`;
}

/**
 * Kartu lengkap BESERTA seluruh tangga levelnya.
 *
 * Tangga ini ada karena sebelumnya pemain diminta membayar serpihan dan Keping
 * untuk naik level tanpa pernah diberi tahu akan dapat apa: `.tcg kartu` hanya
 * menampilkan stat level saat ini, dan `.tcg naik` baru memberi tahu hasilnya
 * SETELAH biayanya terpotong. Sekarang Lv.1-5 kelihatan sekaligus, dan baris
 * level yang sedang dipakai ditandai.
 */
function kartuPenuh(kartu, level = 1, qty = 1) {
  const el = ELEMEN[kartu.elemen];
  const s = statKartu(kartu, level);
  const cost = costKartu(kartu);
  const baris = [
    '```',
    `${el.emoji} ${kartu.nama.toUpperCase()}`,
    `${bintang(kartu.rarity)} (${cost}★)  ${STAT_RARITY[kartu.rarity].label} · ${el.nama}`,
    `Peran: ${getPeran(kartu).nama} — ${getPeran(kartu).teks}`,
    '',
    `ATK   ${String(fmt(s.atk)).padEnd(9)}HP    ${fmt(s.hp)}`,
    `KRIT  ${String(persen(s.kritis)).padEnd(9)}CP    ${fmt(s.cp)}`,
    `Lv.   ${String(`${s.level}/${MAKS_LEVEL}`).padEnd(9)}Punya ${qty}`,
    '',
    'TANGGA LEVEL'
  ];
  for (const t of tanggaLevel(kartu)) {
    baris.push(
      `Lv.${t.level}  ATK ${String(fmt(t.atk)).padStart(5)}  HP ${String(fmt(t.hp)).padStart(5)}` +
      `  CP ${String(fmt(t.cp)).padStart(5)}${t.level === s.level ? '  <' : ''}`
    );
  }
  if (kartu.skill && SKILL[kartu.skill]) {
    baris.push('', `Skill: ${SKILL[kartu.skill].nama}`, SKILL[kartu.skill].teks);
  }
  baris.push('```');
  return baris.join('\n');
}

/**
 * Rincian biaya dan hasil kenaikan level BERIKUTNYA, termasuk apakah pemain
 * sanggup membayarnya. Dipakai `.tcg kartu` dan `.tcg naik` tanpa ID.
 */
async function pratinjauNaik(key, kartu, level) {
  const lv = Math.max(1, Math.min(MAKS_LEVEL, level || 1));
  if (lv >= MAKS_LEVEL) {
    return [`⭐ *${kartu.nama}* sudah di level maksimal (${MAKS_LEVEL}).`];
  }

  const kini = statKartu(kartu, lv);
  const nanti = statKartu(kartu, lv + 1);
  const butuhSerpihan = (db.TCG_BIAYA_LEVEL[kartu.rarity] || {})[lv] || 0;
  const butuhKeping = db.tcgBiayaKepingLevel(costKartu(kartu), lv);

  const [serpihan, dompet] = await Promise.all([db.tcgGetSerpihan(key), db.tcgGetWallet(key)]);
  const punyaSerpihan = serpihan[kartu.rarity] || 0;
  const punyaKeping = dompet?.keping || 0;
  const cukupSerpihan = punyaSerpihan >= butuhSerpihan;
  const cukupKeping = punyaKeping >= butuhKeping;

  const kurang = [
    !cukupSerpihan && `*${butuhSerpihan - punyaSerpihan}* serpihan`,
    !cukupKeping && `*${fmt(butuhKeping - punyaKeping)}* Keping`
  ].filter(Boolean);

  return [
    `⬆️ *NAIK KE Lv.${lv + 1}*`,
    `   ATK  ${fmt(kini.atk)} ➜ *${fmt(nanti.atk)}*  _(+${fmt(nanti.atk - kini.atk)})_`,
    `   HP   ${fmt(kini.hp)} ➜ *${fmt(nanti.hp)}*  _(+${fmt(nanti.hp - kini.hp)})_`,
    `   CP   ${fmt(kini.cp)} ➜ *${fmt(nanti.cp)}*  _(+${fmt(nanti.cp - kini.cp)})_`,
    '',
    `   ✦ Serpihan ${STAT_RARITY[kartu.rarity].label}: *${butuhSerpihan}* — punya ${punyaSerpihan} ${cukupSerpihan ? '✅' : '❌'}`,
    `   💠 Keping: *${fmt(butuhKeping)}* — punya ${fmt(punyaKeping)} ${cukupKeping ? '✅' : '❌'}`,
    '',
    kurang.length
      ? `   _Kurang ${kurang.join(' dan ')}._`
      : '   ➜ Ketik `.tcg naik ' + kartu.id + '`'
  ];
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

/** Satu baris ringkas dua jenis energi — dipakai di menu, ransum, gerbang, menara. */
function barisEnergi(energi) {
  const menara = `⚡ Menara *${energi.menara}/${energi.menaraMax}*` +
    (energi.menara < energi.menaraMax ? ` _(+1 dlm ${fmtDurasi(energi.menaraNextMs)})_` : '');
  const gerbang = `🌀 Gerbang *${energi.gerbang}/${energi.gerbangMax}*` +
    (energi.gerbang < energi.gerbangMax ? ` _(+1 dlm ${fmtDurasi(energi.gerbangNextMs)})_` : '');
  return `${menara}   ·   ${gerbang}`;
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

  // Nama dicatat sekali per perintah supaya lawan sparring punya nama sungguhan,
  // bukan deretan angka. Gagal di sini tidak boleh menggagalkan perintahnya.
  try {
    await db.tcgCatatProfil(key, messageObj?.pushName);
  } catch (e) {
    console.error('[TCG] Gagal mencatat profil:', e?.message || e);
  }

  // ============================================================
  // PEMAKLUMAN INPUT
  // ============================================================
  // Dari log pemain sungguhan: 12% perintah `.tcg` gagal bukan karena pemain
  // tidak mengerti permainannya, tapi karena hal sepele — placeholder `<1-3>`
  // ikut tersalin dari teks bantuan, ID kurang satu digit, atau argumen
  // ditempelkan ke sub-perintah yang cuma bisa menampilkan. Semuanya bisa
  // dimaklumi di sini, satu kali, alih-alih ditambal per perintah.

  // `.tcg CMN10` — mengetik ID kartu langsung, tanpa kata `kartu`.
  if (getKartu(sub)) {
    return await tampilKartu(sock, jid, messageObj, key, sub);
  }

  // `.tcg deck 1 RAR09` — `dek` hanya menampilkan, jadi dulu argumennya
  // hilang tanpa suara dan pemain melihat dek yang tidak berubah.
  if (['dek', 'deck'].includes(sub) && args[2]) {
    return await pasangDek(sock, jid, messageObj, key, args[2], args[3]);
  }

  switch (sub) {
    case '':
    case 'menu':
      return await tampilMenu(sock, jid, messageObj, key);

    case 'bantuan':
    case 'help':
      return await tampilBantuan(sock, jid, messageObj, args[2]);

    // Pintasan angka dari menu. Sengaja hanya ke layar yang TIDAK memakai
    // Keping — orang yang sedang menjelajahi menu tidak boleh tiba-tiba gacha.
    case '1':
      return await tampilKoleksi(sock, jid, messageObj, key, args[2]);
    case '2':
      return await tampilDek(sock, jid, messageObj, key);
    case '3':
      return await tampilSpar(sock, jid, messageObj, key, args[2]);
    case '4':
      return await tampilEkspedisi(sock, jid, messageObj, key, args[2], args[3]);
    case '5':
      return await tampilGerbang(sock, jid, messageObj, key, args[2]);
    case '6':
      return await kelolaMenara(sock, jid, messageObj, key, args[2]);
    case '7':
      return await tampilMisi(sock, jid, messageObj, key, args[2]);
    case '8':
      return await tampilBantuan(sock, jid, messageObj, args[2]);

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

    case 'ransum':
    case 'bekal':
    case 'item':
      return await tampilRansum(sock, jid, messageObj, key, args[2]);

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

    case 'sinergi':
    case 'synergy':
      return await tampilSinergi(sock, jid, messageObj);

    case 'misi':
    case 'mission':
    case 'quest':
      return await tampilMisi(sock, jid, messageObj, key, args[2]);

    case 'ambil':
    case 'grab':
    case 'sambar':
      return await ambilKartuDrop(sock, jid, messageObj, key, args[2], isFromGroup);

    case 'drop':
      return await paksaDrop(sock, jid, messageObj, isFromGroup, isStoreAdmin, isOwner);

    case 'spar':
    case 'sparring':
    case 'latihan':
      return await tampilSpar(sock, jid, messageObj, key, args[2]);

    case 'ekspedisi':
    case 'kirim':
    case 'expedition':
      return await tampilEkspedisi(sock, jid, messageObj, key, args[2], args[3]);

    case 'gerbang':
    case 'gate':
      return await tampilGerbang(sock, jid, messageObj, key, args[2]);

    case 'pasang':
    case 'set':
      return await pasangDek(sock, jid, messageObj, key, args[2], args[3]);

    case 'lepas':
      return await lepasDek(sock, jid, messageObj, key, args[2]);

    case 'tukar':
    case 'swap':
    case 'geser':
      return await tukarSlotDek(sock, jid, messageObj, key, args.slice(2));

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
      await send(sock, jid, messageObj, [
        `⚠️ Sub-perintah \`${sub}\` tidak dikenal.`,
        ...(tebakSubPerintah(sub) ? ['', `🤔 Maksudmu \`.tcg ${tebakSubPerintah(sub)}\`?`] : []),
        '',
        'Ketik `.tcg` untuk menu utama, atau `.tcg bantuan` untuk daftar lengkap perintah.'
      ].join('\n'));
      return true;
  }
}

/**
 * Tebakan sub-perintah terdekat dari yang diketik.
 *
 * Jarak Levenshtein sederhana; ambangnya sengaja ketat (maks 2 huruf beda)
 * supaya bot tidak menyarankan hal yang jelas-jelas bukan maksud pemain.
 */
const SUB_DIKENAL = [
  'menu', 'bantuan', 'mulai', 'gacha', 'gacha10', 'daily', 'ransum', 'koleksi',
  'kartu', 'rate', 'keping', 'dek', 'sinergi', 'pasang', 'lepas', 'tukar',
  'menara', 'duel', 'gas', 'tolak', 'jual', 'serpih', 'serpihan',
  'lebur', 'naik', 'misi', 'spar', 'ekspedisi', 'gerbang', 'ambil'
];

function jarakKata(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let baris = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let sebelumnya = baris[0];
    baris[0] = i;
    for (let j = 1; j <= n; j++) {
      const simpan = baris[j];
      baris[j] = Math.min(
        baris[j] + 1,
        baris[j - 1] + 1,
        sebelumnya + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      sebelumnya = simpan;
    }
  }
  return baris[n];
}

function tebakSubPerintah(teks) {
  const q = String(teks || '').toLowerCase();
  if (q.length < 2) return null;
  let terbaik = null;
  let jarakTerbaik = 3;
  for (const s of SUB_DIKENAL) {
    const d = jarakKata(q, s);
    if (d < jarakTerbaik) {
      jarakTerbaik = d;
      terbaik = s;
    }
  }
  return terbaik;
}
// ============================================================
// MENU & BANTUAN
// ============================================================

/**
 * Menu utama: angka, bukan nama perintah.
 *
 * Arena punya lebih dari 30 sub-perintah. Menyodorkan semuanya sekaligus
 * membuat pemain baru berhenti sebelum mulai, jadi menu ini hanya memajang
 * delapan pintu masuk bernomor — `.tcg 3` sama saja dengan `.tcg spar`. Daftar
 * lengkapnya tetap ada di `.tcg bantuan`.
 */
async function tampilMenu(sock, jid, messageObj, key) {
  const [w, hitung, deck, energi, misi] = await Promise.all([
    db.tcgGetWallet(key),
    db.tcgHitungKoleksi(key),
    db.tcgGetDeck(key),
    db.tcgGetEnergi(key),
    db.tcgGetMisi(key)
  ]);

  const biayaDek = [1, 2, 3].reduce((t, s) => t + (deck[s] ? costKartu(getKartu(deck[s].card_id)) : 0), 0);
  const slotTerisi = [1, 2, 3].filter(s => deck[s]).length;

  const teks = [
    '🎴 *ARENA KARTU MONSTER*',
    `Kumpulkan ${TOTAL_KARTU} monster nusantara, susun dek 3 kartu, lalu bertarung.`,
    '',
    `💠 *${fmt(w.keping)}* Keping   📚 *${hitung.unik}/${TOTAL_KARTU}* jenis kartu`,
    `🃏 Dek: *${slotTerisi}/3* slot · *${biayaDek}/${db.TCG_MAX_DECK_COST}★*`,
    barisEnergi(energi),
    misi.kepingSiapKlaim > 0 ? `🎯 _Ada *${fmt(misi.kepingSiapKlaim)} Keping* misi siap diklaim!_` : '',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '*1* · `.tcg koleksi` — lihat kartumu',
    '*2* · `.tcg dek` — atur formasi 3v3',
    '*3* · `.tcg spar` — latih tanding, dapat Keping',
    '*4* · `.tcg ekspedisi` — kirim kartu cari harta',
    '*5* · `.tcg gerbang` — farming serpihan harian',
    '*6* · `.tcg menara` — naik lantai',
    '*7* · `.tcg misi` — misi harian',
    '*8* · `.tcg bantuan` — daftar perintah lengkap',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    hitung.unik === 0
      ? '➡️ Belum punya kartu? Ketik `.tcg mulai` untuk paket pemula gratis.'
      : '🎁 Jangan lupa `.tcg daily` — gratis tiap hari.',
    '',
    '_Ketik angkanya saja, contoh `.tcg 3`._'
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

/**
 * Bantuan dipecah per topik. Satu pesan berisi 30+ perintah tidak terbaca di
 * layar HP, dan yang terjadi di grup adalah pemain berhenti membacanya sama
 * sekali lalu bertanya hal yang sudah tertulis di sana.
 */
const BANTUAN = {
  dasar: {
    judul: '🎴 DASAR & GACHA',
    baris: [
      ['.tcg mulai', `Paket pemula: 5 kartu + ${db.TCG_BONUS_STARTER_KEPING} Keping (sekali seumur hidup)`],
      ['.tcg daily', `Tarikan gratis + ${db.TCG_BONUS_HARIAN_KEPING} Keping + 1 ransum, tiap hari`],
      ['.tcg gacha', `Tarik 1 kartu (${fmt(db.TCG_HARGA_TARIK)} Keping)`],
      ['.tcg gacha10', `Tarik 10 kartu (${fmt(db.TCG_HARGA_TARIK10)} Keping)`],
      ['.tcg rate', 'Peluang tiap rarity & status pity kamu'],
      ['.tcg koleksi [rarity|elemen|hal]', 'Kartu yang kamu punya'],
      ['.tcg kartu <id>', 'Detail kartu + tangga level Lv.1-5'],
      ['.tcg keping', 'Saldo Keping Arena']
    ]
  },
  dek: {
    judul: '🃏 DEK & SINERGI',
    baris: [
      ['.tcg dek', 'Lihat formasi 3v3 kamu'],
      ['.tcg pasang <1-3> <id>', 'Pasang kartu ke slot'],
      ['.tcg lepas <1-3>', 'Kosongkan slot'],
      ['.tcg tukar <slot> <slot>', 'Tukar posisi dua slot'],
      ['.tcg sinergi', 'Daftar bonus komposisi dek']
    ]
  },
  tarung: {
    judul: '⚔️ BERTARUNG',
    baris: [
      ['.tcg spar', 'Latih tanding lawan dek pemain lain — tanpa energi'],
      ['.tcg menara', 'PvE 30 lantai, pakai stamina Menara'],
      ['.tcg menara lawan', 'Tantang lantai berikutnya'],
      ['.tcg gerbang', 'Gerbang elemen harian, pakai energi Gerbang'],
      ['.tcg duel @member [taruhan]', 'Duel PvP di grup'],
      ['.tcg gas / .tcg tolak', 'Terima atau tolak tantangan']
    ]
  },
  naik: {
    judul: '⬆️ LEVEL, SERPIHAN & KEPING',
    baris: [
      ['.tcg naik', 'Daftar kartu yang siap dinaikkan sekarang'],
      ['.tcg naik <id>', 'Naikkan level kartu memakai serpihan (maks Lv.5)'],
      ['.tcg serpih <id> [n]', 'Pecah duplikat jadi serpihan'],
      ['.tcg lebur <rarity>', `${db.TCG_SERPIHAN_PER_LEBUR} serpihan ➜ 1 tingkat di atasnya`],
      ['.tcg jual <id> [n]', 'Jual duplikat jadi Keping'],
      ['.tcg serpihan', 'Cek stok serpihanmu']
    ]
  },
  farming: {
    judul: '🌾 FARMING & HARIAN',
    baris: [
      ['.tcg ekspedisi', 'Kirim kartu cadangan cari Keping + serpihan'],
      ['.tcg ekspedisi <id> <jam>', `Berangkatkan kartu (${db.TCG_EKSPEDISI_DURASI.join('/')} jam)`],
      ['.tcg ekspedisi klaim', 'Ambil hasil kartu yang sudah pulang'],
      ['.tcg misi', 'Misi harian + klaim hadiah'],
      ['.tcg ransum', 'Tas ransum pemulih energi'],
      ['.tcg ambil <1-3>', 'Sambar kartu dari drop grup']
    ]
  }
};

const ALIAS_BANTUAN = {
  dasar: 'dasar', gacha: 'dasar', mulai: 'dasar', kartu: 'dasar', koleksi: 'dasar',
  dek: 'dek', deck: 'dek', sinergi: 'dek', formasi: 'dek',
  tarung: 'tarung', duel: 'tarung', menara: 'tarung', spar: 'tarung', gerbang: 'tarung',
  naik: 'naik', level: 'naik', upgrade: 'naik', serpihan: 'naik', jual: 'naik',
  farming: 'farming', ekspedisi: 'farming', misi: 'farming', ransum: 'farming', drop: 'farming'
};

async function tampilBantuan(sock, jid, messageObj, topikArg) {
  const topik = ALIAS_BANTUAN[String(topikArg || '').toLowerCase()];

  if (topik) {
    const b = BANTUAN[topik];
    const teks = [
      `*${b.judul}*`,
      '',
      ...b.baris.map(([perintah, ket]) => `• \`${perintah}\`\n   └ ${ket}`),
      '',
      '_Kembali ke daftar topik: `.tcg bantuan`_'
    ].join('\n');
    await send(sock, jid, messageObj, teks);
    return true;
  }

  const teks = [
    '📖 *BANTUAN ARENA KARTU MONSTER*',
    `${TOTAL_KARTU} kartu · dek 3 slot · maksimal ${db.TCG_MAX_DECK_COST}★`,
    '',
    'Pilih topik:',
    '`.tcg bantuan dasar` — gacha, koleksi, kartu, keping',
    '`.tcg bantuan dek` — formasi 3v3 & sinergi',
    '`.tcg bantuan tarung` — spar, menara, gerbang, duel',
    '`.tcg bantuan naik` — level kartu, serpihan, jual',
    '`.tcg bantuan farming` — ekspedisi, misi, ransum, drop',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '*Paling sering dipakai:*',
    '• `.tcg` — menu utama bernomor',
    '• `.tcg daily` — hadiah harian gratis',
    '• `.tcg dek` — atur formasi',
    '• `.tcg spar` — cari Keping tanpa energi',
    '',
    '_Ekonomi arena 100% mandiri (Pure 0) — tidak tersambung ke poin bot._'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// STARTER, GACHA, HARIAN
// ============================================================

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

  // Dek pemula dipasang otomatis dari tiga kartu TERMAHAL yang didapat, bukan
  // tiga yang pertama diundi. Pemain baru yang langsung mencoba `.tcg menara`
  // dengan dek acak akan kalah di lantai 1 dan menyimpulkan permainannya rusak.
  const kandidat = [...hasil].sort((a, b) => costKartu(b.kartu) - costKartu(a.kartu));
  const pilih = [];
  let biaya = 0;
  for (const h of kandidat) {
    const c = costKartu(h.kartu);
    if (pilih.length < 3 && biaya + c <= db.TCG_MAX_DECK_COST) {
      pilih.push(h.kartu);
      biaya += c;
    }
  }
  for (let i = 0; i < pilih.length; i++) {
    await db.tcgSetDeckSlot(key, i + 1, pilih[i].id, PETA_COST);
  }

  const gambar = await bufferBanyakKartu(hasil.map(h => ({ kartu: h.kartu, level: 1 }))).catch(() => null);

  const teks = [
    '🎁 *PAKET PEMULA DITERIMA!*',
    '',
    hasilTarikan(hasil),
    '',
    `💠 Bonus: *${db.TCG_BONUS_STARTER_KEPING} Keping Arena*`,
    `🃏 Dek 3v3 pemula sudah otomatis dipasang (*${biaya}/${db.TCG_MAX_DECK_COST}★*)`,
    '',
    'Lanjut: cek `.tcg dek`, lalu jajal `.tcg spar` atau `.tcg menara lawan`.'
  ].join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
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
      `💠 Keping tidak cukup.\nButuh *${fmt(harga)}*, kamu punya *${fmt(bayar.keping || 0)}*.\n\nCari Keping: \`.tcg spar\`, \`.tcg daily\`, \`.tcg ekspedisi\`, atau jual duplikat.`);
    return true;
  }

  const hasil = await prosesTarikan(key, jumlah, false);
  const pity = await db.tcgGetPity(key);
  const baru = hasil.filter(h => h.baru).length;

  try {
    await db.tcgCatatProgresMisi(key, 'GACHA', jumlah);
  } catch (e) {
    console.error('[TCG] Gagal mencatat misi gacha:', e?.message || e);
  }

  const gambar = await bufferBanyakKartu(
    hasil.map(h => ({ kartu: h.kartu, level: 1 }))
  ).catch(() => null);

  const teks = [
    jumlah === 1 ? '🎴 *TARIKAN KARTU*' : `🎴 *TARIKAN ×${jumlah}*`,
    '',
    hasilTarikan(hasil),
    '',
    `💠 Sisa Keping: *${fmt(bayar.keping)}*${baru > 0 ? `   ·   🆕 ${baru} kartu baru` : ''}`,
    `🎯 Menuju jaminan Mythic: *${Math.max(0, PITY_MYTHIC_KERAS - pity.sejak_mythic)}* tarikan lagi`
  ].join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
  return true;
}

async function tarikGratis(sock, jid, messageObj, key) {
  const res = await db.tcgKlaimGratis(key);
  if (!res.success) {
    await send(sock, jid, messageObj, '⏳ Hadiah gratismu hari ini sudah diambil.\nDatang lagi besok setelah jam 00:00 WIB!');
    return true;
  }

  const hasil = await prosesTarikan(key, 1, true);
  try {
    await db.tcgCatatProgresMisi(key, 'GACHA', 1);
  } catch (e) {
    console.error('[TCG] Gagal mencatat misi gacha harian:', e?.message || e);
  }

  // Ransum acak tiap hari — satu-satunya sumber energi tambahan yang tidak
  // perlu menunggu regen, dan sengaja tidak bisa dibeli dengan Keping.
  const idRansum = randomItem(Object.keys(db.TCG_RANSUM));
  let ransumTeks = '';
  try {
    const def = db.tcgGetRansumDef(idRansum);
    await db.tcgTambahItem(key, idRansum, 1);
    ransumTeks = `🎒 Ransum: *${def.nama}* — ${def.desc}`;
  } catch (e) {
    console.error('[TCG] Gagal memberi ransum harian:', e?.message || e);
  }

  const gambar = await bufferKartu(hasil[0].kartu, 1).catch(() => null);

  const teks = [
    '🎁 *HADIAH HARIAN ARENA TERKLAIM*',
    '',
    hasilTarikan(hasil),
    '',
    `💠 Bonus Keping: *+${db.TCG_BONUS_HARIAN_KEPING}* (Total: *${fmt(res.kepingTotal)}*)`,
    ransumTeks,
    '',
    '_Energi Menara & Gerbang terisi sendiri sepanjang hari — cek `.tcg ransum`._'
  ].filter(Boolean).join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
  return true;
}

// ============================================================
// RANSUM (PEMULIH ENERGI)
// ============================================================

async function tampilRansum(sock, jid, messageObj, key, aksiArg) {
  const energi = await db.tcgGetEnergi(key);
  const punya = await db.tcgGetItem(key);

  const arg = String(aksiArg || '').toLowerCase();
  if (arg) {
    const def = Object.values(db.TCG_RANSUM).find(d =>
      d.id.toLowerCase() === arg ||
      d.id.toLowerCase().endsWith(arg) ||
      d.nama.toLowerCase().includes(arg)
    );
    if (!def) {
      await send(sock, jid, messageObj,
        `⚠️ Ransum *${aksiArg}* tidak dikenal.\n\nPilihan: ${Object.values(db.TCG_RANSUM).map(d => `\`${d.id.split('_')[1].toLowerCase()}\``).join(', ')}`);
      return true;
    }

    const pakai = await db.tcgPakaiItem(key, def.id, 1);
    if (!pakai.success) {
      await send(sock, jid, messageObj, `🎒 Kamu tidak punya *${def.nama}*.\n\nKetik \`.tcg ransum\` untuk melihat isi tasmu.`);
      return true;
    }

    await send(sock, jid, messageObj, [
      `🎒 *${def.nama} DIPAKAI!*`,
      def.desc,
      '',
      barisEnergi(pakai.energi),
      '',
      '_Energi tidak bisa melebihi kapasitas — pakai saat benar-benar kosong biar tidak terbuang._'
    ].join('\n'));
    return true;
  }

  const daftar = punya.length > 0
    ? punya.map(r => `${r.def.nama} ×*${r.qty}*\n   └ ${r.def.desc} — \`.tcg ransum ${r.item_id.split('_')[1].toLowerCase()}\``).join('\n')
    : '_Tasmu kosong._';

  await send(sock, jid, messageObj, [
    '🎒 *TAS RANSUM ARENA*',
    '',
    barisEnergi(energi),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    daftar,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '📥 *Cara dapat ransum:*',
    '• `.tcg daily` — dijamin 1 ransum acak tiap hari',
    '• Menang Raid World Boss — peluang drop untuk seluruh regu',
    '• Bansos dari Owner saat ada kompensasi',
    '',
    '_Ransum tidak dijual dengan poin. Energi hanya bisa didapat dari bermain._'
  ].join('\n'));
  return true;
}

// ============================================================
// KOLEKSI & DETAIL KARTU
// ============================================================

async function tampilKoleksi(sock, jid, messageObj, key, saringArg) {
  const koleksi = await db.tcgGetKoleksi(key);
  if (!koleksi.length) {
    await send(sock, jid, messageObj,
      '📭 Koleksimu masih kosong.\n\n➡️ Ketik `.tcg mulai` untuk menerima 5 kartu gratis.');
    return true;
  }

  const q = String(saringArg || '').toUpperCase().trim();
  const saringRarity = URUT_RARITY.includes(q) ? q : null;
  const saringElemen = Object.keys(ELEMEN).includes(q) ? q : null;
  const halamanDiminta = parseInt(saringArg, 10) || 1;

  let daftar = koleksi
    .map(row => ({ row, kartu: getKartu(row.card_id) }))
    .filter(x => x.kartu);

  if (saringRarity) daftar = daftar.filter(x => x.kartu.rarity === saringRarity);
  if (saringElemen) daftar = daftar.filter(x => x.kartu.elemen === saringElemen);

  if (!daftar.length) {
    await send(sock, jid, messageObj,
      `📭 Tidak ada kartu yang cocok dengan saringan *${q}*.\n\nCoba \`.tcg koleksi\` tanpa saringan.`);
    return true;
  }

  daftar.sort((a, b) =>
    URUT_RARITY.indexOf(a.kartu.rarity) - URUT_RARITY.indexOf(b.kartu.rarity) ||
    a.kartu.id.localeCompare(b.kartu.id)
  );

  const PER_HAL = 20;
  const totalHal = Math.ceil(daftar.length / PER_HAL);
  const hal = Math.max(1, Math.min(totalHal, halamanDiminta));
  const potong = daftar.slice((hal - 1) * PER_HAL, hal * PER_HAL);

  const deck = await db.tcgGetDeck(key);
  const diDek = new Set([1, 2, 3].map(s => deck[s]?.card_id).filter(Boolean));

  const grup = [];
  let rarityTerakhir = null;
  for (const { row, kartu } of potong) {
    if (kartu.rarity !== rarityTerakhir) {
      rarityTerakhir = kartu.rarity;
      const info = STAT_RARITY[kartu.rarity];
      const jumlahGrup = daftar.filter(x => x.kartu.rarity === kartu.rarity).length;
      grup.push(`\n${'⭐'.repeat(info.bintang)} *${info.label.toUpperCase()}* (${jumlahGrup} jenis · ${info.bintang}★)`);
    }
    const el = ELEMEN[kartu.elemen];
    const tanda = diDek.has(kartu.id) ? '🔸' : '▫️';
    const ekor = row.qty > 1 ? ` ×${row.qty}` : '';
    const st = statKartu(kartu, row.card_lv);
    grup.push(`${tanda}${el.emoji} \`${kartu.id}\` ${kartu.nama}${ekor} · Lv.${row.card_lv} · CP ${fmt(st.cp)}`);
  }

  const hitung = await db.tcgHitungKoleksi(key);
  const contohId = potong[0]?.kartu?.id || 'CMN01';
  const labelSaring = saringRarity
    ? ` · saringan: ${STAT_RARITY[saringRarity].label}`
    : (saringElemen ? ` · saringan: ${ELEMEN[saringElemen].nama}` : '');

  const teks = [
    '📚 *KOLEKSI KARTUMU*',
    `${hitung.unik}/${TOTAL_KARTU} jenis · ${hitung.total} kartu${labelSaring}`,
    ...grup,
    '',
    totalHal > 1 ? `📄 Halaman ${hal}/${totalHal} — \`.tcg koleksi ${hal < totalHal ? hal + 1 : 1}\`` : '',
    `🔎 Detail: \`.tcg kartu ${contohId}\`   ·   🔸 = sedang di dek`,
    '_Saring: `.tcg koleksi epic` atau `.tcg koleksi api`_'
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
  const level = punya?.card_lv || 1;
  const jumlahPunya = punya?.qty || 0;
  const gambarKartu = await bufferKartu(kartu, jumlahPunya === 0 ? 1 : level).catch(() => null);

  // Elemen yang mengalahkan kartu ini — informasi yang sebelumnya harus
  // dihafal dari roda elemen di kepala pemain.
  const pengalah = pengalahElemen(kartu.elemen).map(e => `${ELEMEN[e].emoji} ${ELEMEN[e].nama}`).join(', ');
  const dikalahkan = ELEMEN[kartu.elemen].unggul.map(e => `${ELEMEN[e].emoji} ${ELEMEN[e].nama}`).join(', ');
  const barisElemen = [
    '',
    `⚔️ Unggul atas: ${dikalahkan}`,
    `🛡️ Rugi melawan: ${pengalah}`
  ];

  if (jumlahPunya === 0) {
    await kirimGambar(sock, jid, messageObj, gambarKartu,
      [kartuPenuh(kartu, 1, 0), ...barisElemen, '', '_Kamu belum memiliki kartu ini._'].join('\n'));
    return true;
  }

  const naik = await pratinjauNaik(key, kartu, level);
  await kirimGambar(sock, jid, messageObj, gambarKartu,
    [kartuPenuh(kartu, level, jumlahPunya), ...barisElemen, '', ...naik].join('\n'));
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
    '_Keping didapat dari Daily, Spar, Ekspedisi, Gerbang, Menara PvE, Jual Duplikat, dan Menang Duel._'
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

  // Saran untuk slot kosong memakai kartu yang benar-benar dimiliki dan belum
  // terpasang. Menyodorkan `<id>` untuk disalin adalah cara paling cepat
  // membuat pemain baru mengetik perintah yang gagal.
  const koleksi = await db.tcgGetKoleksi(key);
  const sudahDiDek = new Set([1, 2, 3].map(i => deck[i]?.card_id).filter(Boolean));
  const cadangan = koleksi.map(r => getKartu(r.card_id))
    .filter(k => k && !sudahDiDek.has(k.id));

  for (let s = 1; s <= 3; s++) {
    const slotData = deck[s];
    if (!slotData) {
      const usul = cadangan[s - 1] || cadangan[0];
      baris.push(usul
        ? `*Slot ${s}:* _(Kosong)_ — coba \`.tcg pasang ${s} ${usul.id}\` _(${usul.nama})_`
        : `*Slot ${s}:* _(Kosong — kamu belum punya kartu cadangan)_`);
    } else {
      const kartu = getKartu(slotData.card_id);
      if (kartu) {
        const cost = costKartu(kartu);
        totalCost += cost;
        const el = ELEMEN[kartu.elemen];
        const st = statKartu(kartu, slotData.card_lv);
        baris.push(
          `*Slot ${s}:* ${el.emoji} *${kartu.nama}* (Lv.${st.level}) — ${bintang(kartu.rarity)} (${cost}★) ${getPeran(kartu).emoji}\n` +
          `   └ ATK ${fmt(st.atk)} · HP ${fmt(st.hp)} · KRIT ${persen(st.kritis)} · CP ${fmt(st.cp)}` +
          `${kartu.skill ? `\n   └ Skill: ${SKILL[kartu.skill].nama}` : ''}`
        );
      }
    }
  }

  const sin = sinergiDek(deck);
  const barisSinergi = [];
  if (sin.aktif.length) {
    barisSinergi.push('', '✨ *SINERGI AKTIF*');
    for (const s of sin.aktif) {
      barisSinergi.push(`${s.emoji} *${s.nama}* — _${s.syarat}_`);
    }
    const efek = [];
    if (sin.atk > 0) efek.push(`ATK *+${Math.round(sin.atk * 100)}%*`);
    if (sin.hp > 0) efek.push(`HP *+${Math.round(sin.hp * 100)}%*`);
    barisSinergi.push(`➜ Total: ${efek.join(' · ')} untuk seluruh dek`);
  } else if (totalCost > 0) {
    barisSinergi.push('', '💤 _Sinergi hanya menyala kalau ketiga slot terisi._');
  }

  // Total CP dek sesudah sinergi — satu angka untuk membandingkan dua susunan.
  let cpDek = 0;
  for (let s = 1; s <= 3; s++) {
    const kartu = deck[s] ? getKartu(deck[s].card_id) : null;
    if (!kartu) continue;
    const st = statKartu(kartu, deck[s].card_lv);
    cpDek += Math.round(st.cp * (1 + sin.atk) * (1 + sin.hp));
  }

  const teks = [
    '🃏 *FORMASI DEK 3V3 KAMU*',
    `Beban Biaya Dek: *${totalCost}/${db.TCG_MAX_DECK_COST}★*${cpDek ? `   ·   Total CP: *${fmt(cpDek)}*` : ''}`,
    '',
    ...baris,
    ...barisSinergi,
    '',
    '• Pasang: `.tcg pasang 1 RAR01`   ·   Tukar: `.tcg tukar 1 3`',
    '• Lepas: `.tcg lepas 2`   ·   Sinergi: `.tcg sinergi`',
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

  // Kartu yang sedang pergi ekspedisi tidak boleh dipasang — kalau tidak,
  // satu kartu bisa bekerja di dua tempat sekaligus.
  const pergi = await db.tcgKartuSedangEkspedisi(key);
  if (pergi.has(kartu.id)) {
    const punya = await db.tcgGetKartu(key, kartu.id);
    if ((punya?.qty || 0) <= 1) {
      await send(sock, jid, messageObj,
        `🧭 *${kartu.nama}* sedang pergi ekspedisi.\n\nTunggu pulang lalu \`.tcg ekspedisi klaim\`, atau pakai kartu lain.`);
      return true;
    }
  }

  const res = await db.tcgSetDeckSlot(key, slot, kartu.id, PETA_COST);
  if (!res.success) {
    const pesan = {
      TIDAK_PUNYA: `❌ Kamu belum memiliki kartu *${kartu.nama}*.`,
      COST_MELEBIHI_BATAS: `⚠️ *Kapasitas Dek Melebihi Batas!*\nTotal bintang dekmu akan menjadi *${res.totalCost}★* (Maksimal *${res.maxCost}★*).\n\nIngat: bintang yang TIDAK terpakai dibayar balik sebagai bonus Pasukan Ramping — dek murah bukan dek lemah. Cek \`.tcg sinergi\`.`,
      SLOT_TIDAK_VALID: '⚠️ Slot harus angka 1, 2, atau 3.'
    }[res.reason] || '❌ Gagal memasang kartu ke dek.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const el = ELEMEN[kartu.elemen];
  const st = statKartu(kartu, res.cardLv);
  await send(sock, jid, messageObj, [
    `✅ ${el.emoji} *${kartu.nama}* (Lv.${res.cardLv}) dipasang ke *Slot ${slot}*!`,
    `   └ ATK ${fmt(st.atk)} · HP ${fmt(st.hp)} · CP ${fmt(st.cp)}`,
    '',
    `Biaya Dek: *${res.totalCost}/${res.maxCost}★*`,
    '',
    '_Lihat hasilnya: `.tcg dek`_'
  ].join('\n'));
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

/**
 * Menukar dua slot dek.
 *
 * Urutan slot BUKAN kosmetik: slot 1 selalu bertemu slot 1 lawan, jadi menggeser
 * kartu adalah keputusan taktis. Sebelum ada perintah ini, satu-satunya cara
 * menukar adalah melepas dua kartu lalu memasangnya kembali — dan itu sempat
 * membuat pemain melanggar batas bintang di tengah proses.
 */
async function tukarSlotDek(sock, jid, messageObj, key, args) {
  const a = parseInt(args[0], 10);
  const b = parseInt(args[1], 10);
  if (![1, 2, 3].includes(a) || ![1, 2, 3].includes(b)) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg tukar <slot> <slot>`\nContoh: `.tcg tukar 1 3`');
    return true;
  }

  const res = await db.tcgTukarSlotDek(key, a, b);
  if (!res.success) {
    const pesan = {
      SLOT_TIDAK_VALID: '⚠️ Slot harus angka 1, 2, atau 3.',
      SLOT_SAMA: '⚠️ Dua slot yang sama tidak bisa ditukar.',
      KEDUANYA_KOSONG: '⚠️ Kedua slot itu kosong — tidak ada yang bisa ditukar.'
    }[res.reason] || '❌ Gagal menukar slot.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const namaA = res.kartuBaruDiA ? (getKartu(res.kartuBaruDiA)?.nama || res.kartuBaruDiA) : '_(kosong)_';
  const namaB = res.kartuBaruDiB ? (getKartu(res.kartuBaruDiB)?.nama || res.kartuBaruDiB) : '_(kosong)_';
  await send(sock, jid, messageObj, [
    `🔄 *Slot ${a}* ⇄ *Slot ${b}*`,
    `Slot ${a}: ${namaA}`,
    `Slot ${b}: ${namaB}`,
    '',
    '_Slot 1 lawan slot 1, slot 2 lawan slot 2 — urutan menentukan hasil._'
  ].join('\n'));
  return true;
}

async function tampilSinergi(sock, jid, messageObj) {
  const baris = SINERGI.map(s => {
    const efek = [];
    if (s.atk > 0) efek.push(`ATK +${Math.round(s.atk * 100)}%`);
    if (s.hp > 0) efek.push(`HP +${Math.round(s.hp * 100)}%`);
    return `${s.emoji} *${s.nama}* — ${efek.join(' · ')}\n   └ _${s.syarat}_`;
  });

  const teks = [
    '✨ *SINERGI DEK*',
    'Bonus datang dari KOMPOSISI, bukan dari rarity. Semua sinergi hanya menyala kalau ketiga slot terisi.',
    '',
    `🪶 *Pasukan Ramping* — ATK & HP +${Math.round(RAMPING_PER_BINTANG * 100)}% per bintang sisa`,
    `   └ _Tiap bintang yang TIDAK kamu pakai dibayar balik, maksimal ${RAMPING_MAKS_BINTANG}★_`,
    '',
    ...baris,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Anggaran dek: *${db.TCG_MAX_DECK_COST}★*. Dek 3 Common (3★) menyisakan 7★ dan dibayar penuh ${RAMPING_MAKS_BINTANG}★ — cukup untuk menantang dek 10★ kalau elemennya ditaruh benar.`,
    '',
    '_Satu Padu, Duo Selaras, dan Tri Elemen saling meniadakan menurut definisi._'
  ].join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// MISI HARIAN
// ============================================================

async function tampilMisi(sock, jid, messageObj, key, aksiArg) {
  const aksi = String(aksiArg || '').toLowerCase();

  if (['klaim', 'ambil', 'claim'].includes(aksi)) {
    const res = await db.tcgKlaimMisi(key);
    if (!res.success) {
      await send(sock, jid, messageObj,
        '📭 Belum ada misi selesai yang bisa diklaim.\n\nCek `.tcg misi` untuk melihat progresmu.');
      return true;
    }
    const rincian = (res.rincian || []).map(r => `• ${r.nama} — *+${fmt(r.keping)}*`).join('\n');
    await send(sock, jid, messageObj, [
      '🎯 *HADIAH MISI TERKLAIM*',
      '',
      rincian,
      '',
      `💠 Total: *+${fmt(res.total)} Keping* (Saldo: *${fmt(res.kepingTotal)}*)`
    ].join('\n'));
    return true;
  }

  const misi = await db.tcgGetMisi(key);
  const baris = misi.daftar.map(m => {
    const tanda = m.diklaim ? '✅' : (m.selesai ? '🎁' : '⬜');
    return `${tanda} ${m.emoji} *${m.nama}*\n   └ ${Math.min(m.progres, m.target)}/${m.target} · hadiah *${fmt(m.hadiah)} Keping*`;
  });

  const bonusTanda = misi.bonusDiklaim ? '✅' : (misi.bonusSiap ? '🎁' : '⬜');

  const teks = [
    '🎯 *MISI HARIAN ARENA*',
    `Reset tiap hari jam 00:00 WIB · hari ini: ${misi.tanggal}`,
    '',
    ...baris,
    '',
    `${bonusTanda} 🏅 *Bonus Tuntas* — selesaikan ${db.TCG_MISI_BONUS_AMBANG} dari ${misi.daftar.length} misi`,
    `   └ ${misi.jumlahSelesai}/${db.TCG_MISI_BONUS_AMBANG} · hadiah *${fmt(db.TCG_MISI_BONUS_KEPING)} Keping*`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    misi.kepingSiapKlaim > 0
      ? `💠 Siap diklaim: *${fmt(misi.kepingSiapKlaim)} Keping* — ketik \`.tcg misi klaim\``
      : '_Belum ada yang bisa diklaim. Main dulu!_'
  ].join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// DROP KARTU DI GRUP
// ============================================================

async function ambilKartuDrop(sock, jid, messageObj, key, nomorArg, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Drop kartu hanya muncul di dalam grup.');
    return true;
  }

  const drop = await db.tcgGetDropAktif(jid);
  if (!drop) {
    await send(sock, jid, messageObj, '💨 Tidak ada drop yang sedang berlangsung di grup ini.\n\n_Drop muncul sendiri kalau grup sedang ramai._');
    return true;
  }

  const nomor = parseInt(nomorArg, 10);
  if (!Number.isInteger(nomor) || nomor < 1 || nomor > drop.kartuIds.length) {
    await send(sock, jid, messageObj,
      `⚠️ Pilih nomor kartunya: \`.tcg ambil 1\` sampai \`.tcg ambil ${drop.kartuIds.length}\`.\n\n_Sisa waktu: ${fmtDurasi(drop.sisaMs)}._`);
    return true;
  }

  const res = await db.tcgAmbilKartuDrop(drop.id, key, nomor - 1);
  if (!res.success) {
    const pesan = {
      DROP_TIDAK_AKTIF: '💨 Dropnya sudah selesai.',
      KEDALUWARSA: '⏰ Terlambat — waktu dropnya sudah habis.',
      NOMOR_TIDAK_VALID: `⚠️ Nomor kartu cuma 1 sampai ${res.jumlah}.`,
      SUDAH_AMBIL: `🖐️ Kamu sudah mengambil kartu nomor *${(res.idxSebelumnya ?? 0) + 1}* dari drop ini. Satu orang satu kartu.`,
      SUDAH_DIAMBIL_ORANG: '😔 Kartu itu keburu disambar orang lain. Coba nomor yang lain!'
    }[res.reason] || '❌ Gagal mengambil kartu.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const kartu = getKartu(res.cardId);
  const sebelum = await db.tcgGetKartu(key, res.cardId);
  await db.tcgTambahKartu(key, res.cardId, 1);

  const el = ELEMEN[kartu.elemen];
  const baru = !sebelum || sebelum.qty === 0;
  const gambar = await bufferKartu(kartu, 1).catch(() => null);

  await kirimGambar(sock, jid, messageObj, gambar, [
    `🎣 *DISAMBAR!* ${el.emoji} *${kartu.nama}* (${kartu.id})`,
    `${bintang(kartu.rarity)} ${STAT_RARITY[kartu.rarity].label}${baru ? '  🆕 kartu baru!' : ''}`,
    '',
    res.habis ? '_Semua kartu drop sudah habis diambil._' : '_Masih ada kartu tersisa — buruan!_'
  ].join('\n'));
  return true;
}

async function paksaDrop(sock, jid, messageObj, isFromGroup, isStoreAdmin, isOwner) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ Drop hanya bisa dijalankan di dalam grup.');
    return true;
  }
  if (!isStoreAdmin && !isOwner) {
    // Untuk pemain biasa, `.tcg drop` cuma menampilkan status — bukan error.
    const s = statusDrop(jid);
    const aktif = await db.tcgGetDropAktif(jid);
    await send(sock, jid, messageObj, [
      '🎣 *STATUS DROP GRUP*',
      '',
      aktif
        ? `Sedang berlangsung — sisa *${fmtDurasi(aktif.sisaMs)}*, ${aktif.kartuIds.length - aktif.diambil.length} kartu belum diambil.\nKetik \`.tcg ambil <nomor>\`.`
        : `Belum ada drop aktif.\nPesan grup terhitung: *${s?.pesan ?? 0}/${db.TCG_DROP_PESAN_PEMICU}*`,
      '',
      '_Drop muncul otomatis kalau grup ramai. Admin bisa memaksanya dengan `.tcg drop`._'
    ].join('\n'));
    return true;
  }

  const aktif = await db.tcgGetDropAktif(jid);
  if (aktif) {
    await send(sock, jid, messageObj, `⚠️ Masih ada drop berjalan di grup ini (sisa ${fmtDurasi(aktif.sisaMs)}).`);
    return true;
  }

  resetPenghitung(jid);
  const ok = await kirimDrop(sock, jid);
  if (!ok) {
    await send(sock, jid, messageObj, '❌ Gagal membuat drop. Cek log server.');
  }
  return true;
}

// ============================================================
// DEK LAWAN BUATAN (SPARRING CADANGAN & PENJAGA GERBANG)
// ============================================================

/**
 * Menyusun dek lawan buatan pada tingkat kesulitan tertentu.
 *
 * Dipakai dua tempat: sparring ketika belum ada pemain lain yang punya dek
 * lengkap (grup baru), dan penjaga Gerbang Elemen. Levelnya naik satu tiap
 * tujuh tingkat supaya kurvanya landai dan tidak melompat.
 */
function dekPenjaga(tingkat, elemen = null) {
  const level = Math.max(1, Math.min(5, 1 + Math.floor(tingkat / 7)));
  const rarity =
    tingkat >= 28 ? 'MYTHIC' :
    tingkat >= 20 ? 'LEGENDARY' :
    tingkat >= 12 ? 'EPIC' :
    tingkat >= 5 ? 'RARE' : 'COMMON';

  const kolam = elemen
    ? KARTU.filter(k => k.elemen === elemen)
    : KARTU;

  const deck = {};
  for (let s = 1; s <= 3; s++) {
    const seRarity = kolam.filter(k => k.rarity === rarity);
    const pilihan = randomItem(seRarity.length ? seRarity : kolam);
    deck[s] = { card_id: pilihan.id, card_lv: level };
  }
  return { deck, rarity, level };
}

// ============================================================
// SPARRING (LATIH TANDING, TANPA ENERGI)
// ============================================================

/**
 * Sparring melawan BAYANGAN dek pemain lain: dek mereka dipakai, tapi mereka
 * tidak perlu online dan tidak kehilangan apa pun. Ini satu-satunya sumber
 * Keping yang tidak memakai energi, jadi hadiahnya menurun tajam setelah jatah
 * harian habis — kalau tidak, sparring akan menggantikan seluruh sisa permainan.
 */
async function tampilSpar(sock, jid, messageObj, key, aksiArg) {
  const status = await db.tcgSparStatus(key);
  const aksi = String(aksiArg || '').toLowerCase();

  if (!['lawan', 'gas', 'fight', 'mulai'].includes(aksi)) {
    const teks = [
      '🥊 *SPARRING ARENA*',
      'Latih tanding melawan bayangan dek pemain lain. *Tidak memakai energi.*',
      '',
      `Hari ini: *${status.totalMain}* pertandingan`,
      `Jatah hadiah penuh: *${status.sisaJatahPenuh}/${db.TCG_SPAR_JATAH_PENUH}* tersisa`,
      `Hadiah menang berikutnya: *${fmt(status.hadiahBerikutnya)} Keping*`,
      '',
      `_Sesudah jatah habis, hadiah turun jadi ${Math.round(db.TCG_SPAR_RASIO_SISA * 100)}% — sparring tetap boleh, tapi tidak lagi jadi mesin uang._`,
      `_Pemilik dek yang berhasil menahanmu ikut dapat *${db.TCG_SPAR_HADIAH_BERTAHAN} Keping*._`,
      '',
      '➜ Ketik `.tcg spar lawan` untuk mulai.'
    ].join('\n');
    await send(sock, jid, messageObj, teks);
    return true;
  }

  if (isOnCooldown(`tcgspar:${key}`, db.TCG_SPAR_JEDA_MS)) {
    await send(sock, jid, messageObj,
      `⏳ Tunggu sebentar sebelum sparring lagi (jeda ${Math.round(db.TCG_SPAR_JEDA_MS / 1000)} detik).`);
    return true;
  }

  const deckA = await db.tcgGetDeck(key);
  if (!deckA[1] || !deckA[2] || !deckA[3]) {
    await send(sock, jid, messageObj,
      '⚠️ Dek kamu belum lengkap. Isi ketiga slot dulu — slot kosong kalah otomatis di rondenya.\n\n`.tcg dek` untuk mengaturnya.');
    return true;
  }

  const lawan = await db.tcgCariLawanBayangan(key);
  let deckB;
  let namaLawan;
  let lawanJid = null;

  if (lawan) {
    deckB = lawan.deck;
    namaLawan = lawan.nama || 'Petarung Bayangan';
    lawanJid = lawan.ownerJid;
  } else {
    // Grup baru: belum ada dek pemain lain yang lengkap. Lawan buatan menjaga
    // fitur ini tetap bisa dipakai hari pertama, bukan menunggu populasi.
    const tower = await db.tcgGetTower(key);
    const buatan = dekPenjaga(Math.max(1, tower.highest_floor || 1));
    deckB = buatan.deck;
    namaLawan = `Petarung Latih (${STAT_RARITY[buatan.rarity].label} Lv.${buatan.level})`;
  }

  const namaKu = messageObj?.pushName || 'Kamu';
  const sim = simulate3v3(deckA, deckB, namaKu, namaLawan);
  const menang = sim.matchWinner === 1;

  const hasil = await db.tcgCatatHasilSpar(key, menang, lawanJid);

  const teks = [
    '🥊 *HASIL SPARRING*',
    `👤 *${namaKu}* VS *${namaLawan}*`,
    '',
    ...sim.sinergiReport,
    '',
    ...sim.roundReports,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    menang
      ? `🏆 *KAMU MENANG* (Skor ${sim.scoreA} - ${sim.scoreB})`
      : (sim.matchWinner === 2
        ? `💀 *KAMU KALAH* (Skor ${sim.scoreA} - ${sim.scoreB})`
        : `⚖️ *SERI* (Skor ${sim.scoreA} - ${sim.scoreB})`),
    menang && hasil?.hadiah
      ? `💠 Hadiah: *+${fmt(hasil.hadiah)} Keping*${hasil.penuh ? '' : ' _(jatah penuh habis)_'}  ·  Saldo: *${fmt(hasil.kepingTotal)}*`
      : '💠 Tidak ada hadiah Keping kali ini.',
    !menang && lawanJid ? `_${namaLawan} mendapat ${db.TCG_SPAR_HADIAH_BERTAHAN} Keping karena deknya bertahan._` : ''
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// EKSPEDISI (KARTU CADANGAN PERGI CARI HARTA)
// ============================================================

// Peta bintang & rarity per ID kartu — dipakai lapisan DB untuk menghitung
// hasil ekspedisi tanpa harus ikut mengenal katalog kartu.
const PETA_BINTANG = KARTU.reduce((acc, k) => {
  acc[k.id] = STAT_RARITY[k.rarity].bintang;
  return acc;
}, {});

const PETA_RARITY_KARTU = KARTU.reduce((acc, k) => {
  acc[k.id] = k.rarity;
  return acc;
}, {});

async function tampilEkspedisi(sock, jid, messageObj, key, arg1, arg2) {
  const aksi = String(arg1 || '').toLowerCase();

  // --- Klaim hasil ---
  if (['klaim', 'ambil', 'pulang', 'claim'].includes(aksi)) {
    const res = await db.tcgKlaimEkspedisi(key, PETA_RARITY_KARTU, PETA_BINTANG);
    if (!res.success) {
      await send(sock, jid, messageObj,
        '🧭 Belum ada kartu yang pulang.\n\nCek `.tcg ekspedisi` untuk melihat sisa waktunya.');
      return true;
    }
    const rincian = (res.rincian || []).map(r => {
      const k = getKartu(r.cardId);
      if (!k) return null;
      return `${ELEMEN[k.elemen].emoji} *${k.nama}* (${r.jam} jam)\n   └ +${fmt(r.keping)} Keping · +${r.serpihan} Serpihan ${STAT_RARITY[r.rarity].label}`;
    }).filter(Boolean).join('\n');

    await send(sock, jid, messageObj, [
      '🧭 *EKSPEDISI PULANG!*',
      '',
      rincian,
      '',
      `💠 Total: *+${fmt(res.totalKeping)} Keping* (Saldo: *${fmt(res.kepingTotal)}*)`
    ].join('\n'));
    return true;
  }

  // --- Berangkatkan kartu ---
  if (arg1 && getKartu(arg1)) {
    const kartu = getKartu(arg1);
    const jam = parseInt(arg2, 10);
    if (!db.TCG_EKSPEDISI_DURASI.includes(jam)) {
      await send(sock, jid, messageObj,
        `⚠️ Durasi harus salah satu dari: *${db.TCG_EKSPEDISI_DURASI.join('*, *')}* jam.\n\nContoh: \`.tcg ekspedisi ${kartu.id} 4\``);
      return true;
    }

    const aktif = await db.tcgGetEkspedisi(key);
    const slotKosong = [1, 2, 3].find(s => !aktif[s]);
    if (!slotKosong) {
      await send(sock, jid, messageObj,
        `🧭 Ketiga slot ekspedisi sedang terpakai.\n\nKlaim yang sudah pulang dengan \`.tcg ekspedisi klaim\`.`);
      return true;
    }

    const res = await db.tcgKirimEkspedisi(key, slotKosong, kartu.id, jam, PETA_BINTANG);
    if (!res.success) {
      const pesan = {
        SLOT_TIDAK_VALID: '⚠️ Slot ekspedisi tidak valid.',
        DURASI_TIDAK_VALID: `⚠️ Durasi harus ${db.TCG_EKSPEDISI_DURASI.join('/')} jam.`,
        TIDAK_PUNYA: `❌ Kamu belum punya *${kartu.nama}*.`,
        SLOT_TERPAKAI: '⚠️ Slot itu sedang dipakai kartu lain.',
        SEDANG_BERTUGAS: `⚠️ *${kartu.nama}* sedang bertugas di tempat lain.\nPunya *${res.punya}*, terpasang di dek *${res.diDek}*, sedang ekspedisi *${res.diEkspedisi}*.\n\n_Satu kartu tidak bisa bekerja di dua tempat sekaligus._`
      }[res.reason] || '❌ Gagal mengirim ekspedisi.';
      await send(sock, jid, messageObj, pesan);
      return true;
    }

    await send(sock, jid, messageObj, [
      `🧭 *${kartu.nama}* berangkat ekspedisi!`,
      `Slot ${res.slot} · durasi *${res.jam} jam*`,
      '',
      `Perkiraan hasil: *+${fmt(res.perkiraan.keping)} Keping* · *+${res.perkiraan.serpihan} Serpihan ${STAT_RARITY[kartu.rarity].label}*`,
      '',
      '_Kartu berbintang lebih tinggi membawa pulang lebih banyak. Klaim dengan `.tcg ekspedisi klaim`._'
    ].join('\n'));
    return true;
  }

  if (arg1) {
    await send(sock, jid, messageObj,
      `⚠️ Kartu *${arg1}* tidak dikenal.\n\nFormat: \`.tcg ekspedisi <id> <${db.TCG_EKSPEDISI_DURASI.join('|')}>\``);
    return true;
  }

  // --- Papan status ---
  const aktif = await db.tcgGetEkspedisi(key);
  const baris = [1, 2, 3].map(s => {
    const e = aktif[s];
    if (!e) return `*Slot ${s}:* _(kosong)_`;
    const k = getKartu(e.cardId);
    const nama = k ? `${ELEMEN[k.elemen].emoji} ${k.nama}` : e.cardId;
    return e.selesai
      ? `*Slot ${s}:* ${nama} — ✅ *sudah pulang*`
      : `*Slot ${s}:* ${nama} — ⏳ ${fmtDurasi(e.sisaMs)} lagi (${e.jam} jam)`;
  });

  const adaYangPulang = [1, 2, 3].some(s => aktif[s]?.selesai);
  const koleksi = await db.tcgGetKoleksi(key);
  const deck = await db.tcgGetDeck(key);
  const diDek = new Set([1, 2, 3].map(s => deck[s]?.card_id).filter(Boolean));
  const pergi = await db.tcgKartuSedangEkspedisi(key);
  const usul = koleksi
    .map(r => ({ r, k: getKartu(r.card_id) }))
    .filter(x => x.k && !pergi.has(x.k.id) && (!diDek.has(x.k.id) || x.r.qty > 1))
    .sort((a, b) => costKartu(b.k) - costKartu(a.k))[0];

  const teks = [
    '🧭 *EKSPEDISI KARTU*',
    'Kirim kartu cadangan mencari Keping & serpihan. Berjalan walau kamu offline.',
    '',
    ...baris,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Durasi tersedia: *${db.TCG_EKSPEDISI_DURASI.join('*, *')}* jam`,
    `Hasil: ${db.TCG_EKSPEDISI_PER_JAM} Keping × jam × bintang kartu`,
    '',
    adaYangPulang ? '✅ Ada yang sudah pulang — ketik `.tcg ekspedisi klaim`' : '',
    usul ? `➜ Contoh: \`.tcg ekspedisi ${usul.k.id} ${db.TCG_EKSPEDISI_DURASI[1]}\`` : '',
    '',
    '_Kartu yang sedang pergi tidak bisa dipasang ke dek._'
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// GERBANG ELEMEN (FARMING SERPIHAN HARIAN)
// ============================================================

/**
 * Penjaga gerbang ditentukan oleh ELEMEN gerbangnya dan lantai menara pemain,
 * jadi kesulitannya ikut tumbuh bersama pemain alih-alih tetap sepanjang masa.
 */
function penjagaGerbang(elemen, tingkat) {
  return dekPenjaga(Math.max(1, tingkat), elemen);
}

async function tampilGerbang(sock, jid, messageObj, key, elemenArg) {
  const bukaHariIni = db.tcgGerbangHariIni();
  const energi = await db.tcgGetEnergi(key);
  const tower = await db.tcgGetTower(key);
  const tingkat = Math.max(1, tower.highest_floor || 1);

  const q = String(elemenArg || '').toUpperCase();
  const elemenDipilih = Object.keys(ELEMEN).find(e =>
    e === q || ELEMEN[e].nama.toUpperCase() === q
  );

  if (!elemenDipilih) {
    const daftar = bukaHariIni.map(e => {
      const p = penjagaGerbang(e, tingkat);
      return `${ELEMEN[e].emoji} *Gerbang ${ELEMEN[e].nama}* — penjaga ${STAT_RARITY[p.rarity].label} Lv.${p.level}\n   └ \`.tcg gerbang ${ELEMEN[e].nama.toLowerCase()}\``;
    });

    const tutup = Object.keys(ELEMEN).filter(e => !bukaHariIni.includes(e));

    const teks = [
      '🌀 *GERBANG ELEMEN*',
      'Farming serpihan harian. Gerbang yang terbuka berganti tiap hari.',
      '',
      barisEnergi(energi),
      '',
      '*TERBUKA HARI INI*',
      ...daftar,
      '',
      tutup.length ? `🔒 Tertutup hari ini: ${tutup.map(e => ELEMEN[e].emoji + ' ' + ELEMEN[e].nama).join(', ')}` : '',
      '',
      `Hadiah menang: *${db.TCG_GERBANG_SERPIHAN} serpihan* + *${db.TCG_GERBANG_KEPING} Keping* · biaya *1 energi Gerbang*`,
      '',
      '_Minggu semua gerbang terbuka. Energi Gerbang terpisah dari stamina Menara._'
    ].filter(Boolean).join('\n');

    await send(sock, jid, messageObj, teks);
    return true;
  }

  if (!bukaHariIni.includes(elemenDipilih)) {
    await send(sock, jid, messageObj,
      `🔒 *Gerbang ${ELEMEN[elemenDipilih].nama}* tutup hari ini.\n\nYang terbuka: ${bukaHariIni.map(e => ELEMEN[e].emoji + ' ' + ELEMEN[e].nama).join(', ')}\n\n_Minggu semuanya terbuka._`);
    return true;
  }

  const deckA = await db.tcgGetDeck(key);
  if (!deckA[1] || !deckA[2] || !deckA[3]) {
    await send(sock, jid, messageObj,
      '⚠️ Dek kamu belum lengkap. Isi ketiga slot dulu dengan `.tcg dek`.');
    return true;
  }

  const pakai = await db.tcgPakaiEnergiGerbang(key, 1);
  if (!pakai.success) {
    await send(sock, jid, messageObj, [
      '🌀 Energi Gerbang habis.',
      '',
      barisEnergi(energi),
      '',
      `_Terisi sendiri +1 tiap ${Math.round(db.TCG_REGEN_GERBANG_MS / 3600000)} jam. Punya Tonik Penjelajah? Cek \`.tcg ransum\`._`
    ].join('\n'));
    return true;
  }

  const penjaga = penjagaGerbang(elemenDipilih, tingkat);
  const namaKu = messageObj?.pushName || 'Kamu';
  const namaLawan = `Penjaga ${ELEMEN[elemenDipilih].nama}`;
  const sim = simulate3v3(deckA, penjaga.deck, namaKu, namaLawan);

  const ekor = [];
  if (sim.matchWinner === 1) {
    const h = await db.tcgHadiahGerbang(key, penjaga.rarity);
    ekor.push(`💠 Hadiah: *+${fmt(h.keping)} Keping* · *+${h.serpihan} Serpihan ${STAT_RARITY[h.rarity].label}*`);
    ekor.push(`Saldo: *${fmt(h.kepingTotal)} Keping*`);
  } else {
    ekor.push('💨 Kalah — energi tetap terpakai, tapi tidak ada hadiah.');
    ekor.push(`_Penjaga gerbang ini ber-elemen ${ELEMEN[elemenDipilih].nama}. Bawa kartu ${pengalahElemen(elemenDipilih).map(e => ELEMEN[e].nama).join(' atau ')}._`);
  }

  const teks = [
    `${ELEMEN[elemenDipilih].emoji} *GERBANG ${ELEMEN[elemenDipilih].nama.toUpperCase()}*`,
    `Penjaga ${STAT_RARITY[penjaga.rarity].label} Lv.${penjaga.level}`,
    '',
    ...sim.sinergiReport,
    '',
    ...sim.roundReports,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    sim.matchWinner === 1
      ? `🏆 *MENANG* (Skor ${sim.scoreA} - ${sim.scoreB})`
      : `💀 *KALAH* (Skor ${sim.scoreA} - ${sim.scoreB})`,
    ...ekor,
    `🌀 Sisa energi Gerbang: *${pakai.sisaEnergi}/${db.TCG_MAX_ENERGI_GERBANG}*`
  ].join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

// ============================================================
// PVE: MENARA PENJAGA MONSTER (TOWER)
// ============================================================

async function kelolaMenara(sock, jid, messageObj, key, aksiArg) {
  const tower = await db.tcgGetTower(key);
  const energi = await db.tcgGetEnergi(key);
  const targetFloor = (tower.highest_floor || 0) + 1;
  const totalLantai = TOWER_FLOORS.length;

  if (!['lawan', 'gas', 'fight'].includes(String(aksiArg || '').toLowerCase())) {
    const nextInfo = getTowerFloor(targetFloor);
    const teks = [
      '🏰 *MENARA PENJAGA MONSTER (PVE)*',
      `Lantai tertinggi dikuasai: *${tower.highest_floor}/${totalLantai}*`,
      '',
      barisEnergi(energi),
      '',
      targetFloor <= totalLantai
        ? `*Tantangan berikutnya:* Lantai ${targetFloor} — _${nextInfo?.nama || 'Monster Penjaga'}_\n` +
          `   └ Hadiah: +${fmt(nextInfo?.rewardKeping || 0)} Keping` +
          (nextInfo?.rewardShards ? ` · +${nextInfo.rewardShards.jumlah} Serpihan ${STAT_RARITY[nextInfo.rewardShards.rarity].label}` : '')
        : `🎉 *Kamu telah menaklukkan seluruh ${totalLantai} lantai Menara Penjaga!*`,
      '',
      targetFloor <= totalLantai ? 'Ketik `.tcg menara lawan` untuk menantang.' : '',
      '_Menara memakai stamina Menara — terpisah dari energi Gerbang._'
    ].filter(Boolean).join('\n');
    await send(sock, jid, messageObj, teks);
    return true;
  }

  if (targetFloor > totalLantai) {
    await send(sock, jid, messageObj, `👑 Selamat! Kamu sudah menamatkan seluruh ${totalLantai} lantai Menara Penjaga.`);
    return true;
  }

  if (energi.menara <= 0) {
    await send(sock, jid, messageObj, [
      `⚡ Stamina Menara habis (0/${db.TCG_MAX_STAMINA_MENARA}).`,
      '',
      barisEnergi(energi),
      '',
      `_Terisi sendiri +1 tiap ${Math.round(db.TCG_REGEN_MENARA_MS / 3600000)} jam. Punya Ransum Pendaki? Cek \`.tcg ransum\`._`
    ].join('\n'));
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

  const namaKu = messageObj?.pushName || 'Kamu';
  const sim = simulate3v3(userDeck, floorData.deck, namaKu, `Penjaga Lantai ${targetFloor}`);

  if (sim.matchWinner === 1) {
    const prog = await db.tcgProgressTower(key, targetFloor, floorData.rewardKeping, floorData.rewardShards);
    if (!prog.success && prog.reason === 'STAMINA_HABIS') {
      await send(sock, jid, messageObj, '⚡ Stamina Menara keburu habis. Coba lagi setelah terisi.');
      return true;
    }

    try {
      await db.tcgCatatProgresMisi(key, 'MENARA', 1);
    } catch (e) {
      console.error('[TCG] Gagal mencatat misi menara:', e?.message || e);
    }

    const shardBonus = floorData.rewardShards
      ? `\n✦ Serpihan: *+${floorData.rewardShards.jumlah} ${STAT_RARITY[floorData.rewardShards.rarity].label}*`
      : '';

    await send(sock, jid, messageObj, [
      `🏰 *KEMENANGAN DI LANTAI ${targetFloor}!*`,
      `📍 *${floorData.nama}*`,
      '',
      ...sim.sinergiReport,
      '',
      ...sim.roundReports,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🎉 *HASIL: KAMU MENANG (Skor ${sim.scoreA} - ${sim.scoreB})*`,
      `💠 Hadiah: *+${fmt(floorData.rewardKeping)} Keping*${shardBonus}`,
      `⚡ Sisa Stamina: *${prog.sisaStamina ?? 0}/${db.TCG_MAX_STAMINA_MENARA}*`
    ].join('\n'));
    return true;
  }

  const pakai = await db.tcgPakaiStamina(key, 1);

  // Saran counter berdasarkan elemen penjaga lantai ini — kekalahan harus
  // mengajari sesuatu, bukan sekadar mengurangi stamina.
  const elemenPenjaga = [1, 2, 3]
    .map(s => getKartu(floorData.deck[s]?.card_id))
    .filter(Boolean)
    .map(k => k.elemen);
  const saran = [...new Set(elemenPenjaga.flatMap(e => pengalahElemen(e)))]
    .map(e => `${ELEMEN[e].emoji} ${ELEMEN[e].nama}`)
    .join(', ');

  await send(sock, jid, messageObj, [
    `💀 *KAMU KALAH DI LANTAI ${targetFloor}!*`,
    `📍 *${floorData.nama}*`,
    '',
    ...sim.sinergiReport,
    '',
    ...sim.roundReports,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `❌ *HASIL: KEKALAHAN (Skor ${sim.scoreA} - ${sim.scoreB})*`,
    saran ? `💡 _Penjaga lantai ini kuat di elemen ${[...new Set(elemenPenjaga)].map(e => ELEMEN[e].nama).join('/')}. Coba bawa: ${saran}._` : '',
    '💡 _Atau naikkan level kartumu: `.tcg naik`_',
    `⚡ Sisa Stamina: *${pakai.sisaStamina ?? 0}/${db.TCG_MAX_STAMINA_MENARA}*`
  ].filter(Boolean).join('\n'));
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

  const deckA = await db.tcgGetDeck(senderKey);
  if (!deckA[1] && !deckA[2] && !deckA[3]) {
    await send(sock, jid, messageObj, '⚠️ Dek kamu masih kosong! Pasang kartu dengan `.tcg pasang <1-3> <id>`.');
    return true;
  }

  if (bet > 0) {
    const wA = await db.tcgGetWallet(senderKey);
    if (wA.keping < bet) {
      await send(sock, jid, messageObj, `❌ Keping kamu tidak cukup untuk taruhan *${fmt(bet)} Keping* (Punya: *${fmt(wA.keping)}*).`);
      return true;
    }
  }

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

  // Biaya dek penantang ditampilkan supaya yang ditantang bisa menilai lawannya
  // sebelum menerima — satu-satunya informasi yang boleh bocor sebelum duel.
  const biaya = [1, 2, 3].reduce((t, s) => t + (deckA[s] ? costKartu(getKartu(deckA[s].card_id)) : 0), 0);

  const betInfo = bet > 0 ? `💰 Taruhan: *${fmt(bet)} Keping*` : '🤝 Duel Persahabatan (Tanpa Taruhan)';
  const teks = [
    '⚔️ *TANTANGAN DUEL ARENA KARTU 3V3!*',
    `👤 Penantang: *${challengerName}* _(dek ${biaya}/${db.TCG_MAX_DECK_COST}★)_`,
    `🎯 Sasaran: ${targetName}`,
    betInfo,
    '',
    `👉 ${targetName}, ketik \`.tcg gas\` untuk menerima, atau \`.tcg tolak\`!`,
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
      await db.tcgAddKeping(duel.challengerKey, duel.bet, 'DUEL_REFUND');
      await db.tcgAddKeping(duel.targetKey, duel.bet, 'DUEL_REFUND');
      hasilTaruhan = '\n⚖️ Hasil seri! Taruhan dikembalikan ke masing-masing pihak.';
    }
  }

  // Misi DUEL hanya dicatat untuk pemenang — kalau tidak, dua orang bisa
  // bergantian mengalah untuk saling menuntaskan misi.
  try {
    if (sim.matchWinner === 1) await db.tcgCatatProgresMisi(duel.challengerKey, 'DUEL', 1);
    else if (sim.matchWinner === 2) await db.tcgCatatProgresMisi(duel.targetKey, 'DUEL', 1);
  } catch (e) {
    console.error('[TCG] Gagal mencatat misi duel:', e?.message || e);
  }

  const teks = [
    '⚔️ *HASIL PERTANDINGAN DUEL ARENA 3V3*',
    `👤 *${duel.challengerName}* VS *${targetName}*`,
    '',
    ...sim.sinergiReport,
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
    'Naikkan level: `.tcg naik` (lihat yang siap) atau `.tcg naik RAR01`',
    `Lebur ${db.TCG_SERPIHAN_PER_LEBUR} serpihan jadi 1 tingkat di atasnya: \`.tcg lebur common\``,
    '',
    '_Serpihan didapat dari Gerbang, Ekspedisi, Menara, dan memecah duplikat._'
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

/**
 * `.tcg naik` tanpa ID: daftar kartu yang BISA dinaikkan sekarang juga.
 *
 * Sebelumnya pemain harus menebak sendiri kartu mana yang serpihannya cukup,
 * satu per satu, dan biayanya baru ketahuan setelah gagal.
 */
async function daftarNaikLevel(sock, jid, messageObj, key) {
  const [koleksi, serpihan, dompet] = await Promise.all([
    db.tcgGetKoleksi(key),
    db.tcgGetSerpihan(key),
    db.tcgGetWallet(key)
  ]);

  if (!koleksi.length) {
    await send(sock, jid, messageObj, '📭 Koleksimu masih kosong.\n\n➡️ Ketik `.tcg mulai` dulu.');
    return true;
  }

  const punyaKeping = dompet?.keping || 0;
  const kandidat = koleksi
    .map(r => ({ r, kartu: getKartu(r.card_id) }))
    .filter(x => x.kartu && (x.r.card_lv || 1) < MAKS_LEVEL)
    .map(x => {
      const lv = x.r.card_lv || 1;
      const butuhS = (db.TCG_BIAYA_LEVEL[x.kartu.rarity] || {})[lv] || 0;
      const butuhK = db.tcgBiayaKepingLevel(costKartu(x.kartu), lv);
      const punyaS = serpihan[x.kartu.rarity] || 0;
      const kini = statKartu(x.kartu, lv);
      const nanti = statKartu(x.kartu, lv + 1);
      return {
        kartu: x.kartu, lv, butuhS, butuhK, punyaS,
        naikCp: nanti.cp - kini.cp,
        mampu: punyaS >= butuhS && punyaKeping >= butuhK
      };
    })
    .sort((a, b) => (Number(b.mampu) - Number(a.mampu)) || (b.naikCp - a.naikCp));

  if (!kandidat.length) {
    await send(sock, jid, messageObj, `⭐ Semua kartumu sudah di level maksimal (${MAKS_LEVEL}). Luar biasa.`);
    return true;
  }

  const siap = kandidat.filter(x => x.mampu).slice(0, 10);
  const belum = kandidat.filter(x => !x.mampu).slice(0, 5);

  const barisSiap = siap.map(x =>
    `✅ \`${x.kartu.id}\` ${x.kartu.nama} — Lv.${x.lv} ➜ *Lv.${x.lv + 1}* _(+${fmt(x.naikCp)} CP)_\n` +
    `   └ ${x.butuhS} serpihan ${STAT_RARITY[x.kartu.rarity].label} · ${fmt(x.butuhK)} Keping`
  );

  const barisBelum = belum.map(x => {
    const kurang = [
      x.punyaS < x.butuhS && `${x.butuhS - x.punyaS} serpihan`,
      punyaKeping < x.butuhK && `${fmt(x.butuhK - punyaKeping)} Keping`
    ].filter(Boolean).join(' & ');
    return `❌ \`${x.kartu.id}\` ${x.kartu.nama} — kurang ${kurang}`;
  });

  const teks = [
    '⬆️ *SIAP NAIK LEVEL*',
    `💠 ${fmt(punyaKeping)} Keping · ✦ ${db.TCG_RARITY.map(r => `${STAT_RARITY[r].label[0]}${serpihan[r]}`).join(' ')}`,
    '',
    siap.length ? barisSiap.join('\n') : '_Belum ada kartu yang serpihan & Kepingnya cukup._',
    barisBelum.length ? '\n*Hampir bisa:*' : '',
    ...barisBelum,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    siap.length ? `➜ Contoh: \`.tcg naik ${siap[0].kartu.id}\`` : '➜ Cari serpihan di `.tcg gerbang` atau `.tcg ekspedisi`',
    '_Lihat tangga level lengkap sebuah kartu: `.tcg kartu <id>`_'
  ].filter(Boolean).join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

async function naikLevel(sock, jid, messageObj, key, idArg) {
  if (!idArg) return await daftarNaikLevel(sock, jid, messageObj, key);

  const kartu = getKartu(idArg);
  if (!kartu) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg naik <id>`\nContoh: `.tcg naik RAR01`\n\n_Atau ketik `.tcg naik` saja untuk melihat yang siap dinaikkan._');
    return true;
  }

  const sebelum = await db.tcgGetKartu(key, kartu.id);
  const levelSebelum = sebelum?.card_lv || 1;

  // Kegagalan bayar Keping dilempar supaya transaksinya batal utuh — serpihan
  // sudah terpotong lebih dulu, dan tidak boleh hilang tanpa hasil.
  let res;
  try {
    res = await db.tcgNaikLevel(key, kartu.id, kartu.rarity, costKartu(kartu));
  } catch (e) {
    res = e?.hasil || { success: false, reason: 'GAGAL' };
  }

  if (!res.success) {
    const pesan = {
      TIDAK_PUNYA: `❌ Kamu belum punya *${kartu.nama}*.`,
      SUDAH_MAKS: `⚠️ *${kartu.nama}* sudah level maksimal (${MAKS_LEVEL}).`,
      SERPIHAN_KURANG: `❌ Butuh *${res.butuh}* Serpihan ${STAT_RARITY[kartu.rarity].label}, kamu punya *${res.punya}*.\n\nCari serpihan di \`.tcg gerbang\` atau \`.tcg ekspedisi\`, atau pecah duplikat dengan \`.tcg serpih ${kartu.id}\`.`,
      KEPING_KURANG: `❌ Butuh *${fmt(res.butuhKeping)} Keping* untuk menempa, kamu punya *${fmt(res.punyaKeping)}*.\n\nCari Keping cepat di \`.tcg spar\` — tidak makan stamina.`
    }[res.reason] || '❌ Gagal menaikkan level.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const punya = await db.tcgGetKartu(key, kartu.id);
  const lama = statKartu(kartu, levelSebelum);
  const baru = statKartu(kartu, res.levelBaru);
  const gambar = await bufferKartu(kartu, res.levelBaru).catch(() => null);

  const teks = [
    `⬆️ *${kartu.nama}* naik ke *Level ${res.levelBaru}*!`,
    '',
    `   ATK  ${fmt(lama.atk)} ➜ *${fmt(baru.atk)}*  _(+${fmt(baru.atk - lama.atk)})_`,
    `   HP   ${fmt(lama.hp)} ➜ *${fmt(baru.hp)}*  _(+${fmt(baru.hp - lama.hp)})_`,
    `   CP   ${fmt(lama.cp)} ➜ *${fmt(baru.cp)}*  _(+${fmt(baru.cp - lama.cp)})_`,
    '',
    `_Biaya: ${res.biaya} Serpihan + ${fmt(res.biayaKeping)} Keping_`,
    '',
    kartuPenuh(kartu, res.levelBaru, punya.qty),
    '',
    ...(await pratinjauNaik(key, kartu, res.levelBaru))
  ].join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
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
  const energi = await db.tcgGetEnergi(target);

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
    `🏰 Menara: Lantai *${tower.highest_floor}/${TOWER_FLOORS.length}*`,
    barisEnergi(energi),
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

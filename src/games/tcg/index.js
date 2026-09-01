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
  ringkasEfekSkill, tanggaRefine, MAKS_REFINE,
  STAT_RARITY, statKartu, ELEMEN, SKILL, PETA_COST, costKartu, getPeran,
  SINERGI, sinergiDek, hitungSinergi, RAMPING_PER_BINTANG, RAMPING_MAKS_BINTANG,
  pengalahElemen, MAKS_LEVEL, tanggaLevel
} from './cards.js';
import {
  simulate3v3, TOWER_FLOORS, getTowerFloor,
  getActiveDuel, setTcgDuel, deleteTcgDuel,
  ringkasPenjaga, saranCounter, elemenDek, dekAbadi, modifierAbadi
} from './battle.js';
import { bufferKartu, bufferBanyakKartu } from './gambar.js';
import {
  bannerAktif, sisaHariBanner, undiKartuBanner,
  BANNER_PELUANG_MYTHIC, BANNER_PELUANG_LEGENDARY
} from './banner.js';
import { kirimDrop, resetPenghitung, statusDrop } from './drop.js';
import {
  catatAksi, barisGelar, labelTier, teksHadiahMusim,
  tampilRank, tampilGelar, tampilTonggak, tampilMingguan, kelolaAbadi,
  tawarBarter, terimaBarter, tolakBarter, adaBarterMenunggu
} from './meta.js';
import { kelolaGauntlet, kelolaBos } from './tantangan.js';

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
function kartuPenuh(kartu, level = 1, qty = 1, refine = 1) {
  const el = ELEMEN[kartu.elemen];
  const s = statKartu(kartu, level);
  const cost = costKartu(kartu);
  const r = Math.max(1, Math.min(5, Math.floor(refine) || 1));
  const baris = [
    '```',
    `${el.emoji} ${kartu.nama.toUpperCase()}`,
    // Hanya Legendary/Mythic yang punya gelar; ketiadaannya di tier bawah
    // adalah penanda tier, jadi barisnya benar-benar dihilangkan, bukan dikosongkan.
    ...(kartu.gelar ? [`"${kartu.gelar}"`] : []),
    `${bintang(kartu.rarity)} (${cost}★)  ${STAT_RARITY[kartu.rarity].label} · ${el.nama}`,
    `Peran: ${getPeran(kartu).nama} — ${getPeran(kartu).teks}`,
    '',
    `ATK   ${String(fmt(s.atk)).padEnd(9)}HP    ${fmt(s.hp)}`,
    `KRIT  ${String(persen(s.kritis)).padEnd(9)}CP    ${fmt(s.cp)}`,
    `Lv.   ${String(`${s.level}/${MAKS_LEVEL}`).padEnd(9)}R     ${r}/5`,
    `Punya ${qty}`,
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
    // Tangga R sengaja disandingkan dengan TANGGA LEVEL di atasnya. Keduanya
    // adalah dua sumbu yang berbeda — level membeli STAT, refine membeli
    // SKILL — dan pemain baru bisa memilih di antara keduanya kalau ia melihat
    // ongkos dan hasil keduanya di layar yang sama.
    baris.push('', 'TANGGA R  (1 duplikat/tingkat)');
    for (const t of tanggaRefine(kartu)) {
      baris.push(`R${t.refine}  ${t.efek}${t.refine === r ? '  <' : ''}`);
    }
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
  const butuhPicis = db.tcgBiayaPicisLevel(costKartu(kartu), lv);

  const [serpihan, dompet] = await Promise.all([db.tcgGetSerpihan(key), db.tcgGetWallet(key)]);
  const punyaSerpihan = serpihan[kartu.rarity] || 0;
  const punyaPicis = dompet?.picis || 0;
  const cukupSerpihan = punyaSerpihan >= butuhSerpihan;
  const cukupPicis = punyaPicis >= butuhPicis;

  const kurang = [
    !cukupSerpihan && `*${butuhSerpihan - punyaSerpihan}* serpihan`,
    !cukupPicis && `*${fmt(butuhPicis - punyaPicis)}* Picis`
  ].filter(Boolean);

  return [
    `⬆️ *NAIK KE Lv.${lv + 1}*`,
    `   ATK  ${fmt(kini.atk)} ➜ *${fmt(nanti.atk)}*  _(+${fmt(nanti.atk - kini.atk)})_`,
    `   HP   ${fmt(kini.hp)} ➜ *${fmt(nanti.hp)}*  _(+${fmt(nanti.hp - kini.hp)})_`,
    `   CP   ${fmt(kini.cp)} ➜ *${fmt(nanti.cp)}*  _(+${fmt(nanti.cp - kini.cp)})_`,
    '',
    `   ✦ Serpihan ${STAT_RARITY[kartu.rarity].label}: *${butuhSerpihan}* — punya ${punyaSerpihan} ${cukupSerpihan ? '✅' : '❌'}`,
    `   🪙 Picis: *${fmt(butuhPicis)}* — punya ${fmt(punyaPicis)} ${cukupPicis ? '✅' : '❌'}`,
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
    // Penanda RATE ON dipasang di depan supaya terbaca sekilas di tengah
    // sepuluh baris hasil — itu satu-satunya informasi yang benar-benar dicari
    // pemain saat membuka hasil tarikan.
    const rate = x.unggulan ? '⬆️ ' : '';
    const baris = `${rate}${el.emoji} ${bintang(x.kartu.rarity)} *${x.kartu.nama}* (${x.kartu.id})${tanda}`;
    // Gelar cuma dimiliki Legendary & Mythic, jadi baris tambahan ini otomatis
    // hanya muncul di tarikan yang memang layak dirayakan. Tarikan 10x biasanya
    // menambah nol atau satu baris — daftarnya tetap terbaca.
    const gelar = x.kartu.gelar ? `\n     _${x.kartu.gelar}_` : '';
    const jaminan = x.jaminanTerpakai ? '\n     _🎯 jaminan terpakai_' : '';
    return `${baris}${gelar}${jaminan}`;
  }).join('\n');
}

async function prosesTarikan(key, jumlah, gratis = false) {
  const hasil = [];
  const banner = bannerAktif(db.tcgTanggalHariIni());
  // Status jaminan dibaca SEKALI lalu diubah di tempat sepanjang rangkaian,
  // baru disimpan sekali di akhir. Kalau ia ditulis ulang tiap tarikan,
  // `.tcg gacha10` menulis sepuluh kali untuk satu hasil yang sama.
  const [status, pity, dompet] = await Promise.all([
    db.tcgGetBanner(key, banner.id),
    db.tcgGetPity(key),
    db.tcgGetWallet(key)
  ]);
  let tambahMythic = 0;
  let tambahLegendary = 0;

  for (let i = 0; i < jumlah; i++) {
    const pity = await db.tcgGetPity(key);
    const rarity = undiRarity(pity);
    const undian = undiKartuBanner(rarity, banner, status, getKartuByRarity);
    const kartu = undian.kartu;
    if (undian.unggulan && rarity === 'MYTHIC') tambahMythic++;
    if (undian.unggulan && rarity === 'LEGENDARY') tambahLegendary++;
    const sebelum = await db.tcgGetKartu(key, kartu.id);
    await db.tcgTambahKartu(key, kartu.id, 1);
    await db.tcgCatatTarikan(key, rarity, gratis);
    hasil.push({
      kartu,
      baru: !sebelum || sebelum.qty === 0,
      unggulan: undian.unggulan,
      jaminanTerpakai: undian.jaminanTerpakai
    });
  }

  await db.tcgSimpanBanner(key, banner.id, {
    ...status,
    tambahTarikan: jumlah,
    tambahMythic,
    tambahLegendary
  });
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
  if (['dek', 'deck', 'tim', 'formasi', 'dekku'].includes(sub) && args[2]) {
    return await pasangDek(sock, jid, messageObj, key, args[2], args[3]);
  }

  switch (sub) {
    case '':
    case 'menu':
      return await tampilMenu(sock, jid, messageObj, key);

    case 'bantuan':
    case 'help':
      return await tampilBantuan(sock, jid, messageObj, args[2]);

    // Pintasan angka dari menu, URUT MENGIKUTI ALUR: dapat kartu ➜ siapkan dek
    // ➜ bertarung ➜ harian ➜ jangka panjang. Urutan lamanya acak (spar di 3,
    // gerbang di 5, gauntlet di 11) sehingga menu terbaca sebagai daftar, bukan
    // sebagai urutan yang mengajari pemain baru harus mulai dari mana.
    //
    // Angkanya BERGESER dari versi sebelumnya. Itu memang ada ongkosnya bagi
    // yang sudah hafal, tapi angka menu selalu dibaca dari menu yang sedang
    // terbuka — dan menu yang urutannya acak jauh lebih mahal untuk selamanya.
    //
    // Semua pintasan di bawah HANYA membuka layar, tidak pernah membelanjakan
    // apa pun. `naik` dan `refine` sengaja dipanggil tanpa argumen supaya
    // `.tcg 4` menampilkan daftar, bukan langsung memakan serpihan atau duplikat.
    case '1':
      return await tampilBanner(sock, jid, messageObj, key);
    case '2':
      return await tampilKoleksi(sock, jid, messageObj, key, args[2]);
    case '3':
      return await tampilDek(sock, jid, messageObj, key);
    case '4':
      return await naikLevel(sock, jid, messageObj, key, undefined);
    case '5':
      return await refineKartu(sock, jid, messageObj, key, '');
    case '6':
      return await tampilSpar(sock, jid, messageObj, key, args[2]);
    case '7':
      return await kelolaMenara(sock, jid, messageObj, key, args[2]);
    case '8':
      return await tampilRank(sock, jid, messageObj, key, args[2]);
    case '9':
      return await kelolaGauntlet(sock, jid, messageObj, key, args[2], messageObj?.pushName);
    case '10':
      return await kelolaBos(sock, jid, messageObj, key, args[2], isFromGroup);
    case '11':
      return await tampilGerbang(sock, jid, messageObj, key, args[2]);
    case '12':
      return await tampilEkspedisi(sock, jid, messageObj, key, args[2], args[3]);
    case '13':
      return await tampilMisi(sock, jid, messageObj, key, args[2]);
    case '14':
      return await tampilGelar(sock, jid, messageObj, key, args[2]);
    case '15':
      return await tawarBarter(sock, jid, messageObj, key, args.slice(2), isFromGroup);
    case '0':
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
    case 'absen':
    case 'beruntun':
    case 'streak':
      return await tarikGratis(sock, jid, messageObj, key);

    case 'ransum':
    case 'bekal':
    case 'item':
    case 'stamina':
      return await tampilRansum(sock, jid, messageObj, key, args[2]);

    case 'koleksi':
    case 'collection':
    case 'kartuku':
    case 'koleksiku':
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
    case 'tim':
    case 'formasi':
    case 'dekku':
      return await tampilDek(sock, jid, messageObj, key);

    case 'sinergi':
    case 'synergy':
      return await tampilSinergi(sock, jid, messageObj);

    case 'misi':
    case 'mission':
    case 'quest':
    case 'misiku':
    case 'tugasku':
      return await tampilMisi(sock, jid, messageObj, key, args[2]);

    case 'ambil':
    case 'grab':
    case 'sambar':
    case 'tangkap':
      return await ambilKartuDrop(sock, jid, messageObj, key, args[2], isFromGroup);

    case 'drop':
      return await paksaDrop(sock, jid, messageObj, isFromGroup, isStoreAdmin, isOwner);

    case 'spar':
    case 'sparring':
    case 'latihan':
    case 'latih':
      return await tampilSpar(sock, jid, messageObj, key, args[2]);

    case 'ekspedisi':
    case 'kirim':
    case 'expedition':
    case 'berangkat':
      return await tampilEkspedisi(sock, jid, messageObj, key, args[2], args[3]);

    case 'gerbang':
    case 'gate':
    case 'portal':
      return await tampilGerbang(sock, jid, messageObj, key, args[2]);

    case 'pasang':
    case 'set':
    case 'taruh':
    case 'pasangin':
    case 'masukin':
      return await pasangDek(sock, jid, messageObj, key, args[2], args[3]);

    case 'autodek':
    case 'bestdek':
    case 'autodeck':
    case 'pasangauto':
    case 'auto':
    case 'susun':
    case 'bestdeck':
      return await pasangAutoDek(sock, jid, messageObj, key, args[2]);

    case 'gauntlet':
    case 'gantlet':
    case 'ujian':
    case 'gaunlet':
      return await kelolaGauntlet(sock, jid, messageObj, key, args[2], messageObj?.pushName);

    case 'bos':
    case 'boss':
    case 'bosarena':
    case 'raid':
    case 'bosgrup':
      return await kelolaBos(sock, jid, messageObj, key, args[2], isFromGroup);

    case 'lepas':
    case 'copot':
    case 'copotin':
    case 'lepasin':
      return await lepasDek(sock, jid, messageObj, key, args[2]);

    case 'tukar':
    case 'swap':
    case 'geser':
    case 'pindah':
    case 'pindahin':
      return await tukarSlotDek(sock, jid, messageObj, key, args.slice(2));

    case 'menara':
    case 'dungeon':
    case 'tower':
      return await kelolaMenara(sock, jid, messageObj, key, args[2]);

    case 'duel':
    case 'tantang':
    case 'pvp':
      return await tantangDuel(sock, jid, messageObj, key, args, isFromGroup);

    case 'gas':
    case 'terima':
    case 'accept':
    case 'gaspol':
      return await terimaDuel(sock, jid, messageObj, key, isFromGroup);

    case 'tolak':
    case 'cancel':
    case 'nolak':
      return await tolakDuel(sock, jid, messageObj, key);

    // ---- Lapisan retensi (meta.js) ----
    case 'rank':
    case 'peringkat':
    case 'elo':
    case 'liga':
    case 'tier':
      return await tampilRank(sock, jid, messageObj, key, args[2]);

    case 'gelar':
    case 'titel':
    case 'title':
    case 'julukan':
      return await tampilGelar(sock, jid, messageObj, key, args[2]);

    case 'tonggak':
    case 'milestone':
      return await tampilTonggak(sock, jid, messageObj, key, args[2]);

    case 'mingguan':
    case 'weekly':
    case 'minggu':
      return await tampilMingguan(sock, jid, messageObj, key, args[2]);

    case 'abadi':
    case 'endless':
    case 'void':
    case 'menaraabadi':
      return await kelolaAbadi(sock, jid, messageObj, key, args[2]);

    case 'barter':
    case 'trade':
    case 'tukarkartu':
      return await tawarBarter(sock, jid, messageObj, key, args.slice(2), isFromGroup);

    case 'deal':
    case 'setuju':
    case 'sepakat':
      return await terimaBarter(sock, jid, messageObj, key, isFromGroup);

    // `batal` menolak barter kalau ada yang menunggu, dan menolak duel kalau
    // tidak. Dua alias terpisah (`tolak` untuk duel, `batal` untuk barter)
    // sudah dicoba dan salah dipakai terus — pemain mengetik yang mana saja
    // yang teringat, lalu bingung kenapa tawarannya masih menggantung.
    case 'batal':
      return adaBarterMenunggu(key)
        ? await tolakBarter(sock, jid, messageObj, key)
        : await tolakDuel(sock, jid, messageObj, key);

    case 'jual':
    case 'jualin':
      return await jualKartu(sock, jid, messageObj, key, args[2], args[3]);

    case 'jualsemua':
    case 'sellsall':
    case 'jualall':
      return await jualSemuaKartu(sock, jid, messageObj, key, args[2]);

    case 'serpih':
    case 'pecah':
    case 'pecahin':
      return await serpihKartu(sock, jid, messageObj, key, args[2], args[3]);

    case 'serpihsemua':
    case 'salvagesemua':
    case 'scrapsall':
    case 'serpihall':
      return await serpihSemuaKartu(sock, jid, messageObj, key, args[2]);

    case 'serpihan':
    case 'shards':
    case 'serpihanku':
    case 'shard':
    case 'pecahan':
      return await tampilSerpihan(sock, jid, messageObj, key);

    case 'lebur':
    case 'leburin':
      return await leburSerpihan(sock, jid, messageObj, key, args[2]);

    case 'batas':
    case 'limit':
    case 'batasgacha':
      return await aturBatasTarik(sock, jid, messageObj, args[2], isOwner, isStoreAdmin, messageObj?.pushName);

    case 'banner':
    case 'bener':
    case 'unggulan':
    case 'rateon':
      return await tampilBanner(sock, jid, messageObj, key);

    case 'naik':
    case 'upgrade':
    case 'naikin':
      return await naikLevel(sock, jid, messageObj, key, args[2]);

    case 'refine':
    case 'sisip':
    case 'sisipkan':
    case 'evolusi':
      return await refineKartu(sock, jid, messageObj, key, args.slice(2).join(' '));

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
  'kartu', 'rate', 'keping', 'dek', 'sinergi', 'pasang', 'autodek', 'lepas', 'copot', 'tukar',
  'menara', 'duel', 'gas', 'tolak', 'jual', 'jualsemua', 'serpih', 'serpihsemua', 'serpihan',
  'lebur', 'naik', 'misi', 'spar', 'ekspedisi', 'gerbang', 'ambil',
  'rank', 'gelar', 'tonggak', 'mingguan', 'abadi', 'barter', 'deal', 'batal',
  'gauntlet', 'bos', 'refine', 'sisip', 'evolusi', 'banner', 'unggulan', 'batas',
  // Alias sehari-hari yang benar-benar diketik pemain. Sengaja ditaruh DI AKHIR:
  // tebakSubPerintah memakai `d < jarakTerbaik` yang strict, jadi entri lama tetap
  // menang saat jaraknya seri dan koreksi yang sudah benar tidak pernah direbut.
  // Alias yang berjarak <= 2 dari sub-perintah lama SENGAJA TIDAK ada di sini —
  // cukup jadi `case`, supaya ia bisa diketik tapi tidak ikut jadi tebakan.
  'taruh', 'auto', 'susun', 'bestdeck', 'pindah', 'formasi',
  'pecah', 'pecahan', 'portal', 'latih', 'menaraabadi', 'bosgrup',
  'liga', 'tier', 'julukan', 'absen', 'beruntun', 'streak',
  'stamina', 'tangkap', 'berangkat', 'tukarkartu', 'tugasku', 'pvp'
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
  const [w, hitung, deck, energi, misi, streak, rank, mingguan, tonggak, gelar] = await Promise.all([
    db.tcgGetWallet(key),
    db.tcgHitungKoleksi(key),
    db.tcgGetDeck(key),
    db.tcgGetEnergi(key),
    db.tcgGetMisi(key),
    db.tcgGetStreak(key),
    db.tcgGetRank(key, { umumkan: true }),
    db.tcgGetMisiMingguan(key),
    db.tcgGetTonggak(key),
    barisGelar(key)
  ]);

  const biayaDek = [1, 2, 3].reduce((t, s) => t + (deck[s] ? costKartu(getKartu(deck[s].card_id)) : 0), 0);
  const slotTerisi = [1, 2, 3].filter(s => deck[s]).length;

  // Baris "yang bisa kamu ambil sekarang" sengaja dikumpulkan jadi satu blok.
  // Hadiah yang menunggu tanpa diberitahukan sama saja dengan tidak ada, dan di
  // WhatsApp pemain tidak akan mengetik enam perintah untuk memeriksanya satu
  // per satu.
  const stBatas = await db.tcgStatusBatasTarik();

  const siap = [
    stBatas.dinaikkan
      ? `🎉 *Batas gacha hari ini naik jadi ${stBatas.batas}x!* _(normal ${stBatas.normal}x)_`
      : '',
    !streak.sudahKlaimHariIni ? '🎁 `.tcg daily` — hadiah harian belum diambil' : '',
    misi.kepingSiapKlaim > 0 ? `🎯 \`.tcg misi klaim\` — *${fmt(misi.kepingSiapKlaim)} Keping* menunggu` : '',
    mingguan.adaKlaim ? '📆 `.tcg mingguan klaim` — hadiah mingguan siap' : '',
    tonggak.adaKlaim ? '🏛️ `.tcg tonggak klaim` — tonggak koleksi tercapai' : ''
  ].filter(Boolean);

  const teks = [
    '🎴 *ARENA KARTU MONSTER*',
    gelar ? `🏷️ ${gelar}` : `Kumpulkan ${TOTAL_KARTU} monster nusantara, susun dek 3 kartu, lalu bertarung.`,
    '',
    `💠 *${fmt(w.keping)}* Keping   🪙 *${fmt(w.picis || 0)}* Picis`,
    `📚 *${hitung.unik}/${TOTAL_KARTU}* jenis kartu`,
    `🃏 Dek: *${slotTerisi}/3* slot · *${biayaDek}/${db.TCG_MAX_DECK_COST}★*`,
    `${rank.tier.emoji} ${rank.tier.nama} *${fmt(rank.poin)}* poin _(musim ${rank.musim}, sisa ${rank.sisaHari}h)_`,
    streak.streak > 0
      ? `🔥 Beruntun *${streak.streak} hari*${streak.sudahKlaimHariIni ? '' : ' — _klaim hari ini!_'}`
      : '🔥 Beruntun *0* — mulai lagi dengan `.tcg daily`',
    barisEnergi(energi),
    ...(siap.length ? ['', ...siap] : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🎴 *DAPAT KARTU*',
    '*1* · `.tcg banner` — kartu unggulan pekan ini 🆕',
    '*2* · `.tcg koleksi` — lihat kartumu',
    '',
    '🃏 *SIAPKAN DEK*',
    '*3* · `.tcg dek` — atur formasi 3v3',
    '*4* · `.tcg naik` — naikkan level kartu _(stat)_',
    '*5* · `.tcg refine` — sisipkan duplikat, naikkan R _(skill)_ 🆕',
    '',
    '⚔️ *BERTARUNG*',
    '*6* · `.tcg spar` — latih tanding, dapat Keping',
    '*7* · `.tcg menara` — naik lantai PvE',
    '*8* · `.tcg rank` — peringkat musim & duel',
    '*9* · `.tcg gauntlet` — 3 lawan pekanan, kartu tak boleh diulang',
    '*10* · `.tcg bos` — bos grup, HP bersama',
    '',
    '🌾 *HARIAN*',
    '*11* · `.tcg gerbang` — farming serpihan + Picis',
    '*12* · `.tcg ekspedisi` — kirim kartu cari harta',
    '*13* · `.tcg misi` — misi harian & mingguan',
    '',
    '🏛️ *JANGKA PANJANG*',
    '*14* · `.tcg gelar` — gelar & tonggak koleksi',
    '*15* · `.tcg barter` — tukar duplikat dengan teman',
    '*0* · `.tcg bantuan` — daftar perintah lengkap',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    hitung.unik === 0
      ? '➡️ Belum punya kartu? Ketik `.tcg mulai` untuk paket pemula gratis.'
      : null,
    '_Ketik angkanya saja, contoh `.tcg 1`._',
    // Hadiah akhir musim dibayar malas oleh `tcgGetRank`, dan menu ini adalah
    // layar pertama yang kebanyakan orang buka. Kalau pengumumannya cuma ada di
    // `.tcg rank`, hadiah itu akan dibayar diam-diam di sini lalu hilang.
    teksHadiahMusim(rank.hadiahMusimLalu) || null
  ].filter(x => x !== null && x !== undefined).join('\n');

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
      ['.tcg mulai', 'Paket pemula: kartu + Keping + Picis (sekali seumur hidup)'],
      ['.tcg daily', `Tarikan gratis + ${db.TCG_BONUS_HARIAN_KEPING} Keping + 1 ransum, tiap hari`],
      ['.tcg banner', 'Kartu unggulan pekan ini, rate ON/OFF & jaminan 50/50'],
      ['.tcg gacha', `Tarik 1 kartu (${fmt(db.TCG_HARGA_TARIK)} Keping)`],
      ['.tcg gacha10', `Tarik 10 kartu (${fmt(db.TCG_HARGA_TARIK10)} Keping)`],
      ['.tcg rate', 'Peluang tiap rarity & status pity kamu'],
      ['.tcg batas', 'Batas tarikan harian yang berlaku hari ini'],
      ['.tcg koleksi [rarity|elemen|hal]', 'Kartu yang kamu punya'],
      ['.tcg kartu <id>', 'Detail kartu + tangga level Lv.1-5'],
      ['.tcg keping', 'Dompet: Keping (gacha) + Picis (naik level)']
    ]
  },
  dek: {
    judul: '🃏 DEK & SINERGI',
    baris: [
      ['.tcg dek', 'Lihat formasi 3v3 kamu'],
      ['.tcg autodek / .tcg bestdek', 'Pasang 3 kartu terkuat secara otomatis'],
      ['.tcg autodek <elemen>', 'Susun dek yang UNGGUL melawan elemen itu'],
      ['.tcg autodek abadi', 'Susun dek yang memenuhi syarat lantai Abadi berikutnya'],
      ['.tcg pasang <1-3> <id>', 'Pasang kartu ke slot'],
      ['.tcg lepas <1-3>', 'Kosongkan satu slot (alias: `.tcg copot`)'],
      ['.tcg lepas semua', 'Kosongkan seluruh dek sekaligus'],
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
      ['.tcg abadi', 'Menara Abadi — lantai tanpa ujung (terbuka sesudah lantai 30)'],
      ['.tcg duel @member [taruhan]', 'Duel PvP di grup'],
      ['.tcg gas / .tcg tolak', 'Terima atau tolak tantangan'],
      ['.tcg rank', 'Peringkat & tier musim ini'],
      ['.tcg rank top', 'Papan peringkat 10 besar musim ini'],
      ['.tcg gauntlet', '3 pertarungan pekanan, kartu tidak boleh diulang'],
      ['.tcg gauntlet dek', 'Susun dek dari kartu yang belum terkunci'],
      ['.tcg gauntlet lawan', 'Bertarung di tahap berikutnya'],
      ['.tcg bos', 'Bos Arena grup — HP bersama, hadiah dibagi'],
      ['.tcg bos serang', 'Pukul bos dengan dek aktifmu (3x per hari)']
    ]
  },
  naik: {
    judul: '⬆️ MENGUATKAN KARTU — LEVEL & REFINE',
    baris: [
      ['.tcg naik', 'Daftar kartu yang siap dinaikkan sekarang'],
      ['.tcg naik <id>', 'Naikkan level: serpihan + Picis, maks Lv.5 (menaikkan STAT)'],
      ['.tcg refine', 'Kartu yang duplikatnya sudah cukup untuk di-refine'],
      ['.tcg refine <id>', 'Sisipkan 1 duplikat: R1 ➜ R5, maks R5 (menaikkan SKILL)'],
      ['.tcg serpih <id> [n]', 'Pecah duplikat jadi serpihan'],
      ['.tcg serpihsemua [rarity]', 'Pecah semua duplikat kartu berlebih massal'],
      ['.tcg lebur <rarity>', `${db.TCG_SERPIHAN_PER_LEBUR} serpihan ➜ 1 tingkat di atasnya`],
      ['.tcg jual <id> [n]', 'Jual duplikat jadi Keping'],
      ['.tcg jualsemua [rarity]', 'Jual semua duplikat kartu berlebih massal'],
      ['.tcg serpihan', 'Cek stok serpihanmu']
    ]
  },
  farming: {
    judul: '🌾 FARMING & HARIAN',
    baris: [
      ['.tcg ekspedisi', 'Kirim kartu cadangan cari Keping + serpihan'],
      ['.tcg ekspedisi <id> <jam>', `Berangkatkan kartu (${db.TCG_EKSPEDISI_DURASI.join('/')} jam)`],
      ['.tcg ekspedisi klaim', 'Ambil hasil kartu yang sudah pulang'],
      ['.tcg misi', 'Misi harian (diundi tiap hari) + klaim hadiah'],
      ['.tcg mingguan', 'Misi mingguan, reset tiap Senin'],
      ['.tcg ransum', 'Tas ransum pemulih energi'],
      ['.tcg ambil <1-3>', 'Sambar kartu dari drop grup']
    ]
  },
  jangka: {
    judul: '🏷️ JANGKA PANJANG',
    baris: [
      ['.tcg daily', 'Hadiah harian + beruntun; tonggak di hari 3/7/14/30'],
      ['.tcg gelar', 'Gelar permanen & syaratnya'],
      ['.tcg gelar <id>', 'Pasang gelar di profilmu'],
      ['.tcg tonggak', 'Hadiah tonggak jumlah jenis kartu'],
      ['.tcg tonggak klaim', 'Ambil semua tonggak yang sudah tercapai'],
      ['.tcg barter @member <kartumu> <kartunya>', 'Tukar duplikat di grup'],
      ['.tcg deal / .tcg batal', 'Setujui atau tolak tawaran barter']
    ]
  }
};

const ALIAS_BANTUAN = {
  dasar: 'dasar', gacha: 'dasar', mulai: 'dasar', kartu: 'dasar', koleksi: 'dasar',
  banner: 'dasar', unggulan: 'dasar', rateon: 'dasar', rate: 'dasar', pity: 'dasar',
  dek: 'dek', deck: 'dek', sinergi: 'dek', formasi: 'dek',
  autodek: 'dek', bestdek: 'dek', autodeck: 'dek', otomatis: 'dek',
  gauntlet: 'tarung', bos: 'tarung', boss: 'tarung', modifier: 'tarung',
  tarung: 'tarung', duel: 'tarung', menara: 'tarung', spar: 'tarung', gerbang: 'tarung',
  naik: 'naik', level: 'naik', upgrade: 'naik', serpihan: 'naik', jual: 'naik',
  refine: 'naik', sisip: 'naik', evolusi: 'naik', picis: 'naik', dompet: 'naik',
  keping: 'naik', duplikat: 'naik',
  serpihsemua: 'naik', jualsemua: 'naik', massal: 'naik', bersih: 'naik',
  farming: 'farming', ekspedisi: 'farming', misi: 'farming', ransum: 'farming', drop: 'farming',
  jangka: 'jangka', gelar: 'jangka', tonggak: 'jangka', barter: 'jangka', streak: 'jangka',
  beruntun: 'jangka', mingguan: 'jangka', rank: 'tarung', peringkat: 'tarung', abadi: 'tarung'
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
    '`.tcg bantuan dasar` — banner, gacha, koleksi, dompet',
    '`.tcg bantuan dek` — formasi 3v3 & sinergi',
    '`.tcg bantuan tarung` — spar, menara, gerbang, duel',
    '`.tcg bantuan naik` — level (stat), refine (skill), serpihan',
    '`.tcg bantuan farming` — ekspedisi, misi, ransum, drop',
    '`.tcg bantuan jangka` — beruntun, gelar, tonggak, barter',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '*Paling sering dipakai:*',
    '• `.tcg` — menu utama bernomor',
    '• `.tcg daily` — hadiah harian gratis',
    '• `.tcg dek` — atur formasi',
    '• `.tcg spar` — cari Keping tanpa energi',
    '• `.tcg rank` — peringkat musim & tier',
    '• `.tcg banner` — kartu unggulan & jaminan 50/50',
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
  await db.tcgAddPicis(key, db.TCG_BONUS_STARTER_PICIS, 'PAKET_PEMULA');

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
    `💠 Bonus: *${db.TCG_BONUS_STARTER_KEPING} Keping* — untuk gacha`,
    `🪙 Bonus: *${fmt(db.TCG_BONUS_STARTER_PICIS)} Picis* — untuk menaikkan level`,
    `🃏 Dek 3v3 pemula sudah otomatis dipasang (*${biaya}/${db.TCG_MAX_DECK_COST}★*)`,
    '',
    'Lanjut: cek `.tcg dek`, lalu jajal `.tcg spar` atau `.tcg menara lawan`.'
  ].join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
  return true;
}

/**
 * Menaikkan batas tarikan harian — HANYA untuk hari ini.
 *
 * Aturannya disimpan bertanda tanggal, jadi tidak ada yang perlu mematikannya
 * besok. Itu disengaja: saklar yang harus dimatikan manual pada akhirnya akan
 * lupa dimatikan, dan batas gacha yang terlanjur longgar berhari-hari tidak
 * bisa ditarik kembali sesudah kartunya keluar.
 */
async function aturBatasTarik(sock, jid, messageObj, arg, isOwner, isStoreAdmin, pushName) {
  const st = await db.tcgStatusBatasTarik();
  const a = String(arg || '').toLowerCase().trim();

  if (!a) {
    await send(sock, jid, messageObj, [
      '🎚️ *BATAS TARIKAN HARIAN*',
      '',
      `Hari ini: *${st.batas} tarikan/orang*` + (st.dinaikkan ? '  ⬆️ _dinaikkan_' : (st.diturunkan ? '  ⬇️ _diturunkan_' : '')),
      `Normal: *${st.normal}*`,
      st.adaAturan ? `_Diatur oleh ${st.oleh || 'Owner'} untuk tanggal ${st.tanggal}._` : null,
      '',
      st.adaAturan
        ? '_Aturan ini hangus sendiri saat tanggal berganti — tidak perlu dimatikan._'
        : '_Belum ada pengaturan khusus hari ini._',
      ...(isOwner || isStoreAdmin ? [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `➜ \`.tcg batas <angka>\` — naikkan untuk hari ini (maks ${db.TCG_BATAS_TARIK_MAKS})`,
        '➜ `.tcg batas normal` — kembalikan ke angka biasa'
      ] : [])
    ].filter(x => x !== null).join('\n'));
    return true;
  }

  if (!isOwner && !isStoreAdmin) {
    await send(sock, jid, messageObj, '❌ Perintah ini khusus *Admin Toko* atau *Owner*.');
    return true;
  }

  if (['normal', 'reset', 'batal', 'kembali', 'default', '0'].includes(a)) {
    const res = await db.tcgHapusBatasTarikHariIni();
    await send(sock, jid, messageObj, res.adaSebelumnya
      ? `✅ Batas tarikan dikembalikan ke *${res.batas}/hari*.`
      : `ℹ️ Tidak ada pengaturan khusus hari ini. Batas tetap *${res.batas}/hari*.`);
    return true;
  }

  const n = parseInt(a, 10);
  if (!Number.isFinite(n) || n < 1) {
    await send(sock, jid, messageObj,
      `⚠️ Format: \`.tcg batas <angka 1-${db.TCG_BATAS_TARIK_MAKS}>\`\nContoh: \`.tcg batas 50\`\n\n_Kembalikan normal:_ \`.tcg batas normal\``);
    return true;
  }

  const res = await db.tcgSetBatasTarikHariIni(n, pushName || 'Owner');
  if (!res.success) {
    await send(sock, jid, messageObj, res.reason === 'TERLALU_TINGGI'
      ? `⚠️ Maksimal *${res.maks}* tarikan/hari.\n\n_Batas atas ini ada supaya satu salah ketik tidak menguras Keping seluruh grup dalam satu sore._`
      : '⚠️ Angka tidak valid.');
    return true;
  }

  const naik = res.batas > res.normal;
  await send(sock, jid, messageObj, [
    naik ? '🎉 *BATAS GACHA DINAIKKAN HARI INI!*' : '🎚️ *BATAS GACHA DIUBAH HARI INI*',
    '',
    `Tiap pemain sekarang boleh menarik *${res.batas}x* hari ini _(normal ${res.normal}x)_.`,
    '',
    '⏳ *Berlaku hari ini saja.* Besok kembali normal dengan sendirinya —',
    '_aturannya dikunci ke tanggal, jadi tidak ada yang perlu dimatikan._',
    '',
    '_Batalkan lebih awal:_ `.tcg batas normal`'
  ].join('\n'));
  return true;
}

async function tarik(sock, jid, messageObj, key, jumlah) {
  const [sisaHarian, stBatas] = await Promise.all([
    db.tcgSisaTarikanHarian(key),
    db.tcgStatusBatasTarik()
  ]);
  if (sisaHarian < jumlah) {
    await send(sock, jid, messageObj, [
      `⚠️ Jatah tarikan harianmu tinggal *${sisaHarian}* dari *${stBatas.batas}*.`,
      stBatas.dinaikkan
        ? `_Batas hari ini sudah dinaikkan dari ${stBatas.normal} — dan tetap habis. Besok penuh lagi._`
        : 'Batas ini menjaga ekonomi arena tetap adil.'
    ].join('\n'));
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

  // Dua misi berbeda menghitung tarikan (1 kartu dan 3 kartu). Keduanya selalu
  // dilapori; hanya yang sedang jadi misi hari ini yang benar-benar terisi.
  await catatAksi(key, 'GACHA', jumlah);
  await catatAksi(key, 'GACHA3', jumlah);

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
  const res = await db.tcgKlaimHarian(key);
  if (!res.success) {
    const s = await db.tcgGetStreak(key);
    await send(sock, jid, messageObj, [
      '⏳ Hadiah harianmu sudah diambil hari ini.',
      '',
      `🔥 Beruntun: *${s.streak} hari*${s.terpanjang > s.streak ? ` _(rekor ${s.terpanjang})_` : ''}`,
      `➡️ Besok: *+${fmt(db.TCG_BONUS_HARIAN_KEPING + s.bonusBerikutnya)} Keping*` +
        (s.tonggakBerikutnya ? ` · tonggak hari ke-${s.tonggakBerikutnya.hari} tinggal *${s.tonggakBerikutnya.sisa} hari*` : ''),
      '',
      '_Datang lagi setelah jam 00:00 WIB. Lewat satu hari, beruntunmu kembali ke 1._'
    ].join('\n'));
    return true;
  }

  const hasil = await prosesTarikan(key, 1, true);
  await catatAksi(key, 'GACHA', 1);
  await catatAksi(key, 'GACHA3', 1);

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

  // Beruntun ditampilkan sebagai deretan, bukan angka. Angka "7" tidak
  // memberi tahu apa pun; tujuh api yang menyala di sebelah tiga kotak kosong
  // menunjukkan persis di mana pemain berdiri dan seberapa dekat tonggaknya.
  const tonggakDekat = res.tonggakBerikutnya?.hari || 0;
  const petaBeruntun = tonggakDekat
    ? '🔥'.repeat(Math.min(15, res.streak)) + '▫️'.repeat(Math.max(0, Math.min(15, tonggakDekat) - res.streak))
    : '🔥'.repeat(Math.min(15, res.streak));

  const teks = [
    '🎁 *HADIAH HARIAN ARENA TERKLAIM*',
    '',
    hasilTarikan(hasil),
    '',
    res.putus
      ? `💔 Beruntunmu terputus di *${res.streakSebelum} hari* — mulai lagi dari hari ke-1.`
      : `🔥 *BERUNTUN HARI KE-${res.streak}*${res.streak >= res.terpanjang ? ' _(rekor pribadi!)_' : ` _(rekor ${res.terpanjang})_`}`,
    petaBeruntun,
    '',
    `💠 Keping: *+${fmt(res.kepingDapat)}*` +
      (res.bonusStreak > 0 ? ` _(${res.kepingDasar} dasar + ${res.bonusStreak} bonus beruntun)_` : ''),
    ransumTeks,
    res.tonggak
      ? `\n🎊 *TONGGAK HARI KE-${res.tonggak.hari}!*\n   └ ${res.tonggak.teks.join(' · ')}`
      : '',
    '',
    res.picis > 0 ? `🪙 Picis: *+${fmt(res.picis)}*` : '',
    `💰 Saldo: *${fmt(res.kepingTotal)} Keping* · *${fmt(res.picisTotal || 0)} Picis*`,
    '',
    res.tonggakBerikutnya
      ? `➡️ Besok *+${fmt(db.TCG_BONUS_HARIAN_KEPING + res.bonusBesok)} Keping* · tonggak hari ke-${res.tonggakBerikutnya.hari} tinggal *${res.tonggakBerikutnya.sisa} hari*`
      : `➡️ Besok *+${fmt(db.TCG_BONUS_HARIAN_KEPING + res.bonusBesok)} Keping*`,
    '_Lewat satu hari saja, beruntun kembali ke 1._'
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
    // R hanya ditulis kalau sudah di atas 1. Menuliskan `R1` di 60 baris cuma
    // menambah bising di layar yang sudah padat, sementara yang benar-benar
    // dicari pemain adalah kartu mana yang SUDAH ia refine.
    const tandaR = (row.refine || 1) > 1 ? ` · R${row.refine}` : '';
    grup.push(`${tanda}${el.emoji} \`${kartu.id}\` ${kartu.nama}${ekor} · Lv.${row.card_lv}${tandaR} · CP ${fmt(st.cp)}`);
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
    [kartuPenuh(kartu, level, jumlahPunya, punya?.refine || 1), ...barisElemen, '', ...naik].join('\n'));
  return true;
}

/**
 * Layar banner. Seluruh gunanya adalah membuat rate ON dan rate OFF
 * TERLIHAT — pemain tidak boleh perlu menebak apa yang sedang ia kejar,
 * berapa peluangnya, dan apakah jaminannya sedang menyala.
 */
async function tampilBanner(sock, jid, messageObj, key) {
  const hariIni = db.tcgTanggalHariIni();
  const banner = bannerAktif(hariIni);
  const sisa = sisaHariBanner(hariIni);
  const [status, pity, dompet] = await Promise.all([
    db.tcgGetBanner(key, banner.id),
    db.tcgGetPity(key),
    db.tcgGetWallet(key)
  ]);

  const jmlMythic = getKartuByRarity('MYTHIC').length;
  const jmlLegend = getKartuByRarity('LEGENDARY').length;
  const pM = Math.round(BANNER_PELUANG_MYTHIC * 100);
  const pL = Math.round(BANNER_PELUANG_LEGENDARY * 100);

  // Layar ini adalah tempat orang memutuskan mau membakar 1.800 Keping atau
  // tidak. Menyebut nama kartunya saja tidak cukup — tanpa stat, skill, dan
  // status kepemilikan, keputusan itu ditebak, bukan diambil.
  const kartuBanner = [banner.mythic, ...banner.legendary];
  const punyaSemua = await Promise.all(kartuBanner.map(k => db.tcgGetKartu(key, k.id)));
  const petaPunya = new Map(kartuBanner.map((k, i) => [k.id, punyaSemua[i]]));

  const barisLengkap = (kartu, bintangTeks, peluangTeks) => {
    const p = petaPunya.get(kartu.id);
    const s = statKartu(kartu, p?.card_lv || 1);
    const sk = SKILL[kartu.skill];
    return [
      `${ELEMEN[kartu.elemen].emoji} *${kartu.nama}* ${bintangTeks} _(${costKartu(kartu)}★)_`,
      kartu.gelar ? `     _${kartu.gelar}_` : null,
      `     ATK *${fmt(s.atk)}* · HP *${fmt(s.hp)}* · KRIT *${persen(s.kritis)}* · CP *${fmt(s.cp)}*`,
      sk ? `     ⚡ ${sk.nama} — ${ringkasEfekSkill(kartu, p?.refine || 1)}` : null,
      p && p.qty > 0
        ? `     ✅ Punya *${p.qty}* · Lv.${p.card_lv}/${MAKS_LEVEL} · R${p.refine || 1}/${db.TCG_MAKS_REFINE}`
        : '     ⬜ *Belum kamu punya*',
      peluangTeks
    ].filter(x => x !== null);
  };

  const teks = [
    `🎴 *BANNER: ${banner.nama.toUpperCase()}*`,
    `   _${banner.mulai} — ${banner.selesai}_`,
    sisa <= 2 ? `   ⏳ *Tinggal ${sisa} hari lagi!*` : `   ⏳ Sisa *${sisa} hari*`,
    '',
    '⬆️ *RATE ON* — peluang dinaikkan',
    '',
    ...barisLengkap(banner.mythic, '⭐⭐⭐⭐⭐', `     ➜ *${pM}%* dari setiap Mythic yang keluar`),
    '',
    ...banner.legendary.flatMap(k => [...barisLengkap(k, '⭐⭐⭐⭐', null), '']),
    `_Kedua Legendary di atas berbagi *${pL}%* dari tiap Legendary yang keluar._`,
    '',
    `_Stat ditampilkan di level kartumu sendiri; yang belum kamu punya di Lv.1._`,
    '',
    '⬇️ *RATE OFF* — tetap bisa keluar, tidak dinaikkan',
    `   ${jmlMythic - 1} Mythic lain  ·  ${jmlLegend - banner.legendary.length} Legendary lain`,
    '   _Semua Epic, Rare, dan Common tetap rata seperti biasa._',
    '',
    '🎯 *JAMINAN 50/50*',
    status.kalah_mythic
      ? `   ✅ *AKTIF* — Mythic berikutmu DIJAMIN ${banner.mythic.nama}.`
      : `   ⚪ Belum aktif — Mythic berikutmu ${pM}% ${banner.mythic.nama}.`,
    status.kalah_mythic
      ? null
      : '   _Kalau meleset, yang berikutnya otomatis dijamin._',
    status.kalah_legendary
      ? '   ✅ Legendary berikutmu dijamin kartu unggulan.'
      : null,
    '',
    `📊 *Di banner ini kamu sudah:* ${status.tarikan} tarikan` +
      (status.dapat_mythic ? ` · ${status.dapat_mythic}× Mythic unggulan` : ''),
    `🎲 Menuju jaminan Mythic: *${Math.max(0, PITY_MYTHIC_KERAS - (pity?.sejak_mythic || 0))}* tarikan lagi` +
      ((pity?.sejak_mythic || 0) >= PITY_MYTHIC_LUNAK ? '  🔥 _soft pity aktif_' : ''),
    `💠 Biaya: *${fmt(db.TCG_HARGA_TARIK)}* / tarikan  ·  *${fmt(db.TCG_HARGA_TARIK10)}* untuk 10x`,
    `👛 Saldomu: *${fmt(dompet.keping)} Keping* — cukup untuk *${Math.floor(dompet.keping / db.TCG_HARGA_TARIK)}* tarikan`,
    '',
    '_Banner berganti tiap 14 hari. Jaminan TIDAK terbawa ke banner berikutnya,_',
    '_tapi kemajuan pity Mythic-mu tetap utuh._',
    '',
    '➜ `.tcg gacha`  ·  `.tcg gacha10`  ·  `.tcg rate`'
  ].filter(x => x !== null).join('\n');

  const gambar = await bufferBanyakKartu([banner.mythic, ...banner.legendary]).catch(() => null);
  if (gambar) await kirimGambar(sock, jid, messageObj, gambar, teks);
  else await send(sock, jid, messageObj, teks);
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
    `Jatah tarikan hari ini: *${await db.tcgSisaTarikanHarian(key)}/${(await db.tcgStatusBatasTarik()).batas}*` +
      ((await db.tcgStatusBatasTarik()).dinaikkan ? '  ⬆️ _dinaikkan hari ini!_' : ''),
    '',
    '🎴 _Peluang di atas berlaku untuk RARITY. Kartu MANA yang keluar ditentukan_',
    '_banner yang sedang tayang —_ `.tcg banner`'
  ].filter(Boolean).join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

async function tampilKeping(sock, jid, messageObj, key) {
  const w = await db.tcgGetWallet(key);
  const teks = [
    '👛 *DOMPET ARENA*',
    '',
    `💠 *${fmt(w.keping)} Keping*  — untuk gacha`,
    `   _setara ${Math.floor(w.keping / db.TCG_HARGA_TARIK)} tarikan_`,
    '',
    `🪙 *${fmt(w.picis || 0)} Picis*  — untuk menaikkan level`,
    `   _cukup untuk ${Math.floor((w.picis || 0) / db.TCG_BIAYA_LEVEL_PICIS)}x biaya level Common Lv.1_`,
    '',
    '_Dua kantong terpisah dan tidak bisa ditukar._',
    '💠 Keping: Daily, Spar, Ekspedisi, Gerbang, Menara, Jual Duplikat, Duel.',
    '🪙 Picis: Gerbang dan Ekspedisi.',
    '',
    '_Dipisah supaya menaikkan level tidak lagi berebut dompet dengan gacha —',
    '_selama keduanya satu kantong, gacha selalu menang dan kartu tidak pernah naik._'
  ].join('\n');
  await send(sock, jid, messageObj, teks);
  return true;
}

/**
 * Menyisipkan duplikat untuk menaikkan R (R1-R5).
 *
 * R menaikkan ANGKA SKILL kartu, tidak pernah ATK atau HP — lihat catatan
 * panjang di atas `skillEfektif` di cards.js untuk alasannya.
 */
async function refineKartu(sock, jid, messageObj, key, kueri) {
  if (!kueri) {
    const koleksi = await db.tcgGetKoleksi(key);
    // Yang ditawarkan hanya kartu yang BENAR-BENAR bisa di-refine sekarang.
    // Menawarkan kartu yang duplikatnya sedang bertugas di dek cuma memindah
    // kekecewaan satu langkah ke belakang.
    const siap = koleksi
      .map(r => ({ r, kartu: getKartu(r.card_id) }))
      .filter(x => x.kartu && x.r.qty > 1 && (x.r.refine || 1) < db.TCG_MAKS_REFINE)
      .sort((a, b) => (b.r.qty - a.r.qty) || a.kartu.nama.localeCompare(b.kartu.nama));

    await send(sock, jid, messageObj, [
      '🔧 *REFINE — SISIPKAN DUPLIKAT*',
      '',
      'Duplikat kartu yang sama disisipkan untuk menaikkan *R*.',
      'Yang naik adalah *angka skillnya*, bukan ATK atau HP.',
      `R1 ➜ R5 menuntut *${db.TCG_MAKS_REFINE - 1} duplikat*, dan efek skill jadi *2x lipat* di R5.`,
      '',
      siap.length
        // Sebelum ini barisnya cuma menyebut R dan jumlah duplikat, jadi pemain
        // harus menebak apa yang ia beli. Membakar duplikat itu permanen, dan
        // keputusan permanen tidak boleh diambil dengan menebak — jadi angka
        // SEBELUM dan SESUDAH ditampilkan berdampingan.
        ? '*Siap di-refine sekarang:*\n\n' + siap.slice(0, 8).map(x => {
            const r = x.r.refine || 1;
            return [
              `• ${ELEMEN[x.kartu.elemen].emoji} *${x.kartu.nama}* (${x.kartu.id})`,
              `   R${r} ➜ *R${r + 1}* · punya ${x.r.qty} keping`,
              `   ${ringkasEfekSkill(x.kartu, r)}`,
              `   ➜ *${ringkasEfekSkill(x.kartu, r + 1)}*`
            ].join('\n');
          }).join('\n\n')
        : '_Belum ada kartu yang punya duplikat berlebih._\n_Duplikat datang dari gacha dan drop grup._',
      '',
      '➜ `.tcg refine <id atau nama>`'
    ].join('\n'));
    return true;
  }

  const cocok = cariKartu(kueri);
  if (!cocok.length) {
    await send(sock, jid, messageObj, `❌ Kartu *${kueri}* tidak ditemukan.`);
    return true;
  }
  if (cocok.length > 1) {
    await send(sock, jid, messageObj,
      `🔎 Ada ${cocok.length} kartu cocok:\n\n${cocok.slice(0, 10).map(k => barisKartu(k)).join('\n')}\n\nPakai ID-nya.`);
    return true;
  }

  const kartu = cocok[0];
  const res = await db.tcgRefineKartu(key, kartu.id);

  if (!res.success) {
    const pesan = {
      TIDAK_PUNYA: `❌ Kamu belum punya *${kartu.nama}*.`,
      SUDAH_MAKS: `✨ *${kartu.nama}* sudah *R${db.TCG_MAKS_REFINE}* — setinggi-tingginya.`,
      GAGAL_BERSAING: '⚠️ Gagal — coba sekali lagi.',
      DUPLIKAT_KURANG: [
        `❌ Duplikat *${kartu.nama}* tidak cukup.`,
        `   Punya *${res.punya}* keping, butuh *${res.butuh}*.`,
        res.bertugas > 0
          ? `   _${res.bertugas} di antaranya sedang bertugas di dek/ekspedisi dan tidak boleh dipakai._`
          : '',
        '',
        '_Refine memakan duplikatnya. Satu keping harus selalu tersisa._'
      ].filter(Boolean).join('\n')
    }[res.reason] || `⚠️ Gagal: ${res.reason}`;
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const sk = SKILL[kartu.skill];
  await send(sock, jid, messageObj, [
    `🔧 *${kartu.nama}* ➜ *R${res.refineBaru}*`,
    '',
    sk ? `⚡ *${sk.nama}*` : null,
    sk ? `   ${ringkasEfekSkill(kartu, res.refineBaru - 1)}` : null,
    sk ? `   ➜ *${ringkasEfekSkill(kartu, res.refineBaru)}*` : null,
    '',
    `Sisa keping ${kartu.nama}: *${res.sisaKeping}*`,
    res.refineBaru >= db.TCG_MAKS_REFINE
      ? '✨ _Sudah setinggi-tingginya._'
      : `_1 duplikat lagi ➜ R${res.refineBaru + 1}: ${ringkasEfekSkill(kartu, res.refineBaru + 1)}_`
  ].filter(x => x !== null).join('\n'));
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
        // R ikut ditulis, dan skillnya ditampilkan dengan ANGKA yang benar-benar
        // berlaku di R itu — bukan sekadar namanya. Sebelumnya layar ini cuma
        // menyebut `Skill: Gerhana`, jadi pemain yang sudah menaikkan kartunya ke
        // R4 tidak punya satu pun cara melihat bahwa pukulan pertamanya sekarang
        // +105% dan bukan +60%.
        const r = slotData.refine || 1;
        const tandaR = r > 1 ? ` · R${r}` : '';
        baris.push(
          `*Slot ${s}:* ${el.emoji} *${kartu.nama}* (Lv.${st.level}${tandaR}) — ${bintang(kartu.rarity)} (${cost}★) ${getPeran(kartu).emoji}\n` +
          `   └ ATK ${fmt(st.atk)} · HP ${fmt(st.hp)} · KRIT ${persen(st.kritis)} · CP ${fmt(st.cp)}` +
          `${kartu.skill ? `\n   └ ⚡ ${SKILL[kartu.skill].nama}: ${ringkasEfekSkill(kartu, r)}` : ''}`
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
      SALINAN_TIDAK_CUKUP: `⚠️ Salinan *${kartu.nama}* tidak cukup (${res.punya || 0} punya, ${res.dipakai || 0} di slot lain, ${res.ekspedisi || 0} di ekspedisi).\n\nTarik salinan baru atau lepas dulu dari slot/ekspedisi lain.`,
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

/**
 * Melepas kartu dari slot dek.
 *
 * `semua` ditambahkan karena log produksi menunjukkan pemain mengetik
 * `.tcg lepas semua`, ditolak, lalu terpaksa mengirim TIGA pesan berturut-turut
 * (lepas 1, lepas 2, lepas 3) untuk maksud yang sama. Kata itu bukan tebakan
 * liar: bot sendiri yang mengajarkannya lewat `.tcg serpihsemua` dan
 * `.tcg jualsemua`, jadi pemain hanya menggeneralisasi pola yang kita
 * perkenalkan sendiri.
 *
 * Aman tanpa konfirmasi: melepas tidak menghapus kartu apa pun dari koleksi,
 * dan `.tcg autodek` mengembalikan dek dalam satu ketikan. Bandingkan dengan
 * `.tcg jualsemua` yang memang menghancurkan kartu dan karena itu memeriksa
 * rarity dengan ketat.
 */
async function lepasDek(sock, jid, messageObj, key, slotArg) {
  const arg = String(slotArg || '').toLowerCase().trim();

  if (['semua', 'all', 'semuanya', 'kosong', 'kosongkan', 'reset'].includes(arg)) {
    const dekLama = await db.tcgGetDeck(key);
    const terisi = [1, 2, 3].filter(s => dekLama[s]);
    if (!terisi.length) {
      await send(sock, jid, messageObj, '📭 Dekmu memang sudah kosong.');
      return true;
    }
    for (const s of terisi) await db.tcgClearDeckSlot(key, s);
    const nama = terisi
      .map(s => getKartu(dekLama[s].card_id))
      .filter(Boolean)
      .map(k => `${ELEMEN[k.elemen].emoji} ${k.nama}`)
      .join(', ');
    await send(sock, jid, messageObj, [
      `✅ *${terisi.length} slot dikosongkan.*`,
      nama ? `   ${nama}` : '',
      '',
      '_Kartunya tetap di koleksimu — melepas tidak pernah menghapus apa pun._',
      '➜ Susun ulang cepat: `.tcg autodek`'
    ].filter(Boolean).join('\n'));
    return true;
  }

  const slot = parseInt(slotArg, 10);
  if (![1, 2, 3].includes(slot)) {
    await send(sock, jid, messageObj, '⚠️ Format: `.tcg lepas <slot 1-3>`\nContoh: `.tcg lepas 2`\n\n_Mau mengosongkan semuanya sekaligus? Ketik_ `.tcg lepas semua`');
    return true;
  }
  await db.tcgClearDeckSlot(key, slot);
  await send(sock, jid, messageObj, `✅ Kartu di *Slot ${slot}* berhasil dilepas.`);
  return true;
}

/**
 * Nama elemen yang diketik pemain -> kunci ELEMEN.
 *
 * Ditulis longgar dengan sengaja: pemain mengetik "gelap", "listrik", "water",
 * dan semuanya berarti hal yang jelas. Menolak semua itu demi lima kata baku
 * cuma menambah pesan error, bukan menambah kejelasan.
 */
function normalisasiElemen(teks) {
  const t = String(teks || '').toUpperCase().trim();
  const peta = {
    API: 'API', FIRE: 'API', APIAPI: 'API',
    AIR: 'AIR', WATER: 'AIR', LAUT: 'AIR',
    ANGIN: 'ANGIN', WIND: 'ANGIN', UDARA: 'ANGIN',
    PETIR: 'PETIR', LISTRIK: 'PETIR', THUNDER: 'PETIR', ELECTRIC: 'PETIR',
    DARK: 'DARK', GELAP: 'DARK', KEGELAPAN: 'DARK', KELAM: 'DARK'
  };
  return peta[t] || null;
}

async function pasangAutoDek(sock, jid, messageObj, key, sasaranArg) {
  const arg = String(sasaranArg || '').toLowerCase().trim();
  const opsi = {};
  let judulSasaran = '';

  if (['abadi', 'lantai', 'menaraabadi'].includes(arg)) {
    // Menyusun dek untuk lantai Abadi berikutnya: elemen penjaganya jadi
    // sasaran counter, dan syarat modifier lantai itu ikut dipatuhi. Ini yang
    // membuat autodek tetap berguna sesudah modifier ada — tanpa ini pemain
    // harus menyusun ulang dek secara manual tiap lantai.
    const abadi = await db.tcgGetAbadi(key);
    const lantai = dekAbadi(abadi.berikutnya);
    const mod = modifierAbadi(abadi.berikutnya);
    opsi.lawanElemen = lantai.elemen;
    if (mod?.efek?.batasBintang) opsi.batasBintang = mod.efek.batasBintang;
    if (mod?.efek?.laranganElemen) opsi.laranganElemen = mod.efek.laranganElemen;
    if (mod?.efek?.wajibElemen) opsi.wajibElemen = mod.efek.wajibElemen;
    judulSasaran = `Lantai Abadi ${abadi.berikutnya}` + (mod ? ` · ${mod.emoji} ${mod.nama}` : '');
  } else if (arg) {
    const el = normalisasiElemen(arg);
    if (!el) {
      await send(sock, jid, messageObj, [
        '⚠️ Sasaran tidak dikenal.',
        '',
        'Contoh yang benar:',
        '› `.tcg autodek` — dek terkuat apa adanya',
        '› `.tcg autodek api` — dek yang unggul melawan Api',
        '› `.tcg autodek abadi` — dek untuk lantai Abadi berikutnya',
        '',
        `_Elemen: ${Object.keys(ELEMEN).map(e => ELEMEN[e].emoji + ' ' + ELEMEN[e].nama).join(' · ')}_`
      ].join('\n'));
      return true;
    }
    opsi.lawanElemen = el;
    judulSasaran = `Melawan ${ELEMEN[el].emoji} ${ELEMEN[el].nama}`;
  }

  const res = await db.tcgAutoBuildDeck(key, opsi);
  if (!res.success) {
    const pesan = {
      KOLEKSI_KOSONG: '📭 Kamu belum memiliki kartu monster apapun.\nKetik `.tcg gacha` atau `.tcg daily` untuk mendapatkan kartu!',
      SEMUA_KARTU_EKSPEDISI: '🧭 Semua kartumu sedang pergi ekspedisi. Tunggu mereka kembali atau klaim terlebih dahulu.',
      KARTU_TERSISA_HABIS: '🔒 Semua kartumu sudah terkunci di tahap Gauntlet sebelumnya.',
      TIDAK_DAPAT_DISUSUN: opsi.laranganElemen || opsi.wajibElemen || opsi.batasBintang
        ? '⚠️ Koleksimu belum bisa memenuhi syarat lantai ini.\n\n_Modifier lantai membatasi elemen atau biaya bintang — kumpulkan kartu yang cocok dulu, atau naik lewat lantai lain._'
        : '⚠️ Tidak dapat menyusun dek otomatis dari koleksi yang tersedia saat ini.'
    }[res.reason] || '❌ Gagal menyusun dek otomatis.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const slotTeks = res.deck.map(c => {
    const el = ELEMEN[c.elemen] || { emoji: '✨' };
    const rLabel = STAT_RARITY[c.rarity]?.label || c.rarity;
    return `*Slot ${c.slot}:* ${el.emoji} *${c.nama}* (Lv.${c.level}) [${rLabel}]\n   └ ⭐ ${c.cost}★ · ⚡ Power: ${fmt(c.power)}`;
  });

  const sinergi = hitungSinergi(res.deck.map(d => getKartu(d.card_id)));
  const sinergiTeks = sinergi?.aktif?.length > 0
    ? sinergi.aktif.map(s => `• ${s.emoji} *${s.nama}:* ${s.syarat}`).join('\n')
    : '_Tidak ada sinergi elemen khusus._';

  const syarat = [
    opsi.batasBintang ? `anggaran ${opsi.batasBintang}★` : '',
    opsi.laranganElemen ? `tanpa ${ELEMEN[opsi.laranganElemen].nama}` : '',
    opsi.wajibElemen ? `wajib ${ELEMEN[opsi.wajibElemen].nama}` : ''
  ].filter(Boolean).join(' · ');

  const teks = [
    '🤖 *PEMASANGAN DEK OTOMATIS CERDAS* 🎴',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    judulSasaran ? `🎯 Sasaran: *${judulSasaran}*` : null,
    syarat ? `📋 Syarat dipatuhi: _${syarat}_` : null,
    judulSasaran || syarat ? '' : null,
    opsi.lawanElemen
      ? `Dek disusun untuk UNGGUL melawan ${ELEMEN[opsi.lawanElemen].emoji} *${ELEMEN[opsi.lawanElemen].nama}*, bukan sekadar yang paling kuat:`
      : 'Bot telah menganalisis koleksimu dan memasang 3 kartu terbaik dengan total daya tempur tertinggi:',
    '',
    ...slotTeks,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `⭐ Total Biaya Bintang: *${res.totalCost}/${res.maxCost}★*`,
    `⚔️ Total Estimasi Power: *${fmt(res.totalPower)}*`,
    '',
    '🌀 *SINERGI TIM AKTIF:*',
    sinergiTeks,
    '',
    '_Gunakan `.tcg spar` atau `.tcg menara` untuk menguji dek barumu!_'
  ].filter(b => b !== null).join('\n');

  await send(sock, jid, messageObj, teks);
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
    const rincian = (res.rincian || []).map(r => `• ${r.nama} — *+${fmt(r.hadiah)}*`).join('\n');
    await send(sock, jid, messageObj, [
      '🎯 *HADIAH MISI TERKLAIM*',
      '',
      rincian,
      '',
      `💠 Total: *+${fmt(res.total)} Keping* (Saldo: *${fmt(res.kepingTotal)}*)`
    ].join('\n'));
    return true;
  }

  const [misi, mingguan, streak] = await Promise.all([
    db.tcgGetMisi(key),
    db.tcgGetMisiMingguan(key),
    db.tcgGetStreak(key)
  ]);

  const baris = misi.daftar.map(m => {
    const tanda = m.diklaim ? '✅' : (m.selesai ? '🎁' : '⬜');
    return `${tanda} ${m.emoji} *${m.nama}*\n   └ ${Math.min(m.progres, m.target)}/${m.target} · hadiah *${fmt(m.hadiah)} Keping*`;
  });

  const bonusTanda = misi.bonusDiklaim ? '✅' : (misi.bonusSiap ? '🎁' : '⬜');

  const teks = [
    '🎯 *MISI HARIAN ARENA*',
    `Diundi ulang tiap hari jam 00:00 WIB · hari ini: ${misi.tanggal}`,
    '',
    ...baris,
    '',
    `${bonusTanda} 🏅 *Bonus Tuntas* — selesaikan ${db.TCG_MISI_BONUS_AMBANG} dari ${misi.daftar.length} misi`,
    `   └ ${misi.jumlahSelesai}/${db.TCG_MISI_BONUS_AMBANG} · hadiah *${fmt(db.TCG_MISI_BONUS_KEPING)} Keping*`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    misi.kepingSiapKlaim > 0
      ? `💠 Siap diklaim: *${fmt(misi.kepingSiapKlaim)} Keping* — ketik \`.tcg misi klaim\``
      : '_Belum ada yang bisa diklaim. Main dulu!_',
    '',
    `📆 Misi mingguan: *${mingguan.jumlahSelesai}/${mingguan.daftar.length}* selesai${mingguan.adaKlaim ? ' — *ada hadiah siap!*' : ''} · \`.tcg mingguan\``,
    streak.sudahKlaimHariIni
      ? `🔥 Beruntun harian: *${streak.streak} hari* — aman untuk hari ini.`
      : '🎁 Hadiah harian belum diambil — `.tcg daily`',
    '',
    '_Misi harian diacak dari kolam besar, jadi isinya berbeda tiap hari dan tiap orang._'
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

  const res = await db.tcgAmbilKartuDrop(drop.id, key, nomor);
  if (!res.success) {
    const pesan = {
      DROP_TIDAK_AKTIF: '💨 Dropnya sudah selesai.',
      KEDALUWARSA: '⏰ Terlambat — waktu dropnya sudah habis.',
      NOMOR_TIDAK_VALID: `⚠️ Nomor kartu cuma 1 sampai ${res.jumlah}.`,
      SUDAH_AMBIL: `🖐️ Kamu sudah mengambil kartu nomor *${res.idxSebelumnya || nomor}* dari drop ini. Satu orang satu kartu.`,
      SUDAH_DIAMBIL_ORANG: '😔 Kartu itu keburu disambar orang lain. Coba nomor yang lain!'
    }[res.reason] || '❌ Gagal mengambil kartu.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const kartu = getKartu(res.cardId);
  await catatAksi(key, 'AMBIL', 1);

  const el = ELEMEN[kartu.elemen];
  const baru = res.baru;
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
    const [rank, sisaRank] = await Promise.all([
      db.tcgGetRank(key, { umumkan: true }),
      db.tcgSisaSparBerperingkat(key)
    ]);
    const teks = [
      '🥊 *SPARRING ARENA*',
      'Latih tanding melawan bayangan dek pemain lain. *Tidak memakai energi.*',
      '',
      `Hari ini: *${status.totalMain}* pertandingan`,
      `Jatah hadiah penuh: *${status.sisaJatahPenuh}/${db.TCG_SPAR_JATAH_PENUH}* tersisa`,
      `Hadiah menang berikutnya: *${fmt(status.hadiahBerikutnya)} Keping*`,
      '',
      `${rank.tier.emoji} Peringkat: *${fmt(rank.poin)}* poin · sparring berperingkat tersisa *${sisaRank}/${db.TCG_RANK_MAKS_SPAR}*`,
      '',
      `_Sesudah jatah habis, hadiah turun jadi ${Math.round(db.TCG_SPAR_RASIO_SISA * 100)}% — sparring tetap boleh, tapi tidak lagi jadi mesin uang._`,
      `_Pemilik dek yang berhasil menahanmu ikut dapat *${db.TCG_SPAR_HADIAH_BERTAHAN} Keping*._`,
      '',
      '➜ Ketik `.tcg spar lawan` untuk mulai.',
      teksHadiahMusim(rank.hadiahMusimLalu)
    ].filter(Boolean).join('\n');
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

  await catatAksi(key, 'SPAR_MAIN', 1);
  if (menang) await catatAksi(key, 'SPAR', 1);

  // Sparring ikut menggerakkan peringkat, tapi dengan bobot separuh duel dan
  // hanya untuk beberapa laga pertama tiap hari.
  //
  // Lawannya cuma BAYANGAN dek — orangnya sendiri tidak sedang bermain, jadi
  // poinnya tidak boleh ikut turun; ratingnya hanya dipakai sebagai acuan
  // kekuatan. Kalau bayangan ikut kehilangan poin, pemain aktif bisa menjatuhkan
  // peringkat orang lain tanpa orang itu pernah menekan satu tombol pun.
  let rankTeks = '';
  try {
    const sisaRank = await db.tcgSisaSparBerperingkat(key);
    if (sisaRank > 0) {
      const acuan = lawanJid ? (await db.tcgGetRank(lawanJid)).poin : db.TCG_POIN_AWAL;
      const laga = await db.tcgCatatLaga(key, menang ? 1 : (sim.matchWinner === 2 ? 0 : 0.5), {
        k: db.TCG_K_SPAR,
        poinLawanTetap: acuan
      });
      await db.tcgPakaiSparBerperingkat(key);
      if (laga?.berperingkat) {
        const tanda = laga.delta >= 0 ? '+' : '';
        rankTeks = `${laga.tier.emoji} Peringkat: *${fmt(laga.poin)}* _(${tanda}${laga.delta})_` +
          (laga.naikTier ? `\n🎊 *NAIK TIER: ${labelTier(laga.tier)}!*` : '') +
          (laga.turunTier ? `\n📉 _Turun ke ${labelTier(laga.tier)}._` : '');
      }
    } else {
      rankTeks = `_Sparring berperingkat hari ini sudah habis (${db.TCG_RANK_MAKS_SPAR}/hari) — laga ini tidak mengubah poin._`;
    }
  } catch (e) {
    console.error('[TCG] Gagal mencatat peringkat sparring:', e?.message || e);
  }

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
    rankTeks,
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
    await catatAksi(key, 'PANEN', (res.rincian || []).length || 1);

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
      `💠 Total: *+${fmt(res.totalKeping)} Keping* (Saldo: *${fmt(res.kepingTotal)}*)`,
      res.totalPicis > 0
        ? `🪙 Picis: *+${fmt(res.totalPicis)}* — untuk menaikkan level`
        : ''
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
    if (res.success) await catatAksi(key, 'EKSPEDISI', 1);
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
    await catatAksi(key, 'GERBANG', 1);
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
      // Dek penjaga sengaja dibuka sebelum bertarung. Sebelumnya lantai ini
      // rahasia, jadi counter elemen mustahil dan pemain baru tahu lawannya
      // SESUDAH staminanya terpakai — itu menghukum tanpa mengajari.
      targetFloor <= totalLantai
        ? [
            `*Tantangan berikutnya:* Lantai ${targetFloor} — _${nextInfo?.nama || 'Monster Penjaga'}_`,
            ...ringkasPenjaga(nextInfo?.deck || {}),
            saranCounter(nextInfo?.deck || {})
              ? `   └ 💡 Unggul melawan mereka: ${saranCounter(nextInfo.deck)}`
              : '',
            `   └ 🎁 Hadiah: +${fmt(nextInfo?.rewardKeping || 0)} Keping` +
              (nextInfo?.rewardShards ? ` · +${nextInfo.rewardShards.jumlah} Serpihan ${STAT_RARITY[nextInfo.rewardShards.rarity].label}` : '')
          ].filter(Boolean).join('\n')
        : `🎉 *Kamu telah menaklukkan seluruh ${totalLantai} lantai Menara Penjaga!*\n` +
          '🌌 Lanjutkan ke *Menara Abadi* — lantai tanpa ujung: `.tcg abadi`',
      '',
      targetFloor <= totalLantai ? 'Ketik `.tcg menara lawan` untuk menantang.' : '',
      '_Menara memakai stamina Menara — terpisah dari energi Gerbang._'
    ].filter(Boolean).join('\n');
    await send(sock, jid, messageObj, teks);
    return true;
  }

  if (targetFloor > totalLantai) {
    await send(sock, jid, messageObj, [
      `👑 Selamat! Kamu sudah menamatkan seluruh ${totalLantai} lantai Menara Penjaga.`,
      '',
      '🌌 Petualanganmu belum selesai: *Menara Abadi* tidak punya puncak.',
      'Ketik `.tcg abadi` untuk melihat lantai berikutnya.'
    ].join('\n'));
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

    await catatAksi(key, 'MENARA', 1);

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

  // Saran counter lantai ini — kekalahan harus mengajari sesuatu, bukan sekadar
  // mengurangi stamina. Memakai `saranCounter` yang sama dengan layar pratinjau:
  // dulu di sini ada salinan rumusnya sendiri, dan salinan itu ikut mewarisi
  // cacat "union tanpa bobot" yang membuat sarannya sering justru merugikan.
  const saran = saranCounter(floorData.deck);

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
    saran ? `💡 _Penjaga lantai ini ber-elemen ${elemenDek(floorData.deck).map(e => ELEMEN[e].nama).join('/')}. Coba bawa: ${saran}._` : '',
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

  // Tier kedua pihak ditampilkan supaya yang ditantang tahu ia sedang dipanggil
  // oleh siapa. Duel sekarang menggeser poin musim, jadi menerima tantangan dari
  // orang yang jauh lebih tinggi bukan lagi keputusan tanpa akibat.
  const [rankA, rankB] = await Promise.all([
    db.tcgGetRank(senderKey),
    db.tcgGetRank(targetKey)
  ]);

  const betInfo = bet > 0 ? `💰 Taruhan: *${fmt(bet)} Keping*` : '🤝 Duel Persahabatan (Tanpa Taruhan)';
  const teks = [
    '⚔️ *TANTANGAN DUEL ARENA KARTU 3V3!*',
    `👤 Penantang: *${challengerName}* _(dek ${biaya}/${db.TCG_MAX_DECK_COST}★)_`,
    `   └ ${labelTier(rankA.tier)} · ${fmt(rankA.poin)} poin`,
    `🎯 Sasaran: ${targetName}`,
    `   └ ${labelTier(rankB.tier)} · ${fmt(rankB.poin)} poin`,
    betInfo,
    '',
    `👉 ${targetName}, ketik \`.tcg gas\` untuk menerima, atau \`.tcg tolak\`!`,
    '_Tantangan otomatis kedaluwarsa dalam 90 detik._',
    '_Duel ini berperingkat — poin musim kedua pihak akan bergerak._'
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

    const spendA = await db.tcgSpendKeping(duel.challengerKey, duel.bet, 'DUEL_BET', `vs ${duel.targetKey}`);
    if (!spendA?.success) {
      await send(sock, jid, messageObj, `❌ Duel batal: Gagal memotong Keping penantang (${duel.challengerName}).`);
      return true;
    }
    const spendB = await db.tcgSpendKeping(duel.targetKey, duel.bet, 'DUEL_BET', `vs ${duel.challengerKey}`);
    if (!spendB?.success) {
      await db.tcgAddKeping(duel.challengerKey, duel.bet, 'DUEL_REFUND');
      await send(sock, jid, messageObj, `❌ Duel batal: Gagal memotong Keping kamu.`);
      return true;
    }
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
  if (sim.matchWinner === 1) await catatAksi(duel.challengerKey, 'DUEL', 1);
  else if (sim.matchWinner === 2) await catatAksi(duel.targetKey, 'DUEL', 1);

  // Peringkat musiman. Elo dihitung dari sudut penantang; poin sasaran bergerak
  // berlawanan dengan besar yang sama, jadi duel tidak pernah mencetak poin baru
  // ke dalam sistem — ia hanya memindahkannya.
  let rankTeks = '';
  try {
    const laga = await db.tcgCatatLaga(
      duel.challengerKey,
      sim.matchWinner === 1 ? 1 : (sim.matchWinner === 2 ? 0 : 0.5),
      { k: db.TCG_K_DUEL, lawanJid: duel.targetKey }
    );
    if (laga?.berperingkat) {
      const tandaA = laga.delta >= 0 ? '+' : '';
      const tandaB = laga.lawan.delta >= 0 ? '+' : '';
      rankTeks = [
        '',
        '📊 *PERINGKAT MUSIM*',
        `${laga.tier.emoji} ${duel.challengerName}: *${fmt(laga.poin)}* _(${tandaA}${laga.delta})_`,
        `${laga.lawan.tier.emoji} ${targetName}: *${fmt(laga.lawan.poin)}* _(${tandaB}${laga.lawan.delta})_`
      ].join('\n');
    } else if (laga?.reason === 'BATAS_PASANGAN') {
      // Batasnya diumumkan, bukan disembunyikan: dua orang yang duel berkali-kali
      // berhak tahu kenapa poinnya berhenti bergerak.
      rankTeks = `\n_📊 Duel ini tidak berperingkat — kalian sudah bertanding ${laga.batas}× hari ini. Poin bergerak lagi besok._`;
    }
  } catch (e) {
    console.error('[TCG] Gagal mencatat peringkat duel:', e?.message || e);
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
    hasilTaruhan,
    rankTeks
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

async function serpihSemuaKartu(sock, jid, messageObj, key, rarityArg) {
  const rarity = rarityArg ? String(rarityArg).toUpperCase() : null;
  const res = await db.tcgSerpihSemua(key, rarity);
  if (!res.success) {
    const pesan = {
      RARITY_TIDAK_VALID: '⚠️ Rarity tidak valid. Pilih: `common`, `rare`, `epic`, `legendary`, `mythic`, atau `semua`.\nContoh: `.tcg serpihsemua common`',
      TIDAK_ADA_DUPLIKAT: '📭 Kamu tidak memiliki kartu duplikat untuk dipecah.',
      TIDAK_ADA_DUPLIKAT_BEBAS: '🛡️ Semua duplikat kartumu sedang terpasang di Dek atau bertugas di Ekspedisi sehingga tidak bisa dipecah.'
    }[res.reason] || '❌ Gagal memecah kartu massal.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const baris = Object.entries(res.dapatSerpih).map(([r, jml]) => {
    const lbl = STAT_RARITY[r]?.label || r;
    return `• *${lbl}:* +${jml} Serpihan`;
  });

  const teks = [
    '✦ *PEMBERSIHAN KARTU MASSAL (SALVAGE)* ✦',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📦 Total Kartu Dipecah: *${res.totalDiproses} Kartu* (${res.totalKartuUnik} Jenis)`,
    '',
    '🎁 *HASIL SERPIHAN DIPEROLEH:*',
    ...baris,
    '',
    '_ℹ️ Seluruh kartu sisa tetap tersimpan aman minimal 1 di koleksimu._',
    'Cek saldo serpihan: `.tcg serpihan`'
  ].join('\n');

  await send(sock, jid, messageObj, teks);
  return true;
}

async function jualSemuaKartu(sock, jid, messageObj, key, rarityArg) {
  const rarity = rarityArg ? String(rarityArg).toUpperCase() : null;
  const res = await db.tcgJualSemua(key, rarity);
  if (!res.success) {
    const pesan = {
      RARITY_TIDAK_VALID: '⚠️ Rarity tidak valid. Pilih: `common`, `rare`, `epic`, `legendary`, `mythic`, atau `semua`.\nContoh: `.tcg jualsemua common`',
      TIDAK_ADA_DUPLIKAT: '📭 Kamu tidak memiliki kartu duplikat untuk dijual.',
      TIDAK_ADA_DUPLIKAT_BEBAS: '🛡️ Semua duplikat kartumu sedang terpasang di Dek atau bertugas di Ekspedisi sehingga tidak bisa dijual.'
    }[res.reason] || '❌ Gagal menjual kartu massal.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  const teks = [
    '💰 *PENJUALAN KARTU MASSAL (BULK SELL)* 💰',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📦 Total Kartu Terjual: *${res.totalDiproses} Kartu* (${res.totalKartuUnik} Jenis)`,
    `💵 Total Keping Didapat: *+${fmt(res.totalKepingDapat)} Keping*`,
    '',
    `💠 Saldo Keping Sekarang: *${fmt(res.sisaKeping)} Keping*`,
    '',
    '_ℹ️ Kartu koleksi minimal 1 & kartu dek/ekspedisi tetap aman tersimpan._'
  ].join('\n');

  await send(sock, jid, messageObj, teks);
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
  await catatAksi(key, 'LEBUR', 1);
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

  const punyaPicis = dompet?.picis || 0;
  const kandidat = koleksi
    .map(r => ({ r, kartu: getKartu(r.card_id) }))
    .filter(x => x.kartu && (x.r.card_lv || 1) < MAKS_LEVEL)
    .map(x => {
      const lv = x.r.card_lv || 1;
      const butuhS = (db.TCG_BIAYA_LEVEL[x.kartu.rarity] || {})[lv] || 0;
      const butuhK = db.tcgBiayaPicisLevel(costKartu(x.kartu), lv);
      const punyaS = serpihan[x.kartu.rarity] || 0;
      const kini = statKartu(x.kartu, lv);
      const nanti = statKartu(x.kartu, lv + 1);
      return {
        kartu: x.kartu, lv, butuhS, butuhK, punyaS,
        naikCp: nanti.cp - kini.cp,
        mampu: punyaS >= butuhS && punyaPicis >= butuhK
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
      punyaPicis < x.butuhK && `${fmt(x.butuhK - punyaPicis)} Picis`
    ].filter(Boolean).join(' & ');
    return `❌ \`${x.kartu.id}\` ${x.kartu.nama} — kurang ${kurang}`;
  });

  const teks = [
    '⬆️ *SIAP NAIK LEVEL*',
    `🪙 ${fmt(punyaPicis)} Picis · ✦ ${db.TCG_RARITY.map(r => `${STAT_RARITY[r].label[0]}${serpihan[r]}`).join(' ')}`,
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
      PICIS_KURANG: `❌ Butuh *${fmt(res.butuhPicis)} Picis* untuk menempa, kamu punya *${fmt(res.punyaPicis)}*.\n\nPicis datang dari \`.tcg gerbang\` dan \`.tcg ekspedisi\` — bukan dari gacha.`
    }[res.reason] || '❌ Gagal menaikkan level.';
    await send(sock, jid, messageObj, pesan);
    return true;
  }

  await catatAksi(key, 'NAIK', 1);

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
    `_Biaya: ${res.biaya} Serpihan + ${fmt(res.biayaPicis)} Picis_`,
    '',
    kartuPenuh(kartu, res.levelBaru, punya.qty, punya.refine || 1),
    '',
    ...(await pratinjauNaik(key, kartu, res.levelBaru))
  ].join('\n');

  await kirimGambar(sock, jid, messageObj, gambar, teks);
  return true;
}

// ============================================================
// ADMIN TOKO / OWNER
// ============================================================

async function targetDariPesan(args, messageObj) {
  const mention = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (mention) return tcgKey(mention);
  const quotedSender = messageObj?.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedSender) return tcgKey(quotedSender);
  const arg = args.find(a => /^\d{7,}$/.test(String(a || '').replace(/[^0-9]/g, '')) );
  if (arg) {
    const res = await db.resolveTargetJid(arg);
    if (res?.ditemukan && res.jid) return tcgKey(res.jid);
    return tcgKey(String(arg).replace(/[^0-9]/g, '') + '@s.whatsapp.net');
  }
  return null;
}

async function adminBeri(sock, jid, messageObj, args, isStoreAdmin, isOwner) {
  if (!isStoreAdmin && !isOwner) {
    await send(sock, jid, messageObj, '❌ Perintah ini khusus *Admin Toko* atau *Owner*.');
    return true;
  }
  const target = await targetDariPesan(args, messageObj);
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
  const target = await targetDariPesan(args, messageObj);
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
  const streak = await db.tcgGetStreak(target);
  const rank = await db.tcgGetRank(target);
  const abadi = await db.tcgGetAbadi(target);
  const potret = await db.tcgPotretPemain(target, TOTAL_KARTU);

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
    `🏰 Menara: Lantai *${tower.highest_floor}/${TOWER_FLOORS.length}*` +
      (abadi.lantai > 0 ? ` · 🌌 Abadi *${abadi.lantai}* (${abadi.percobaan} percobaan)` : ''),
    `${rank.tier.emoji} Peringkat musim ${rank.musim}: *${fmt(rank.poin)}* (${rank.menang}M-${rank.kalah}K-${rank.seri}S)`,
    `🔥 Beruntun: *${streak.streak}* hari (rekor *${streak.terpanjang}*, total klaim ${streak.totalKlaim})`,
    `🤝 Barter selesai: *${potret.barter}* · kartu Lv.5: *${potret.levelMaks}* · Mythic: *${potret.mythic}*`,
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

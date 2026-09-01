/**
 * BANSOS OWNER — pembagian hadiah massal ala surat kompensasi game gacha.
 *
 * Bedanya dengan `.giveaway` yang sudah ada: `.giveaway` cuma membagi Akbar
 * Poin. Bansos membagi apa pun (poin, Keping, energi, ransum, kartu, paket
 * campuran), mencatat riwayatnya, dan mengumumkan ke grup dengan alasan yang
 * kamu tulis sendiri — persis seperti surat "kompensasi maintenance" yang bikin
 * pemain mau membuka game lagi.
 *
 * Tiga aturan yang dipegang:
 *
 * 1. **Owner saja.** Ini mencetak nilai dari udara; tidak boleh ada jalur lain
 *    yang bisa memanggilnya.
 * 2. **Selalu tercatat.** Tiap pembagian masuk `bansos_log` supaya kamu bisa
 *    melihat sendiri berapa banyak yang sudah dicetak — inflasi poin di bot ini
 *    sudah cukup deras tanpa bansos yang tidak terlacak.
 * 3. **Batas per pembagian.** Jumlahnya dipagari supaya salah ketik satu nol
 *    tidak menghancurkan ekonomi grup dalam sekali perintah.
 */

import * as db from '../../database.js';
import { send, randomItem } from './helpers.js';

const BATAS = {
  poin: 25000,
  keping: 5000,
  energi: 5,
  ransum: 10
};

const JEDA_SIAR_MS = 1500;

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('id-ID');
}

/**
 * CURRENT_TIMESTAMP SQLite itu UTC. Owner membaca riwayat ini untuk tahu
 * "tadi jam berapa aku bagi bansos", jadi harus ditampilkan dalam WIB.
 */
function fmtWaktu(nilai) {
  if (!nilai) return '-';
  const t = new Date(String(nilai).replace(' ', 'T') + 'Z');
  if (isNaN(t.getTime())) return String(nilai).slice(0, 16);
  return t.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Penerima bansos: semua member yang sudah `.daftar`, **termasuk owner**.
 *
 * Dulu ini memanggil `getProfileLeaderboard('poin', 500)` — fungsi papan
 * peringkat, yang sengaja menyaring owner dan memotong hasil di 100 baris.
 * Akibatnya owner tidak pernah menerima bansosnya sendiri. Lihat catatan di
 * `getPenerimaBansos()`.
 */
async function daftarPenerima() {
  const rows = await db.getPenerimaBansos(1000);
  return rows.map(r => ({ jid: r.customer_jid, nama: r.customer_nama }));
}

const JENIS = {
  poin: {
    alias: ['poin', 'point', 'points'],
    label: '💰 Akbar Poin',
    satuan: 'Poin',
    perluJumlah: true,
    // addGamePoints: bansos adalah pemberian, bukan kemenangan game.
    // awardGamePoints ikut mencetak XP senilai poin, jadi `.bansos poin 2000`
    // ke 62 orang dulu berarti +20 level serentak untuk semuanya.
    beri: async (jid, jumlah) => { await db.addGamePoints(jid, jumlah); }
  },
  keping: {
    alias: ['keping', 'kepingan', 'coin'],
    label: '💠 Keping Arena',
    satuan: 'Keping',
    perluJumlah: true,
    beri: async (jid, jumlah) => {
      const { tcgAddKeping } = await import('../database/tcgDb.js');
      await tcgAddKeping(jid, jumlah, 'BANSOS');
    }
  },
  energi: {
    alias: ['energi', 'energy', 'stamina'],
    label: '⚡ Energi Arena (Menara + Gerbang)',
    satuan: 'Energi',
    perluJumlah: true,
    beri: async (jid, jumlah) => {
      const { tcgTambahEnergi } = await import('../database/tcgDb.js');
      await tcgTambahEnergi(jid, { menara: jumlah, gerbang: jumlah });
    }
  },
  ransum: {
    alias: ['ransum', 'bekal', 'item'],
    label: '🎒 Ransum Arena',
    satuan: 'Ransum',
    perluJumlah: true,
    beri: async (jid, jumlah) => {
      const { TCG_RANSUM, tcgTambahItem } = await import('../database/tcgDb.js');
      for (let i = 0; i < jumlah; i++) {
        await tcgTambahItem(jid, randomItem(Object.keys(TCG_RANSUM)), 1);
      }
    }
  },
  kartu: {
    alias: ['kartu', 'card'],
    label: '🃏 Kartu Monster',
    satuan: 'Kartu',
    perluRarity: true,
    beri: async (jid, jumlah, rarity) => {
      const { getKartuByRarity } = await import('./tcg/cards.js');
      const { tcgTambahKartu } = await import('../database/tcgDb.js');
      const pool = getKartuByRarity(rarity);
      if (!pool || pool.length === 0) return;
      for (let i = 0; i < jumlah; i++) {
        await tcgTambahKartu(jid, randomItem(pool).id, 1);
      }
    }
  }
};

function cariJenis(teks) {
  const k = String(teks || '').toLowerCase().trim();
  for (const [id, def] of Object.entries(JENIS)) {
    if (id === k || def.alias.includes(k)) return { id, def };
  }
  return null;
}

// ─── PANDUAN ─────────────────────────────────────────────────────────

async function tampilkanPanduan(sock, jid, messageObj) {
  const penerima = await daftarPenerima();
  const riwayat = await db.getBansosLog(5);
  const barisRiwayat = riwayat.length > 0
    ? riwayat.map(r => `   • *${r.jenis}* ${fmt(r.jumlah)} → ${r.penerima} ${satuanPenerima(r.jenis)} _(${fmtWaktu(r.created_at)})_${r.alasan ? `\n     _"${r.alasan}"_` : ''}`).join('\n')
    : '   _Belum ada bansos yang pernah dibagikan._';

  await send(sock, jid, messageObj,
`🎁 *BANSOS OWNER — PEMBAGIAN MASSAL*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *Calon penerima saat ini:* *${penerima.length} member terdaftar*

📋 *FORMAT:*
▫️ \`.bansos poin <jumlah> [alasan]\`
▫️ \`.bansos keping <jumlah> [alasan]\`
▫️ \`.bansos energi <jumlah> [alasan]\` — isi Menara & Gerbang sekaligus
▫️ \`.bansos ransum <jumlah> [alasan]\`
▫️ \`.bansos kartu <rarity> [alasan]\` — common/rare/epic/legendary/mythic
▫️ \`.bansos paket [alasan]\` — 500 Poin + 200 Keping + 2 Ransum + 1 Kartu Rare
▫️ \`.bansos drop\` — jatuhkan kartu gratis di semua grup aktif
▫️ \`.bansos riwayat\` — 15 pembagian terakhir

*Contoh:*
\`.bansos poin 500 Maaf bot sempat down 2 jam\`
\`.bansos paket Selamat 100 member!\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧾 *5 BANSOS TERAKHIR:*
${barisRiwayat}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ *Batas per pembagian:* ${fmt(BATAS.poin)} Poin · ${fmt(BATAS.keping)} Keping · ${BATAS.energi} Energi · ${BATAS.ransum} Ransum.
_Semua pembagian tercatat. Ingat: bunga bank sudah mencetak ~2% per hari — bansos poin menambah tekanan inflasi._`);
  return true;
}

/** Drop kartu jatuh ke GRUP, bansos lain ke orang. */
function satuanPenerima(jenis) {
  return jenis === 'drop' ? 'grup' : 'orang';
}

async function tampilkanRiwayat(sock, jid, messageObj) {
  const rows = await db.getBansosLog(15);
  if (rows.length === 0) {
    await send(sock, jid, messageObj, '🧾 Belum ada bansos yang pernah dibagikan.');
    return true;
  }
  const baris = rows.map((r, i) =>
    `*${i + 1}.* ${r.jenis} — *${fmt(r.jumlah)}* ke *${r.penerima}* ${satuanPenerima(r.jenis)}\n     _${fmtWaktu(r.created_at)}_${r.alasan ? `\n     _"${r.alasan}"_` : ''}`
  ).join('\n');

  await send(sock, jid, messageObj,
    `🧾 *RIWAYAT BANSOS (15 TERAKHIR)*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${baris}`);
  return true;
}

// ─── PENGUMUMAN ──────────────────────────────────────────────────────

function suratBansos({ label, jumlah, satuan, alasan, penerima, rincian }) {
  return `📮 *SURAT BANSOS DARI OWNER* 🎁
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Owner membagikan hadiah ke *seluruh member terdaftar*.

🎁 *Isi:* ${rincian || `*${fmt(jumlah)} ${satuan}* — ${label}`}
👥 *Diterima:* *${penerima} member*
${alasan ? `\n📝 *Pesan Owner:*\n_"${alasan}"_\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Hadiahnya *sudah otomatis masuk* ke akunmu — tidak perlu klaim apa pun.
💡 Cek dengan \`.poin\`, \`.tcg\`, atau \`.tcg ransum\`.`;
}

async function siarkan(sock, teks) {
  let tujuan = [];
  try {
    const { daftarGrupPengumuman } = await import('../utils/startupAnnounce.js');
    const hasil = await daftarGrupPengumuman(sock);
    tujuan = hasil.tujuan;
  } catch (err) {
    console.warn('[BANSOS] Gagal mengambil daftar grup:', err.message);
    return 0;
  }

  let sukses = 0;
  for (const gjid of tujuan) {
    try {
      await sock.sendMessage(gjid, { text: teks });
      sukses++;
    } catch (err) {
      console.warn(`[BANSOS] Gagal kirim ke ${gjid}:`, err.message);
    }
    await new Promise(r => setTimeout(r, JEDA_SIAR_MS));
  }
  return sukses;
}

// ─── EKSEKUSI ────────────────────────────────────────────────────────

async function bagikan(sock, jid, messageObj, { jenisId, def, jumlah, rarity, alasan, rincian }) {
  const penerima = await daftarPenerima();
  if (penerima.length === 0) {
    await send(sock, jid, messageObj, '⚠️ Belum ada member terdaftar yang bisa menerima bansos.');
    return true;
  }

  await send(sock, jid, messageObj,
    `⏳ Membagikan *${rincian || `${fmt(jumlah)} ${def.satuan}`}* ke *${penerima.length} member*…`);

  let berhasil = 0;
  for (const orang of penerima) {
    try {
      await def.beri(orang.jid, jumlah, rarity);
      berhasil++;
    } catch (err) {
      console.warn(`[BANSOS] Gagal ke ${orang.jid}:`, err.message);
    }
  }

  await db.catatBansos({
    jenis: jenisId, jumlah, penerima: berhasil, alasan: alasan || null
  });

  const teksSurat = suratBansos({
    label: def.label, jumlah, satuan: def.satuan, alasan, penerima: berhasil, rincian
  });
  const grup = await siarkan(sock, teksSurat);

  await send(sock, jid, messageObj,
`✅ *BANSOS SELESAI DIBAGIKAN*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎁 *Isi:* ${rincian || `${fmt(jumlah)} ${def.satuan} (${def.label})`}
👥 *Berhasil ke:* *${berhasil}/${penerima.length} member*
📢 *Diumumkan ke:* *${grup} grup*
${alasan ? `📝 *Alasan:* _"${alasan}"_` : ''}

_Tercatat di_ \`.bansos riwayat\`.`);
  return true;
}

// ─── PAKET & DROP ────────────────────────────────────────────────────

async function bagikanPaket(sock, jid, messageObj, alasan) {
  const penerima = await daftarPenerima();
  if (penerima.length === 0) {
    await send(sock, jid, messageObj, '⚠️ Belum ada member terdaftar yang bisa menerima bansos.');
    return true;
  }

  const rincian = '*500 Poin* + *200 Keping* + *2 Ransum* + *1 Kartu Rare*';
  await send(sock, jid, messageObj, `⏳ Membagikan paket bansos ke *${penerima.length} member*…`);

  let berhasil = 0;
  for (const orang of penerima) {
    try {
      await JENIS.poin.beri(orang.jid, 500);
      await JENIS.keping.beri(orang.jid, 200);
      await JENIS.ransum.beri(orang.jid, 2);
      await JENIS.kartu.beri(orang.jid, 1, 'RARE');
      berhasil++;
    } catch (err) {
      console.warn(`[BANSOS PAKET] Gagal ke ${orang.jid}:`, err.message);
    }
  }

  await db.catatBansos({ jenis: 'paket', jumlah: 1, penerima: berhasil, alasan: alasan || null });
  const grup = await siarkan(sock, suratBansos({ penerima: berhasil, alasan, rincian }));

  await send(sock, jid, messageObj,
`✅ *PAKET BANSOS SELESAI DIBAGIKAN*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎁 *Isi:* ${rincian}
👥 *Berhasil ke:* *${berhasil}/${penerima.length} member*
📢 *Diumumkan ke:* *${grup} grup*
${alasan ? `📝 *Alasan:* _"${alasan}"_` : ''}`);
  return true;
}

async function jatuhkanDrop(sock, jid, messageObj) {
  let tujuan = [];
  try {
    const { daftarGrupPengumuman } = await import('../utils/startupAnnounce.js');
    const hasil = await daftarGrupPengumuman(sock);
    tujuan = hasil.tujuan;
  } catch (err) {
    await send(sock, jid, messageObj, `⚠️ Gagal mengambil daftar grup: ${err.message}`);
    return true;
  }

  if (tujuan.length === 0) {
    await send(sock, jid, messageObj, '⚠️ Tidak ada grup terkonfigurasi yang bisa dijatuhi drop.');
    return true;
  }

  const { kirimDrop, resetPenghitung } = await import('./tcg/drop.js');
  let sukses = 0;
  for (const gjid of tujuan) {
    try {
      await kirimDrop(sock, gjid);
      resetPenghitung(gjid);
      sukses++;
    } catch (err) {
      console.warn(`[BANSOS DROP] Gagal di ${gjid}:`, err.message);
    }
    await new Promise(r => setTimeout(r, JEDA_SIAR_MS));
  }

  // penerima = jumlah GRUP yang kejatuhan drop. Berapa orang yang akhirnya
  // mengambil kartunya baru diketahui belakangan, jadi jangan dicatat 0 —
  // riwayat jadi berbunyi "drop 3 -> 0 orang" seolah gagal total.
  await db.catatBansos({ jenis: 'drop', jumlah: sukses, penerima: sukses, alasan: 'Drop kartu massal' });
  await send(sock, jid, messageObj, `🃏 *Drop kartu dijatuhkan di ${sukses}/${tujuan.length} grup.*\n_Siapa cepat dia dapat — \`.tcg ambil <nomor>\`._`);
  return true;
}

// ─── ROUTER ──────────────────────────────────────────────────────────

export async function handleBansosCommand(sock, jid, senderNumber, messageObj, args, { isOwner = false } = {}) {
  if (!isOwner) {
    await send(sock, jid, messageObj, '⚠️ Perintah `.bansos` hanya untuk *Owner*.\n_Perintah ini mencetak nilai ke seluruh member, jadi sengaja dikunci rapat._');
    return true;
  }

  const sub = String(args[1] || '').toLowerCase().trim();

  if (!sub) return await tampilkanPanduan(sock, jid, messageObj);
  if (['riwayat', 'log', 'history'].includes(sub)) return await tampilkanRiwayat(sock, jid, messageObj);
  if (['drop', 'dropkartu'].includes(sub)) return await jatuhkanDrop(sock, jid, messageObj);
  if (['paket', 'package', 'komplit'].includes(sub)) {
    return await bagikanPaket(sock, jid, messageObj, args.slice(2).join(' ').trim());
  }

  const ketemu = cariJenis(sub);
  if (!ketemu) {
    await send(sock, jid, messageObj,
      `⚠️ Jenis bansos *${sub}* tidak dikenal.\n\n📋 Pilihan: ${Object.keys(JENIS).map(k => `\`${k}\``).join(' · ')} · \`paket\` · \`drop\` · \`riwayat\`\n\n👉 Ketik \`.bansos\` untuk panduan lengkap.`);
    return true;
  }

  const { id: jenisId, def } = ketemu;

  // Kartu memakai rarity, bukan angka.
  if (def.perluRarity) {
    const rarity = String(args[2] || '').toUpperCase();
    const sah = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];
    if (!sah.includes(rarity)) {
      await send(sock, jid, messageObj,
        `⚠️ Format: \`.bansos kartu <rarity> [alasan]\`\nRarity: ${sah.map(r => `\`${r.toLowerCase()}\``).join(' · ')}`);
      return true;
    }
    return await bagikan(sock, jid, messageObj, {
      jenisId, def, jumlah: 1, rarity,
      alasan: args.slice(3).join(' ').trim(),
      rincian: `*1 Kartu ${rarity}* acak`
    });
  }

  const jumlah = parseInt(String(args[2] || '').replace(/[^0-9]/g, ''), 10);
  if (!jumlah || isNaN(jumlah) || jumlah <= 0) {
    await send(sock, jid, messageObj,
      `⚠️ Format: \`.bansos ${jenisId} <jumlah> [alasan]\`\nContoh: \`.bansos ${jenisId} ${jenisId === 'poin' ? '500' : '2'} Kompensasi bot down\``);
    return true;
  }

  const batas = BATAS[jenisId] || 1000;
  if (jumlah > batas) {
    await send(sock, jid, messageObj,
      `⚠️ Batas *${def.label}* per pembagian adalah *${fmt(batas)}*.\n_Pagar ini ada supaya salah ketik satu nol tidak menghancurkan ekonomi grup dalam sekali perintah._`);
    return true;
  }

  return await bagikan(sock, jid, messageObj, {
    jenisId, def, jumlah, alasan: args.slice(3).join(' ').trim()
  });
}

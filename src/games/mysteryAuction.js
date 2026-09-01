/**
 * LELANG KOTAK MISTERI — lelang poin di grup dengan isi kotak yang dirahasiakan.
 *
 * Catatan desain (baca sebelum menggeser angka apa pun):
 *
 * 1. **Isi kotak di-roll saat lelang DIBUKA, bukan saat ditutup.** Ini syarat
 *    mutlak untuk sistem petunjuk: bot membocorkan sifat kotak yang sebenarnya
 *    di detik 30/20/10, jadi harga bergerak mengikuti informasi. Dulu isinya
 *    baru diundi setelah palu jatuh, sehingga lelang tidak pernah membawa
 *    informasi baru sama sekali.
 * 2. **Poin ditahan (escrow) saat menawar, bukan saat menang.** Selain membuat
 *    dompet benar-benar terasa terkunci, ini menghapus jebakan lama: dulu poin
 *    baru dipotong di akhir, jadi pemenang yang kebetulan kehabisan poin di
 *    game lain langsung dipenjara 15 menit sebagai "penipu lelang".
 *    KONSEKUENSI: sesi lelang WAJIB tahan restart — kalau tidak, poin yang
 *    ditahan hilang bersama proses. Lihat saveAuctionSessions/restore di bawah.
 * 3. **Palu tiga hitungan menggantikan timer sunyi.** Fase tawar berakhir lalu
 *    juru lelang menghitung SEKALI → DUA KALI → TERJUAL. Tawaran apa pun
 *    mengembalikan hitungan ke awal, sampai batas durasi total.
 * 4. **Yang kalah membayar biaya papan.** Kecil saja, tapi tanpa itu menaikkan
 *    tawaran sampai batas atas selalu keputusan gratis dan lelang tidak pernah
 *    terasa berisiko.
 *
 * EMPAT MODE:
 *   TERBUKA — lelang biasa, tawaran naik dan terlihat semua orang.
 *   BUTA    — tawaran disegel lewat DM; tertinggi menang tapi *membayar harga
 *             penawar kedua* (lelang Vickrey). Tidak ada palu: tidak ada yang
 *             bisa direaksikan kalau semua tawaran rahasia.
 *   KUTUK   — lelang terbalik. Kotaknya jelas-jelas terkutuk dan membawa pot
 *             poin; penawar menurunkan berapa poin yang mereka mau terima untuk
 *             menanggungnya. Penawar TERENDAH yang "menang".
 *   GUDANG  — tiga lot berurutan dengan satu dompet. Poin yang habis di lot 1
 *             benar-benar tidak bisa dipakai di lot 3.
 */

import fs from 'fs';
import path from 'path';
import * as db from '../../database.js';
import { send, randomItem } from './helpers.js';
import { COOLDOWN_IMMUNITY } from './rpgSystem.js';

export const activeAuctions = new Map();
/** Disimpan untuk kompatibilitas; cooldown asli sekarang ada di DB. */
export const auctionCooldowns = new Map();

const STATE_FILE = path.join(process.cwd(), 'data', 'auction_state.json');

// ─── KONSTANTA (semua tuas penyetelan ada di sini) ───────────────────
const BID_PHASE_MS = 40 * 1000;        // fase tawar sebelum palu diangkat
const BUTA_PHASE_MS = 60 * 1000;       // lelang buta tidak punya palu
const PALU_STEP_MS = 8 * 1000;         // jeda antar ketukan palu
const MAX_TOTAL_MS = 4 * 60 * 1000;    // setelah ini palu tidak bisa direset lagi
const KLU_SISA = [30 * 1000, 20 * 1000, 10 * 1000]; // petunjuk keluar di sisa waktu ini
const PELUANG_KLU_PALSU = 0.20;        // sebagian petunjuk sengaja menyesatkan
const LOBBY_COOLDOWN_MS = 30 * 1000;
const BIAYA_PAPAN_RATE = 0.05;
const BIAYA_PAPAN_CAP = 50;
const STALE_RESTORE_MS = 10 * 60 * 1000;

const GUDANG_LOT = 3;
const GUDANG_JEDA_MS = 6 * 1000;

const BIAYA_GERTAK = 25;
const BIAYA_SIKUT = 100;
const DURASI_SIKUT_MS = 15 * 1000;

// ─── 1. KATALOG PETUNJUK ─────────────────────────────────────────────
// Sifat sengaja dipakai bersama antara hadiah dan jebakan. Petunjuk yang
// langsung menunjuk satu isi saja membunuh ketegangan di detik pertama.
const PETUNJUK = {
  berat:    '⚖️ Juru lelang mengangkatnya dengan susah payah — _kotak ini jauh lebih berat daripada ukurannya._',
  ringan:   '🪶 Kotaknya terangkat cuma dengan satu jari — _ringan sekali, hampir seperti kosong._',
  logam:    '🔔 Saat digoyang terdengar _denting logam bertumpuk_ dari dalam.',
  hangus:   '🔥 Tercium _bau hangus_ menyelinap keluar dari celah engselnya.',
  hangat:   '🌡️ Sisi kotaknya _terasa hangat_ di telapak tangan.',
  dingin:   '❄️ Permukaannya _dingin menusuk_ sampai berembun.',
  dengung:  '📿 Ada _dengung halus_ yang tidak berhenti dari dalam kotak.',
  wangi:    '🌸 Aroma _dupa manis_ menyeruak setiap kotaknya digeser.',
  bergetar: '💢 Kotaknya _bergetar sendiri_ sesekali, seperti ada yang bergerak di dalam.',
  berdebu:  '🕸️ Debu tebal dan sarang laba-laba — _sudah sangat lama tersimpan._',
  basah:    '💧 Bagian bawahnya _basah_ dan meninggalkan bekas di meja lelang.',
  segel:    '🔏 Ada _segel lilin merah_ yang belum pernah dibuka siapa pun.'
};

// Harga rahasia: sebagian besar lelang aman, tapi pemain tidak pernah tahu
// yang mana — itulah gunanya.
const TINGKAT_RESERVE = [
  { mult: 1.00, weight: 60 },
  { mult: 1.30, weight: 25 },
  { mult: 1.70, weight: 15 }
];

// ─── 2. DEFINISI KOTAK MISTERI ───────────────────────────────────────
export const BOX_TYPES = {
  bronze: {
    id: 'bronze',
    name: 'Kotak Perunggu',
    emoji: '🥉',
    openBid: 30,
    minInc: 10,
    cooldownMenit: 1,
    desc: 'Kotak kayu berlapis perunggu kuno. Murah dan ramah pemula!',
    lootPool: [
      { type: 'points', weight: 35, min: 70, max: 170, label: '💰 Kantong Poin Perunggu', sifat: ['logam', 'berat'] },
      { type: 'xp', weight: 25, amount: 80, label: '⭐ Kristal XP (+80 XP)', sifat: ['dengung', 'hangat'] },
      { type: 'zonk', weight: 20, comp: 15, label: '📜 Surat Pantun Bot (Zonk)', sifat: ['ringan', 'berdebu'] },
      { type: 'free_jail', weight: 10, label: '🎫 Kartu Pengampunan (Bebas Penjara)', sifat: ['segel', 'ringan'] },
      { type: 'slip_trap', weight: 10, penalty: 20, label: '🍌 Trap Kulit Pisang (-20 Poin)', sifat: ['basah', 'ringan'] }
    ]
  },
  silver: {
    id: 'silver',
    name: 'Kotak Perak Saudagar',
    emoji: '🥈',
    openBid: 100,
    minInc: 25,
    cooldownMenit: 3,
    desc: 'Peti perak mengkilap dari gudang saudagar kaya. Berisi hadiah berharga!',
    lootPool: [
      { type: 'points', weight: 30, min: 180, max: 350, label: '💰 Kantong Poin Perak', sifat: ['logam', 'berat'] },
      { type: 'xp_points', weight: 25, xp: 200, points: 60, label: '⭐ Paket Booster XP (+200 XP & +60 Poin)', sifat: ['dengung', 'hangat'] },
      { type: 'shield', weight: 15, durationHours: 6, label: '🛡️ Shield Anti-Maling (6 Jam)', sifat: ['dingin', 'segel'] },
      { type: 'free_jail_bonus', weight: 15, points: 100, label: '🎫 Tiket Bebas Penjara + 100 Poin', sifat: ['segel', 'wangi'] },
      { type: 'jail_trap', weight: 10, minutes: 10, label: '🚨 Trap Gas Air Mata (Penjara 10 Menit)', sifat: ['hangus', 'dengung'] },
      { type: 'zonk', weight: 5, comp: 25, label: '💌 Surat Cinta Bot (Zonk)', sifat: ['ringan', 'berdebu'] }
    ]
  },
  gold: {
    id: 'gold',
    name: 'Peti Emas Kerajaan',
    emoji: '🥇',
    openBid: 300,
    minInc: 50,
    cooldownMenit: 10,
    desc: 'Peti emas berukir mewah milik keluarga kerajaan. Hadiah berlimpah!',
    lootPool: [
      { type: 'jackpot_points', weight: 30, min: 600, max: 1200, label: '💎 JACKPOT EMAS KERAJAAN', sifat: ['berat', 'logam', 'wangi'] },
      { type: 'shield_points', weight: 25, durationHours: 12, points: 200, label: '🛡️ Mega Shield (12 Jam + 200 Poin)', sifat: ['dingin', 'segel'] },
      { type: 'xp_points', weight: 20, xp: 500, points: 300, label: '⭐ Mega XP Booster (+500 XP & +300 Poin)', sifat: ['hangat', 'dengung'] },
      { type: 'jail_trap', weight: 15, minutes: 20, label: '💣 Trap Bom Asap (Penjara 20 Menit)', sifat: ['hangus', 'bergetar'] },
      { type: 'curse_points', weight: 10, penalty: 150, label: '⚡ Kutukan Siluman (-150 Poin)', sifat: ['dingin', 'bergetar'] }
    ]
  },
  diamond: {
    id: 'diamond',
    name: 'Peti Keramat Diamond',
    emoji: '💎',
    openBid: 800,
    minInc: 100,
    cooldownMenit: 30,
    desc: 'Peti permata legendaris langka! Risiko tinggi dengan jackpot ekstrem!',
    lootPool: [
      { type: 'mega_jackpot', weight: 35, min: 1800, max: 3000, label: '👑 ULTRA MEGA JACKPOT POIN', sifat: ['berat', 'logam', 'wangi'] },
      { type: 'ultra_shield', weight: 25, durationHours: 24, points: 500, xp: 500, label: '🛡️ Ultra Aegis Shield (24 Jam + 500 Poin + 500 XP)', sifat: ['dingin', 'segel', 'berat'] },
      { type: 'cashback_voucher', weight: 20, points: 800, xp: 400, label: '🛍️ Voucher Sultan (+800 Poin & +400 XP)', sifat: ['wangi', 'segel'] },
      { type: 'curse_percent', weight: 10, percent: 15, label: '💀 Kutukan Raja Kegelapan (Sita 15% Dompet)', sifat: ['dingin', 'bergetar', 'berdebu'] },
      { type: 'jail_trap', weight: 10, minutes: 30, label: '⛓️ Jebakan Borgol Besi (Penjara 30 Menit)', sifat: ['hangus', 'bergetar'] }
    ]
  }
};

/**
 * Peti Terkutuk — lelang terbalik.
 *
 * Tidak ada yang membayar untuk menawar di sini. Kotaknya membawa pot poin, dan
 * penawar justru MENURUNKAN berapa poin yang mereka mau terima untuk memikul
 * kutukannya. Yang menawar paling rendah "menang": dia menerima potnya lalu
 * menanggung apa pun isi kutukannya — termasuk kemungkinan kutukannya ternyata
 * mandul, dan dia pulang membawa poin gratis.
 */
export const KUTUK_BOX = {
  id: 'kutuk',
  name: 'Peti Terkutuk Berlumur Ter',
  emoji: '🕯️',
  potMin: 700,
  potMax: 1800,
  minInc: 50,
  cooldownMenit: 20,
  desc: 'Peti hitam berlumur ter yang tidak berhenti berdesis. Semua orang tahu isinya kutukan — pertanyaannya kutukan yang mana.',
  lootPool: [
    { type: 'kutuk_jail', weight: 30, minutes: 25, label: '⛓️ Borgol Arwah (Penjara 25 Menit)', sifat: ['logam', 'bergetar'] },
    { type: 'kutuk_drain', weight: 30, penalty: 400, label: '🩸 Lintah Poin (-400 Poin)', sifat: ['dingin', 'basah'] },
    { type: 'kutuk_percent', weight: 25, percent: 20, label: '💀 Sita 20% Dompet', sifat: ['dingin', 'bergetar', 'berat'] },
    { type: 'kutuk_ampun', weight: 15, label: '🕊️ Kutukannya Ternyata Mandul (kamu selamat!)', sifat: ['ringan', 'wangi', 'segel'] }
  ]
};

// ─── 3. UTILITAS ─────────────────────────────────────────────────────

function pickWeighted(pool) {
  const total = pool.reduce((acc, item) => acc + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of pool) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return pool[0];
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('id-ID');
}

function fmtDurasi(ms) {
  const detik = Math.ceil(ms / 1000);
  if (detik < 60) return `${detik} detik`;
  const menit = Math.floor(detik / 60);
  const sisa = detik % 60;
  return sisa > 0 ? `${menit} menit ${sisa} detik` : `${menit} menit`;
}

function biayaPapan(bidTertinggi) {
  return Math.min(BIAYA_PAPAN_CAP, Math.floor(bidTertinggi * BIAYA_PAPAN_RATE));
}

function namaTampil(nama, digits) {
  return nama === `@${digits}` ? `@${digits}` : `*${nama}* (@${digits})`;
}

/** Isi mana saja di kotak ini yang punya sifat tersebut. */
function isiDenganSifat(pool, sifat) {
  return pool.filter(l => (l.sifat || []).includes(sifat));
}

/**
 * Pilih satu sifat untuk dibocorkan.
 *
 * Sebagian kecil petunjuk sengaja diambil dari isi yang SALAH. Tanpa itu tiga
 * petunjuk berturut-turut akan mengunci jawabannya dan sisa lelang jadi
 * formalitas — pemain diberi tahu soal ini di kartu lelang, jadi tetap adil.
 */
function undiSifat(session, indeksKlu = 0) {
  const pool = session.pool;
  const loot = session.loot;
  const sudah = session.sifatTerungkap || [];

  const semuaSifat = new Set();
  for (const l of pool) for (const sf of (l.sifat || [])) semuaSifat.add(sf);

  const dariIsiBenar = (loot.sifat || []).filter(sf => !sudah.includes(sf));
  const dariIsiLain = [...semuaSifat].filter(sf => !(loot.sifat || []).includes(sf) && !sudah.includes(sf));

  const palsu = Math.random() < PELUANG_KLU_PALSU;
  let kandidat = (palsu && dariIsiLain.length > 0) ? dariIsiLain : dariIsiBenar;
  if (kandidat.length === 0) kandidat = dariIsiBenar.length > 0 ? dariIsiBenar : dariIsiLain;
  if (kandidat.length === 0) return null;

  // Dua petunjuk pertama sengaja dipilih yang ambigu (cocok minimal 2 isi).
  // Kalau petunjuk pembuka langsung menunjuk satu isi saja, sisa lelang jadi
  // formalitas dan seluruh ketegangan habis di detik ke-10.
  if (indeksKlu < 2) {
    const ambigu = kandidat.filter(sf => isiDenganSifat(pool, sf).length >= 2);
    if (ambigu.length > 0) kandidat = ambigu;
  }

  return randomItem(kandidat);
}

// ─── 4. PERSISTENSI (WAJIB — poin pemain sedang ditahan) ─────────────

export function saveAuctionSessions() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serialized = [];
    for (const [jid, s] of activeAuctions.entries()) {
      serialized.push({
        jid,
        hostJid: s.hostJid,
        hostName: s.hostName,
        mode: s.mode,
        boxId: s.box.id,
        pot: s.pot || 0,
        lootType: s.loot.type,
        reserve: s.reserve,
        currentHighestBid: s.currentHighestBid,
        currentHighestBidder: s.currentHighestBidder,
        currentHighestBidderName: s.currentHighestBidderName,
        escrow: s.escrow,
        peserta: Array.from(s.peserta.entries()),
        segel: Array.from((s.segel || new Map()).entries()),
        sudahEndus: Array.from(s.sudahEndus || []),
        sudahSikut: Array.from(s.sudahSikut || []),
        blokir: Array.from((s.blokir || new Map()).entries()),
        fase: s.fase,
        bidEndTime: s.bidEndTime,
        klu: s.klu,
        sifatTerungkap: s.sifatTerungkap,
        paluStep: s.paluStep,
        paluReset: s.paluReset,
        gudang: s.gudang || null,
        startedAt: s.startedAt,
        savedAt: Date.now()
      });
    }

    if (serialized.length === 0) {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
      return;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
  } catch (err) {
    console.error('[LELANG] Gagal menyimpan state lelang:', err.message);
  }
}

export async function restoreAuctionSessions(sock) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    if (!content) return;
    const data = JSON.parse(content);
    if (!Array.isArray(data) || data.length === 0) return;

    for (const item of data) {
      const box = item.boxId === 'kutuk' ? KUTUK_BOX : BOX_TYPES[item.boxId];
      const loot = box?.lootPool.find(l => l.type === item.lootType);
      const umur = Date.now() - (item.savedAt || 0);

      // Terlalu lama menggantung: kembalikan semua poin yang ditahan.
      if (!box || !loot || umur > STALE_RESTORE_MS) {
        let dikembalikan = 0;
        if (item.mode === 'BUTA') {
          for (const [pjid, s] of (item.segel || [])) {
            if (s?.amount > 0) { await db.addGamePoints(pjid, s.amount); dikembalikan += s.amount; }
          }
        } else if (item.currentHighestBidder && item.escrow > 0) {
          await db.addGamePoints(item.currentHighestBidder, item.escrow);
          dikembalikan = item.escrow;
        }
        try {
          await send(sock, item.jid, null,
            `📦 Lelang ${box ? `${box.emoji} *${box.name}*` : 'kotak misteri'} dibatalkan karena bot sempat restart terlalu lama.\n` +
            (dikembalikan > 0 ? `💰 Seluruh poin yang ditahan (*${fmt(dikembalikan)} Poin*) sudah dikembalikan.\n` : '') +
            `👉 Ketik \`.lelang\` untuk membuka lelang baru.`);
        } catch { /* grup mungkin sudah tidak bisa dikirimi pesan */ }
        continue;
      }

      const session = {
        jid: item.jid,
        hostJid: item.hostJid,
        hostName: item.hostName,
        mode: item.mode || 'TERBUKA',
        box,
        pool: box.lootPool,
        pot: item.pot || 0,
        loot,
        reserve: item.reserve,
        currentHighestBid: item.currentHighestBid,
        currentHighestBidder: item.currentHighestBidder,
        currentHighestBidderName: item.currentHighestBidderName,
        escrow: item.escrow || 0,
        peserta: new Map(item.peserta || []),
        segel: new Map(item.segel || []),
        sudahEndus: new Set(item.sudahEndus || []),
        sudahSikut: new Set(item.sudahSikut || []),
        blokir: new Map(item.blokir || []),
        bidHistory: [],
        fase: item.fase || 'TAWAR',
        bidEndTime: item.bidEndTime,
        klu: item.klu || [],
        sifatTerungkap: item.sifatTerungkap || [],
        paluStep: item.paluStep || 0,
        paluNextTime: Date.now() + PALU_STEP_MS,
        paluReset: item.paluReset || 0,
        gudang: item.gudang || null,
        startedAt: item.startedAt || Date.now(),
        timer: null
      };

      // Waktu yang hilang selama bot mati dikembalikan ke pemain: fase tawar
      // diberi sisa minimal 20 detik supaya tidak ada yang kehilangan giliran.
      if (session.fase === 'TAWAR') {
        session.bidEndTime = Math.max(session.bidEndTime, Date.now() + 20 * 1000);
      }

      activeAuctions.set(item.jid, session);

      const penawarTxt = session.mode === 'BUTA'
        ? `📨 *${session.segel.size} tawaran tersegel* sudah masuk.`
        : (session.currentHighestBidder
          ? `👑 Tawaran tertinggi: *${fmt(session.currentHighestBid)} Poin* oleh @${session.currentHighestBidder.split('@')[0]}`
          : `_Belum ada penawar._`);

      await send(sock, item.jid, null,
        `🔄 *LELANG DILANJUTKAN SETELAH RESTART!* 📦\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${session.box.emoji} *${session.box.name}*\n${penawarTxt}\n\n` +
        `👉 Ketik \`.bidup\` untuk menyalip!`,
        { mentions: session.currentHighestBidder ? [session.currentHighestBidder] : [] });

      jadwalkanEvent(sock, session);
    }

    fs.unlinkSync(STATE_FILE);
  } catch (err) {
    console.error('[LELANG] Gagal memulihkan state lelang:', err.message);
  }
}

// ─── 5. ROUTER COMMAND ───────────────────────────────────────────────

export async function handleAuctionCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup, isAdmin = false, isOwner = false) {
  // Statistik boleh dibuka di DM.
  if (['lelangtop', 'toplelang', 'lelangleaderboard'].includes(command)) {
    return await showAuctionLeaderboard(sock, jid, messageObj);
  }
  if (['lelangstats', 'statlelang', 'lelangstat'].includes(command)) {
    return await showAuctionStats(sock, jid, senderNumber, messageObj);
  }

  // Tawaran tersegel memang datang lewat DM — itu inti mode buta.
  if (!isFromGroup && ['bid', 'tawar', 'bidup'].includes(command)) {
    return await placeSealedBid(sock, jid, senderNumber, messageObj, args, command);
  }

  if (!isFromGroup) {
    await send(sock, jid, messageObj, "❌ *Game Lelang Kotak Misteri* hanya bisa dibuka di dalam grup WhatsApp!\n💡 Di DM kamu bisa cek `.lelangstats`, `.lelangtop`, dan mengirim tawaran tersegel saat ada *lelang buta* berjalan.");
    return true;
  }

  if (['cancellelang', 'batallelang'].includes(command)) {
    return await cancelAuction(sock, jid, senderNumber, messageObj, isAdmin, isOwner);
  }

  if (['infolelang', 'lelanginfo'].includes(command)) {
    return await showAuctionInfo(sock, jid, messageObj);
  }

  if (['endus', 'periksakotak', 'ciumkotak'].includes(command)) {
    return await sabotaseEndus(sock, jid, senderNumber, messageObj);
  }
  if (['gertak', 'gertakan'].includes(command)) {
    return await sabotaseGertak(sock, jid, senderNumber, messageObj, args);
  }
  if (['sikut', 'blokir', 'ganggu'].includes(command)) {
    return await sabotaseSikut(sock, jid, senderNumber, messageObj, args);
  }

  if (['bid', 'tawar', 'bidup'].includes(command)) {
    return await placeBid(sock, jid, senderNumber, messageObj, args, command);
  }

  if (['lelang', 'auction', 'lelangkotak'].includes(command)) {
    const sub = (args[1] || '').toLowerCase();
    if (['list', 'daftar', 'kotak', 'info'].includes(sub)) {
      return await showBoxList(sock, jid, messageObj);
    }
    return await startAuction(sock, jid, senderNumber, messageObj, args);
  }

  return false;
}

// ─── 6. DAFTAR KOTAK ─────────────────────────────────────────────────

async function showBoxList(sock, jid, messageObj) {
  const baris = [];
  for (const key of Object.keys(BOX_TYPES)) {
    const b = BOX_TYPES[key];
    const sisaCd = await db.getCooldownMs(jid, `LELANG:${b.id}`);
    baris.push(
      `${b.emoji} *${b.name}*\n` +
      `   💵 Harga buka: *${fmt(b.openBid)} Poin* • 📈 Kelipatan: *+${fmt(b.minInc)}*\n` +
      `   📝 _${b.desc}_\n` +
      `   ${sisaCd > 0 ? `⏳ _Stok kosong, datang lagi dalam ${fmtDurasi(sisaCd)}_` : '✅ _Tersedia di gudang_'}`
    );
  }

  const cdKutuk = await db.getCooldownMs(jid, `LELANG:${KUTUK_BOX.id}`);
  baris.push(
    `${KUTUK_BOX.emoji} *${KUTUK_BOX.name}* _(lelang terbalik)_\n` +
    `   💰 Pot: *${fmt(KUTUK_BOX.potMin)}–${fmt(KUTUK_BOX.potMax)} Poin* • 📉 Penurunan minimal: *${fmt(KUTUK_BOX.minInc)}*\n` +
    `   📝 _${KUTUK_BOX.desc}_\n` +
    `   ${cdKutuk > 0 ? `⏳ _Sedang disegel pendeta, ${fmtDurasi(cdKutuk)} lagi_` : '✅ _Menunggu orang nekat_'}`
  );

  await send(sock, jid, messageObj,
`📦 *GUDANG KOTAK MISTERI* 🏷️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${baris.join('\n\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎛️ *MODE LELANG:*
• \`.lelang [kotak]\` — lelang biasa, tawaran terbuka
• \`.lelang buta [kotak]\` — tawaran disegel lewat DM, *pemenang bayar harga penawar kedua*
• \`.lelang kutuk\` — lelang terbalik, siapa paling nekat menanggung kutukan
• \`.lelang gudang\` — *${GUDANG_LOT} lot berurutan* dengan satu dompet

🗡️ *SABOTASE:* \`.endus\` • \`.gertak <jumlah>\` • \`.sikut @orang\``);
  return true;
}

// ─── 7. MEMBUKA LELANG ───────────────────────────────────────────────

async function startAuction(sock, jid, senderNumber, messageObj, args) {
  if (activeAuctions.has(jid)) {
    await showAuctionInfo(sock, jid, messageObj);
    return true;
  }

  const sisaLobby = await db.getCooldownMs(jid, 'LELANG:LOBBY');
  if (sisaLobby > 0) {
    await send(sock, jid, messageObj, `⏳ Juru lelang masih merapikan mejanya. Tunggu *${fmtDurasi(sisaLobby)}* lagi.`);
    return true;
  }

  const a1 = (args[1] || '').toLowerCase();
  const a2 = (args[2] || '').toLowerCase();

  let mode = 'TERBUKA';
  let tipeArg = a1;
  if (['buta', 'sealed', 'tertutup', 'segel'].includes(a1)) { mode = 'BUTA'; tipeArg = a2; }
  else if (['kutuk', 'terkutuk', 'curse', 'kutukan'].includes(a1)) { mode = 'KUTUK'; tipeArg = ''; }
  else if (['gudang', 'warehouse', 'borongan', 'marathon'].includes(a1)) { mode = 'GUDANG'; tipeArg = ''; }

  const hostCust = await db.getCustomerByPhone(senderNumber);
  const hostName = hostCust?.nama ? hostCust.nama : `@${senderNumber.split('@')[0]}`;

  // ── Lelang gudang: tiga lot berurutan ──
  if (mode === 'GUDANG') {
    const jadwal = [];
    for (let i = 0; i < GUDANG_LOT; i++) {
      jadwal.push(pickWeighted([
        { key: 'bronze', weight: 30 }, { key: 'silver', weight: 40 },
        { key: 'gold', weight: 20 }, { key: 'diamond', weight: 10 }
      ]).key);
    }
    const gudang = { lot: 1, total: GUDANG_LOT, jadwal, riwayat: [], hostJid: senderNumber, hostName };

    await send(sock, jid, messageObj,
`🏚️ *LELANG GUDANG DIBUKA — ${GUDANG_LOT} LOT BERURUTAN!* 📦📦📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Juru lelang membuka pintu gudang. Tiga kotak akan dilelang *berturut-turut tanpa jeda panjang*.

⚠️ *Poin yang kamu habiskan di lot awal benar-benar hilang dari dompet.* Kalau kamu kalap di Lot 1, kamu cuma bisa menonton saat Lot 3 keluar.

📋 *Urutan lot malam ini:*
${jadwal.map((k, i) => `   *Lot ${i + 1}:* ${BOX_TYPES[k].emoji} ${BOX_TYPES[k].name}`).join('\n')}

_Lot 1 dimulai sekarang…_`);

    await bukaLot(sock, jid, gudang, messageObj);
    return true;
  }

  // ── Peti terkutuk ──
  if (mode === 'KUTUK') {
    const sisaCd = await db.getCooldownMs(jid, `LELANG:${KUTUK_BOX.id}`);
    if (sisaCd > 0) {
      await send(sock, jid, messageObj, `🕯️ ${KUTUK_BOX.emoji} *${KUTUK_BOX.name}* masih disegel pendeta desa.\nBisa dibuka lagi dalam *${fmtDurasi(sisaCd)}*.`);
      return true;
    }
    return await mulaiSesi(sock, jid, senderNumber, messageObj, {
      mode: 'KUTUK', box: KUTUK_BOX, hostName, gudang: null
    });
  }

  // ── Terbuka / buta ──
  let chosenType = null;
  if (['perunggu', 'bronze', '1'].includes(tipeArg)) chosenType = 'bronze';
  else if (['perak', 'silver', '2'].includes(tipeArg)) chosenType = 'silver';
  else if (['emas', 'gold', '3'].includes(tipeArg)) chosenType = 'gold';
  else if (['diamond', 'keramat', 'mitik', 'mythic', '4'].includes(tipeArg)) chosenType = 'diamond';

  if (chosenType) {
    const sisaCd = await db.getCooldownMs(jid, `LELANG:${chosenType}`);
    if (sisaCd > 0) {
      const b = BOX_TYPES[chosenType];
      await send(sock, jid, messageObj, `📦 Stok ${b.emoji} *${b.name}* di gudang sedang kosong.\nKiriman berikutnya tiba dalam *${fmtDurasi(sisaCd)}*.\n\n👉 Ketik \`.lelang list\` untuk melihat kotak lain.`);
      return true;
    }
  } else {
    const bobot = { bronze: 30, silver: 40, gold: 20, diamond: 10 };
    const kandidat = [];
    for (const key of Object.keys(BOX_TYPES)) {
      const sisaCd = await db.getCooldownMs(jid, `LELANG:${key}`);
      if (sisaCd <= 0) kandidat.push({ key, weight: bobot[key] || 10 });
    }
    if (kandidat.length === 0) {
      await send(sock, jid, messageObj, `📦 Gudang kotak misteri sedang kosong total di grup ini.\n👉 Ketik \`.lelang list\` untuk melihat sisa waktu tiap kotak.`);
      return true;
    }
    chosenType = pickWeighted(kandidat).key;
  }

  return await mulaiSesi(sock, jid, senderNumber, messageObj, {
    mode, box: BOX_TYPES[chosenType], hostName, gudang: null
  });
}

/** Buka satu lot dari lelang gudang. */
async function bukaLot(sock, jid, gudang, messageObj) {
  const key = gudang.jadwal[gudang.lot - 1];
  return await mulaiSesi(sock, jid, gudang.hostJid, messageObj, {
    mode: 'TERBUKA', box: BOX_TYPES[key], hostName: gudang.hostName, gudang
  });
}

/** Inti pembuatan sesi lelang untuk semua mode. */
async function mulaiSesi(sock, jid, hostJid, messageObj, { mode, box, hostName, gudang }) {
  const loot = pickWeighted(box.lootPool);
  const isKutuk = mode === 'KUTUK';
  const pot = isKutuk
    ? Math.round((Math.floor(Math.random() * (box.potMax - box.potMin + 1)) + box.potMin) / 50) * 50
    : 0;
  const reserve = isKutuk ? 0 : Math.round(box.openBid * pickWeighted(TINGKAT_RESERVE).mult);

  const durasi = mode === 'BUTA' ? BUTA_PHASE_MS : BID_PHASE_MS;
  const now = Date.now();
  const bidEndTime = now + durasi;

  const session = {
    jid,
    hostJid,
    hostName,
    mode,
    box,
    pool: box.lootPool,
    loot,
    pot,
    reserve,
    // Untuk KUTUK angka ini berarti "tawaran TERENDAH saat ini" — arah lelangnya terbalik.
    currentHighestBid: isKutuk ? pot : box.openBid,
    currentHighestBidder: null,
    currentHighestBidderName: null,
    escrow: 0,
    peserta: new Map(),
    segel: new Map(),
    sudahEndus: new Set(),
    sudahSikut: new Set(),
    blokir: new Map(),
    bidHistory: [],
    fase: 'TAWAR',
    bidEndTime,
    klu: KLU_SISA.filter(s => s < durasi).map(sisa => ({ waktu: bidEndTime - sisa, terkirim: false })),
    sifatTerungkap: [],
    paluStep: 0,
    paluNextTime: 0,
    paluReset: 0,
    gudang,
    startedAt: now,
    timer: null
  };

  activeAuctions.set(jid, session);
  jadwalkanEvent(sock, session);
  saveAuctionSessions();

  await send(sock, jid, messageObj, kartuLelang(session), { buttons: tombolLelang(session) });
  return true;
}

function tombolLelang(session) {
  if (session.mode === 'KUTUK') {
    return [
      { type: 'reply', text: `😈 Turunkan ke ${fmt(session.currentHighestBid - session.box.minInc)}`, id: '.bidup' },
      { type: 'reply', text: '👃 Endus Kotak', id: '.endus' },
      { type: 'reply', text: 'ℹ️ Status Lelang', id: '.infolelang' }
    ];
  }
  if (session.mode === 'BUTA') {
    return [
      { type: 'reply', text: '👃 Endus Kotak', id: '.endus' },
      { type: 'reply', text: 'ℹ️ Status Lelang', id: '.infolelang' }
    ];
  }
  return [
    { type: 'reply', text: `💰 Tawar ${fmt(session.box.openBid)} Poin`, id: `.bid ${session.box.openBid}` },
    { type: 'reply', text: `📈 Naikkan (+${fmt(session.box.minInc)})`, id: '.bidup' },
    { type: 'reply', text: '👃 Endus Kotak', id: '.endus' },
    { type: 'reply', text: 'ℹ️ Status Lelang', id: '.infolelang' }
  ];
}

function kartuLelang(session) {
  const { box, mode, gudang } = session;
  const judulLot = gudang ? `🏚️ *LOT ${gudang.lot} DARI ${gudang.total}* — ` : '';
  const aturanSabotase =
`🗡️ *SABOTASE (opsional, berbayar):*
• \`.endus\` — beli satu petunjuk rahasia lewat DM (sekali per orang)
• \`.gertak <jumlah>\` — umumkan gertakan (${BIAYA_GERTAK} Poin, tidak mengikat)
• \`.sikut @orang\` — kunci lawan ${Math.round(DURASI_SIKUT_MS / 1000)} detik (${BIAYA_SIKUT} Poin, sekali per orang)`;

  if (mode === 'KUTUK') {
    return (
`🕯️ *LELANG TERBALIK — PETI TERKUTUK!* 😈
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Seorang pertapa menaruh peti hitam berlumur ter di atas meja lalu pergi tanpa bicara.

${box.emoji} *${box.name}*
📝 _${box.desc}_

💰 *Pot Tanggungan:* *${fmt(session.pot)} Poin*
😱 *Aturannya terbalik:* kalian *menurunkan* berapa poin yang mau kalian terima untuk memikul kutukannya. Penawar *TERENDAH* yang "menang" — dia menerima potnya, lalu menanggung isinya.
📉 *Penurunan minimal:* *${fmt(box.minInc)} Poin* tiap tawaran
🎲 *Kabar baiknya:* ada kemungkinan kutukannya ternyata mandul, dan si nekat pulang membawa poin gratis.

🕯️ *TIGA PETUNJUK AKAN BOCOR* soal kutukan mana yang mengintai.
⚠️ _Satu di antaranya bisa saja menyesatkan._

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${aturanSabotase}

⏳ *Fase Tawar:* *${Math.round(BID_PHASE_MS / 1000)} detik*, lalu palu tiga hitungan.
👉 Ketik \`.bid <jumlah>\` (harus lebih rendah) atau \`.bidup\``);
  }

  if (mode === 'BUTA') {
    return (
`📜 *LELANG BUTA — TAWARAN TERSEGEL!* 🤫
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${judulLot}Juru lelang membagikan amplop. Malam ini *tidak ada yang tahu tawaran siapa pun.*

${box.emoji} *Kategori:* *${box.name}*
📝 _${box.desc}_

💵 *Harga Buka:* *${fmt(box.openBid)} Poin*
🤫 *Cara ikut:* kirim \`.bid <jumlah>\` *ke DM bot ini* — bukan di grup. Grup hanya diberi tahu *berapa banyak* amplop yang masuk, bukan isinya.
🏆 *Aturan Vickrey:* penawar tertinggi menang, tapi *membayar harga penawar KEDUA*. Menawar jujur sesuai nilai aslinya adalah strategi terbaikmu.
✏️ Tawaran boleh direvisi selama waktu masih ada — poin lama dikembalikan.
🔏 *Harga Rahasia:* ada batas minimum tersembunyi. Tidak tertembus, kotak ditarik.

🕯️ *TIGA PETUNJUK AKAN BOCOR* di grup, terbuka untuk semua.
⚠️ _Satu di antaranya bisa saja menyesatkan._

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💸 Poin *langsung ditahan* begitu amplopmu masuk. Yang kalah dikembalikan penuh, dipotong biaya papan ${Math.round(BIAYA_PAPAN_RATE * 100)}% (maks ${BIAYA_PAPAN_CAP} Poin).

${aturanSabotase}

⏳ *Batas Amplop:* *${Math.round(BUTA_PHASE_MS / 1000)} detik* — tidak ada palu, tidak ada perpanjangan.
👉 Kirim \`.bid <jumlah>\` ke DM bot sekarang!`);
  }

  return (
`📦 *${judulLot}LELANG KOTAK MISTERI DIMULAI!* 💰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Juru lelang menaruh sebuah kotak di atas meja. Isinya *sudah ditentukan* — tinggal siapa yang berani menebusnya.

${box.emoji} *Kategori:* *${box.name}*
📝 _${box.desc}_

💵 *Harga Buka:* *${fmt(box.openBid)} Poin*
📈 *Kelipatan Minimal:* *+${fmt(box.minInc)} Poin*
🔏 *Harga Rahasia:* juru lelang menyimpan batas minimum. Kalau tawaran tertinggi tidak menembusnya, *kotak ditarik dan tidak ada yang membawanya pulang.*

🕯️ *TIGA PETUNJUK AKAN BOCOR* di detik ke-10, 20, dan 30.
⚠️ _Satu di antaranya bisa saja menyesatkan. Percaya atau tidak, itu risikomu._

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💸 *ATURAN UANG:*
• Poin *langsung ditahan* begitu tawaranmu masuk, dan dikembalikan penuh kalau kamu disalip.
• Yang ikut menawar tapi kalah membayar *biaya papan ${Math.round(BIAYA_PAPAN_RATE * 100)}%* dari tawaran tertingginya (maksimal ${BIAYA_PAPAN_CAP} Poin).
• Setelah fase tawar habis, juru lelang mengetuk palu: *SEKALI → DUA KALI → TERJUAL*. Tawaran baru mengembalikan hitungan ke awal.

${aturanSabotase}

⏳ *Fase Tawar:* *${Math.round(BID_PHASE_MS / 1000)} detik*
👉 Ketik \`.bid <jumlah>\` atau \`.bidup\``);
}

// ─── 8. PENJADWALAN EVENT (petunjuk & palu) ──────────────────────────

function jadwalkanEvent(sock, session) {
  if (session.timer) clearTimeout(session.timer);

  let waktu;
  let jenis;

  if (session.fase === 'TAWAR') {
    const pending = (session.klu || []).filter(k => !k.terkirim).map(k => k.waktu);
    const kluBerikut = pending.length > 0 ? Math.min(...pending) : Infinity;
    if (kluBerikut < session.bidEndTime) {
      waktu = kluBerikut;
      jenis = 'KLU';
    } else {
      waktu = session.bidEndTime;
      jenis = 'PALU';
    }
  } else {
    waktu = session.paluNextTime;
    jenis = 'PALU';
  }

  const delay = Math.max(300, waktu - Date.now());
  session.timer = setTimeout(async () => {
    try {
      if (!activeAuctions.has(session.jid)) return;
      if (jenis === 'KLU') await kirimPetunjuk(sock, session);
      // Lelang buta tidak punya palu: semua tawaran rahasia, tidak ada yang
      // bisa direaksikan, jadi hitungan mundur cuma menunda tanpa ketegangan.
      else if (session.mode === 'BUTA') await resolveAuction(sock, session);
      else await ketukPalu(sock, session);
    } catch (err) {
      console.error('[LELANG EVENT ERROR]', err);
    }
  }, delay);
}

async function kirimPetunjuk(sock, session) {
  const pending = (session.klu || []).filter(k => !k.terkirim).sort((a, b) => a.waktu - b.waktu);
  const slot = pending[0];
  if (slot) slot.terkirim = true;

  const sifat = undiSifat(session, session.sifatTerungkap.length);
  if (sifat) {
    session.sifatTerungkap.push(sifat);

    const cocok = isiDenganSifat(session.pool, sifat);
    const nomor = session.sifatTerungkap.length;
    const sisaDetik = Math.max(1, Math.ceil((session.bidEndTime - Date.now()) / 1000));
    const daftarCocok = cocok.length > 0
      ? cocok.map(l => `   • ${l.label}`).join('\n')
      : '   • _tidak ada yang cocok… aneh sekali._';

    let penawarTxt;
    if (session.mode === 'BUTA') {
      penawarTxt = `📨 *${session.segel.size} amplop* sudah masuk. Isinya? Tidak ada yang tahu.`;
    } else if (session.mode === 'KUTUK') {
      penawarTxt = session.currentHighestBidder
        ? `😈 Tawaran terendah: *${fmt(session.currentHighestBid)} Poin* (@${session.currentHighestBidder.split('@')[0]})`
        : `😈 _Belum ada yang berani menyentuhnya._`;
    } else {
      penawarTxt = session.currentHighestBidder
        ? `👑 Tertinggi sekarang: *${fmt(session.currentHighestBid)} Poin* (@${session.currentHighestBidder.split('@')[0]})`
        : `👑 _Belum ada satu pun tawaran masuk._`;
    }

    const ajakan = session.mode === 'BUTA'
      ? '👉 Revisi amplopmu lewat DM selagi sempat.'
      : (session.mode === 'KUTUK'
        ? '👉 `.bidup` kalau masih berani turun, atau mundur selagi bisa.'
        : '👉 `.bidup` untuk menyalip, atau diam saja kalau nyalimu ciut.');

    await send(sock, session.jid, null,
`🕯️ *PETUNJUK ${nomor} DARI ${session.klu.length}* 🔍
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${PETUNJUK[sifat] || '_Juru lelang berdehem, tapi tidak berkata apa-apa._'}

📋 *Isi yang cocok dengan tanda ini:*
${daftarCocok}

${penawarTxt}
⏳ Fase tawar tinggal *${sisaDetik} detik*.
${ajakan}`,
      { mentions: session.currentHighestBidder ? [session.currentHighestBidder] : [] });
  }

  saveAuctionSessions();
  jadwalkanEvent(sock, session);
}

async function ketukPalu(sock, session) {
  if (session.fase === 'TAWAR') {
    session.fase = 'PALU';
    session.paluStep = 0;
  }

  session.paluStep += 1;

  if (session.paluStep >= 3) {
    await resolveAuction(sock, session);
    return;
  }

  const label = session.paluStep === 1 ? '🔨 *SEKALI…*' : '🔨🔨 *DUA KALI…*';
  const isKutuk = session.mode === 'KUTUK';
  const penawarTxt = session.currentHighestBidder
    ? (isKutuk
      ? `😈 *${session.currentHighestBidderName}* siap memikul kutukannya demi *${fmt(session.currentHighestBid)} Poin*`
      : `👑 *${session.currentHighestBidderName}* memegang tawaran *${fmt(session.currentHighestBid)} Poin*`)
    : `👑 _Belum ada penawar sama sekali._`;
  const ancaman = session.paluStep === 1
    ? '_Masih ada waktu menyalip._'
    : '⚠️ _Ketukan berikutnya menutup lelang!_';

  const targetBid = session.currentHighestBidder
    ? (isKutuk ? session.currentHighestBid - session.box.minInc : session.currentHighestBid + session.box.minInc)
    : (isKutuk ? session.pot - session.box.minInc : session.box.openBid);

  session.paluNextTime = Date.now() + PALU_STEP_MS;
  saveAuctionSessions();
  jadwalkanEvent(sock, session);

  await send(sock, session.jid, null,
`${label}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${penawarTxt}
${ancaman}

👉 \`.bidup\` sekarang atau ${isKutuk ? 'biarkan dia yang menanggung!' : 'kehilangan kotaknya!'}`,
    {
      mentions: session.currentHighestBidder ? [session.currentHighestBidder] : [],
      buttons: [
        { type: 'reply', text: isKutuk ? `😈 Turun ke ${fmt(Math.max(0, targetBid))}` : `🔥 Salip ${fmt(targetBid)} Poin`, id: '.bidup' },
        { type: 'reply', text: 'ℹ️ Status Lelang', id: '.infolelang' }
      ]
    });
}

// ─── 9. MENAWAR (terbuka & terkutuk) ─────────────────────────────────

async function placeBid(sock, jid, senderNumber, messageObj, args, command) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang yang sedang aktif di grup ini.\nKetik *.lelang* untuk membuka lelang kotak baru!");
    return true;
  }

  if (session.mode === 'BUTA') {
    await send(sock, jid, messageObj, `🤫 Ini *lelang buta* — tawaran tidak boleh diumbar di grup!\n👉 Kirim \`.bid <jumlah>\` ke *DM bot* supaya amplopmu tersegel.`);
    return true;
  }

  const senderDigits = senderNumber.split('@')[0];
  const isKutuk = session.mode === 'KUTUK';

  // Kena sikut lawan?
  let blokirSampai = session.blokir.get(senderNumber) || 0;
  if (!blokirSampai) {
    for (const [blockedJid, until] of session.blokir.entries()) {
      if (until > Date.now() && db.isPhoneMatch(blockedJid, senderNumber)) {
        blokirSampai = until;
        break;
      }
    }
  }
  if (blokirSampai > Date.now()) {
    await send(sock, jid, messageObj, `🤛 @${senderDigits}, kamu baru saja *disikut* dari meja lelang!\nTunggu *${Math.ceil((blokirSampai - Date.now()) / 1000)} detik* lagi sebelum bisa menawar.`, { mentions: [senderNumber] });
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const senderName = cust?.nama ? cust.nama : `@${senderDigits}`;

  if (session.currentHighestBidder === senderNumber) {
    await send(sock, jid, messageObj, isKutuk
      ? `⚠️ @${senderDigits}, kamu yang sedang paling nekat (*${fmt(session.currentHighestBid)} Poin*). Tidak perlu menurunkan tawaran sendiri.`
      : `⚠️ @${senderDigits}, tawaran tertinggi masih atas namamu (*${fmt(session.currentHighestBid)} Poin*) — poinmu sedang ditahan. Tunggu ada yang berani menyalip.`,
      { mentions: [senderNumber] });
    return true;
  }

  const minInc = session.box.minInc;
  const targetBerikut = session.currentHighestBidder
    ? (isKutuk ? session.currentHighestBid - minInc : session.currentHighestBid + minInc)
    : (isKutuk ? session.pot - minInc : session.box.openBid);

  let bidAmount;
  if (command === 'bidup') {
    bidAmount = Math.max(0, targetBerikut);
  } else {
    const raw = args[1] ? args[1].replace(/[^0-9]/g, '') : '';
    bidAmount = parseInt(raw, 10);
  }

  if (isNaN(bidAmount) || bidAmount < 0 || (!isKutuk && bidAmount <= 0)) {
    await send(sock, jid, messageObj, `⚠️ *Format Bid Salah!*\nMasukkan nominal angka tawaran yang valid.\n\n*Contoh:* \`.bid ${Math.max(0, targetBerikut)}\` atau ketik \`.bidup\``);
    return true;
  }

  if (isKutuk) {
    if (bidAmount > targetBerikut) {
      await send(sock, jid, messageObj, `⚠️ Ini *lelang terbalik* — tawaranmu harus *lebih rendah* minimal *${fmt(minInc)} Poin* dari tawaran sekarang.\n👉 Tawaran sah berikutnya: *${fmt(Math.max(0, targetBerikut))} Poin* atau kurang.`);
      return true;
    }
  } else {
    if (bidAmount < targetBerikut) {
      const alasan = session.currentHighestBidder
        ? `Tawaran harus minimal *+${fmt(minInc)} Poin* di atas tawaran sekarang.`
        : `Tawaran pembuka minimal *${fmt(session.box.openBid)} Poin*.`;
      await send(sock, jid, messageObj, `⚠️ ${alasan}\n👉 Tawaran minimal berikutnya: *${fmt(targetBerikut)} Poin*.`);
      return true;
    }

    // Escrow: poin ditahan sekarang juga. deductGamePoints bersifat atomik,
    // jadi tidak ada celah balapan antara dua penawar di detik yang sama.
    const tahan = await db.deductGamePoints(senderNumber, bidAmount);
    if (!tahan.success) {
      await send(sock, jid, messageObj, `❌ Poin dompetmu tidak cukup untuk menahan tawaran *${fmt(bidAmount)} Poin*!\n💰 Poin dompetmu: *${fmt(tahan.currentPoints || 0)} Poin*`);
      return true;
    }
  }

  const penawarLama = session.currentHighestBidder;
  const escrowLama = session.escrow;
  if (!isKutuk && penawarLama && escrowLama > 0) {
    await db.addGamePoints(penawarLama, escrowLama);
  }

  session.currentHighestBid = bidAmount;
  session.currentHighestBidder = senderNumber;
  session.currentHighestBidderName = senderName;
  session.escrow = isKutuk ? 0 : bidAmount;
  session.bidHistory.push({ bidder: senderNumber, bidderName: senderName, amount: bidAmount, time: Date.now() });

  const pesertaLama = session.peserta.get(senderNumber);
  session.peserta.set(senderNumber, {
    name: senderName,
    tertinggi: Math.max(pesertaLama?.tertinggi || 0, isKutuk ? 0 : bidAmount)
  });

  let resetPalu = false;
  let paluTerakhir = false;
  if (session.fase === 'PALU') {
    if (Date.now() - session.startedAt < MAX_TOTAL_MS) {
      session.paluStep = 0;
      session.paluReset += 1;
      session.paluNextTime = Date.now() + PALU_STEP_MS;
      resetPalu = true;
      jadwalkanEvent(sock, session);
    } else {
      paluTerakhir = true;
    }
  }

  saveAuctionSessions();

  const nextTarget = isKutuk ? Math.max(0, bidAmount - minInc) : bidAmount + minInc;
  const infoFase = session.fase === 'TAWAR'
    ? `⏳ Fase tawar tinggal *${Math.max(1, Math.ceil((session.bidEndTime - Date.now()) / 1000))} detik*.`
    : (resetPalu
      ? `🔨 *PALU DITARIK KEMBALI!* Hitungan diulang dari awal _(reset ke-${session.paluReset})_.`
      : `🔨 *PALU TERAKHIR* — lelang sudah melewati batas waktu, hitungan tidak bisa diulang lagi!`);

  const bebasTxt = (!isKutuk && penawarLama)
    ? `\n💸 Poin *${fmt(escrowLama)}* milik @${penawarLama.split('@')[0]} sudah dikembalikan.`
    : '';

  const judul = isKutuk ? '😈 *ADA YANG LEBIH NEKAT!* 📉' : '🔥 *TAWARAN BARU MASUK!* 📈';
  const barisTawaran = isKutuk
    ? `😈 Bersedia menanggung kutukan demi: *${fmt(bidAmount)} Poin*`
    : `💰 Tawaran: *${fmt(bidAmount)} Poin* _(ditahan dari dompet)_${bebasTxt}`;

  await send(sock, jid, messageObj,
`${judul}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Penawar: ${namaTampil(senderName, senderDigits)}
${barisTawaran}
📦 Kotak: ${session.box.emoji} *${session.box.name}*
${infoFase}

👉 ${isKutuk ? `Ada yang lebih nekat? \`.bid ${nextTarget}\` atau kurang!` : `Penawar berikutnya minimal \`.bid ${nextTarget}\` atau \`.bidup\`!`}`,
    {
      mentions: penawarLama ? [senderNumber, penawarLama] : [senderNumber],
      buttons: [
        { type: 'reply', text: isKutuk ? `😈 Turun ke ${fmt(nextTarget)}` : `🔥 Salip ${fmt(nextTarget)} Poin`, id: `.bid ${nextTarget}` },
        { type: 'reply', text: 'ℹ️ Status Lelang', id: '.infolelang' }
      ]
    });

  if (paluTerakhir) jadwalkanEvent(sock, session);
  return true;
}

// ─── 10. TAWARAN TERSEGEL (mode buta, lewat DM) ──────────────────────

/** Cari lelang buta yang sedang berjalan. Praktisnya hampir selalu cuma satu. */
function cariLelangButa() {
  let terbaru = null;
  for (const s of activeAuctions.values()) {
    if (s.mode !== 'BUTA') continue;
    if (!terbaru || s.startedAt > terbaru.startedAt) terbaru = s;
  }
  return terbaru;
}

async function placeSealedBid(sock, dmJid, senderNumber, messageObj, args, command) {
  const session = cariLelangButa();
  if (!session) {
    await send(sock, dmJid, messageObj, "❌ Tidak ada *lelang buta* yang sedang berjalan.\n_Tawaran lewat DM hanya berlaku untuk mode `.lelang buta`._");
    return true;
  }

  const senderDigits = senderNumber.split('@')[0];
  const cust = await db.getCustomerByPhone(senderNumber);
  const senderName = cust?.nama ? cust.nama : `@${senderDigits}`;

  const lama = session.segel.get(senderNumber);
  let bidAmount;
  if (command === 'bidup') {
    bidAmount = lama ? lama.amount + session.box.minInc : session.box.openBid;
  } else {
    const raw = args[1] ? args[1].replace(/[^0-9]/g, '') : '';
    bidAmount = parseInt(raw, 10);
  }

  if (!bidAmount || isNaN(bidAmount) || bidAmount <= 0) {
    await send(sock, dmJid, messageObj, `⚠️ Masukkan nominal tawaran yang valid.\n*Contoh:* \`.bid ${session.box.openBid}\``);
    return true;
  }
  if (bidAmount < session.box.openBid) {
    await send(sock, dmJid, messageObj, `⚠️ Tawaran minimal *${fmt(session.box.openBid)} Poin* (harga buka ${session.box.emoji} ${session.box.name}).`);
    return true;
  }

  // Revisi amplop: hitung selisih antara tawaran baru dan lama
  const selisih = bidAmount - (lama?.amount || 0);
  if (selisih > 0) {
    const tahan = await db.deductGamePoints(senderNumber, selisih);
    if (!tahan.success) {
      await send(sock, dmJid, messageObj, `❌ Poin dompetmu tidak cukup untuk menaikkan tawaran ke *${fmt(bidAmount)} Poin* (kurang +${fmt(selisih)} Poin)!\n💰 Poin dompetmu: *${fmt(tahan.currentPoints || 0)} Poin*`);
      return true;
    }
  } else if (selisih < 0) {
    await db.addGamePoints(senderNumber, Math.abs(selisih));
  }

  session.segel.set(senderNumber, { name: senderName, amount: bidAmount });
  session.peserta.set(senderNumber, { name: senderName, tertinggi: bidAmount });
  saveAuctionSessions();

  const sisaDetik = Math.max(1, Math.ceil((session.bidEndTime - Date.now()) / 1000));
  await send(sock, dmJid, messageObj,
`🤫 *AMPLOP TERSEGEL DITERIMA* 📨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Kotak: ${session.box.emoji} *${session.box.name}*
💰 Tawaranmu: *${fmt(bidAmount)} Poin* _(ditahan dari dompet)_
${lama ? `♻️ Amplop lamamu (*${fmt(lama.amount)} Poin*) dibatalkan dan poinnya dikembalikan.\n` : ''}
🏆 Ingat: kalau kamu menang, kamu *membayar harga penawar kedua*, bukan angka ini.
⏳ Masih bisa direvisi *${sisaDetik} detik* lagi.

_Tidak ada yang tahu isinya sampai palu jatuh._`);

  // Grup hanya diberi tahu jumlah amplop, tidak pernah isinya.
  await send(sock, session.jid, null,
    `📨 *Sebuah amplop masuk ke kotak segel.* Total sekarang *${session.segel.size} amplop*.\n_Isinya? Cuma juru lelang yang tahu._`);

  return true;
}

// ─── 11. SABOTASE ────────────────────────────────────────────────────

async function sabotaseEndus(sock, jid, senderNumber, messageObj) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada lelang aktif untuk diendus di grup ini.");
    return true;
  }
  if (session.sudahEndus.has(senderNumber)) {
    await send(sock, jid, messageObj, `👃 Kamu sudah mengendus kotak ini sekali. Hidungmu tidak akan menemukan yang baru.`);
    return true;
  }

  const dasar = session.mode === 'KUTUK' ? session.box.minInc : session.box.openBid;
  const harga = Math.max(25, Math.round(dasar * 0.2));
  const bayar = await db.deductGamePoints(senderNumber, harga);
  if (!bayar.success) {
    await send(sock, jid, messageObj, `❌ Mengendus kotak butuh *${fmt(harga)} Poin*, dompetmu cuma punya *${fmt(bayar.currentPoints || 0)} Poin*.`);
    return true;
  }

  session.sudahEndus.add(senderNumber);
  saveAuctionSessions();

  // Petunjuk pribadi selalu JUJUR — itu yang dibayar pemain. Yang bocor di
  // grup boleh menyesatkan, yang ini tidak.
  const belumTerungkap = (session.loot.sifat || []).filter(sf => !session.sifatTerungkap.includes(sf));
  const sifat = belumTerungkap.length > 0 ? randomItem(belumTerungkap) : randomItem(session.loot.sifat || []);
  const cocok = isiDenganSifat(session.pool, sifat);

  await send(sock, senderNumber, null,
`👃 *HASIL ENDUSAN RAHASIA* 🔍
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 ${session.box.emoji} *${session.box.name}* di grup sebelah.

${PETUNJUK[sifat] || sifat}

📋 *Isi yang cocok:*
${cocok.map(l => `   • ${l.label}`).join('\n')}

✅ _Petunjuk berbayar ini dijamin JUJUR — beda dengan yang bocor di grup._
🤐 Jangan bilang siapa-siapa.`);

  await send(sock, jid, messageObj,
    `👃 @${senderNumber.split('@')[0]} membayar *${fmt(harga)} Poin* untuk mengendus kotaknya diam-diam.\n_Hasilnya dikirim ke DM-nya. Entah dia jujur atau tidak nanti._`,
    { mentions: [senderNumber] });
  return true;
}

async function sabotaseGertak(sock, jid, senderNumber, messageObj, args) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada lelang aktif di grup ini untuk digertak.");
    return true;
  }

  const raw = args[1] ? args[1].replace(/[^0-9]/g, '') : '';
  const angka = parseInt(raw, 10);
  if (!angka || isNaN(angka) || angka <= 0) {
    await send(sock, jid, messageObj, `⚠️ Gertak butuh nominal.\n*Contoh:* \`.gertak 2000\` — biaya *${BIAYA_GERTAK} Poin*, dan gertakan ini *tidak mengikat*.`);
    return true;
  }

  const bayar = await db.deductGamePoints(senderNumber, BIAYA_GERTAK);
  if (!bayar.success) {
    await send(sock, jid, messageObj, `❌ Menggertak butuh *${BIAYA_GERTAK} Poin*, dompetmu cuma punya *${fmt(bayar.currentPoints || 0)} Poin*.`);
    return true;
  }

  const cust = await db.getCustomerByPhone(senderNumber);
  const nama = cust?.nama || `@${senderNumber.split('@')[0]}`;

  await send(sock, jid, messageObj,
`😤 *GERTAKAN DILEMPAR KE MEJA!* 📣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*${nama}* berdiri, menatap seisi ruangan, lalu berkata:

   _"Aku siap sampai *${fmt(angka)} Poin*. Silakan coba."_

⚠️ _Gertakan tidak mengikat sama sekali. Bisa jadi dia benar-benar punya poinnya, bisa jadi cuma menggetarkan nyali kalian._`,
    { mentions: [senderNumber] });
  return true;
}

async function sabotaseSikut(sock, jid, senderNumber, messageObj, args) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada lelang aktif di grup ini.");
    return true;
  }
  if (session.sudahSikut.has(senderNumber)) {
    await send(sock, jid, messageObj, `🤛 Kamu sudah menyikut satu orang di lelang ini. Sekali saja per lelang.`);
    return true;
  }

  const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  let target = mentions[0];
  if (!target && args[1]) {
    const res = await db.resolveTargetJid(args[1]);
    if (res?.ditemukan && res.jid) target = res.jid;
    else {
      const bersih = args[1].replace(/[^0-9]/g, '');
      if (bersih.length > 5) target = `${bersih}@s.whatsapp.net`;
    }
  }
  if (!target) {
    await send(sock, jid, messageObj, `⚠️ Sikut siapa?\n*Contoh:* \`.sikut @teman\` — biaya *${BIAYA_SIKUT} Poin*, mengunci dia *${Math.round(DURASI_SIKUT_MS / 1000)} detik*.`);
    return true;
  }
  if (target === senderNumber) {
    await send(sock, jid, messageObj, `🤛 Menyikut diri sendiri? Hemat poinmu.`);
    return true;
  }

  const bayar = await db.deductGamePoints(senderNumber, BIAYA_SIKUT);
  if (!bayar.success) {
    await send(sock, jid, messageObj, `❌ Menyikut butuh *${BIAYA_SIKUT} Poin*, dompetmu cuma punya *${fmt(bayar.currentPoints || 0)} Poin*.`);
    return true;
  }

  session.sudahSikut.add(senderNumber);
  session.blokir.set(target, Date.now() + DURASI_SIKUT_MS);
  saveAuctionSessions();

  await send(sock, jid, messageObj,
`🤛 *SIKUTAN DI MEJA LELANG!* 💢
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
@${senderNumber.split('@')[0]} menyikut @${target.split('@')[0]} sampai terdorong dari meja!

⛔ @${target.split('@')[0]} *tidak bisa menawar selama ${Math.round(DURASI_SIKUT_MS / 1000)} detik*.
💸 Biaya sikutan: *${BIAYA_SIKUT} Poin*`,
    { mentions: [senderNumber, target] });
  return true;
}

// ─── 12. PENYELESAIAN LELANG ─────────────────────────────────────────

async function resolveAuction(sock, session) {
  const { jid, box, loot, mode } = session;

  if (session.timer) clearTimeout(session.timer);
  activeAuctions.delete(jid);
  saveAuctionSessions();
  auctionCooldowns.set(jid, Date.now());
  await db.setCooldown(jid, `LELANG:${box.id}`, box.cooldownMenit * 60 * 1000);
  // Lelang gudang tidak boleh dijeda cooldown lobby di tengah rangkaian lot.
  if (!session.gudang || session.gudang.lot >= session.gudang.total) {
    await db.setCooldown(jid, 'LELANG:LOBBY', LOBBY_COOLDOWN_MS);
  }

  if (mode === 'BUTA') return await resolveButa(sock, session);
  if (mode === 'KUTUK') return await resolveKutuk(sock, session);
  return await resolveTerbuka(sock, session);
}

async function resolveTerbuka(sock, session) {
  const { jid, box, loot, reserve, currentHighestBid, currentHighestBidder, currentHighestBidderName } = session;

  if (!currentHighestBidder) {
    await send(sock, jid, null,
`⌛ *TIDAK ADA SATU PUN TAWARAN* 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Juru lelang mengetuk palu ke meja kosong. ${box.emoji} *${box.name}* dibawa kembali ke gudang tanpa ada yang menyentuhnya.

🔓 *Padahal isinya:* ${loot.label}
${lootBerbahaya(loot) ? '_…mungkin kalian memang beruntung._' : '_…dan kalian melewatkannya begitu saja._'}`);
    await lanjutkanGudang(sock, session, null);
    return;
  }

  const winnerDigits = currentHighestBidder.split('@')[0];

  if (currentHighestBid < reserve) {
    await db.addGamePoints(currentHighestBidder, session.escrow);
    const dendaBaris = await tagihBiayaPapan(session, null);

    await send(sock, jid, null,
`🔏 *KOTAK DITARIK — HARGA RAHASIA TIDAK TERTEMBUS!* 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Juru lelang menggeleng pelan dan menarik kembali ${box.emoji} *${box.name}* dari meja.

💰 *Tawaran tertinggi:* *${fmt(currentHighestBid)} Poin* (@${winnerDigits})
🔏 *Harga rahasianya:* *${fmt(reserve)} Poin* — kurang *${fmt(reserve - currentHighestBid)} Poin*!
🔓 *Isi yang gagal kalian bawa pulang:* ${loot.label}

💸 *Poin @${winnerDigits} dikembalikan penuh*, tapi biaya papan tetap ditagih.
${dendaBaris}`,
      { mentions: Array.from(session.peserta.keys()) });

    for (const [pjid, p] of session.peserta.entries()) {
      await db.recordAuctionResult(pjid, { won: false, paid: 0, reward: 0, denda: 0, boardFee: biayaPapan(p.tertinggi), bid: p.tertinggi, kategori: 'lain' });
    }
    await lanjutkanGudang(sock, session, null);
    return;
  }

  await send(sock, jid, null,
`🔨 *TERJUAL!* 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Palu jatuh. ${box.emoji} *${box.name}* resmi jadi milik @${winnerDigits} seharga *${fmt(currentHighestBid)} Poin*.

_Juru lelang menyerahkan kotaknya. Engselnya berderit… kunci pertama terbuka…_ 🔓`,
    { mentions: [currentHighestBidder] });

  // Jeda dramatis. Tanpa ini seluruh ketegangan tiga petunjuk tadi
  // dihabiskan dalam satu pesan yang sama.
  await new Promise(r => setTimeout(r, 3000));

  const hasil = await terapkanLoot(currentHighestBidder, loot, winnerDigits);
  const dendaBaris = await tagihBiayaPapan(session, currentHighestBidder);
  await catatStatistik(session, currentHighestBidder, currentHighestBid, hasil);

  await send(sock, jid, null,
    pesanUnboxing(session, currentHighestBidder, currentHighestBidderName, winnerDigits, currentHighestBid, hasil, dendaBaris,
      await db.getGameProfile(currentHighestBidder)),
    {
      mentions: Array.from(session.peserta.keys()),
      buttons: [
        { type: 'reply', text: '📦 Lelang Lagi', id: '.lelang' },
        { type: 'reply', text: '📊 Statistikku', id: '.lelangstats' },
        { type: 'reply', text: '🏅 Papan Peringkat', id: '.lelangtop' }
      ]
    });

  await lanjutkanGudang(sock, session, { pemenang: currentHighestBidderName, harga: currentHighestBid, isi: loot.label });
}

async function resolveButa(sock, session) {
  const { jid, box, loot, reserve } = session;
  const amplop = Array.from(session.segel.entries())
    .map(([pjid, s]) => ({ jid: pjid, name: s.name, amount: s.amount }))
    .sort((a, b) => b.amount - a.amount);

  if (amplop.length === 0) {
    await send(sock, jid, null,
`⌛ *KOTAK SEGEL DIBUKA — KOSONG MELOMPONG* 📭
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tidak ada satu pun amplop masuk. ${box.emoji} *${box.name}* dibawa kembali ke gudang.

🔓 *Padahal isinya:* ${loot.label}`);
    return;
  }

  const daftarAmplop = amplop.map((a, i) =>
    `${i + 1}. ${a.name === `@${a.jid.split('@')[0]}` ? `@${a.jid.split('@')[0]}` : `*${a.name}*`} — *${fmt(a.amount)} Poin*`).join('\n');

  const pemenang = amplop[0];
  const kedua = amplop[1]?.amount || box.openBid;
  const hargaBayar = Math.max(kedua, reserve);

  // Reserve dibandingkan dengan tawaran TERTINGGI (aturan lelang standar),
  // lalu harga bayar dinaikkan ke reserve kalau perlu.
  if (pemenang.amount < reserve) {
    for (const a of amplop) await db.addGamePoints(a.jid, a.amount);
    const dendaBaris = await tagihBiayaPapan(session, null);

    await send(sock, jid, null,
`🔏 *SEGEL DIBUKA — TAK ADA YANG MENEMBUS HARGA RAHASIA!* 📜
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📨 *Isi semua amplop:*
${daftarAmplop}

🔏 *Harga rahasianya:* *${fmt(reserve)} Poin*
🔓 *Isi yang gagal dibawa pulang:* ${loot.label}

💸 Seluruh poin yang ditahan dikembalikan penuh.
${dendaBaris}`,
      { mentions: amplop.map(a => a.jid) });

    for (const a of amplop) {
      await db.recordAuctionResult(a.jid, { won: false, paid: 0, reward: 0, denda: 0, boardFee: biayaPapan(a.amount), bid: a.amount, kategori: 'lain' });
    }
    return;
  }

  // Kembalikan semua yang kalah, dan kembalikan selisih ke pemenang.
  for (const a of amplop) {
    if (a.jid === pemenang.jid) {
      const kembali = a.amount - hargaBayar;
      if (kembali > 0) await db.addGamePoints(a.jid, kembali);
    } else {
      await db.addGamePoints(a.jid, a.amount);
    }
  }

  const winnerDigits = pemenang.jid.split('@')[0];
  await send(sock, jid, null,
`📜 *SEGEL DIBUKA!* 🤫➡️📣
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📨 *Isi semua amplop, dari tertinggi:*
${daftarAmplop}

👑 *Pemenang:* @${winnerDigits}
💰 *Tawarannya:* *${fmt(pemenang.amount)} Poin*
🧾 *Yang benar-benar dibayar:* *${fmt(hargaBayar)} Poin* _(harga penawar kedua${hargaBayar === reserve && kedua < reserve ? ', dinaikkan ke harga rahasia' : ''})_
${pemenang.amount > hargaBayar ? `💸 Selisih *${fmt(pemenang.amount - hargaBayar)} Poin* dikembalikan ke pemenang.` : ''}

_Kotaknya diserahkan. Engselnya berderit…_ 🔓`,
    { mentions: amplop.map(a => a.jid) });

  await new Promise(r => setTimeout(r, 3000));

  const hasil = await terapkanLoot(pemenang.jid, loot, winnerDigits);
  const dendaBaris = await tagihBiayaPapan(session, pemenang.jid);
  await catatStatistik(session, pemenang.jid, hargaBayar, hasil);

  await send(sock, jid, null,
    pesanUnboxing(session, pemenang.jid, pemenang.name, winnerDigits, hargaBayar, hasil, dendaBaris,
      await db.getGameProfile(pemenang.jid)),
    {
      mentions: amplop.map(a => a.jid),
      buttons: [
        { type: 'reply', text: '📦 Lelang Lagi', id: '.lelang' },
        { type: 'reply', text: '📊 Statistikku', id: '.lelangstats' },
        { type: 'reply', text: '🏅 Papan Peringkat', id: '.lelangtop' }
      ]
    });
}

async function resolveKutuk(sock, session) {
  const { jid, box, loot, currentHighestBid, currentHighestBidder, currentHighestBidderName } = session;

  if (!currentHighestBidder) {
    await send(sock, jid, null,
`🕯️ *TIDAK ADA YANG BERANI MENYENTUHNYA* 😰
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pot *${fmt(session.pot)} Poin* tergeletak di meja sampai lilinnya padam. Pertapa itu datang lagi, mengambil ${box.emoji} *${box.name}*, dan pergi tanpa berkata apa-apa.

🔓 *Kutukan yang mengintai tadi:* ${loot.label}
_Bijak juga kalian._`);
    return;
  }

  const winnerDigits = currentHighestBidder.split('@')[0];

  await send(sock, jid, null,
`🔨 *TERJUAL — KEPADA YANG PALING NEKAT!* 🕯️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
@${winnerDigits} menerima *${fmt(currentHighestBid)} Poin* dan memikul ${box.emoji} *${box.name}* di pundaknya.

_Ter di peti itu mulai mendidih. Segelnya retak…_ 🔓`,
    { mentions: [currentHighestBidder] });

  await new Promise(r => setTimeout(r, 3000));

  // Potnya dibayar lebih dulu — dia memang berhak atas keberaniannya,
  // apa pun yang keluar dari peti setelah ini.
  if (currentHighestBid > 0) await db.awardGamePoints(currentHighestBidder, currentHighestBid, true);
  const hasil = await terapkanLoot(currentHighestBidder, loot, winnerDigits);
  await catatStatistik(session, currentHighestBidder, 0, { ...hasil, hadiahPoin: hasil.hadiahPoin + currentHighestBid });

  const finalProfile = await db.getGameProfile(currentHighestBidder);
  const bersih = currentHighestBid + hasil.hadiahPoin - hasil.dendaPoin;

  await send(sock, jid, null,
`🕯️ *PETI TERKUTUK TERBUKA!* 😱
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Si Nekat:* @${winnerDigits}${currentHighestBidderName === `@${winnerDigits}` ? '' : ` (${currentHighestBidderName})`}
💰 *Pot diterima:* *+${fmt(currentHighestBid)} Poin*

${hasil.title}
${hasil.detail}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *Hasil akhir:* ${bersih >= 0 ? `🟢 *UNTUNG +${fmt(bersih)} Poin*` : `🔴 *RUGI ${fmt(Math.abs(bersih))} Poin*`}${hasil.nonPoin ? ` _(belum menghitung ${hasil.nonPoin})_` : ''}
🕯️ *Petunjuk yang keluar tadi:* ${session.sifatTerungkap.length > 0 ? session.sifatTerungkap.map(sf => `_${sf}_`).join(', ') : '_tidak ada_'}
${session.sifatTerungkap.some(sf => !(loot.sifat || []).includes(sf)) ? '🎭 _Salah satu petunjuk tadi memang palsu._' : '✅ _Semua petunjuk tadi jujur._'}

💰 *Sisa dompet:* *${fmt(finalProfile?.points || 0)} Poin* • ⭐ Lv.${finalProfile?.level || 1}`,
    {
      mentions: [currentHighestBidder],
      buttons: [
        { type: 'reply', text: '🕯️ Peti Terkutuk Lagi', id: '.lelang kutuk' },
        { type: 'reply', text: '📦 Lelang Biasa', id: '.lelang' },
        { type: 'reply', text: '🏅 Papan Peringkat', id: '.lelangtop' }
      ]
    });
}

function lootBerbahaya(loot) {
  return loot.type.includes('trap') || loot.type.includes('curse') || loot.type === 'zonk' || loot.type.startsWith('kutuk_');
}

function pesanUnboxing(session, winnerJid, winnerName, winnerDigits, harga, hasil, dendaBaris, profile) {
  const untungRugi = hasil.hadiahPoin - hasil.dendaPoin - harga;
  const barisUntung = untungRugi >= 0
    ? `🟢 *UNTUNG +${fmt(untungRugi)} Poin*`
    : `🔴 *RUGI ${fmt(Math.abs(untungRugi))} Poin*`;
  const lotTxt = session.gudang ? `🏚️ *Lot ${session.gudang.lot} dari ${session.gudang.total}*\n` : '';

  return (
`📦 *ISI KOTAK TERBUKA!* 🏆
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${lotTxt}👑 *Pemenang:* @${winnerDigits}${winnerName === `@${winnerDigits}` ? '' : ` (${winnerName})`}
💰 *Dibayar:* *${fmt(harga)} Poin*

${hasil.title}
${hasil.detail}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *Hitung-hitungan:* modal *${fmt(harga)}* → ${barisUntung}${hasil.nonPoin ? ` _(belum menghitung ${hasil.nonPoin})_` : ''}
🕯️ *Petunjuk yang keluar tadi:* ${session.sifatTerungkap.length > 0 ? session.sifatTerungkap.map(sf => `_${sf}_`).join(', ') : '_tidak ada_'}
${session.sifatTerungkap.some(sf => !(session.loot.sifat || []).includes(sf)) ? '🎭 _Salah satu petunjuk tadi memang palsu._' : '✅ _Semua petunjuk tadi jujur._'}
${dendaBaris}

💰 *Sisa dompet pemenang:* *${fmt(profile?.points || 0)} Poin* • ⭐ Lv.${profile?.level || 1}`);
}

async function catatStatistik(session, winnerJid, harga, hasil) {
  await db.recordAuctionResult(winnerJid, {
    won: true, paid: harga, reward: hasil.hadiahPoin, denda: hasil.dendaPoin,
    boardFee: 0, bid: harga, kategori: hasil.kategori
  });
  for (const [pjid, p] of session.peserta.entries()) {
    if (pjid === winnerJid) continue;
    await db.recordAuctionResult(pjid, {
      won: false, paid: 0, reward: 0, denda: 0,
      boardFee: biayaPapan(p.tertinggi), bid: p.tertinggi, kategori: 'lain'
    });
  }
}

/** Lanjut ke lot berikutnya kalau ini bagian dari lelang gudang. */
async function lanjutkanGudang(sock, session, hasilLot) {
  const g = session.gudang;
  if (!g) return;

  g.riwayat.push({
    lot: g.lot,
    box: `${session.box.emoji} ${session.box.name}`,
    ...(hasilLot || { pemenang: null, harga: 0, isi: session.loot.label })
  });

  if (g.lot >= g.total) {
    const baris = g.riwayat.map(r =>
      `*Lot ${r.lot}* — ${r.box}\n   ${r.pemenang ? `👑 ${r.pemenang} • ${fmt(r.harga)} Poin • ${r.isi}` : `_tidak laku • ${r.isi}_`}`).join('\n');
    await send(sock, session.jid, null,
`🏚️ *GUDANG DITUTUP — REKAP ${g.total} LOT* 📦
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${baris}

_Pintu gudang dikunci. Ketik \`.lelang gudang\` lagi kalau dompet kalian masih bernyawa._`,
      {
        buttons: [
          { type: 'reply', text: '📊 Statistikku', id: '.lelangstats' },
          { type: 'reply', text: '🏅 Papan Peringkat', id: '.lelangtop' }
        ]
      });
    return;
  }

  g.lot += 1;
  setTimeout(async () => {
    try {
      if (activeAuctions.has(session.jid)) return; // grup keburu membuka lelang lain
      await send(sock, session.jid, null, `🏚️ _Juru lelang menyeret kotak berikutnya…_ *LOT ${g.lot} DARI ${g.total}* siap dilelang!`);
      await bukaLot(sock, session.jid, g, null);
    } catch (err) {
      console.error('[LELANG GUDANG ERROR]', err);
    }
  }, GUDANG_JEDA_MS);
}

/**
 * Tagih biaya papan ke semua peserta yang kalah.
 * `pemenangJid` boleh null (kotak ditarik) — saat itu semua peserta ditagih.
 */
async function tagihBiayaPapan(session, pemenangJid) {
  const baris = [];
  for (const [pjid, p] of session.peserta.entries()) {
    if (pemenangJid && pjid === pemenangJid) continue;
    const fee = biayaPapan(p.tertinggi);
    if (fee <= 0) continue;

    const prof = await db.getGameProfile(pjid);
    const tertagih = Math.min(fee, Math.max(0, prof?.points || 0));
    if (tertagih > 0) await db.deductGamePoints(pjid, tertagih);
    baris.push(`   • @${pjid.split('@')[0]} — *-${fmt(tertagih)} Poin*`);
  }

  if (baris.length === 0) return '';
  return `\n🧾 *Biaya papan lelang (${Math.round(BIAYA_PAPAN_RATE * 100)}% dari tawaran tertinggi):*\n${baris.join('\n')}`;
}

/** Eksekusi efek isi kotak. Mengembalikan teks + angka untuk statistik. */
async function terapkanLoot(winnerJid, loot, winnerDigits) {
  let title = '';
  let detail = '';
  let kategori = 'lain';
  let hadiahPoin = 0;
  let dendaPoin = 0;
  let nonPoin = null;   // nilai yang tidak berbentuk poin (shield, tiket, XP)

  if (loot.type === 'points' || loot.type === 'jackpot_points' || loot.type === 'mega_jackpot') {
    const won = Math.floor(Math.random() * (loot.max - loot.min + 1)) + loot.min;
    const xp = Math.floor(won / 2);
    await db.awardGamePoints(winnerJid, won, true);
    await db.grantXp(winnerJid, xp);
    hadiahPoin = won;
    kategori = 'jackpot';
    nonPoin = `${fmt(xp)} XP`;

    title = '🎉 *KANTONG POIN DITEMUKAN!* 💰';
    detail = `🎁 *Isi Kotak:* *+${fmt(won)} Akbar Poin* & *+${fmt(xp)} XP*`;

  } else if (loot.type === 'xp') {
    await db.grantXp(winnerJid, loot.amount);
    nonPoin = `${loot.amount} XP`;
    title = '⭐ *KRISTAL XP DITEMUKAN!* ⭐';
    detail = `🎁 *Isi Kotak:* *+${loot.amount} XP Karakter*\n_Tidak ada poin, tapi levelmu melesat._`;

  } else if (loot.type === 'xp_points' || loot.type === 'cashback_voucher') {
    await db.awardGamePoints(winnerJid, loot.points, true);
    await db.grantXp(winnerJid, loot.xp);
    hadiahPoin = loot.points;
    nonPoin = `${fmt(loot.xp)} XP`;
    title = '✨ *PAKET KOMBO SULTAN!* ✨';
    detail = `🎁 *Isi Kotak:* *+${fmt(loot.points)} Poin* & *+${fmt(loot.xp)} XP Booster*!`;

  } else if (loot.type === 'shield' || loot.type === 'shield_points' || loot.type === 'ultra_shield') {
    const hours = loot.durationHours || 12;
    await db.setCooldown(winnerJid, COOLDOWN_IMMUNITY, hours * 60 * 60 * 1000);
    if (loot.points) { await db.awardGamePoints(winnerJid, loot.points, true); hadiahPoin += loot.points; }
    if (loot.xp) await db.grantXp(winnerJid, loot.xp);

    nonPoin = `Shield kebal maling ${hours} jam${loot.xp ? ` & ${fmt(loot.xp)} XP` : ''}`;
    title = '🛡️ *AEGIS SECURITY SHIELD AKTIF!* 🛡️';
    detail =
      `🎁 *Isi Kotak:* *Kebal dari \`.steal\` / \`.maling\` selama ${hours} jam!*` +
      (loot.points ? `\n💰 *Bonus:* +${fmt(loot.points)} Poin${loot.xp ? ` & +${fmt(loot.xp)} XP` : ''}` : '') +
      `\n_Dompetmu aman total dari pencopetan member lain selama periode ini._`;

  } else if (loot.type === 'free_jail' || loot.type === 'free_jail_bonus') {
    await db.clearGameJail(winnerJid);
    if (loot.points) { await db.awardGamePoints(winnerJid, loot.points, true); hadiahPoin += loot.points; }

    nonPoin = 'Tiket bebas penjara';
    title = '🎫 *KARTU PENGAMPUNAN KEPOLISIAN!* 🎫';
    detail =
      `🎁 *Isi Kotak:* *Tiket Bebas Penjara Instan!*` +
      (loot.points ? `\n💰 *Bonus Poin:* +${fmt(loot.points)} Poin` : '') +
      `\n_Catatan kriminalmu diputihkan seketika._`;

  } else if (loot.type === 'jail_trap' || loot.type === 'kutuk_jail') {
    const mins = loot.minutes || 15;
    await db.setGameJail(winnerJid, mins);
    kategori = 'trap';
    // Penjara tidak berbentuk poin, tapi tetap harus muncul di baris
    // untung-rugi. Tanpa ini pemenang yang dibui terbaca "UNTUNG".
    nonPoin = `penjara ${mins} menit`;

    title = loot.type === 'kutuk_jail' ? '⛓️ *BORGOL ARWAH MENGUNCI PERGELANGANMU!* 👻' : '🚨 *JEBAKAN MELEDAK DI TANGANMU!* 💥';
    detail =
      `💣 *Isi:* ${loot.label}\n` +
      `⛓️ *Hukuman:* Penjara *${mins} menit*.\n` +
      `_Coba \`.jailbreak\` untuk kabur, atau minta teman mengetik \`.tebus @${winnerDigits}\`._`;

  } else if (loot.type === 'slip_trap' || loot.type === 'curse_points' || loot.type === 'kutuk_drain') {
    const pen = loot.penalty || 50;
    const prof = await db.getGameProfile(winnerJid);
    const tertagih = Math.min(pen, Math.max(0, prof?.points || 0));
    if (tertagih > 0) await db.deductGamePoints(winnerJid, tertagih);
    dendaPoin = tertagih;
    kategori = 'trap';

    title = '💀 *KUTUKAN MENYEDOT DOMPETMU!* ⚡';
    detail = `💣 *Isi:* ${loot.label}\n🩸 Tersedot: *-${fmt(tertagih)} Poin*`;

  } else if (loot.type === 'curse_percent' || loot.type === 'kutuk_percent') {
    const prof = await db.getGameProfile(winnerJid);
    const potong = Math.floor((prof?.points || 0) * (loot.percent / 100));
    if (potong > 0) await db.deductGamePoints(winnerJid, potong);
    dendaPoin = potong;
    kategori = 'trap';

    title = '💀 *KUTUKAN RAJA KEGELAPAN!* 💀';
    detail = `💣 *Isi:* ${loot.label}\n🌑 Badai kegelapan menyita *${loot.percent}% dompetmu* — *-${fmt(potong)} Poin*!`;

  } else if (loot.type === 'kutuk_ampun') {
    kategori = 'jackpot';
    title = '🕊️ *KUTUKANNYA TERNYATA MANDUL!* 😮‍💨';
    detail = `🎁 *Isi:* ${loot.label}\n_Ter di peti itu cuma ter biasa. Kamu memeluk pot poinnya dan pulang tanpa lecet sedikit pun. Nekat memang kadang dibayar._`;

  } else {
    const comp = loot.comp || 15;
    await db.awardGamePoints(winnerJid, comp, false);
    hadiahPoin = comp;
    kategori = 'zonk';

    const lelucon = [
      "Hanya ada selembar tisu bekas dan surat bertuliskan: 'Terima kasih atas donasi poinnya!' 🤣",
      "Sarung bantal bekas dan foto selfie bot yang sedang tersenyum lebar. 😜",
      "Sebungkus angin surga dan secarik kertas: 'Coba lagi lain kali ya!' 💨",
      "Rekaman suara tawa bot: 'Wkwkwkwk kena zonk kan!' 🤖"
    ];

    title = '🤡 *ZONK LUCU DITEMUKAN!* 🤡';
    detail = `🎁 *Isi Kotak:* ${randomItem(lelucon)}\n🪙 *Kompensasi hiburan:* +${comp} Poin`;
  }

  return { title, detail, kategori, hadiahPoin, dendaPoin, nonPoin };
}

// ─── 13. STATUS LELANG ───────────────────────────────────────────────

async function showAuctionInfo(sock, jid, messageObj) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang yang sedang aktif di grup ini.\nKetik *.lelang* untuk membuka lelang kotak misteri baru!");
    return true;
  }

  const isKutuk = session.mode === 'KUTUK';
  const isButa = session.mode === 'BUTA';

  let penawarTxt;
  if (isButa) penawarTxt = `📨 *${session.segel.size} amplop tersegel* — isinya rahasia sampai palu jatuh.`;
  else if (session.currentHighestBidder) {
    penawarTxt = `${isKutuk ? '😈 Paling nekat' : '👑 Tertinggi'}: @${session.currentHighestBidder.split('@')[0]} — *${fmt(session.currentHighestBid)} Poin*`;
  } else {
    penawarTxt = isKutuk ? `😈 _Belum ada yang berani._` : `👑 _Belum ada penawar (harga buka ${fmt(session.box.openBid)} Poin)_`;
  }

  const target = session.currentHighestBidder
    ? (isKutuk ? Math.max(0, session.currentHighestBid - session.box.minInc) : session.currentHighestBid + session.box.minInc)
    : (isKutuk ? Math.max(0, session.pot - session.box.minInc) : session.box.openBid);

  const faseTxt = session.fase === 'TAWAR'
    ? `⏳ *Fase Tawar:* sisa *${Math.max(1, Math.ceil((session.bidEndTime - Date.now()) / 1000))} detik*`
    : `🔨 *Fase Palu:* ketukan ke-*${session.paluStep}/2*${session.paluReset > 0 ? ` _(sudah ${session.paluReset}x diulang)_` : ''}`;

  const kluTxt = session.sifatTerungkap.length > 0
    ? session.sifatTerungkap.map((sf, i) => `${i + 1}. ${PETUNJUK[sf] || sf}`).join('\n')
    : '_Belum ada petunjuk yang bocor._';

  const modeTxt = { TERBUKA: '📦 Lelang Terbuka', BUTA: '🤫 Lelang Buta (Vickrey)', KUTUK: '🕯️ Lelang Terbalik Terkutuk' }[session.mode];
  const lotTxt = session.gudang ? `\n🏚️ *Lot ${session.gudang.lot} dari ${session.gudang.total}*` : '';

  await send(sock, jid, messageObj,
`📦 *STATUS LELANG KOTAK MISTERI* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎛️ *Mode:* ${modeTxt}${lotTxt}
${session.box.emoji} *${session.box.name}*
📝 _${session.box.desc}_
👤 *Host:* ${session.hostName}
${isKutuk ? `💰 *Pot tanggungan awal:* *${fmt(session.pot)} Poin*` : ''}

${penawarTxt}
${isButa ? '' : `📈 *Tawaran sah berikutnya:* *${fmt(target)} Poin*${isKutuk ? ' atau kurang' : ''}\n`}👥 *Peserta:* *${session.peserta.size} orang*
${faseTxt}

🕯️ *Petunjuk yang sudah bocor (${session.sifatTerungkap.length}/${session.klu.length}):*
${kluTxt}

👉 ${isButa ? 'Kirim `.bid <jumlah>` ke *DM bot*.' : `Ketik \`.bid ${target}\` atau \`.bidup\`!`}`,
    {
      mentions: session.currentHighestBidder ? [session.currentHighestBidder] : [],
      buttons: isButa
        ? [{ type: 'reply', text: '👃 Endus Kotak', id: '.endus' }]
        : [
          { type: 'reply', text: isKutuk ? `😈 Turun ke ${fmt(target)}` : `🔥 Tawar ${fmt(target)} Poin`, id: `.bid ${target}` },
          { type: 'reply', text: '👃 Endus Kotak', id: '.endus' }
        ]
    });

  return true;
}

// ─── 14. STATISTIK & PAPAN PERINGKAT ─────────────────────────────────

function gelarLelang(stats) {
  const profit = (stats.total_hadiah || 0) - (stats.total_bid_dibayar || 0) - (stats.total_biaya_papan || 0) - (stats.total_denda || 0);
  if ((stats.lelang_diikuti || 0) < 3) return '🪙 Pengunjung Pasar';
  if (profit > 5000) return '👑 Sultan Balai Lelang';
  if (profit > 0) return '💼 Saudagar Licin';
  if ((stats.trap_count || 0) >= 3) return '💀 Langganan Jebakan';
  if ((stats.zonk_count || 0) >= 3) return '🤡 Kolektor Zonk';
  return '📦 Pemburu Kotak';
}

async function showAuctionStats(sock, jid, senderNumber, messageObj) {
  const mentions = messageObj?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const targetJid = mentions[0] || senderNumber;

  const stats = await db.getAuctionStats(targetJid);
  if (!stats || (stats.lelang_diikuti || 0) === 0) {
    await send(sock, jid, messageObj, `📊 ${targetJid === senderNumber ? 'Kamu' : `@${targetJid.split('@')[0]}`} belum pernah ikut Lelang Kotak Misteri.\n👉 Ketik \`.lelang\` di grup untuk mulai!`, { mentions: [targetJid] });
    return true;
  }

  const cust = await db.getCustomerByPhone(targetJid);
  const nama = cust?.nama || `@${targetJid.split('@')[0]}`;
  const profit = (stats.total_hadiah || 0) - (stats.total_bid_dibayar || 0) - (stats.total_biaya_papan || 0) - (stats.total_denda || 0);
  const winRate = Math.round(((stats.lelang_menang || 0) / Math.max(1, stats.lelang_diikuti)) * 100);

  await send(sock, jid, messageObj,
`📊 *STATISTIK LELANG KOTAK MISTERI*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *${nama}*
🏅 *Gelar:* ${gelarLelang(stats)}

📦 Lelang diikuti: *${stats.lelang_diikuti}x*
🏆 Kotak dimenangkan: *${stats.lelang_menang || 0}x* _(${winRate}%)_
💸 Total dibayar: *${fmt(stats.total_bid_dibayar)} Poin*
🎁 Total isi kotak: *${fmt(stats.total_hadiah)} Poin*
💀 Total denda kutukan: *${fmt(stats.total_denda)} Poin*
🧾 Total biaya papan: *${fmt(stats.total_biaya_papan)} Poin*
${profit >= 0 ? `🟢 *Untung bersih: +${fmt(profit)} Poin*` : `🔴 *Rugi bersih: ${fmt(Math.abs(profit))} Poin*`}

🔨 Tawaran tertinggi: *${fmt(stats.bid_tertinggi)} Poin*
💎 Jackpot: *${stats.jackpot_count || 0}x* • 💣 Jebakan: *${stats.trap_count || 0}x* • 🤡 Zonk: *${stats.zonk_count || 0}x*

_Ketik \`.lelangtop\` untuk papan peringkat._`, { mentions: [targetJid] });
  return true;
}

async function showAuctionLeaderboard(sock, jid, messageObj) {
  const rows = await db.getAuctionLeaderboard(10, 1);
  if (!rows || rows.length === 0) {
    await send(sock, jid, messageObj, "🏅 Belum ada juragan lelang yang tercatat.\n👉 Ketik `.lelang` di grup untuk jadi yang pertama!");
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
    const profit = Number(r.profit) || 0;
    const untungTxt = profit >= 0 ? `🟢 +${fmt(profit)}` : `🔴 ${fmt(profit)}`;
    return `${medali[i] || `${i + 1}.`} *${nama}*\n     ${untungTxt} Poin • 🏆 ${r.lelang_menang || 0} kotak • 💎 ${r.jackpot_count || 0} jackpot • 💣 ${r.trap_count || 0} jebakan`;
  }).join('\n');

  await send(sock, jid, messageObj,
    `🏅 *PAPAN PERINGKAT JURAGAN LELANG* 📦\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${baris}\n\n` +
    `_Urutan: untung bersih (isi kotak dikurangi bayaran, denda & biaya papan)._\n👉 Ketik \`.lelangstats\` untuk statistik pribadimu.`,
    { mentions });
  return true;
}

// ─── 15. BATALKAN LELANG ─────────────────────────────────────────────

async function cancelAuction(sock, jid, senderNumber, messageObj, isAdmin, isOwner) {
  const session = activeAuctions.get(jid);
  if (!session) {
    await send(sock, jid, messageObj, "❌ Tidak ada sesi lelang aktif di grup ini untuk dibatalkan.");
    return true;
  }

  const isHost = session.hostJid === senderNumber;
  if (!isHost && !isAdmin && !isOwner) {
    await send(sock, jid, messageObj, "⚠️ Hanya Host yang membuka lelang atau Admin grup yang dapat membatalkan lelang ini!");
    return true;
  }

  if (session.timer) clearTimeout(session.timer);
  if (session.gudang) session.gudang.lot = session.gudang.total; // hentikan rangkaian lot
  activeAuctions.delete(jid);
  saveAuctionSessions();
  await db.setCooldown(jid, 'LELANG:LOBBY', LOBBY_COOLDOWN_MS);

  // Pembatalan tidak boleh memakan poin siapa pun: semua tahanan kembali penuh
  // dan biaya papan tidak ditagih.
  let dikembalikan = 0;
  const kembaliKe = [];
  if (session.mode === 'BUTA') {
    for (const [pjid, s] of session.segel.entries()) {
      if (s.amount > 0) { await db.addGamePoints(pjid, s.amount); dikembalikan += s.amount; kembaliKe.push(pjid); }
    }
  } else if (session.currentHighestBidder && session.escrow > 0) {
    await db.addGamePoints(session.currentHighestBidder, session.escrow);
    dikembalikan = session.escrow;
    kembaliKe.push(session.currentHighestBidder);
  }

  await send(sock, jid, messageObj,
    `🛑 *LELANG DIBATALKAN!*\nSesi ${session.box.emoji} *${session.box.name}* dihentikan oleh @${senderNumber.split('@')[0]}.` +
    (dikembalikan > 0 ? `\n💸 Seluruh poin yang ditahan (*${fmt(dikembalikan)} Poin*) sudah dikembalikan penuh.` : '') +
    `\n_Tidak ada biaya papan yang ditagih._`,
    { mentions: [senderNumber, ...kembaliKe] });

  return true;
}

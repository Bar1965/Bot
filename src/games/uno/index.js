/**
 * 🎴 UNO WHATSAPP — MESIN PERMAINAN
 *
 * Dirancang dengan satu batasan keras di depan mata: **tombol WhatsApp tidak
 * ada di bot ini.** `sendInteractiveButtons` di bot.js hanya merender teks
 * "(Ketik `x`)", jadi tidak ada yang bisa di-tap. Semua interaksi berarti
 * mengetik, dan tiap ketikan tambahan adalah beban buat pemain.
 *
 * Maka desainnya berputar pada satu hal: **satu giliran = satu ketikan pendek.**
 *  • Tangan dikirim ke DM sudah bernomor, kartu legal ditandai ✅ — pemain tidak
 *    perlu hafal aturan, cukup baca nomornya.
 *  • Main kartu = `.u 3`. Kartu liar sekalian warnanya = `.u 3 merah`.
 *  • Tidak punya kartu legal? Bot menarikkan sendiri. Tidak ada yang perlu diketik.
 *  • Lupa bilang "UNO" tidak dihukum — bot yang mengumumkan. Itu sumber ribut
 *    nomor satu di UNO dan tidak adil di chat yang lambat.
 *
 * Pelajaran dari audit Buckshot ikut dipakai sejak awal, bukan ditambal belakangan:
 *  • `samaJid` — perbandingan pemain tahan beda format JID (@lid, @c.us, sufiks perangkat).
 *  • `kirimAman` — satu kegagalan kirim tidak boleh membekukan meja dan menyandera taruhan.
 *  • `sesi.busy` — kunci re-entrancy supaya dua pesan beruntun tidak diproses dobel.
 *  • `db.sesiGameId('uno', jid)` — baris sesi sendiri, tidak menimpa game lain di grup yang sama.
 *  • Fungsi aturan murni yang diekspor supaya smoke test menguji kode sungguhan.
 */

import * as db from '../../../database.js';
import { send } from '../helpers.js';
import {
  WARNA, buatDeck, kocok, labelKartu, labelAtas, bolehDimainkan,
  bacaWarna, efekKartu, isLiar, nilaiTangan
} from './kartu.js';
import { BOT_UNO, isBotUno, namaBot, waktuBerpikir, putuskanLangkahBot } from './ai.js';
import { bufferTanganUno } from './gambar.js';

export const activeUno = new Map();

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const KARTU_AWAL = 7;
const MIN_BET = 20;
const DEFAULT_BET = 50;
const MAX_BET = 100_000;
const LOBBY_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 45_000;
const JEDA_ANTAR_GILIRAN_MS = 900;

// ─── Utilitas identitas & pengiriman ──────────────────────────────

function tag(jid) {
  return `@${String(jid || '').split('@')[0]}`;
}

export function samaJid(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ua = String(a).split('@')[0].split(':')[0];
  const ub = String(b).split('@')[0].split(':')[0];
  if (ua === ub) return true;
  try { return db.isPhoneMatch(ua, ub); } catch (_) { return false; }
}

async function kirimAman(sock, jid, messageObj, text, options = {}) {
  try {
    return await send(sock, jid, messageObj, text, options);
  } catch (e) {
    console.error('[UNO_SEND_ERR]', e?.message || e);
    return null;
  }
}

async function dm(sock, jid, text) {
  if (isBotUno(jid)) return true;
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (_) {
    return false;
  }
}

function labelPemain(sesi, jid) {
  if (isBotUno(jid)) return namaBot(jid);
  return tag(jid);
}

function mentionsManusia(sesi) {
  return sesi.players.filter(p => !isBotUno(p));
}

function bersihkanTimer(sesi) {
  if (sesi?.timer) { clearTimeout(sesi.timer); sesi.timer = null; }
}

function bersihkanLobbyTimer(sesi) {
  if (sesi?.lobbyTimer) { clearTimeout(sesi.lobbyTimer); sesi.lobbyTimer = null; }
}

// ─── Aturan meja (murni, diuji smoke test) ────────────────────────

/** Indeks pemain berikutnya dengan menghormati arah putaran. */
export function indeksBerikut(idx, arah, jumlah, langkah = 1) {
  if (jumlah <= 0) return 0;
  return ((idx + arah * langkah) % jumlah + jumlah) % jumlah;
}

/**
 * Kembalikan tumpukan buangan ke deck saat deck habis.
 * Kartu liar HARUS dilucuti warnanya — kalau tidak, Wild yang dulu dipilih
 * merah akan kembali ke deck sebagai kartu merah permanen dan jumlah kartu
 * per warna jadi kacau.
 */
export function isiUlangDeck(sesi, acak = Math.random) {
  if (sesi.buang.length <= 1) return false;
  const atas = sesi.buang.pop();
  const daurUlang = sesi.buang.map(k => (isLiar(k) ? { ...k, warna: null } : k));
  sesi.buang = [atas];
  sesi.deck = kocok(daurUlang, acak);
  return true;
}

export function ambilDariDeck(sesi, jumlah, acak = Math.random) {
  const hasil = [];
  for (let i = 0; i < jumlah; i++) {
    if (sesi.deck.length === 0 && !isiUlangDeck(sesi, acak)) break;
    if (sesi.deck.length === 0) break;
    hasil.push(sesi.deck.pop());
  }
  return hasil;
}

/**
 * Terapkan kartu yang baru dimainkan ke keadaan meja.
 *
 * Fungsi ini yang memegang seluruh aturan pergerakan: warna aktif, pembalikan
 * arah, siapa yang kena tarik, dan giliran berikutnya. Sengaja dibuat mutasi
 * di tempat + tanpa I/O supaya smoke test bisa menjalankan ronde penuh tanpa
 * socket maupun database.
 */
export function terapkanKartu(sesi, kartu, warnaPilihan = null, acak = Math.random) {
  const jumlah = sesi.players.length;

  sesi.buang.push(kartu);
  sesi.atas = kartu;
  sesi.warnaAktif = isLiar(kartu) ? (warnaPilihan || sesi.warnaAktif) : kartu.warna;

  const efek = efekKartu(kartu, jumlah);
  if (efek.balik) sesi.arah = -sesi.arah;

  const idxKorban = indeksBerikut(sesi.idxAktif, sesi.arah, jumlah);
  const korban = (efek.lewati || efek.tarik > 0) ? sesi.players[idxKorban] : null;

  // Aturan penumpukan aktif: kartu tarik TIDAK langsung dieksekusi. Nilainya
  // menumpuk dan pemain berikutnya diberi giliran penuh untuk menimpanya.
  // Tanpa cabang ini, korban langsung menarik dan dilewati — dan aturan
  // penumpukan tidak pernah benar-benar berlaku.
  if (sesi.aturan?.tumpuk && efek.tarik > 0) {
    sesi.tumpukan = {
      jumlah: (sesi.tumpukan?.jumlah || 0) + efek.tarik,
      jenis: kartu.simbol
    };
    sesi.idxAktif = indeksBerikut(sesi.idxAktif, sesi.arah, jumlah, 1);
    sesi.turnSeq = (sesi.turnSeq || 0) + 1;
    return {
      korban, tarik: 0, lewati: false, balik: efek.balik, ditarik: [],
      menumpuk: sesi.tumpukan.jumlah, jenisTumpuk: sesi.tumpukan.jenis
    };
  }

  let ditarik = [];
  if (efek.tarik > 0 && korban) {
    ditarik = ambilDariDeck(sesi, efek.tarik, acak);
    if (ditarik.length) sesi.tangan.get(korban).push(...ditarik);
  }

  sesi.idxAktif = indeksBerikut(sesi.idxAktif, sesi.arah, jumlah, efek.lewati ? 2 : 1);
  sesi.turnSeq = (sesi.turnSeq || 0) + 1;

  return { korban, tarik: efek.tarik, lewati: efek.lewati, balik: efek.balik, ditarik, menumpuk: 0 };
}

/**
 * Pemain aktif menelan seluruh tumpukan +2/+4 yang berjalan lalu kehilangan
 * giliran. Inilah satu-satunya cara rantai penumpukan berakhir.
 */
export function serapTumpukan(sesi, acak = Math.random) {
  const jumlah = sesi.tumpukan?.jumlah || 0;
  if (jumlah <= 0) return { korban: null, ditarik: [], jumlah: 0 };

  const korban = sesi.players[sesi.idxAktif];
  const ditarik = ambilDariDeck(sesi, jumlah, acak);
  if (ditarik.length) sesi.tangan.get(korban).push(...ditarik);
  sesi.tumpukan = { jumlah: 0, jenis: null };
  lewatiGiliran(sesi);

  return { korban, ditarik, jumlah };
}

/** Majukan giliran satu langkah tanpa memainkan kartu (dipakai saat pemain pas). */
export function lewatiGiliran(sesi) {
  sesi.idxAktif = indeksBerikut(sesi.idxAktif, sesi.arah, sesi.players.length);
  sesi.turnSeq = (sesi.turnSeq || 0) + 1;
}

function pemainAktif(sesi) {
  return sesi.players[sesi.idxAktif];
}

// ─── Aturan rumah opsional (Fase 3) ───────────────────────────────
//
// Ketiganya MATI secara bawaan, dan itu keputusan sadar. Penumpukan +2/+4
// mengubah satu giliran jadi rantai panjang yang harus dipantau terus-menerus,
// dan penalti lupa "UNO" adalah sumber ribut nomor satu di meja UNO mana pun —
// keduanya membuat permainan lebih repot, bukan lebih seru, untuk kebanyakan
// orang. Yang mau versi keras tinggal menyalakannya per meja.

/** Baca taruhan + aturan opsional dari `.uno 50 tumpuk penalti skor 300`. */
export function bacaAturan(args) {
  const kata = (args || []).slice(1).map(a => String(a || '').toLowerCase());
  const idxSkor = kata.findIndex(k => ['skor', 'score', 'target'].includes(k));

  let targetSkor = 0;
  if (idxSkor !== -1) {
    const sesudah = kata.slice(idxSkor + 1).find(k => /^\d+$/.test(k));
    targetSkor = sesudah ? Math.min(2000, Math.max(100, Number(sesudah))) : 300;
  }

  // Angka SEBELUM kata "skor" adalah taruhan; angka sesudahnya milik target skor.
  const angkaTaruhan = kata.find((k, i) => /^\d+$/.test(k) && (idxSkor === -1 || i < idxSkor));
  const buyIn = Math.min(MAX_BET, Math.max(MIN_BET, angkaTaruhan ? Number(angkaTaruhan) : DEFAULT_BET));

  return {
    buyIn,
    tumpuk: kata.some(k => ['tumpuk', 'stack', 'tumpukan'].includes(k)),
    penalti: kata.some(k => ['penalti', 'penalty', 'ketat', 'hardcore'].includes(k)),
    targetSkor
  };
}

/**
 * Legalitas yang berlaku SAAT INI — sudah memperhitungkan tumpukan +2/+4.
 *
 * Saat ada tumpukan berjalan, satu-satunya langkah sah adalah menimpanya
 * dengan kartu sejenis. Sengaja tipe yang sama persis (+2 di atas +2, +4 di
 * atas +4): membolehkan +4 menimpa +2 adalah aturan rumah yang paling sering
 * jadi bahan berdebat di tengah permainan.
 */
export function bolehSekarang(sesi, kartu) {
  if (sesi.tumpukan?.jumlah > 0) return kartu?.simbol === sesi.tumpukan.jenis;
  return bolehDimainkan(kartu, sesi.atas, sesi.warnaAktif);
}

export function legalSekarang(sesi, tangan) {
  return (tangan || []).filter(k => bolehSekarang(sesi, k));
}

export function adaLegalSekarang(sesi, tangan) {
  return legalSekarang(sesi, tangan).length > 0;
}

function konteksTumpuk(sesi) {
  return sesi.tumpukan?.jumlah > 0 ? { tumpukJenis: sesi.tumpukan.jenis } : {};
}

// ─── Ekonomi poin ─────────────────────────────────────────────────

/**
 * Batas hadiah nyata — menyalin konvensi yang sudah dipakai Texas Hold'em.
 *
 * Bot tidak punya saldo, jadi taruhan bot di pot TIDAK ada backing-nya. Kalau
 * dibayar penuh, `.uno bot 5` jadi mesin cetak poin. Pemenang boleh membawa
 * seluruh uang manusia, plus tambahan dari taruhan bot maksimal 1:1 terhadap
 * taruhannya sendiri.
 *
 * Dihitung dari `potManusia`/`potBot` yang dikunci saat ronde dimulai, BUKAN
 * dari `sesi.players` saat itu juga — kalau tidak, pemain yang menyerah di
 * tengah ronde ikut mengecilkan hadiah pemenang padahal taruhannya sudah
 * telanjur masuk pot.
 */
export function batasKreditNyata(sesi) {
  const potManusia = sesi.potManusia ?? 0;
  const potBot = sesi.potBot ?? 0;
  return potManusia + Math.min(potBot, sesi.buyIn);
}

async function refundSesi(sesi) {
  let poin = 0;
  for (const p of [...(sesi.sudahBayar || [])]) {
    if (isBotUno(p)) continue;
    try {
      await db.addGamePoints(p, sesi.buyIn);
      poin += sesi.buyIn;
    } catch (_) {}
  }
  sesi.sudahBayar?.clear();
  return poin;
}

// ─── Tampilan ─────────────────────────────────────────────────────

/** Peringatan tumpukan +2/+4 di kepala tampilan tangan, kosong kalau tidak ada. */
function barisTumpukan(sesi) {
  if (!(sesi.tumpukan?.jumlah > 0)) return '';
  const jenis = sesi.tumpukan.jenis === 'D2' ? '+2' : '+4';
  return `🔁 *TUMPUKAN +${sesi.tumpukan.jumlah} MENANTIMU!* Hanya kartu *${jenis}* yang bisa menimpanya.\n`;
}

/** Apa yang terjadi kalau pemain tidak punya langkah sah. */
function pesanTakBisa(sesi) {
  if (sesi.tumpukan?.jumlah > 0) {
    return `⛔ Tidak ada kartu untuk menimpa — kamu akan menelan *${sesi.tumpukan.jumlah} kartu* otomatis.`;
  }
  return '⛔ Tidak ada kartu yang bisa dimainkan — bot akan menarikkan kartu untukmu otomatis.';
}

/** Daftar aturan opsional yang menyala di meja ini, atau null kalau semua standar. */
function ringkasAturan(sesi) {
  const a = sesi.aturan || {};
  const nyala = [];
  if (a.tumpuk) nyala.push('🔁 Kartu +2/+4 boleh ditumpuk');
  if (a.penalti) nyala.push('🔔 Wajib menyatakan UNO (`.u <nomor> uno`), lalai kena +2');
  if (a.targetSkor) nyala.push(`🏁 Main beberapa ronde sampai ${a.targetSkor} poin`);
  return nyala.length ? nyala.join('\n  • ') : null;
}

function barisPemain(sesi) {
  return sesi.players.map((p, i) => {
    const n = sesi.tangan.get(p)?.length ?? 0;
    const penanda = i === sesi.idxAktif ? '👉 ' : '';
    const bahaya = n === 1 ? ' 🔥' : '';
    return `${penanda}${labelPemain(sesi, p)} (${n})${bahaya}`;
  }).join(' · ');
}

/**
 * Papan meja — sengaja dipadatkan.
 *
 * Bentuk lamanya 12 baris penuh garis pemisah, dan itu masih lumayan sebagai
 * pesan sesekali. Tapi papan ini muncul di setiap giliran, jadi tiap baris
 * yang tidak benar-benar dibutuhkan terbayar puluhan kali per ronde. Yang
 * disisakan cuma yang dipakai pemain untuk mengambil keputusan.
 */
export function renderMeja(sesi) {
  const aktif = pemainAktif(sesi);
  const arah = sesi.arah === 1 ? '➡️' : '⬅️';
  const judul = sesi.aturan?.targetSkor ? `🎴 *UNO* · Ronde ${sesi.ronde}` : '🎴 *UNO*';

  const tumpuk = sesi.tumpukan?.jumlah > 0
    ? `\n🔁 *TUMPUKAN +${sesi.tumpukan.jumlah}* — hanya *${sesi.tumpukan.jenis === 'D2' ? '+2' : '+4'}* yang bisa menimpa!`
    : '';

  const jejak = (sesi.riwayat || []).length
    ? `\n${sesi.riwayat.map(r => `▸ ${r}`).join('\n')}`
    : '';

  const giliran = isBotUno(aktif)
    ? `👉 Giliran ${labelPemain(sesi, aktif)}…`
    : `👉 Giliran ${labelPemain(sesi, aktif)} — cek DM, ketik \`.u <nomor>\` _(${TURN_TIMEOUT_MS / 1000}s)_`;

  return (
`${judul}  ·  ${labelAtas(sesi.atas, sesi.warnaAktif)}  ·  ${arah}  ·  📦${sesi.deck.length}${tumpuk}
👥 ${barisPemain(sesi)}${jejak}
${giliran}`
  );
}

function renderTangan(sesi, jid, catatan = '') {
  const tangan = sesi.tangan.get(jid) || [];
  const baris = tangan.map((k, i) => {
    const ok = bolehSekarang(sesi, k);
    return `${ok ? '✅' : '⛔'} *${i + 1}.* ${labelKartu(k)}`;
  }).join('\n') || '_Tanganmu kosong._';

  const adaLegal = adaLegalSekarang(sesi, tangan);

  return (
`🎴 *TANGAN UNO KAMU* (${tangan.length} kartu)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🃏 *Kartu Atas:* ${labelAtas(sesi.atas, sesi.warnaAktif)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${baris}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${barisTumpukan(sesi)}${catatan ? `${catatan}\n` : ''}${adaLegal
  ? '✅ = bisa dimainkan. Ketik `.u <nomor>` *di grup*.\n⭐ Kartu liar sekalian warnanya: `.u 3 merah`'
  : pesanTakBisa(sesi)}`
  );
}

/** Keterangan pendek untuk gambar tangan — nomornya sudah tercetak di kartunya. */
function kaptenTangan(sesi, jid, catatan = '') {
  const tangan = sesi.tangan.get(jid) || [];
  const adaLegal = adaLegalSekarang(sesi, tangan);

  return (
`🎴 *TANGAN UNO KAMU* — ${tangan.length} kartu
🃏 *Kartu Atas:* ${labelAtas(sesi.atas, sesi.warnaAktif)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${barisTumpukan(sesi)}${catatan ? `${catatan}\n` : ''}${adaLegal
  ? '🟢 Kartu bernomor *hijau* bisa dimainkan, yang redup tidak.\nKetik `.u <nomor>` *di grup*.\n⭐ Kartu liar sekalian warnanya: `.u 3 merah`'
  : pesanTakBisa(sesi)}`
  );
}

/**
 * Kirim tangan pemain sebagai GAMBAR bernomor, jatuh ke daftar teks kalau
 * penggambarannya gagal.
 *
 * Gambar bukan hiasan di sini: tanpa tombol WhatsApp, satu-satunya cara pemain
 * memilih kartu adalah menyebut nomornya, dan nomor yang tercetak langsung di
 * atas kartunya jauh lebih cepat dibaca daripada daftar teks belasan baris.
 * Tapi render TIDAK BOLEH jadi titik gagal baru — apa pun yang meledak di
 * @napi-rs/canvas berakhir sebagai teks biasa, bukan giliran yang hilang.
 */
async function dmTangan(sock, sesi, jid, catatan = '') {
  if (isBotUno(jid)) return true;
  const tangan = sesi.tangan.get(jid) || [];

  try {
    const gambar = await bufferTanganUno(tangan, {
      atas: sesi.atas,
      warnaAktif: sesi.warnaAktif,
      bolehFn: (k) => bolehSekarang(sesi, k)
    });
    if (gambar) {
      await sock.sendMessage(jid, { image: gambar, caption: kaptenTangan(sesi, jid, catatan) });
      return true;
    }
  } catch (e) {
    console.warn('[UNO_GBR] Gagal mengirim gambar tangan, jatuh ke teks:', e?.message || e);
  }

  return await dm(sock, jid, renderTangan(sesi, jid, catatan));
}

// ─── Papan hidup (satu pesan yang diperbarui) ─────────────────────
//
// Versi pertama mengirim papan 12 baris SETIAP giliran sambil men-tag seluruh
// pemain. Satu ronde rata-rata 38 giliran, jadi grup dihujani ~38 pesan panjang
// dan tiap orang berdering 38 kali — persis keluhan "terlalu rame dan ngespam".
//
// Sekarang papannya cuma SATU pesan yang diedit di tempat, memakai pola yang
// sudah terbukti di umaDerby.js (`edit: key`, dengan cadangan kirim-baru kalau
// gagal). Yang di-tag pun hanya pemain yang sedang mendapat giliran, bukan
// semua orang. Notifikasi sungguhan tetap sampai lewat DM berisi kartunya —
// itulah yang memang perlu dia lihat.

/** Sesudah sekian giliran, papan dikirim ulang supaya tidak terkubur obrolan. */
const JANGKAR_ULANG_TIAP = 12;

/** Jejak langkah terakhir, ditumpuk di papan supaya tidak perlu pesan sendiri. */
function catatRiwayat(sesi, baris) {
  if (!baris) return;
  sesi.riwayat = [...(sesi.riwayat || []), baris].slice(-3);
}

/**
 * Perbarui papan hidup. Mengembalikan true kalau berhasil.
 *
 * `pingAktif` hanya dinyalakan saat papan dijangkarkan ulang — mengedit pesan
 * tidak memicu notifikasi, jadi menaruh mention di setiap edit percuma dan
 * cuma menambah beban.
 */
async function perbaruiPapan(sock, jid, sesi) {
  const teks = renderMeja(sesi);
  // Papan menyebut SEMUA pemain manusia sebagai @tag, jadi semuanya harus ikut
  // di `mentions` supaya tagnya benar-benar tertaut dan bukan tampil sebagai
  // deretan angka. Ini tidak menambah dering: hanya pesan BARU yang memicu
  // notifikasi, dan pesan baru cuma terjadi saat papan dijangkarkan ulang.
  const sebut = mentionsManusia(sesi);

  const kirimBaru = async () => {
    try {
      const msg = await send(sock, jid, null, teks, { mentions: sebut });
      sesi.papanKey = msg?.key || null;
      sesi.papanUmur = 0;
      return true;
    } catch (e) {
      console.error('[UNO_PAPAN_ERR]', e?.message || e);
      sesi.papanKey = null;
      return false;
    }
  };

  // Belum ada papan, atau sudah terlalu lama di atas — jangkarkan ulang.
  if (!sesi.papanKey || (sesi.papanUmur || 0) >= JANGKAR_ULANG_TIAP) {
    return await kirimBaru();
  }

  try {
    await sock.sendMessage(jid, { text: teks, edit: sesi.papanKey, mentions: sebut });
    sesi.papanUmur = (sesi.papanUmur || 0) + 1;
    return true;
  } catch (e) {
    // WhatsApp menolak mengedit pesan yang terlalu tua (sekitar 15 menit).
    // Ronde dengan pemain yang berpikir lama pasti menabraknya, jadi ini jalur
    // normal — bukan kegagalan.
    return await kirimBaru();
  }
}

/** Papan ditutup saat ronde selesai supaya ronde berikutnya punya papan sendiri. */
function lepasPapan(sesi) {
  sesi.papanKey = null;
  sesi.papanUmur = 0;
  sesi.riwayat = [];
}

// ─── Alur giliran ─────────────────────────────────────────────────

/**
 * Jantung permainan: umumkan keadaan meja, lalu jalankan giliran pemain aktif.
 *
 * Semua percabangan (bot / manusia / tidak punya kartu legal) berakhir di sini,
 * dan tiap langkah berikutnya dijadwalkan lewat setTimeout — bukan rekursi
 * langsung — supaya rantai "empat pemain berturut-turut tidak punya kartu
 * legal" tidak menumpuk stack dan pesannya tetap terbaca satu per satu.
 */
async function lanjutGiliran(sock, jid, aksiTerakhir = '') {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return;

  bersihkanTimer(sesi);

  const aktif = pemainAktif(sesi);

  // Jendela `.uno tangkap` menutup begitu giliran si pelupa kembali padanya —
  // lawan sudah dapat satu putaran penuh untuk memergokinya.
  if (sesi.lupaUno && samaJid(aktif, sesi.lupaUno.jid)) sesi.lupaUno = null;

  catatRiwayat(sesi, aksiTerakhir);
  await perbaruiPapan(sock, jid, sesi);

  const seq = sesi.turnSeq;

  if (isBotUno(aktif)) {
    sesi.timer = setTimeout(() => { jalankanGiliranBot(sock, jid, seq).catch(e => console.error('[UNO_BOT_ERR]', e)); }, waktuBerpikir());
    return;
  }

  const tangan = sesi.tangan.get(aktif) || [];

  // Tidak punya kartu legal → tarik otomatis. Pemain tidak perlu mengetik apa pun.
  if (!adaLegalSekarang(sesi, tangan)) {
    sesi.timer = setTimeout(() => { tarikOtomatis(sock, jid, seq).catch(e => console.error('[UNO_DRAW_ERR]', e)); }, JEDA_ANTAR_GILIRAN_MS);
    return;
  }

  await dmTangan(sock, sesi, aktif);
  sesi.timer = setTimeout(() => { giliranHabis(sock, jid, seq).catch(e => console.error('[UNO_TIMEOUT_ERR]', e)); }, TURN_TIMEOUT_MS);
}

/** Menarik satu kartu untuk pemain aktif yang tidak punya langkah legal. */
async function tarikOtomatis(sock, jid, seq) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING' || sesi.turnSeq !== seq || sesi.busy) return;

  sesi.busy = true;
  try {
    const aktif = pemainAktif(sesi);
    const tangan = sesi.tangan.get(aktif);

    // Ada tumpukan +2/+4 berjalan dan pemain tidak punya kartu untuk menimpa:
    // dia menelan seluruh tumpukan sekaligus, bukan menarik satu kartu biasa.
    if (sesi.tumpukan?.jumlah > 0) {
      const hasil = serapTumpukan(sesi);
      if (!isBotUno(hasil.korban)) {
        await dmTangan(sock, sesi, hasil.korban, `💥 Kamu menelan tumpukan *+${hasil.jumlah}* dan kehilangan giliran.`);
      }
      await lanjutGiliran(sock, jid, `${labelPemain(sesi, hasil.korban)} · 💥 menelan tumpukan +${hasil.ditarik.length}`);
      return;
    }

    const [kartu] = ambilDariDeck(sesi, 1);

    if (!kartu) {
      lewatiGiliran(sesi);
      await lanjutGiliran(sock, jid, `${labelPemain(sesi, aktif)} · 📦 deck habis, dilewati`);
      return;
    }

    tangan.push(kartu);

    if (bolehSekarang(sesi, kartu)) {
      // Kartu tarikan boleh langsung dimainkan — giliran tetap miliknya.
      if (isBotUno(aktif)) {
        const langkah = putuskanLangkahBot(tangan, sesi.atas, sesi.warnaAktif, konteksBot(sesi));
        if (langkah.aksi === 'main') {
          // Kunci sudah dipegang di sini — panggil intinya langsung, bukan
          // pembungkusnya, kalau tidak langkah ini ditolak kuncinya sendiri.
          await eksekusiKartuInti(sock, jid, sesi, aktif, langkah.indeks, langkah.warna, `📥`, { nyatakanUno: botMenyatakanUno() });
          return;
        }
        lewatiGiliran(sesi);
        await lanjutGiliran(sock, jid, `${labelPemain(sesi, aktif)} · 📥 tarik, lewat`);
        return;
      }

      // Papan diperbarui di tempat, bukan ditambahi pesan baru. Pemainnya
      // sendiri tetap tahu karena kartunya dikirim ke DM sedetik kemudian.
      catatRiwayat(sesi, `${labelPemain(sesi, aktif)} · 📥 tarik, masih gilirannya`);
      await perbaruiPapan(sock, jid, sesi);
      await dmTangan(sock, sesi, aktif, `📥 Kamu menarik: *${labelKartu(kartu)}* — kartu ini bisa langsung dimainkan!\n_Ketik_ \`.uno pas\` _kalau mau melewatkannya._`);
      // Nomor giliran disalin ke variabel: kalau dibaca dari `sesi` saat timer
      // meletus, nilainya selalu yang terbaru dan penjaganya jadi tidak berguna.
      const seqSekarang = sesi.turnSeq;
      sesi.timer = setTimeout(() => { giliranHabis(sock, jid, seqSekarang).catch(e => console.error('[UNO_TIMEOUT_ERR]', e)); }, TURN_TIMEOUT_MS);
      return;
    }

    lewatiGiliran(sesi);
    await lanjutGiliran(sock, jid, `${labelPemain(sesi, aktif)} · 📥 tarik, lewat`);
  } finally {
    sesi.busy = false;
  }
}

/**
 * Bot sesekali lalai menyatakan UNO.
 *
 * Kalau bot selalu ingat, `.uno tangkap` cuma jadi tombol mati saat meja diisi
 * AI — aturan penaltinya ada tapi tidak pernah bisa dipakai. Seperempat
 * kelalaian membuat pemain punya alasan nyata untuk memantau lawannya.
 */
function botMenyatakanUno() {
  return Math.random() > 0.25;
}

function konteksBot(sesi) {
  const berikut = sesi.players[indeksBerikut(sesi.idxAktif, sesi.arah, sesi.players.length)];
  return {
    kartuLawanBerikut: sesi.tangan.get(berikut)?.length ?? 7,
    ...konteksTumpuk(sesi)
  };
}

async function jalankanGiliranBot(sock, jid, seq) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING' || sesi.turnSeq !== seq || sesi.busy) return;

  const aktif = pemainAktif(sesi);
  if (!isBotUno(aktif)) return;

  const tangan = sesi.tangan.get(aktif) || [];
  const langkah = putuskanLangkahBot(tangan, sesi.atas, sesi.warnaAktif, konteksBot(sesi));

  if (langkah.aksi === 'tarik') {
    await tarikOtomatis(sock, jid, seq);
    return;
  }

  await eksekusiKartu(sock, jid, aktif, langkah.indeks, langkah.warna, "", { nyatakanUno: botMenyatakanUno() });
}

/** Waktu giliran pemain manusia habis → dimainkan otomatis, bukan dihukum. */
async function giliranHabis(sock, jid, seq) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING' || sesi.turnSeq !== seq || sesi.busy) return;

  const aktif = pemainAktif(sesi);
  const tangan = sesi.tangan.get(aktif) || [];
  const langkah = putuskanLangkahBot(tangan, sesi.atas, sesi.warnaAktif, konteksBot(sesi));

  if (langkah.aksi === 'tarik') {
    await tarikOtomatis(sock, jid, seq);
    return;
  }

  await eksekusiKartu(sock, jid, aktif, langkah.indeks, langkah.warna, `⏰`, { nyatakanUno: true });
}

/**
 * Satu-satunya jalan kartu boleh berpindah dari tangan ke meja.
 * Semua jalur (perintah pemain, bot, auto-main) lewat sini.
 */
async function eksekusiKartu(sock, jid, pemain, indeks, warnaPilihan, catatan = '', opsi = {}) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;
  if (sesi.busy) return false;

  sesi.busy = true;
  bersihkanTimer(sesi);
  try {
    return await eksekusiKartuInti(sock, jid, sesi, pemain, indeks, warnaPilihan, catatan, opsi);
  } finally {
    if (activeUno.get(jid) === sesi) sesi.busy = false;
  }
}

/**
 * Isi sebenarnya dari sebuah langkah — MENGANDAIKAN kunci `sesi.busy` sudah
 * dipegang pemanggil.
 *
 * Dipisah karena `tarikOtomatis` sudah memegang kunci saat ia menemukan kartu
 * tarikan yang ternyata bisa langsung dimainkan. Kalau ia memanggil pembungkus
 * `eksekusiKartu`, langkahnya ditolak oleh kuncinya sendiri dan giliran bot
 * berhenti diam-diam di tengah ronde.
 */
async function eksekusiKartuInti(sock, jid, sesi, pemain, indeks, warnaPilihan, catatan = '', opsi = {}) {
  {
    const tangan = sesi.tangan.get(pemain);
    const kartu = tangan?.[indeks];
    if (!kartu) return false;

    tangan.splice(indeks, 1);
    const hasil = terapkanKartu(sesi, kartu, warnaPilihan);

    // Satu langkah = SATU baris. Baris ini ditumpuk sebagai jejak di papan
    // hidup, jadi kalimat panjang berbaris-baris akan membuat papannya tumbuh
    // tak terkendali — persis keramaian yang sedang diberantas.
    let teks = `${catatan ? `${catatan} ` : ''}${labelPemain(sesi, pemain)} → *${labelKartu(kartu)}*`;
    if (isLiar(kartu)) teks += ` → ${WARNA[sesi.warnaAktif].emoji}`;

    if (hasil.balik) teks += ` · 🔄 balik`;
    if (hasil.menumpuk > 0) {
      teks += ` · 🔁 tumpukan +${hasil.menumpuk}`;
    } else if (hasil.tarik > 0 && hasil.korban) {
      teks += ` · 💥 ${labelPemain(sesi, hasil.korban)} +${hasil.ditarik.length}`;
    } else if (hasil.lewati && hasil.korban) {
      teks += ` · ⛔ ${labelPemain(sesi, hasil.korban)} lewat`;
    }

    // Menang: tangan habis.
    if (tangan.length === 0) {
      // Kartu penutup yang kebetulan +2/+4 di meja bertumpuk tetap harus
      // ditagihkan sebelum ronde ditutup. Tanpa ini tumpukannya menggantung:
      // lawan seolah tidak pernah kena serangan terakhir, dan di meja
      // bertarget skor kartu-kartu itu hilang dari perhitungan.
      const sisaTumpukan = serapTumpukan(sesi);
      if (sisaTumpukan.korban && sisaTumpukan.ditarik.length) {
        teks += ` · 💥 ${labelPemain(sesi, sisaTumpukan.korban)} +${sisaTumpukan.ditarik.length}`;
      }
      await selesaikanUno(sock, jid, pemain, teks);
      return true;
    }

    // Tinggal satu kartu.
    //
    // Papan sudah menandainya dengan 🔥 di sebelah nama pemain, jadi bawaannya
    // TIDAK ada pesan sendiri — itu cuma menambah keramaian tanpa memberi
    // informasi baru.
    //
    // Kekecualiannya kalau aturan `penalti` menyala dan pemainnya lalai: di
    // situ lawan memang perlu didering, karena mereka punya jendela terbatas
    // untuk mengetik `.uno tangkap`. Mengedit papan diam-diam tidak akan
    // pernah mereka sadari.
    if (tangan.length === 1) {
      if (sesi.aturan?.penalti && !opsi.nyatakanUno) {
        sesi.lupaUno = { jid: pemain, seq: sesi.turnSeq };
        await kirimAman(sock, jid, null,
          `🤫 ${labelPemain(sesi, pemain)} tinggal *1 kartu* — tapi lupa menyatakan UNO!\n_Ketik_ \`.uno tangkap\` _sebelum gilirannya kembali._`,
          { mentions: sesi.players.filter(p => !isBotUno(p) && p !== pemain) });
      } else {
        sesi.lupaUno = null;
        teks += ` · 🔔 *UNO!*`;
      }
    }

    // Kartu tarikan korban perlu disegarkan tampilannya di DM.
    if (hasil.tarik > 0 && hasil.korban && !isBotUno(hasil.korban)) {
      await dmTangan(sock, sesi, hasil.korban, `💥 Kamu terkena *+${hasil.ditarik.length}* dan kehilangan giliran.`);
    }

    await lanjutGiliran(sock, jid, teks);
    return true;
  }
}

// ─── Perintah ─────────────────────────────────────────────────────

export async function handleUnoCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  if (!isFromGroup) {
    await send(sock, jid, messageObj, '❌ UNO hanya dapat dimainkan di grup!');
    return true;
  }

  // Main kartu: `.u 3`, `.u 3 merah`, `.u 3 uno`
  if (command === 'u') {
    return await aksiMainKartu(sock, jid, senderNumber, messageObj, args);
  }

  if (command === 'ambil') {
    return await aksiTarikManual(sock, jid, senderNumber, messageObj);
  }

  if (['kartu', 'hand', 'mycards', 'cekkartu', 'kartuku'].includes(command)) {
    return await aksiIntipTangan(sock, jid, senderNumber, messageObj);
  }

  if (command === 'joinuno') return await gabungLobi(sock, jid, senderNumber, messageObj);
  if (command === 'gasuno') return await mulaiPermainan(sock, jid, senderNumber, messageObj);
  if (command === 'bataluno') return await batalkanUno(sock, jid, senderNumber, messageObj);
  if (command === 'nyerahuno') return await nyerahUno(sock, jid, senderNumber, messageObj);

  const sub = String(args[1] || '').toLowerCase();

  if (['join', 'ikut', 'masuk', 'gabung'].includes(sub)) return await gabungLobi(sock, jid, senderNumber, messageObj);
  if (['bot', 'addbot', 'ai'].includes(sub)) return await tambahBot(sock, jid, senderNumber, messageObj, parseInt(args[2], 10) || 1);
  if (['start', 'mulai', 'gas'].includes(sub)) return await mulaiPermainan(sock, jid, senderNumber, messageObj);
  if (['batal', 'cancel', 'stop', 'tutup'].includes(sub)) return await batalkanUno(sock, jid, senderNumber, messageObj);
  if (['nyerah', 'surrender', 'menyerah', 'keluar'].includes(sub)) return await nyerahUno(sock, jid, senderNumber, messageObj);
  if (['pas', 'pass', 'lewat', 'skip'].includes(sub)) return await aksiPas(sock, jid, senderNumber, messageObj);
  if (['tangkap', 'catch', 'gotcha', 'tuduh'].includes(sub)) return await aksiTangkap(sock, jid, senderNumber, messageObj);
  if (['kartu', 'tangan', 'hand'].includes(sub)) return await aksiIntipTangan(sock, jid, senderNumber, messageObj);
  if (['aturan', 'rules', 'help', 'bantuan'].includes(sub)) return await tampilkanAturan(sock, jid, messageObj);

  return await buatLobi(sock, jid, senderNumber, messageObj, args);
}

async function tampilkanAturan(sock, jid, messageObj) {
  await send(sock, jid, messageObj,
`🎴 *CARA MAIN UNO DI GRUP INI*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*Membuka meja*
• \`.uno [taruhan]\` — buka lobi (mis. \`.uno 50\`)
• \`.uno 50 tumpuk penalti skor 300\` — nyalakan aturan keras (opsional)
• \`.uno join\` — ikut duduk
• \`.uno bot 2\` — tambah 2 lawan AI
• \`.uno start\` — mulai (minimal ${MIN_PLAYERS} pemain)
• \`.uno batal\` — bubarkan, taruhan dikembalikan

*Saat bermain*
• \`.u 3\` — mainkan kartu nomor 3 dari tanganmu
• \`.u 3 merah\` — kartu liar sekaligus pilih warnanya
• \`.uno pas\` — lewati kartu tarikan
• \`.ambil\` — tarik kartu manual
• \`.kartu\` — kirim ulang tanganmu ke DM
• \`.uno nyerah\` — keluar dari meja

*Yang sengaja dipermudah*
• Tanganmu dikirim ke DM sudah bernomor, kartu legal ditandai ✅
• Tidak punya kartu cocok? Bot menarikkan otomatis, kamu tidak perlu ngetik
• Tidak ada penalti lupa bilang "UNO" — bot yang mengumumkan
• Nganggur ${TURN_TIMEOUT_MS / 1000} detik? Kartumu dimainkan otomatis, bukan dihukum

*Aturan meja (bawaan)*
• +2 dan +4 langsung berlaku, tidak bisa ditumpuk
• Kartu Balik di meja 2 pemain berlaku seperti Skip
• Satu ronde saja — pemenang membawa seluruh pot

*Aturan keras (opsional, sebutkan saat membuka meja)*
• \`tumpuk\` — +2 boleh ditimpa +2, +4 boleh ditimpa +4. Yang tidak bisa menimpa
  menelan seluruh tumpukan sekaligus.
• \`penalti\` — wajib menyatakan sendiri: \`.u 3 uno\`. Lalai? Lawan boleh
  \`.uno tangkap\` sebelum gilliranmu kembali, dan kamu kena +2.
• \`skor <angka>\` — main beberapa ronde. Pemenang ronde memanen total nilai
  kartu sisa lawan; yang pertama menembus target menang pot.

_Contoh:_ \`.uno 50 tumpuk penalti skor 300\``);
  return true;
}

async function buatLobi(sock, jid, senderNumber, messageObj, args) {
  if (activeUno.has(jid)) {
    const s = activeUno.get(jid);
    if (s.status === 'LOBBY') {
      await send(sock, jid, messageObj, `⚠️ Sudah ada lobi UNO di grup ini!\n👑 Host: ${labelPemain(s, s.host)}\n👥 Pemain (${s.players.length}/${MAX_PLAYERS}): ${s.players.map(p => labelPemain(s, p)).join(', ')}\n💰 Taruhan: *${s.buyIn} Poin*\n\nKetik \`.uno join\` untuk ikut atau \`.uno start\` untuk mulai.`, { mentions: mentionsManusia(s) });
    } else {
      await send(sock, jid, messageObj, '⚠️ Masih ada permainan UNO yang sedang berlangsung di grup ini!\n_Peserta bisa mengetik_ `.uno nyerah` _untuk keluar._');
    }
    return true;
  }

  const aturan = bacaAturan(args);
  const buyIn = aturan.buyIn;

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < buyIn) {
    await send(sock, jid, messageObj, `❌ Poinmu tidak cukup untuk taruhan *${buyIn} Poin*! (Poinmu: ${prof?.points || 0})`);
    return true;
  }

  // Cek DM SEBELUM poin dipotong. Kalau chat pribadi bot belum pernah dibuka,
  // kartunya tidak akan pernah sampai — lebih baik ketahuan sekarang daripada
  // di tengah ronde saat taruhan sudah masuk pot.
  const dmOk = await dm(sock, senderNumber, '🎴 *UNO siap!* Kartu-kartumu akan dikirim ke chat ini setiap giliranmu.');
  if (!dmOk) {
    await send(sock, jid, messageObj, `❌ Bot tidak bisa mengirim DM ke ${tag(senderNumber)}.\n\n👉 Buka chat pribadi dengan bot ini, kirim satu pesan apa saja, lalu coba \`.uno\` lagi.\n_Tanpa DM, kartumu tidak bisa dirahasiakan._`, { mentions: [senderNumber] });
    return true;
  }

  const potong = await db.deductGamePoints(senderNumber, buyIn);
  if (!potong?.success) {
    await send(sock, jid, messageObj, '❌ Gagal memotong poin taruhan. Coba lagi.');
    return true;
  }

  const sesi = {
    jid,
    host: senderNumber,
    buyIn,
    players: [senderNumber],
    sudahBayar: new Set([senderNumber]),
    tangan: new Map(),
    deck: [],
    buang: [],
    atas: null,
    warnaAktif: null,
    arah: 1,
    idxAktif: 0,
    status: 'LOBBY',
    busy: false,
    turnSeq: 0,
    timer: null,
    lobbyTimer: null,
    // Aturan rumah opsional — semuanya mati kecuali diminta di perintah pembuka.
    aturan: { tumpuk: aturan.tumpuk, penalti: aturan.penalti, targetSkor: aturan.targetSkor },
    tumpukan: { jumlah: 0, jenis: null },
    skor: new Map(),
    ronde: 1,
    lupaUno: null,
    // Papan hidup: satu pesan grup yang diedit tiap giliran, plus jejak 3
    // langkah terakhir supaya tiap kejadian kecil tidak butuh pesan sendiri.
    papanKey: null,
    papanUmur: 0,
    riwayat: [],
    createdAt: Date.now()
  };

  sesi.lobbyTimer = setTimeout(async () => {
    const s = activeUno.get(jid);
    if (!s || s.status !== 'LOBBY') return;
    activeUno.delete(jid);
    const poin = await refundSesi(s);
    await kirimAman(sock, jid, null, `⌛ *LOBI UNO KEDALUWARSA* karena tidak dimulai dalam ${LOBBY_TIMEOUT_MS / 1000} detik.${poin > 0 ? `\n💰 Taruhan *${poin} Poin* telah dikembalikan.` : ''}`);
  }, LOBBY_TIMEOUT_MS);

  activeUno.set(jid, sesi);

  await send(sock, jid, messageObj,
`🎴 ─── *LOBI UNO DIBUKA!* ─── 🎴
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👑 *Host:* ${tag(senderNumber)}
💰 *Taruhan:* *${buyIn} Poin* / pemain
👥 *Pemain (1/${MAX_PLAYERS}):* ${tag(senderNumber)}${ringkasAturan(sesi) ? `\n\n⚙️ *Aturan rumah:*\n  • ${ringkasAturan(sesi)}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👉 Ketik \`.uno join\` untuk ikut duduk
🤖 Kurang orang? \`.uno bot 2\` untuk tambah lawan AI
🚀 Host ketik \`.uno start\` kalau sudah siap (minimal ${MIN_PLAYERS} pemain)
📖 Belum paham? \`.uno aturan\`
_⏳ Lobi ditutup otomatis dalam ${LOBBY_TIMEOUT_MS / 1000} detik_`, { mentions: [senderNumber] });
  return true;
}

async function gabungLobi(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi) {
    await send(sock, jid, messageObj, '❌ Belum ada lobi UNO di grup ini. Ketik `.uno` untuk membuka meja!');
    return true;
  }
  if (sesi.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Permainan UNO sudah dimulai — tidak bisa ikut di tengah jalan.');
    return true;
  }
  if (sesi.players.some(p => samaJid(p, senderNumber))) {
    await send(sock, jid, messageObj, '⚠️ Kamu sudah duduk di meja ini!');
    return true;
  }
  if (sesi.players.length >= MAX_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Meja sudah penuh (${MAX_PLAYERS}/${MAX_PLAYERS} pemain)!`);
    return true;
  }

  const prof = await db.getGameProfile(senderNumber);
  if ((prof?.points || 0) < sesi.buyIn) {
    await send(sock, jid, messageObj, `❌ Poinmu tidak cukup untuk taruhan *${sesi.buyIn} Poin*! (Poinmu: ${prof?.points || 0})`);
    return true;
  }

  const dmOk = await dm(sock, senderNumber, '🎴 *Kamu duduk di meja UNO!* Kartu-kartumu akan dikirim ke chat ini setiap giliranmu.');
  if (!dmOk) {
    await send(sock, jid, messageObj, `❌ Bot tidak bisa mengirim DM ke ${tag(senderNumber)}.\n\n👉 Buka chat pribadi dengan bot ini, kirim satu pesan apa saja, lalu ketik \`.uno join\` lagi.`, { mentions: [senderNumber] });
    return true;
  }

  const potong = await db.deductGamePoints(senderNumber, sesi.buyIn);
  if (!potong?.success) {
    await send(sock, jid, messageObj, '❌ Gagal memotong poin taruhan. Coba lagi.');
    return true;
  }

  sesi.players.push(senderNumber);
  sesi.sudahBayar.add(senderNumber);

  await send(sock, jid, messageObj, `✅ ${tag(senderNumber)} duduk di meja UNO!\n👥 *Pemain (${sesi.players.length}/${MAX_PLAYERS}):* ${sesi.players.map(p => labelPemain(sesi, p)).join(', ')}\n\n${sesi.players.length >= MIN_PLAYERS ? `🚀 Host ${tag(sesi.host)} bisa ketik \`.uno start\`!` : `_Butuh minimal ${MIN_PLAYERS} pemain._`}`, { mentions: mentionsManusia(sesi) });
  return true;
}

async function tambahBot(sock, jid, senderNumber, messageObj, jumlah) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '❌ Tidak ada lobi UNO yang bisa ditambahi bot.');
    return true;
  }
  if (!samaJid(sesi.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host (${tag(sesi.host)}) yang boleh menambahkan bot!`, { mentions: [sesi.host] });
    return true;
  }

  const muat = MAX_PLAYERS - sesi.players.length;
  if (muat <= 0) {
    await send(sock, jid, messageObj, '❌ Meja sudah penuh!');
    return true;
  }

  const n = Math.min(muat, Math.max(1, jumlah));
  const tersedia = BOT_UNO.filter(b => !sesi.players.includes(b.id));
  const dipakai = tersedia.slice(0, n);
  if (dipakai.length === 0) {
    await send(sock, jid, messageObj, '❌ Semua bot UNO sudah duduk di meja ini.');
    return true;
  }

  for (const b of dipakai) sesi.players.push(b.id);

  await send(sock, jid, messageObj, `🤖 Bot bergabung: ${dipakai.map(b => b.nama).join(', ')}\n👥 *Pemain (${sesi.players.length}/${MAX_PLAYERS}):* ${sesi.players.map(p => labelPemain(sesi, p)).join(', ')}\n\n🚀 Ketik \`.uno start\` untuk mulai!`, { mentions: mentionsManusia(sesi) });
  return true;
}

async function mulaiPermainan(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi) {
    await send(sock, jid, messageObj, '❌ Belum ada lobi UNO. Ketik `.uno` untuk membuka meja!');
    return true;
  }
  if (sesi.status !== 'LOBBY') {
    await send(sock, jid, messageObj, '⚠️ Permainan UNO sudah berjalan.');
    return true;
  }
  if (!samaJid(sesi.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host (${tag(sesi.host)}) yang boleh memulai permainan!`, { mentions: [sesi.host] });
    return true;
  }
  if (sesi.players.length < MIN_PLAYERS) {
    await send(sock, jid, messageObj, `❌ Butuh minimal ${MIN_PLAYERS} pemain. Ketik \`.uno bot 1\` kalau mau lawan AI.`);
    return true;
  }

  bersihkanLobbyTimer(sesi);

  // Bagikan kartu.
  sesi.deck = kocok(buatDeck());
  sesi.buang = [];
  for (const p of sesi.players) {
    sesi.tangan.set(p, sesi.deck.splice(-KARTU_AWAL, KARTU_AWAL));
  }

  // Kartu pembuka: kartu liar tidak boleh membuka meja (tidak ada yang berhak
  // memilih warnanya), jadi ambil kartu berwarna teratas dari deck.
  //
  // Ditulis sebagai pencarian indeks, BUKAN loop pop+unshift: memindahkan
  // kartu liar ke dasar deck tidak mengubah panjang deck, jadi kalau sisa
  // deck kebetulan semuanya liar, loopnya berputar selamanya dan bot mati
  // menggantung di tengah `.uno start`.
  let pembuka = null;
  for (let i = sesi.deck.length - 1; i >= 0; i--) {
    if (!isLiar(sesi.deck[i])) { pembuka = sesi.deck.splice(i, 1)[0]; break; }
  }
  if (!pembuka) pembuka = { warna: 'M', simbol: '0' };

  sesi.buang.push(pembuka);
  sesi.atas = pembuka;
  sesi.warnaAktif = pembuka.warna;
  sesi.arah = 1;
  sesi.idxAktif = 0;
  sesi.turnSeq = 1;
  sesi.status = 'PLAYING';

  // Dikunci sekarang dan tidak pernah dihitung ulang: pemain yang menyerah di
  // tengah ronde tidak boleh mengecilkan hadiah pemenang.
  sesi.potManusia = sesi.buyIn * sesi.players.filter(p => !isBotUno(p)).length;
  sesi.potBot = sesi.buyIn * sesi.players.filter(isBotUno).length;

  await db.createActiveGameSession({
    id: db.sesiGameId('uno', jid),
    gameType: 'UNO',
    jid,
    host: sesi.host,
    buyIn: sesi.buyIn,
    pot: sesi.buyIn * sesi.players.filter(p => !isBotUno(p)).length,
    players: sesi.players.filter(p => !isBotUno(p)).map(p => ({ jid: p, points: sesi.buyIn }))
  });

  await kirimAman(sock, jid, messageObj,
`🚨 *PERMAINAN UNO DIMULAI!* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 *${sesi.players.length} Pemain:* ${sesi.players.map(p => labelPemain(sesi, p)).join(', ')}
💰 *Total Pot:* *${sesi.buyIn * sesi.players.length} Poin*
🃏 Masing-masing dibagikan *${KARTU_AWAL} kartu* (dikirim ke DM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, { mentions: mentionsManusia(sesi) });

  // Semua pemain manusia dapat tangan awalnya sekaligus, supaya bisa
  // menyiapkan langkah sebelum gilirannya tiba.
  for (const p of sesi.players) {
    if (!isBotUno(p)) await dmTangan(sock, sesi, p);
  }

  await lanjutGiliran(sock, jid, `🎬 kartu pembuka *${labelKartu(pembuka)}*`);
  return true;
}

async function aksiMainKartu(sock, jid, senderNumber, messageObj, args) {
  const slotArg = args[1];
  // Warna dicari dari kata mana pun sesudah nomor, jadi `.u 3 uno merah` dan
  // `.u 3 merah uno` sama-sama diterima — pemain tidak perlu hafal urutannya.
  const warnaArg = args.slice(2).map(a => bacaWarna(a)).find(Boolean) || null;
  const nyatakanUno = args.slice(2).some(a => /^uno!*$/i.test(String(a || '')));
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;

  const idxPemain = sesi.players.findIndex(p => samaJid(p, senderNumber));
  if (idxPemain === -1) return false; // bukan peserta, lepas ke handler lain

  const pemain = sesi.players[idxPemain];

  if (idxPemain !== sesi.idxAktif) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Sekarang giliran ${labelPemain(sesi, pemainAktif(sesi))}.`, { mentions: isBotUno(pemainAktif(sesi)) ? [] : [pemainAktif(sesi)] });
    return true;
  }

  if (sesi.busy) {
    await send(sock, jid, messageObj, '⏳ Langkah sebelumnya masih diproses, tunggu sebentar.');
    return true;
  }

  const tangan = sesi.tangan.get(pemain) || [];
  const slot = parseInt(slotArg, 10);
  if (!slotArg || isNaN(slot) || slot < 1 || slot > tangan.length) {
    await send(sock, jid, messageObj, `❌ Nomor kartu tidak valid. Tanganmu berisi *${tangan.length} kartu* — ketik \`.u 1\` sampai \`.u ${tangan.length}\`.\n_Ketik_ \`.kartu\` _kalau lupa isi tanganmu._`);
    return true;
  }

  const kartu = tangan[slot - 1];
  if (!bolehSekarang(sesi, kartu)) {
    await send(sock, jid, messageObj, `❌ *${labelKartu(kartu)}* tidak bisa dimainkan di atas *${labelAtas(sesi.atas, sesi.warnaAktif)}*.\n_Kartu yang boleh ditandai_ ✅ _di DM-mu._`);
    return true;
  }

  let warna = null;
  if (isLiar(kartu)) {
    warna = warnaArg;
    if (!warna) {
      await send(sock, jid, messageObj, `⭐ *${labelKartu(kartu)}* butuh warna. Ketik sekaligus:\n\`.u ${slot} merah\` · \`.u ${slot} kuning\` · \`.u ${slot} hijau\` · \`.u ${slot} biru\``);
      return true;
    }
  }

  await eksekusiKartu(sock, jid, pemain, slot - 1, warna, '', { nyatakanUno });
  return true;
}

/**
 * `.uno tangkap` — menghukum pemain yang lalai menyatakan UNO.
 * Hanya hidup kalau meja dibuka dengan aturan `penalti`.
 */
async function aksiTangkap(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;

  const penangkap = sesi.players.find(p => samaJid(p, senderNumber));
  if (!penangkap) return false;

  if (!sesi.aturan?.penalti) {
    await send(sock, jid, messageObj, 'ℹ️ Meja ini tidak memakai penalti UNO — bot yang mengumumkan sendiri, jadi tidak ada yang perlu ditangkap.\n_Buka meja dengan_ `.uno 50 penalti` _kalau mau versi ketatnya._');
    return true;
  }

  const target = sesi.lupaUno?.jid;
  if (!target) {
    await send(sock, jid, messageObj, '🤷 Tidak ada yang sedang lalai menyatakan UNO saat ini.');
    return true;
  }
  if (samaJid(target, penangkap)) {
    await send(sock, jid, messageObj, '😅 Tidak bisa menangkap dirimu sendiri!');
    return true;
  }
  if (sesi.busy) {
    await send(sock, jid, messageObj, '⏳ Langkah sedang diproses, coba lagi sebentar.');
    return true;
  }

  const ditarik = ambilDariDeck(sesi, 2);
  if (ditarik.length) sesi.tangan.get(target).push(...ditarik);
  sesi.lupaUno = null;

  await kirimAman(sock, jid, messageObj, `🔔 *TERTANGKAP!* ${labelPemain(sesi, penangkap)} memergoki ${labelPemain(sesi, target)} yang lupa menyatakan UNO!\n💥 ${labelPemain(sesi, target)} menarik *${ditarik.length} kartu* sebagai penalti.`, { mentions: [penangkap, target].filter(p => !isBotUno(p)) });
  if (!isBotUno(target)) await dmTangan(sock, sesi, target, `🔔 Kamu tertangkap lupa menyatakan UNO — kena penalti *+${ditarik.length} kartu*.`);
  return true;
}

async function aksiTarikManual(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;

  const idxPemain = sesi.players.findIndex(p => samaJid(p, senderNumber));
  if (idxPemain === -1) return false;

  if (idxPemain !== sesi.idxAktif) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu! Sekarang giliran ${labelPemain(sesi, pemainAktif(sesi))}.`, { mentions: isBotUno(pemainAktif(sesi)) ? [] : [pemainAktif(sesi)] });
    return true;
  }
  if (sesi.busy) {
    await send(sock, jid, messageObj, '⏳ Langkah sebelumnya masih diproses, tunggu sebentar.');
    return true;
  }

  await tarikOtomatis(sock, jid, sesi.turnSeq);
  return true;
}

async function aksiPas(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;

  const idxPemain = sesi.players.findIndex(p => samaJid(p, senderNumber));
  if (idxPemain === -1) return false;

  if (idxPemain !== sesi.idxAktif) {
    await send(sock, jid, messageObj, `⚠️ Bukan giliranmu!`);
    return true;
  }
  if (sesi.busy) {
    await send(sock, jid, messageObj, '⏳ Langkah sebelumnya masih diproses, tunggu sebentar.');
    return true;
  }

  bersihkanTimer(sesi);
  const pemain = sesi.players[idxPemain];

  // Tumpukan +2/+4 tidak boleh dilewati begitu saja. Tanpa penjaga ini,
  // `.uno pas` jadi pintu darurat gratis: pemain yang ditagih +8 tinggal
  // mengetiknya dan lolos tanpa menarik satu kartu pun.
  if (sesi.tumpukan?.jumlah > 0) {
    const hasil = serapTumpukan(sesi);
    if (!isBotUno(hasil.korban)) {
      await dmTangan(sock, sesi, hasil.korban, `💥 Kamu menelan tumpukan *+${hasil.jumlah}*.`);
    }
    await lanjutGiliran(sock, jid, `${labelPemain(sesi, pemain)} · 💥 menelan tumpukan +${hasil.ditarik.length}`);
    return true;
  }

  lewatiGiliran(sesi);
  await lanjutGiliran(sock, jid, `${labelPemain(sesi, pemain)} · ⏭️ lewat`);
  return true;
}

async function aksiIntipTangan(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') return false;

  const pemain = sesi.players.find(p => samaJid(p, senderNumber));
  if (!pemain) return false;

  const ok = await dmTangan(sock, sesi, pemain);
  await send(sock, jid, messageObj, ok
    ? `🤫 ${tag(senderNumber)}, tanganmu sudah dikirim ulang ke DM!`
    : `⚠️ ${tag(senderNumber)}, DM gagal terkirim — buka chat pribadi dengan bot lalu coba lagi.`,
  { mentions: [senderNumber] });
  return true;
}

async function batalkanUno(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi) {
    await send(sock, jid, messageObj, '❌ Tidak ada meja UNO di grup ini.');
    return true;
  }

  const pesertanya = sesi.players.some(p => samaJid(p, senderNumber));
  if (!samaJid(sesi.host, senderNumber) && !pesertanya) {
    await send(sock, jid, messageObj, '⚠️ Kamu bukan peserta meja UNO ini!');
    return true;
  }

  if (sesi.status === 'PLAYING') {
    // Ronde sudah jalan: membatalkan = menyerah, bukan menarik taruhan kembali.
    // Kalau tidak, siapa pun bisa mengintip kartunya dulu lalu membubarkan meja
    // saat kartunya jelek — main tanpa pernah bisa rugi.
    await send(sock, jid, messageObj, '⚠️ Ronde sudah berjalan dan taruhan sudah masuk pot.\nKetik `.uno nyerah` kalau kamu ingin mengundurkan diri.');
    return true;
  }

  if (!samaJid(sesi.host, senderNumber)) {
    await send(sock, jid, messageObj, `❌ Hanya host (${tag(sesi.host)}) yang boleh membubarkan lobi.`, { mentions: [sesi.host] });
    return true;
  }

  bersihkanLobbyTimer(sesi);
  bersihkanTimer(sesi);
  activeUno.delete(jid);
  const poin = await refundSesi(sesi);

  await send(sock, jid, messageObj, `🛑 Lobi UNO dibubarkan oleh host.${poin > 0 ? `\n💰 Taruhan *${poin} Poin* telah dikembalikan ke semua pemain.` : ''}`);
  return true;
}

async function nyerahUno(sock, jid, senderNumber, messageObj) {
  const sesi = activeUno.get(jid);
  if (!sesi || sesi.status !== 'PLAYING') {
    await send(sock, jid, messageObj, '❌ Tidak ada permainan UNO yang sedang berjalan.');
    return true;
  }
  if (sesi.busy) {
    await send(sock, jid, messageObj, '⏳ Langkah sedang diproses, coba lagi sebentar.');
    return true;
  }

  const idx = sesi.players.findIndex(p => samaJid(p, senderNumber));
  if (idx === -1) {
    await send(sock, jid, messageObj, '⚠️ Kamu bukan peserta permainan UNO ini!');
    return true;
  }

  const keluar = sesi.players[idx];
  bersihkanTimer(sesi);

  // Kartunya dikembalikan ke tumpukan buangan supaya deck tidak menyusut.
  const tangan = sesi.tangan.get(keluar) || [];
  sesi.buang.unshift(...tangan.map(k => (isLiar(k) ? { ...k, warna: null } : k)));
  sesi.tangan.delete(keluar);
  sesi.players.splice(idx, 1);

  // Giliran harus tetap menunjuk pemain yang sama setelah barisannya menyusut.
  if (idx < sesi.idxAktif) sesi.idxAktif--;
  if (sesi.idxAktif >= sesi.players.length) sesi.idxAktif = 0;
  sesi.turnSeq++;

  const manusiaTersisa = sesi.players.filter(p => !isBotUno(p));
  if (sesi.players.length < MIN_PLAYERS || manusiaTersisa.length === 0) {
    const pemenang = manusiaTersisa[0] || sesi.players[0];
    await kirimAman(sock, jid, null, `🏳️ ${labelPemain(sesi, keluar)} menyerah dan meninggalkan meja.`, { mentions: [keluar] });
    await selesaikanUno(sock, jid, pemenang, `🏳️ Meja bubar karena pemain tidak cukup.`);
    return true;
  }

  // Cukup satu pesan: kabarnya masuk ke jejak papan, bukan jadi pesan sendiri
  // yang diikuti papan lagi sedetik kemudian.
  await lanjutGiliran(sock, jid, `${labelPemain(sesi, keluar)} · 🏳️ menyerah, taruhannya hangus ke pot`);
  return true;
}

/**
 * Skor ronde menurut aturan UNO resmi: pemenang mendapat total nilai kartu
 * yang masih tergenggam lawan-lawannya.
 */
export function hitungSkorRonde(sesi, pemenang) {
  const rincian = sesi.players
    .filter(p => p !== pemenang)
    .map(p => ({ pemain: p, nilai: nilaiTangan(sesi.tangan.get(p)), sisa: sesi.tangan.get(p)?.length ?? 0 }));
  return { rincian, total: rincian.reduce((t, x) => t + x.nilai, 0) };
}

/**
 * Satu ronde tuntas. Di meja biasa ini berarti pertandingan selesai; di meja
 * bertarget skor, ronde berikutnya dibagikan sampai ada yang menembus target.
 */
async function selesaikanUno(sock, jid, pemenang, catatan = '') {
  const sesi = activeUno.get(jid);
  if (!sesi) return;

  bersihkanTimer(sesi);
  const { rincian, total } = hitungSkorRonde(sesi, pemenang);
  const target = sesi.aturan?.targetSkor || 0;

  if (target > 0 && pemenang) {
    sesi.skor.set(pemenang, (sesi.skor.get(pemenang) || 0) + total);
    const totalPemenang = sesi.skor.get(pemenang);

    if (totalPemenang < target && sesi.players.length >= MIN_PLAYERS) {
      const papanSkor = sesi.players
        .map(p => `   • ${labelPemain(sesi, p)} — *${sesi.skor.get(p) || 0}* poin`)
        .join('\n');

      await kirimAman(sock, jid, null,
`🏁 *RONDE ${sesi.ronde} SELESAI!*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${catatan ? `${catatan}\n\n` : ''}🎉 ${labelPemain(sesi, pemenang)} habis duluan dan memanen *+${total} poin* dari sisa kartu lawan!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *Papan Skor* (target ${target}):
${papanSkor}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_Ronde ${sesi.ronde + 1} dibagikan sebentar lagi..._`, { mentions: mentionsManusia(sesi) });

      await mulaiRondeBaru(sock, jid, sesi, pemenang);
      return;
    }
  }

  await selesaikanPertandingan(sock, jid, sesi, pemenang, rincian, total, catatan);
}

/** Bagikan ronde berikutnya pada meja bertarget skor. */
async function mulaiRondeBaru(sock, jid, sesi, pemenangSebelumnya) {
  sesi.ronde++;
  // Ronde baru dapat papan hidupnya sendiri; jejak ronde lalu dibuang.
  lepasPapan(sesi);
  sesi.deck = kocok(buatDeck());
  sesi.buang = [];
  sesi.tumpukan = { jumlah: 0, jenis: null };
  sesi.lupaUno = null;
  sesi.arah = 1;

  for (const p of sesi.players) {
    sesi.tangan.set(p, sesi.deck.splice(-KARTU_AWAL, KARTU_AWAL));
  }

  let pembuka = null;
  for (let i = sesi.deck.length - 1; i >= 0; i--) {
    if (!isLiar(sesi.deck[i])) { pembuka = sesi.deck.splice(i, 1)[0]; break; }
  }
  if (!pembuka) pembuka = { warna: 'M', simbol: '0' };

  sesi.buang.push(pembuka);
  sesi.atas = pembuka;
  sesi.warnaAktif = pembuka.warna;

  // Ronde berikutnya dibuka oleh pemain SETELAH pemenang ronde lalu, supaya
  // keunggulan giliran pertama tidak menumpuk di orang yang sama.
  const idxMenang = sesi.players.indexOf(pemenangSebelumnya);
  sesi.idxAktif = idxMenang === -1 ? 0 : indeksBerikut(idxMenang, 1, sesi.players.length);
  sesi.turnSeq++;

  for (const p of sesi.players) {
    if (!isBotUno(p)) await dmTangan(sock, sesi, p);
  }

  await lanjutGiliran(sock, jid, `🎬 ronde ${sesi.ronde} dibuka *${labelKartu(pembuka)}*`);
}

/** Pertandingan benar-benar tuntas: pot dibayarkan dan meja dibubarkan. */
async function selesaikanPertandingan(sock, jid, sesi, pemenang, rincian, totalRonde, catatan = '') {
  bersihkanTimer(sesi);
  lepasPapan(sesi);
  bersihkanLobbyTimer(sesi);
  // Dihapus sebelum `await` pertama supaya dua jalur penyelesaian yang beradu
  // (menang & menyerah) tidak pernah membayar pot dua kali.
  activeUno.delete(jid);
  sesi.status = 'FINISHED';

  const potPenuh = (sesi.potManusia ?? 0) + (sesi.potBot ?? 0);
  let dibayar = 0;

  if (pemenang && !isBotUno(pemenang)) {
    dibayar = Math.max(0, Math.min(potPenuh, batasKreditNyata(sesi)));
    if (dibayar > 0) {
      try { await db.addGamePoints(pemenang, dibayar); } catch (_) { dibayar = 0; }
    }
  }

  try { await db.finishActiveGameSession(db.sesiGameId('uno', jid), 'FINISHED'); } catch (_) {}

  const bertarget = (sesi.aturan?.targetSkor || 0) > 0;
  const papan = bertarget
    ? sesi.players.map(p => `   • ${labelPemain(sesi, p)} — *${sesi.skor.get(p) || 0}* poin`).join('\n')
    : rincian.map(r => `   • ${labelPemain(sesi, r.pemain)} — sisa ${r.sisa} kartu (${r.nilai} poin)`).join('\n');

  await kirimAman(sock, jid, null,
`👑🏆 *PEMENANG UNO!* 🏆👑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${catatan ? `${catatan}\n\n` : ''}🎉 ${labelPemain(sesi, pemenang)} ${bertarget ? `menembus target *${sesi.aturan.targetSkor} poin* setelah ${sesi.ronde} ronde!` : 'menghabiskan seluruh kartunya!'}
${papan ? `\n📋 *${bertarget ? 'Papan Skor Akhir' : 'Sisa kartu lawan'}:*\n${papan}\n` : ''}
💰 *Hadiah:* ${isBotUno(pemenang) ? '_Bot tidak menerima poin._' : `*+${dibayar} Poin*`}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ketik \`.uno\` untuk meja baru!`, { mentions: mentionsManusia(sesi) });
}

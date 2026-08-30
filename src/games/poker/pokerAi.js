// ─── 🤖 POKER AI — MESIN KEPUTUSAN ───────────────────────────────
//
// Prinsip: kekuatan tangan TIDAK dinilai dari kelasnya sendiri, tapi dari
// persentil terhadap range lawan (preflop: chart 169 tangan; postflop:
// enumerasi eksak semua kombo lawan DI PAPAN INI). Keputusan lanjut/mundur
// selalu dibandingkan dengan HARGA, bukan dengan ambang tetap.
//
// Versi lama melipat 74,7% tangan di preflop karena scorePreflopHand memberi
// 79,7% tangan skor di bawah 50, dan cabang di bawah 50 punya syarat
// `toCall <= minRaise*0.5` yang TIDAK PERNAH benar saat menghadapi big blind.
// Bot juga tidak tahu posisi, tidak menghitung pot odds, dan menganggap
// flush draw sebagai high card lalu melipatnya.
import { createDeck } from './deck.js';

// ═══ §0. PROFIL BOT ══════════════════════════════════════════════
// `personality` lama DIPERTAHANKAN supaya tidak ada yang pecah; yang dibaca
// AI sekarang adalah `persona`, dan ketujuhnya berbeda — dulu 4 dari 7 bot
// menjalankan jalur kode yang 100% identik (PRO dan PASSIVE bahkan tidak
// pernah diuji di satu cabang pun).
export const BOT_NAMES = [
  { id: 'bot_akbar@ai',  name: '🤖 Bot Akbar',  personality: 'PRO',          persona: 'PROFESOR',
    julukan: 'Sang Profesor', gaya: 'Ketat-agresif. Jarang masuk pot, tapi kalau masuk dia menekan.' },
  { id: 'bot_sultan@ai', name: '🤖 Bot Sultan', personality: 'BLUFFER',      persona: 'SULTAN',
    julukan: 'Si Sultan',     gaya: 'Maniak. Raise besar, sering gertak, suka overbet.' },
  { id: 'bot_dealer@ai', name: '🤖 Bot Dealer', personality: 'PASSIVE',      persona: 'BATU',
    julukan: 'Si Batu',       gaya: 'Nit. Cuma main tangan bagus. Dia masuk pot = kartunya beneran.' },
  { id: 'bot_yann@ai',   name: '🤖 Bot Yann',   personality: 'CALL_STATION', persona: 'TEMBOK',
    julukan: 'Si Tembok',     gaya: 'Call station. Hampir tak pernah fold, hampir tak pernah raise.' },
  { id: 'bot_gacor@ai',  name: '🤖 Bot Gacor',  personality: 'PRO',          persona: 'PENJEBAK',
    julukan: 'Si Penjebak',   gaya: 'Licik. Taruhannya kecil-besar tak beraturan. Hati-hati kalau dia diam.' },
  { id: 'bot_botak@ai',  name: '🤖 Bot Botak',  personality: 'BLUFFER',      persona: 'EMOSI',
    julukan: 'Si Emosi',      gaya: 'Ngegas. Cepat bertindak, sering menekan, kadang ngawur.' },
  { id: 'bot_santai@ai', name: '🤖 Bot Santai', personality: 'PASSIVE',      persona: 'SANTAI',
    julukan: 'Si Santai',     gaya: 'Longgar-pasif. Ikut terus, taruhannya kecil. Sasaran empuk.' }
];

export function isAiPlayer(jid) {
  return String(jid).endsWith('@ai');
}

// ═══ §1. TABEL KEPRIBADIAN — DIAL ANGKA, BUKAN CABANG if ═════════
//  rfi    pengali lebar range pembukaan
//  def    pengali ambang bertahan (MDF preflop DAN required equity postflop)
//  agr    pengali porsi range yang jadi raise, bukan call
//  bluff  frekuensi gertak murni
//  cbet   pengali frekuensi continuation bet
//  sizing [min,max] fraksi pot — TANDA TANGAN yang paling cepat terbaca di chat
//  noise  lebar jitter ambang (poin persentil) = "kadang salah seperti manusia"
//  salah  peluang membalik FOLD marjinal jadi CALL (digerbangi keyakinan)
//  tempo  pengali waktu berpikir
//  mulut  peluang celetuk
// Dua dial yang paling menentukan "rasa" seorang lawan adalah `def` (seberapa
// sering dia LANJUT saat ditagih) dan `agr` (seberapa besar porsi lanjutan itu
// jadi raise, bukan call). Keduanya sengaja disebar di kuadran yang berbeda —
// kalau dua bot punya (def, agr) yang mirip, pemain tidak akan pernah bisa
// membedakan mereka berapa lama pun bermain. Diuji di GERBANG 4
// scripts/pokerPersonaTest.mjs: tidak boleh ada pasangan berjarak < 15 poin.
export const PERSONA = {
  PROFESOR: { rfi: 1.00, def: 1.00, agr: 1.00, bluff: 0.28, cbet: 0.72, sizing: [0.55, 0.75], noise: 3.0, salah: 0.06, tempo: 1.00, mulut: 0.20 },
  SULTAN:   { rfi: 1.50, def: 1.28, agr: 1.85, bluff: 0.60, cbet: 0.90, sizing: [0.80, 1.30], noise: 5.0, salah: 0.14, tempo: 0.72, mulut: 0.85 },
  TEMBOK:   { rfi: 0.75, def: 1.48, agr: 0.22, bluff: 0.05, cbet: 0.28, sizing: [0.35, 0.50], noise: 2.5, salah: 0.20, tempo: 0.88, mulut: 0.35 },
  PENJEBAK: { rfi: 0.85, def: 0.84, agr: 0.45, bluff: 0.25, cbet: 0.40, sizing: [0.40, 1.25], noise: 4.0, salah: 0.05, tempo: 1.15, mulut: 0.40 },
  SANTAI:   { rfi: 1.28, def: 1.20, agr: 0.50, bluff: 0.10, cbet: 0.32, sizing: [0.30, 0.55], noise: 6.0, salah: 0.22, tempo: 1.18, mulut: 0.30 },
  BATU:     { rfi: 0.50, def: 0.58, agr: 1.30, bluff: 0.03, cbet: 0.65, sizing: [0.60, 0.80], noise: 2.0, salah: 0.02, tempo: 1.35, mulut: 0.05 },
  EMOSI:    { rfi: 1.32, def: 0.78, agr: 1.45, bluff: 0.42, cbet: 0.72, sizing: [0.50, 0.95], noise: 4.5, salah: 0.11, tempo: 0.85, mulut: 0.60 }
};

const ALIAS = { PRO: 'PROFESOR', BLUFFER: 'SULTAN', PASSIVE: 'SANTAI', CALL_STATION: 'TEMBOK' };
const ambilGaya = n => PERSONA[n] || PERSONA[ALIAS[n]] || PERSONA.PROFESOR;

// Kunci = jumlah pemain yang masih bicara SESUDAH kita.
// 0 = aku pembicara terakhir (BB) → ini ambang OPTION BB, bukan RFI.
// 1 = SB, 2 = BTN, ..., 7 = UTG meja 8.
// Angka SB/BTN SENGAJA dipotong dari nilai EV-optimal push/fold (sekitar
// 90-97%) supaya bot tidak terasa maniak. Itu keputusan rasa, bukan matematika.
export const RFI_SHOVE = { 0: 20, 1: 58, 2: 52, 3: 44, 4: 36, 5: 30, 6: 26, 7: 23 };
export const RFI_DEEP  = { 0: 14, 1: 46, 2: 42, 3: 32, 4: 26, 5: 21, 6: 18, 7: 15 };

// ═══ §2. PENILAIAN TANGAN AWAL: CHART 169 TANGAN → PERSENTIL ═════
// Pengganti scorePreflopHand. Rumus lama punya plafon matematis 69,5 untuk
// AKs sementara ambang raise-nya 75 — jadi TIDAK ADA tangan non-pair yang
// bisa membuka raise, selamanya. Chart ini bisa dibaca & disetel manusia:
// menggeser 76s naik cukup satu edit string.
export const CHART =
 'AA KK QQ JJ AKs AQs TT AKo AJs KQs 99 ATs AQo KJs 88 QJs KTs A9s AJo QTs KQo KJo 77 ' +
 'JTs A8s K9s ATo A7s Q9s 66 T9s A5s A6s J9s QJo A4s 55 KTo A3s 98s Q8s T8s A2s K8s ' +
 'JTo J8s 44 87s QTo 97s K7s A9o 33 76s T7s Q7s K6s 22 J7s 86s A8o K5s 65s 96s Q6s ' +
 'K4s A7o J9o T9o 75s K3s Q5s A5o T6s A6o 54s K2s Q4s J6s 85s A4o 98o 95s 64s Q3s J5s ' +
 'A3o K9o T5s 87o Q2s J4s 74s 53s A2o T4s J3s 84s Q9o 76o J8o K8o T8o 63s J2s T3s 43s ' +
 '94s Q8o 65o T2s 93s 73s 52s K7o J7o 97o 86o 42s 92s 83s 54o Q7o K6o 32s 62s 82s 72s ' +
 '75o T7o J6o 96o K5o Q6o 64o 85o T6o J5o K4o Q5o 53o 95o J4o T5o K3o 43o 74o Q4o J3o ' +
 'K2o 84o T4o Q3o J2o 63o 52o 94o T3o Q2o 73o 42o T2o 83o 93o 32o 62o 82o 92o 72o';

const RN = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
const HAND_PCT = {};
{
  let cum = 0;
  for (const h of CHART.split(' ')) {
    cum += h.length === 2 ? 6 : (h[2] === 's' ? 4 : 12); // pair 6 kombo, suited 4, offsuit 12
    HAND_PCT[h] = (cum / 1326) * 100;
  }
}

function handCode(c1, c2) {
  const hi = Math.max(c1.rank, c2.rank), lo = Math.min(c1.rank, c2.rank);
  if (hi === lo) return RN[hi] + RN[hi];
  return RN[hi] + RN[lo] + (c1.suit === c2.suit ? 's' : 'o');
}

/** "Tangan ini masuk berapa persen teratas dari semua tangan awal." */
export function handPercentile(hole) {
  if (!hole || hole.length !== 2) return 100;
  const v = HAND_PCT[handCode(hole[0], hole[1])];
  return v === undefined ? 100 : v;
}

// ═══ §3. fastEval — evaluator integer khusus simulasi ════════════
// evaluate7Cards TETAP dipakai texasHoldem.js untuk showdown karena di sana
// butuh name/description untuk dicetak ke chat. fastEval hanya untuk loop
// enumerasi: satu integer, dibandingkan dengan `>`. Sekitar 237x lebih cepat,
// dan sudah diuji menghasilkan urutan yang identik.
const SUIT_IDX = { s: 0, h: 1, c: 2, d: 3 };
const SUIT_KEY = ['s', 'h', 'c', 'd'];

const STRAIGHTS = (() => {
  const m = [];
  for (let hi = 14; hi >= 6; hi--) {
    let k = 0;
    for (let r = hi; r > hi - 5; r--) k |= 1 << r;
    m.push({ hi, mask: k });
  }
  // Wheel A-2-3-4-5: As dipakai sebagai kartu rendah, jadi masknya eksplisit.
  m.push({ hi: 5, mask: (1 << 14) | (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2) });
  return m;
})();

function straightHigh(mask) {
  for (let i = 0; i < STRAIGHTS.length; i++) {
    if ((mask & STRAIGHTS[i].mask) === STRAIGHTS[i].mask) return STRAIGHTS[i].hi;
  }
  return 0;
}

const _cnt = new Int8Array(15);

/** Kekuatan tangan sebagai SATU integer. Makin besar makin kuat. */
export function fastEval(cards, n) {
  if (n === undefined) n = cards.length;
  _cnt.fill(0);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0, rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i], r = c.rank, si = SUIT_IDX[c.suit];
    _cnt[r]++;
    rankMask |= 1 << r;
    if (si === 0) { s0 |= 1 << r; c0++; }
    else if (si === 1) { s1 |= 1 << r; c1++; }
    else if (si === 2) { s2 |= 1 << r; c2++; }
    else { s3 |= 1 << r; c3++; }
  }
  let fm = -1;
  if (c0 >= 5) fm = s0; else if (c1 >= 5) fm = s1; else if (c2 >= 5) fm = s2; else if (c3 >= 5) fm = s3;
  if (fm >= 0) {
    const sh = straightHigh(fm);
    if (sh) return ((sh === 14 ? 9 : 8) << 20) | (sh << 16);
  }
  let quad = 0, trip = 0, trip2 = 0, p1 = 0, p2 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = _cnt[r];
    if (c === 4) { if (!quad) quad = r; }
    else if (c === 3) { if (!trip) trip = r; else if (!trip2) trip2 = r; }
    else if (c === 2) { if (!p1) p1 = r; else if (!p2) p2 = r; }
  }
  if (quad) {
    let k = 0;
    for (let r = 14; r >= 2; r--) if (r !== quad && _cnt[r]) { k = r; break; }
    return (7 << 20) | (quad << 16) | (k << 12);
  }
  if (trip && (trip2 || p1)) {
    const p = trip2 > p1 ? trip2 : p1;
    return (6 << 20) | (trip << 16) | (p << 12);
  }
  if (fm >= 0) {
    let v = 5 << 20, sh = 16, t = 0;
    for (let r = 14; r >= 2 && t < 5; r--) if (fm & (1 << r)) { v |= r << sh; sh -= 4; t++; }
    return v;
  }
  const st = straightHigh(rankMask);
  if (st) return (4 << 20) | (st << 16);
  if (trip) {
    let v = (3 << 20) | (trip << 16), sh = 12, t = 0;
    for (let r = 14; r >= 2 && t < 2; r--) if (r !== trip && _cnt[r]) { v |= r << sh; sh -= 4; t++; }
    return v;
  }
  if (p1 && p2) {
    let k = 0;
    for (let r = 14; r >= 2; r--) if (r !== p1 && r !== p2 && _cnt[r]) { k = r; break; }
    return (2 << 20) | (p1 << 16) | (p2 << 12) | (k << 8);
  }
  if (p1) {
    let v = (1 << 20) | (p1 << 16), sh = 12, t = 0;
    for (let r = 14; r >= 2 && t < 3; r--) if (r !== p1 && _cnt[r]) { v |= r << sh; sh -= 4; t++; }
    return v;
  }
  let v = 0, sh = 16, t = 0;
  for (let r = 14; r >= 2 && t < 5; r--) if (_cnt[r]) { v |= r << sh; sh -= 4; t++; }
  return v;
}

const jepit = (v, a, b) => (v < a ? a : v > b ? b : v);
const acak = () => Math.random();

// ═══ §4. PENILAIAN POSTFLOP RELATIF PAPAN ════════════════════════
// Pertanyaan yang benar bukan "kelas tanganku apa", tapi "berapa persen
// tangan yang mungkin dipegang lawan yang bisa kukalahkan DI PAPAN INI".
// Dihitung ENUMERASI EKSAK atas seluruh kombo dua-kartu yang tersisa, bukan
// Monte Carlo — jadi deterministik (spot yang sama selalu memberi angka yang
// sama, tidak terbaca "ngaco") dan tetap murah.
//
// Ini yang membedakan "punya pair" milik BOT LAMA dari kenyataan: pasangan
// yang ada DI PAPAN dimiliki semua orang dan cuma mengalahkan 8% range lawan,
// tapi bot lama membacanya sebagai rank=1 lalu memanggil taruhan.
const SEMUA_KARTU = createDeck();
const _buf = new Array(7);

export function boardRank(hole, board, oppPct) {
  if (oppPct === undefined) oppPct = 100;
  if (!hole || hole.length !== 2 || !board || board.length < 3) return 0.5;
  // Kunci dibangun dari rank+suit, BUKAN dari c.id: pemanggil uji sering
  // membuat kartu polos `{rank, suit}` tanpa id, dan kalau kuncinya undefined
  // seluruh dek dianggap tersedia — bot lalu menghitung lawan yang memegang
  // kartu yang sedang dipegangnya sendiri.
  const kunci = c => c.rank * 4 + SUIT_IDX[c.suit];
  const pakai = new Set();
  for (const c of hole) pakai.add(kunci(c));
  for (const c of board) pakai.add(kunci(c));
  const sisa = [];
  for (const c of SEMUA_KARTU) if (!pakai.has(kunci(c))) sisa.push(c);
  for (let k = 0; k < board.length; k++) _buf[k + 2] = board[k];
  const nb = board.length + 2;
  const mine = hole.concat(board);
  const my = fastEval(mine, mine.length);
  let menang = 0, seri = 0, n = 0;
  for (let i = 0; i < sisa.length - 1; i++) {
    const a = sisa[i];
    for (let j = i + 1; j < sisa.length; j++) {
      const b = sisa[j];
      if (oppPct < 100 && handPercentile([a, b]) > oppPct) continue; // hanya range lawan
      _buf[0] = a; _buf[1] = b;
      const v = fastEval(_buf, nb);
      if (my > v) menang++; else if (my === v) seri++;
      n++;
    }
  }
  return n ? (menang + seri * 0.5) / n : 0.5;
}

/**
 * Klasifikasi tangan RELATIF papan.
 * Jangan pakai daftar 5 kartu terbaik untuk ini — "pasangan milik papan" dan
 * "top pair" sama-sama tampak memakai satu kartu tangan.
 */
export function classifyMade(hole, board) {
  const all = hole.concat(board);
  const v = fastEval(all, all.length);
  const cls = v >>> 20;
  const bv = board.length >= 5 ? fastEval(board, board.length) : -1;
  const mainPapan = bv >= 0 && bv === v; // kartu tangan tidak menambah apa pun
  const rp = board.map(c => c.rank).sort((a, b) => b - a);
  let tipe = 'lain', kicker = 0;
  if (cls === 1) {
    const pr = (v >> 16) & 0xF;
    kicker = (v >> 12) & 0xF;
    const diHole = hole.filter(c => c.rank === pr).length;
    if (diHole === 2) tipe = pr > (rp[0] || 0) ? 'overpair' : 'underpair';
    else if (diHole === 1) {
      const idx = rp.indexOf(pr);
      tipe = idx === 0 ? 'toppair' : (idx === rp.length - 1 ? 'bottompair' : 'middlepair');
      // Kicker YANG BENAR adalah kartu tanganku yang lain. Membaca kicker dari
      // hasil evaluasi bisa mengambil kartu papan: K2 di papan K-9-4 terbaca
      // berkicker 9, padahal kickerku 2.
      const lain = hole.find(c => c.rank !== pr);
      kicker = lain ? lain.rank : kicker;
    } else tipe = 'boardpair'; // pasangan milik SEMUA ORANG
  } else if (cls === 0) tipe = 'udara';
  return { cls, tipe, kicker, mainPapan, nilai: v };
}

// ═══ §5. DETEKSI DRAW ════════════════════════════════════════════
// Straight draw dicari dengan menggeser bitmask: untuk tiap rank yang belum
// ada, cek apakah straight menyala. 2 rank lolos = OESD/double-gutshot,
// 1 = gutshot. Flush draw hanya dihitung kalau minimal satu kartunya dari
// tangan kita — kalau 4 kartu sesuit semuanya di papan, itu draw milik semua
// orang dan tidak memberi kita keunggulan apa pun.
export function detectDraws(hole, board) {
  const h = { flushDraw: false, nutFlush: false, backdoorFlush: false, straightOuts: 0, outs: 0, tipe: 'none' };
  if (!board || board.length < 3 || board.length >= 5) return h; // di river tidak ada draw
  let mask = 0;
  const sc = [0, 0, 0, 0], hs = [0, 0, 0, 0];
  for (const c of board) { mask |= 1 << c.rank; sc[SUIT_IDX[c.suit]]++; }
  for (const c of hole) { mask |= 1 << c.rank; sc[SUIT_IDX[c.suit]]++; hs[SUIT_IDX[c.suit]]++; }
  for (let i = 0; i < 4; i++) {
    if (sc[i] === 4 && hs[i] >= 1) {
      h.flushDraw = true;
      if (hole.some(c => c.suit === SUIT_KEY[i] && c.rank === 14)) h.nutFlush = true;
    }
    if (sc[i] === 3 && hs[i] >= 1 && board.length === 3) h.backdoorFlush = true;
  }
  if (!straightHigh(mask)) { // straight SUDAH jadi berarti bukan draw
    let n = 0;
    for (let r = 2; r <= 14; r++) {
      if (mask & (1 << r)) continue;
      if (straightHigh(mask | (1 << r))) n++;
    }
    h.straightOuts = n >= 2 ? 8 : n === 1 ? 4 : 0;
    h.tipe = n >= 2 ? 'OESD' : n === 1 ? 'gutshot' : 'none';
  }
  if (h.flushDraw && h.straightOuts >= 8) h.outs = 15;      // dikurangi karena tumpang tindih
  else if (h.flushDraw && h.straightOuts === 4) h.outs = 12;
  else h.outs = (h.flushDraw ? 9 : 0) + h.straightOuts;
  return h;
}

// ═══ §6. HARGA: pot odds, implied, reverse implied ═══════════════
// Ini yang membunuh "fold walau cuma bayar 5 ke pot 500": ambangnya ikut harga.
export function requiredEquity(ctx, draw, made) {
  const setelah = ctx.pot + ctx.toCall;
  let implied = 0;
  if (ctx.fase !== 'RIVER' && ctx.effStack > ctx.toCall && draw.outs >= 4) {
    let f = draw.outs >= 8 ? 0.60 : 0.32;
    if (draw.nutFlush) f += 0.15;
    if (ctx.fase === 'TURN') f *= 0.6;                        // tinggal satu kartu lagi
    f *= 1 + 0.12 * Math.max(0, ctx.nOpp - 1);                // multiway = lebih banyak yang membayar
    implied = Math.min(ctx.effStack - ctx.toCall, setelah * f);
  }
  let rio = 0;
  if (ctx.fase !== 'RIVER') {
    // Tangan yang kalau menang menangnya kecil, kalau kalah kalahnya besar.
    const lemah = made.mainPapan || made.tipe === 'boardpair' || made.tipe === 'bottompair' ||
                  made.tipe === 'underpair' || (made.tipe === 'toppair' && made.kicker <= 9);
    if (lemah) {
      let r = (made.mainPapan || made.tipe === 'boardpair') ? 0.35 : 0.18;
      if (!ctx.inPosition) r += 0.07;
      r += 0.04 * Math.max(0, ctx.nOpp - 1);
      rio = setelah * Math.min(0.5, r);
    }
  }
  return ctx.toCall / Math.max(1, setelah + implied - rio);
}

/** Range lawan ditebak dari aksinya: makin besar taruhannya, makin sempit. */
export function tebakRangeLawan(ctx) {
  let r = ctx.adaRaisePreflop ? 45 : 78;
  if (ctx.toCall > 0) {
    const b = ctx.toCall / Math.max(1, ctx.pot - ctx.toCall); // taruhan relatif pot
    r *= jepit(1 - 0.45 * Math.min(1.2, b), 0.45, 1);
  }
  r *= jepit(1 + 0.10 * (ctx.nOpp - 1), 1, 1.5);              // multiway = range lebih lebar
  return jepit(r, 12, 92);
}

/**
 * Nilai showdown SEKARANG ditambah potensi draw. Sengaja bukan simulasi
 * runout: aturan 2/4 yang diskala "seberapa jauh aku tertinggal" sudah cukup,
 * dan bebas dari derau acak.
 */
export function estimasiEquity(br, outs, fase) {
  if (fase === 'RIVER' || outs <= 0) return br;
  const pHit = Math.min(0.62, outs * (fase === 'FLOP' ? 0.04 : 0.02));
  return Math.min(0.97, br + (1 - br) * pHit * 0.85);
}

/**
 * Tekstur papan: menguntungkan range siapa. Papan tinggi & kering menguntungkan
 * penyerang, jadi c-bet sering & kecil. Papan rendah nyambung sebaliknya.
 */
export function fitPapan(board) {
  if (!board || !board.length) return 0.5;
  const r = board.map(c => c.rank);
  const hi = Math.max.apply(null, r), lo = Math.min.apply(null, r);
  const sc = {};
  for (const c of board) sc[c.suit] = (sc[c.suit] || 0) + 1;
  const duaWarna = Object.keys(sc).some(k => sc[k] >= 2);
  const berpasangan = new Set(r).size < r.length;
  const f = 0.50 + (hi - 8) * 0.018 - (hi - lo <= 4 ? 0.05 : 0) -
            (duaWarna ? 0.02 : 0) + (berpasangan ? 0.03 : 0);
  return jepit(f, 0.40, 0.66);
}

// ═══ §7. UKURAN TARUHAN & PENJAGA INVARIAN ═══════════════════════
/**
 * Fraksi pot menjadi tangga kelipatan big blind. Tangga WAJIB relatif BB —
 * tangga absolut akan menabrak all-in di buy-in kecil. Ada aturan anti-receh:
 * tidak ada manusia yang menyisakan 4 chip di depannya.
 * `amount` yang dikembalikan adalah DELTA di atas currentBet (kontrak engine).
 */
export function ukuranTaruhan(ctx, fraksi) {
  const maks = Math.max(0, ctx.myStack - ctx.toCall);
  if (maks <= 0) return { action: ctx.toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
  const target = Math.round((ctx.pot + ctx.toCall) * fraksi);
  let delta = Math.max(ctx.minRaise, target - ctx.toCall);
  const tangga = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 14, 20]
    .map(m => Math.round(m * ctx.bigBlind))
    .filter(v => v >= ctx.minRaise && v <= maks);
  if (tangga.length) delta = tangga.reduce((a, b) => (Math.abs(b - delta) < Math.abs(a - delta) ? b : a));
  delta = jepit(delta, ctx.minRaise, maks);
  if (maks - delta <= ctx.bigBlind * 0.6) return { action: 'ALLIN', amount: 0 };
  return { action: 'RAISE', amount: delta };
}

/**
 * Engine sudah memperbaiki CHECK-saat-ada-taruhan, RAISE-kekecilan, dan
 * RAISE-melebihi-stack. Yang TIDAK ditambalnya: cabang FOLD tidak pernah
 * memeriksa toCall. Bot yang melipat padahal boleh melihat kartu GRATIS
 * menghancurkan seluruh ilusi lawan hidup hanya dengan satu pesan.
 */
export function jagaInvarian(k, ctx) {
  if (!k || typeof k !== 'object') return { action: ctx.toCall > 0 ? 'FOLD' : 'CHECK', amount: 0 };
  if (k.action === 'FOLD' && ctx.toCall <= 0) return { action: 'CHECK', amount: 0 };
  if (k.action === 'ALLIN' && ctx.myStack <= 0) return { action: ctx.toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
  if (k.action === 'RAISE') {
    const maks = Math.max(0, ctx.myStack - ctx.toCall);
    if (maks <= 0) return { action: ctx.toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
    let a = Math.floor(Number(k.amount) || 0);
    if (a < ctx.minRaise) a = ctx.minRaise;
    if (a >= maks) return { action: 'ALLIN', amount: 0 };
    return { action: 'RAISE', amount: a };
  }
  return k;
}

// ═══ §8. KEPUTUSAN PREFLOP ═══════════════════════════════════════
export function keputusanPreflop(ctx) {
  const g = ambilGaya(ctx.persona);
  const pctl = handPercentile(ctx.hole);
  const effBB = ctx.effStack / Math.max(1, ctx.bigBlind);
  // Satu variabel memilih seluruh mode main. Dengan blind 10%/20% buy-in,
  // effBB selalu sekitar 5 sehingga gigi SHOVE yang menyala. Kalau blind
  // diperkecil, gigi DEEP menyala sendiri tanpa satu baris pun diubah.
  const gigi = effBB <= 8 ? 'SHOVE' : effBB <= 15 ? 'SHORT' : 'DEEP';
  const chart = gigi === 'DEEP' ? RFI_DEEP : RFI_SHOVE;
  // Math.random() BARU tiap cabang. Kode lama mengambil `rand` sekali lalu
  // memakainya ulang di 6-9 tempat, sehingga cabang-cabangnya berkorelasi:
  // bot yang "beruntung" di satu cabang otomatis beruntung di semuanya.
  const j = () => (acak() - 0.5) * 2 * g.noise;
  const pb = Math.min(7, Math.max(0, ctx.playersBehind));

  // ── belum ada raise: buka pot sesuai chart posisi ──
  if (!ctx.adaRaise) {
    const amb = Math.min(85, (chart[pb] === undefined ? 25 : chart[pb]) * g.rfi);
    if (pctl + j() <= amb) {
      if (gigi === 'SHOVE') {
        // GOVERNOR: hanya 15% teratas dari range buka yang jadi shove. Sisanya
        // min-raise, sengaja mengorbankan sedikit EV supaya FLOP tetap terjadi
        // dan permainannya tidak berubah jadi lempar koin.
        if (pctl <= amb * 0.15) return { action: 'ALLIN', amount: 0 };
        return jagaInvarian({ action: 'RAISE', amount: ctx.minRaise }, ctx);
      }
      const buka = Math.round(ctx.bigBlind * (pb >= 5 ? 2.5 : 2.2));
      return jagaInvarian({ action: 'RAISE', amount: Math.max(ctx.minRaise, buka - ctx.toCall) }, ctx);
    }
    // Tidak pernah limp: kalau kita yang pertama masuk, itu raise atau fold.
    return { action: ctx.toCall === 0 ? 'CHECK' : 'FOLD', amount: 0 };
  }

  // ── menghadapi raise: MDF (Minimum Defense Frequency) ──
  // Kalau kita melipat lebih sering daripada MDF, lawan untung dengan bertaruh
  // kartu apa pun. Inilah perbaikan tunggal terbesar untuk "gampang banget fold".
  const potOdds = ctx.toCall / Math.max(1, ctx.pot + ctx.toCall);
  const mdf = 1 - potOdds;
  // MDF mengandaikan seluruh equity terwujud — tidak benar di luar posisi, dan
  // sama sekali tidak berlaku untuk pemain dingin yang belum menyetor apa pun
  // (dia tidak rugi apa-apa dengan melipat). Tanpa diskon ini bot bocor pelan.
  const realisasi = pb === 0 ? 0.80                        // BB: sudah setor, bicara terakhir
                  : ctx.isSmallBlind ? 0.72                // sudah setor, tapi selalu OOP
                  : Math.max(0.40, 0.66 - 0.045 * pb);     // cold-call, makin banyak di belakang makin ketat
  const ambBertahan = Math.min(78, mdf * 100 * realisasi * g.def);
  // GOVERNOR: 3-bet dipagari keras di 8 persentil. Tanpa pagar ini pemaksimal
  // EV melawan model lawan statis selalu berubah jadi maniak.
  const ambRaise = Math.min(8, ambBertahan * 0.20 * g.agr);

  if (pctl + j() <= ambRaise) {
    if (effBB <= 15 || ctx.toCall >= ctx.myStack * 0.5) return { action: 'ALLIN', amount: 0 };
    return jagaInvarian({ action: 'RAISE', amount: Math.max(ctx.minRaise, Math.round(ctx.toCall * 2.2)) }, ctx);
  }
  if (pctl + j() <= ambBertahan) {
    return { action: ctx.toCall >= ctx.myStack ? 'ALLIN' : 'CALL', amount: 0 };
  }
  if (pb <= 1 && acak() < g.bluff * 0.20) return { action: 'ALLIN', amount: 0 };
  return { action: ctx.toCall === 0 ? 'CHECK' : 'FOLD', amount: 0 };
}

// ═══ §9. KEPUTUSAN POSTFLOP ══════════════════════════════════════
export function keputusanPostflop(ctx) {
  const g = ambilGaya(ctx.persona);
  const br = boardRank(ctx.hole, ctx.board, tebakRangeLawan(ctx));
  const draw = detectDraws(ctx.hole, ctx.board);
  const made = classifyMade(ctx.hole, ctx.board);
  const eq1 = estimasiEquity(br, draw.outs, ctx.fase);
  // Mengalahkan k lawan kira-kira eq pangkat k. Bot otomatis mengencang di pot
  // ramai tanpa satu pun aturan tambahan.
  const eq = ctx.nOpp <= 1 ? eq1 : Math.pow(eq1, 1 + 0.75 * (ctx.nOpp - 1));
  const spr = ctx.effStack / Math.max(1, ctx.pot);
  const fr = () => g.sizing[0] + (g.sizing[1] - g.sizing[0]) * acak();
  // GOVERNOR: all-in bukan alat gertak.
  const bolehAllIn = eq >= 0.55 || spr < 1.5;
  const bungkus = k => {
    const h = jagaInvarian(k, ctx);
    if (h.action === 'ALLIN' && !bolehAllIn) return { action: ctx.toCall > 0 ? 'CALL' : 'CHECK', amount: 0 };
    return h;
  };

  // ── tidak ada taruhan aktif: bertaruh atau check ──
  if (ctx.toCall === 0) {
    if (eq >= 0.62) return bungkus(ukuranTaruhan(ctx, fr()));                                   // value
    if (draw.outs >= 6 && acak() < 0.45 * g.agr) return bungkus(ukuranTaruhan(ctx, fr() * 0.8)); // semi-bluff
    if (ctx.akuAgresor && ctx.fase === 'FLOP') {                                                // continuation bet
      const fit = fitPapan(ctx.board);
      const p = jepit((fit - 0.44) / 0.20, 0.20, 0.92) * g.cbet;
      if (acak() < p && (eq >= 0.40 || draw.outs >= 4 || made.cls === 0)) {
        return bungkus(ukuranTaruhan(ctx, fit > 0.55 ? 0.35 : 0.62));                           // kering kecil, basah besar
      }
    }
    if (made.cls === 0 && draw.outs < 4 && ctx.nOpp <= 2 && acak() < g.bluff * 0.45) {
      return bungkus(ukuranTaruhan(ctx, fr()));
    }
    return { action: 'CHECK', amount: 0 };
  }

  // ── menghadapi taruhan ──
  // `def` ikut menggeser ambang CALL, bukan cuma agresi. Tanpa ini semua
  // kepribadian punya fold-rate identik — padahal fold/call adalah aksi yang
  // PALING sering dilihat pemain.
  const req = requiredEquity(ctx, draw, made) / g.def;
  // GOVERNOR POLARISASI: hanya value dan semi-bluff yang boleh menaikkan.
  // Tangan MEDIUM wajib CALL — menaikkannya cuma melipat yang lebih lemah dan
  // dipanggil yang lebih kuat.
  if (eq >= 0.62 && acak() < 0.55 * g.agr) return bungkus(ukuranTaruhan(ctx, fr()));
  if (draw.outs >= 8 && ctx.fase !== 'RIVER' && acak() < 0.30 * g.agr) {
    return bungkus(ukuranTaruhan(ctx, fr() * 0.8));
  }
  if (eq >= req) return { action: ctx.toCall >= ctx.myStack ? 'ALLIN' : 'CALL', amount: 0 };
  // Kesalahan manusiawi, DIGERBANGI KEYAKINAN: keputusan yang jelas (melipat
  // 7-2 melawan all-in) tidak pernah dibalik. Hanya "bayar karena penasaran"
  // di spot tipis dan murah — kesalahan yang memang dilakukan manusia.
  const keyakinan = jepit((req - eq) / 0.12, 0, 1);
  if (ctx.toCall <= 0.45 * ctx.pot && acak() < g.salah * (1 - keyakinan)) {
    return { action: ctx.toCall >= ctx.myStack ? 'ALLIN' : 'CALL', amount: 0 };
  }
  return { action: 'FOLD', amount: 0 };
}

export function decideAction(ctx) {
  return jagaInvarian(ctx.fase === 'PREFLOP' ? keputusanPreflop(ctx) : keputusanPostflop(ctx), ctx);
}

// ═══ §10. LAPIS MANUSIAWI ════════════════════════════════════════
/**
 * Dulu tiap bot menunggu 1500-2500 ms acak seragam apa pun keputusannya —
 * tanda robot paling telanjang di sistem ini. Manusia melipat sampah dalam
 * sepersekian detik dan menyiksa diri satu menit di river.
 */
export function waktuBerpikir(o) {
  const r = Math.random;
  const tipis = o.tipis === undefined ? 0.5 : o.tipis;
  let ms = 800 + r() * 600;
  ms += tipis * (600 + r() * 2000);
  if (o.aksi === 'FOLD') ms *= 0.50 + r() * 0.25;
  if (o.aksi === 'CHECK') ms *= 0.70;
  // BIMODAL: manusia cuma dua macam saat all-in — snap-shove, atau mikir lama
  // lalu shove. Hampir tidak pernah di tengah-tengah.
  if (o.aksi === 'ALLIN') ms = r() < 0.40 ? 700 + r() * 500 : ms + 1200 + r() * 1800;
  if (o.fase === 'RIVER') ms *= 1.20;
  if (r() < 0.06) ms += 1800 + r() * 1800;                       // sesekali orang ambil minum
  ms = Math.round(ms * (o.tempo || 1));
  if (o.banyakBot) ms = Math.min(4500, Math.round(ms * 0.75));   // rem wajib untuk meja >= 4 bot
  return Math.max(600, Math.min(6000, ms));                      // plafon 6 dtk: chat hening terbaca "bot hang"
}

// Celetuk HANYA dari kejadian PUBLIK yang sudah dilihat pemain. HARAM dipicu
// oleh kartu sendiri: celetuk yang berkorelasi dengan kekuatan tangan justru
// membuat bot lebih mudah dibaca — kebalikan dari tujuannya.
const CELETUK = {
  SULTAN:   { ditekan: ['segitu doang?', 'ayo naikin lagi'], shove: ['sekalian aja'], ramai: ['rame nih'] },
  TEMBOK:   { ditekan: ['ya udah, ikut'],                    shove: ['nekat dikit'],  ramai: ['banyak amat'] },
  SANTAI:   { ditekan: ['santai bang'],                      shove: ['gas'],          ramai: ['ikut deh'] },
  EMOSI:    { ditekan: ['ah sialan'],                        shove: ['bodo amat'],    ramai: ['ganggu aja'] },
  PENJEBAK: { ditekan: ['hmm...'],                           shove: ['oke'],          ramai: ['sabar'] },
  PROFESOR: { ditekan: ['menarik'],                          shove: ['saya komit'],   ramai: ['ramai ya'] },
  BATU:     {} // diamnya sendiri sudah jadi karakter
};

export function celetukUntuk(persona, peristiwa, mulut) {
  if (Math.random() > (mulut || 0)) return null;
  const t = CELETUK[persona] && CELETUK[persona][peristiwa];
  return t && t.length ? t[Math.floor(Math.random() * t.length)] : null;
}

// ═══ §11. SHIM KOMPATIBILITAS ════════════════════════════════════
// Tanda tangan lama dipertahankan supaya scripts/pokerAiSmokeTest.mjs dan
// pemanggil lain tidak pecah. Engine memakai decideAction langsung.
function shim(hole, board, currentBet, playerBet, pot, minRaise, fase, personality) {
  const bb = minRaise || 10;
  const toCall = Math.max(0, currentBet - playerBet);
  return decideAction({
    persona: ALIAS[personality] || personality || 'PROFESOR',
    fase, hole, board: board || [], pot, toCall, minRaise: bb, bigBlind: bb,
    myStack: 50, effStack: 50, nOpp: 1,
    playersBehind: toCall === 0 ? 0 : 2, inPosition: toCall === 0,
    isSmallBlind: false, adaRaise: currentBet > bb, adaRaisePreflop: currentBet > bb,
    akuAgresor: false
  });
}

export const decidePreflopAction = (h, cb, pb, pot, mr, p) => shim(h, [], cb, pb, pot, mr, 'PREFLOP', p);
export const decidePostflopAction = (h, cc, cb, pb, pot, mr, fase, p) => shim(h, cc, cb, pb, pot, mr, fase, p);

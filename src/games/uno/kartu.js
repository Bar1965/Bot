/**
 * 🎴 UNO — MODEL KARTU & ATURAN DASAR
 *
 * Sengaja dipisah dari mesin permainan dan dibuat MURNI (tanpa socket, tanpa
 * database, tanpa Math.random di jalur aturan) supaya seluruh aturannya bisa
 * diuji sungguhan oleh smoke test. Pelajaran dari Buckshot: test yang menulis
 * ulang logika permainan di dalam dirinya sendiri selalu hijau dan tidak pernah
 * menangkap apa pun.
 *
 * Satu kartu = { warna: 'M'|'K'|'H'|'B'|null, simbol: '0'..'9'|'S'|'R'|'D2'|'W'|'W4' }
 * Kartu liar (W, W4) punya warna null sampai pemain memilih warnanya.
 */

export const WARNA = {
  M: { nama: 'Merah', emoji: '🔴' },
  K: { nama: 'Kuning', emoji: '🟡' },
  H: { nama: 'Hijau', emoji: '🟢' },
  B: { nama: 'Biru', emoji: '🔵' }
};

export const KODE_WARNA = ['M', 'K', 'H', 'B'];

/** Pemain boleh mengetik warna dalam bahasa apa pun yang wajar. */
export const ALIAS_WARNA = {
  m: 'M', merah: 'M', red: 'M', abang: 'M',
  k: 'K', kuning: 'K', yellow: 'K', kunig: 'K',
  h: 'H', hijau: 'H', green: 'H', ijo: 'H',
  b: 'B', biru: 'B', blue: 'B'
};

const NAMA_SIMBOL = {
  S: 'Skip',
  R: 'Balik',
  D2: '+2',
  W: 'Wild',
  W4: 'Wild +4'
};

/** Kartu aksi berwarna (bukan angka, bukan liar). */
export const AKSI_BERWARNA = ['S', 'R', 'D2'];

export function isLiar(kartu) {
  return kartu?.simbol === 'W' || kartu?.simbol === 'W4';
}

export function isAngka(kartu) {
  return /^[0-9]$/.test(String(kartu?.simbol || ''));
}

/**
 * Deck standar 108 kartu:
 * per warna → satu 0, dua tiap 1-9, dua tiap Skip/Balik/+2  = 25 × 4 = 100
 * plus 4 Wild dan 4 Wild +4                                  = 8
 */
export function buatDeck() {
  const deck = [];
  for (const w of KODE_WARNA) {
    deck.push({ warna: w, simbol: '0' });
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      deck.push({ warna: w, simbol: n });
      deck.push({ warna: w, simbol: n });
    }
    for (const a of AKSI_BERWARNA) {
      deck.push({ warna: w, simbol: a });
      deck.push({ warna: w, simbol: a });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ warna: null, simbol: 'W' });
    deck.push({ warna: null, simbol: 'W4' });
  }
  return deck;
}

export function kocok(daftar, acak = Math.random) {
  const arr = [...daftar];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(acak() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Teks pendek satu kartu, mis. "🔴 7" atau "🟢 +2" atau "🃏 Wild +4". */
export function labelKartu(kartu) {
  if (!kartu) return '—';
  if (kartu.simbol === 'W') return '⭐ Wild';
  if (kartu.simbol === 'W4') return '🃏 Wild +4';
  const emoji = WARNA[kartu.warna]?.emoji || '⬜';
  const nama = NAMA_SIMBOL[kartu.simbol] || kartu.simbol;
  return `${emoji} ${nama}`;
}

/** Kartu teratas + warna aktif, mis. "⭐ Wild → 🔴 Merah". */
export function labelAtas(atas, warnaAktif) {
  const dasar = labelKartu(atas);
  if (isLiar(atas) && warnaAktif) {
    return `${dasar} → ${WARNA[warnaAktif].emoji} ${WARNA[warnaAktif].nama}`;
  }
  return dasar;
}

/**
 * Aturan legalitas UNO.
 *
 * Catatan sengaja: Wild +4 di sini boleh dimainkan kapan saja. Aturan resmi
 * mengharuskan pemain tidak memegang warna yang sedang aktif, tapi itu hanya
 * bermakna kalau ada mekanisme tantangan — dan tantangan berarti satu putaran
 * tanya-jawab tambahan di chat. Ditunda ke aturan opsional.
 */
export function bolehDimainkan(kartu, atas, warnaAktif) {
  if (!kartu) return false;
  if (isLiar(kartu)) return true;
  if (kartu.warna === warnaAktif) return true;
  if (atas && !isLiar(atas) && kartu.simbol === atas.simbol) return true;
  return false;
}

export function kartuLegalDi(tangan, atas, warnaAktif) {
  return (tangan || []).filter(k => bolehDimainkan(k, atas, warnaAktif));
}

export function adaKartuLegal(tangan, atas, warnaAktif) {
  return kartuLegalDi(tangan, atas, warnaAktif).length > 0;
}

/**
 * Warna yang paling banyak dipegang — dipakai bot untuk memilih warna kartu
 * liar, dan dipakai auto-main saat waktu giliran habis.
 */
export function warnaTerbanyak(tangan, cadangan = 'M') {
  const hitung = { M: 0, K: 0, H: 0, B: 0 };
  for (const k of tangan || []) {
    if (k.warna && hitung[k.warna] !== undefined) hitung[k.warna]++;
  }
  let terbaik = null;
  let skor = -1;
  for (const w of KODE_WARNA) {
    if (hitung[w] > skor) { skor = hitung[w]; terbaik = w; }
  }
  return skor > 0 ? terbaik : cadangan;
}

export function bacaWarna(teks) {
  const kunci = String(teks || '').trim().toLowerCase();
  return ALIAS_WARNA[kunci] || null;
}

/**
 * Efek kartu terhadap jalannya permainan.
 * `lewati` = pemain berikutnya kehilangan giliran, `tarik` = jumlah kartu
 * yang harus dia ambil, `balik` = arah putaran dibalik.
 */
export function efekKartu(kartu, jumlahPemain) {
  const simbol = kartu?.simbol;
  if (simbol === 'S') return { lewati: true, tarik: 0, balik: false };
  if (simbol === 'D2') return { lewati: true, tarik: 2, balik: false };
  if (simbol === 'W4') return { lewati: true, tarik: 4, balik: false };
  if (simbol === 'R') {
    // Di meja 2 pemain, membalik arah sama saja dengan melewati lawan —
    // aturan resmi UNO, dan tanpa ini giliran langsung kembali ke pemain
    // yang sama tanpa efek apa pun.
    if (jumlahPemain === 2) return { lewati: true, tarik: 0, balik: false };
    return { lewati: false, tarik: 0, balik: true };
  }
  return { lewati: false, tarik: 0, balik: false };
}

/**
 * Nilai kartu untuk penghitungan skor akhir (aturan UNO resmi).
 * Dipakai saat ronde ditutup paksa supaya ada dasar pemeringkatan.
 */
export function nilaiKartu(kartu) {
  if (!kartu) return 0;
  if (isLiar(kartu)) return 50;
  if (AKSI_BERWARNA.includes(kartu.simbol)) return 20;
  return parseInt(kartu.simbol, 10) || 0;
}

export function nilaiTangan(tangan) {
  return (tangan || []).reduce((t, k) => t + nilaiKartu(k), 0);
}

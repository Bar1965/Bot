/**
 * 🎨 PENGGAMBAR KARTU UNO
 *
 * Mengikuti pola yang sudah terbukti di `tcg/gambar.js`: wajah kartu itu
 * deterministik, jadi tiap wajah digambar SEKALI lalu disimpan ke disk.
 * Bedanya UNO cuma punya 54 wajah berbeda — 4 warna × 13 muka, plus Wild dan
 * Wild +4 — jadi seluruh cache-nya selesai terbentuk setelah satu-dua ronde
 * dan sesudah itu menyusun gambar tangan hanya berarti menempel PNG yang sudah
 * jadi.
 *
 * Ini yang membuat Fase 2 murah: biaya render dibayar sekali seumur hidup per
 * wajah kartu, bukan tiap giliran.
 *
 * Naikkan VERSI_KARTU setiap kali desainnya diubah. Tanpa penanda versi di nama
 * berkas, gambar lama di cache akan disajikan selamanya.
 */

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'fs';
import path from 'path';
import { WARNA, isLiar, bolehDimainkan } from './kartu.js';

// v2: Skip, Balik, dan Wild dulu digambar sebagai KARAKTER (⊘ ⇄ ★). Font di
// mesin ini tidak punya glyph-nya, jadi ketiganya keluar sebagai kotak kosong
// dan pemain melihat kartu tanpa muka. Sekarang ketiganya digambar sebagai
// bentuk — pelajaran yang sama sudah tercatat di tcg/gambar.js soal bintang
// rarity. Seluruh cache v1 salah dan harus ditinggalkan.
const VERSI_KARTU = 2;
const DIR_CACHE = path.join(process.cwd(), 'public', 'uno-cards');

export const LEBAR_KARTU = 220;
export const TINGGI_KARTU = 330;

const FONT_TEKS = GlobalFonts.families.some(f => /Segoe UI/i.test(f.family))
  ? '"Segoe UI", sans-serif'
  : 'sans-serif';

/** Warna cat tiap kartu: [gelap, terang] untuk gradasi latar. */
const CAT = {
  M: ['#7f1d1d', '#ef4444'],
  K: ['#854d0e', '#facc15'],
  H: ['#14532d', '#22c55e'],
  B: ['#1e3a8a', '#3b82f6']
};

const CAT_LIAR = ['#111827', '#374151'];

/**
 * Muka kartu yang aman ditulis sebagai TEKS — hanya angka dan tanda plus,
 * yang pasti ada di font apa pun. Skip, Balik, dan Wild sengaja tidak ada di
 * sini: ketiganya digambar sebagai bentuk (lihat catatan VERSI_KARTU).
 */
const MUKA_TEKS = {
  D2: '+2',
  W4: '+4'
};

function mukaTeks(kartu) {
  if (MUKA_TEKS[kartu.simbol]) return MUKA_TEKS[kartu.simbol];
  return /^[0-9]$/.test(kartu.simbol) ? kartu.simbol : null;
}

/** Lingkaran bergaris miring — lambang Skip. */
function ikonSkip(ctx, cx, cy, r, warna, tebal) {
  ctx.save();
  ctx.strokeStyle = warna;
  ctx.lineWidth = tebal;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const d = r * 0.72;
  ctx.beginPath();
  ctx.moveTo(cx - d, cy - d);
  ctx.lineTo(cx + d, cy + d);
  ctx.stroke();
  ctx.restore();
}

/** Satu panah lurus berkepala segitiga. `arah` -1 = ke atas, 1 = ke bawah. */
function panah(ctx, x, y, panjang, arah, warna, tebal) {
  const setengah = panjang / 2;
  const kepala = tebal * 1.9;
  const ujung = y + arah * setengah;
  const pangkal = y - arah * setengah;

  ctx.save();
  ctx.strokeStyle = warna;
  ctx.fillStyle = warna;
  ctx.lineWidth = tebal;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(x, pangkal);
  ctx.lineTo(x, ujung - arah * kepala * 0.6);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, ujung);
  ctx.lineTo(x - kepala, ujung - arah * kepala);
  ctx.lineTo(x + kepala, ujung - arah * kepala);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Dua panah berlawanan arah — lambang Balik. */
function ikonBalik(ctx, cx, cy, r, warna, tebal) {
  const pisah = r * 0.52;
  const panjang = r * 1.5;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 10);
  panah(ctx, -pisah, 0, panjang, -1, warna, tebal);
  panah(ctx, pisah, 0, panjang, 1, warna, tebal);
  ctx.restore();
}

/** Lingkaran empat juring warna — lambang Wild yang dipakai di sudut kartu. */
function ikonWild(ctx, cx, cy, r) {
  const urutan = ['M', 'K', 'H', 'B'];
  ctx.save();
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
    ctx.closePath();
    ctx.fillStyle = CAT[urutan[i]][1];
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.stroke();
  ctx.restore();
}

/** Kode unik per wajah kartu — dasar nama berkas cache. */
export function kodeKartu(kartu) {
  return isLiar(kartu) ? kartu.simbol : `${kartu.warna}${kartu.simbol}`;
}

function persegiBulat(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Wild digambar sebagai empat juring warna di dalam oval tengah — cara paling
 * cepat dikenali mata bahwa kartu ini bisa jadi warna apa saja.
 */
function gambarJuringWild(ctx, cx, cy, rx, ry) {
  const urutan = ['M', 'K', 'H', 'B'];
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.ellipse(cx, cy, rx, ry, -Math.PI / 9, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
    ctx.closePath();
    ctx.fillStyle = CAT[urutan[i]][1];
    ctx.fill();
    ctx.restore();
  }
}

function gambarWajahKartu(kartu) {
  const cv = createCanvas(LEBAR_KARTU, TINGGI_KARTU);
  const ctx = cv.getContext('2d');
  const liar = isLiar(kartu);
  const [gelap, terang] = liar ? CAT_LIAR : CAT[kartu.warna];

  // Badan kartu
  const grad = ctx.createLinearGradient(0, 0, 0, TINGGI_KARTU);
  grad.addColorStop(0, terang);
  grad.addColorStop(1, gelap);
  persegiBulat(ctx, 4, 4, LEBAR_KARTU - 8, TINGGI_KARTU - 8, 22);
  ctx.fillStyle = grad;
  ctx.fill();

  // Bingkai putih
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Oval tengah miring — ciri khas kartu UNO
  const cx = LEBAR_KARTU / 2;
  const cy = TINGGI_KARTU / 2;
  const rx = LEBAR_KARTU * 0.40;
  const ry = TINGGI_KARTU * 0.33;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, -Math.PI / 9, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  if (liar) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.86, ry * 0.86, -Math.PI / 9, 0, Math.PI * 2);
    ctx.clip();
    gambarJuringWild(ctx, cx, cy, rx, ry);
    ctx.restore();
  }

  // Muka utama — teks kalau aman ditulis, bentuk kalau tidak.
  const teks = mukaTeks(kartu);

  if (teks) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${teks.length > 1 ? 74 : 104}px ${FONT_TEKS}`;
    if (liar) {
      // Di atas juring warna-warni, teks putih bergaris gelap paling terbaca.
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#111827';
      ctx.strokeText(teks, cx, cy + 4);
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.fillStyle = gelap;
    }
    ctx.fillText(teks, cx, cy + 4);
  } else if (kartu.simbol === 'S') {
    ikonSkip(ctx, cx, cy, 54, gelap, 16);
  } else if (kartu.simbol === 'R') {
    ikonBalik(ctx, cx, cy, 54, gelap, 14);
  }
  // Wild polos: juring warna di dalam oval sudah jadi mukanya sendiri.

  // Muka kecil di dua sudut, yang bawah terbalik seperti kartu sungguhan.
  const gambarSudut = (x, y, terbalik) => {
    ctx.save();
    ctx.translate(x, y);
    if (terbalik) ctx.rotate(Math.PI);
    if (teks) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `bold ${teks.length > 1 ? 30 : 38}px ${FONT_TEKS}`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(teks, 0, 0);
    } else if (kartu.simbol === 'S') {
      ikonSkip(ctx, 15, -13, 15, '#ffffff', 5);
    } else if (kartu.simbol === 'R') {
      ikonBalik(ctx, 15, -13, 15, '#ffffff', 5);
    } else {
      ikonWild(ctx, 16, -13, 16);
    }
    ctx.restore();
  };

  gambarSudut(22, 44, false);
  gambarSudut(LEBAR_KARTU - 22, TINGGI_KARTU - 44, true);

  return cv.toBuffer('image/png');
}

/**
 * Buffer PNG satu wajah kartu, dari cache kalau ada.
 * Kegagalan menulis cache tidak boleh menggagalkan pengiriman gambar.
 */
export async function bufferKartuUno(kartu) {
  if (!kartu) return null;
  const berkas = path.join(DIR_CACHE, `${kodeKartu(kartu)}_v${VERSI_KARTU}.png`);

  try {
    return await fs.readFile(berkas);
  } catch {
    // belum ada di cache — gambar sekarang
  }

  const buf = gambarWajahKartu(kartu);
  try {
    await fs.mkdir(DIR_CACHE, { recursive: true });
    await fs.writeFile(berkas, buf);
  } catch (e) {
    console.warn('[UNO_GBR] Gagal menyimpan cache kartu:', e?.message || e);
  }
  return buf;
}

/**
 * Gambar tangan pemain: kartu bernomor, yang tidak bisa dimainkan diredupkan.
 *
 * Nomornya yang penting — itulah yang diketik pemain (`.u 3`). Peredupan kartu
 * ilegal membuat pemain tidak perlu menghafal aturan sama sekali; matanya
 * langsung tahu mana yang boleh.
 */
export async function bufferTanganUno(tangan, { atas, warnaAktif, perBaris = 4, bolehFn = null } = {}) {
  const kartuValid = (tangan || []).filter(Boolean);
  if (!kartuValid.length) return null;

  const kolom = Math.min(kartuValid.length, Math.max(1, perBaris));
  const baris = Math.ceil(kartuValid.length / kolom);
  const jarak = 18;
  const tinggiNomor = 46;

  const lebar = kolom * LEBAR_KARTU + (kolom + 1) * jarak;
  const tinggi = baris * (TINGGI_KARTU + tinggiNomor) + (baris + 1) * jarak;

  const cv = createCanvas(lebar, tinggi);
  const ctx = cv.getContext('2d');
  const latar = ctx.createLinearGradient(0, 0, 0, tinggi);
  latar.addColorStop(0, '#0f172a');
  latar.addColorStop(1, '#020617');
  ctx.fillStyle = latar;
  ctx.fillRect(0, 0, lebar, tinggi);

  for (let i = 0; i < kartuValid.length; i++) {
    const kartu = kartuValid[i];
    const buf = await bufferKartuUno(kartu);
    if (!buf) continue;

    const kol = i % kolom;
    const brs = Math.floor(i / kolom);
    const x = jarak + kol * (LEBAR_KARTU + jarak);
    const y = jarak + brs * (TINGGI_KARTU + tinggiNomor + jarak) + tinggiNomor;

    // `bolehFn` dipakai mesin permainan supaya peredupan kartu ikut menghormati
    // aturan rumah (mis. saat tumpukan +2/+4 berjalan, hanya kartu sejenis yang
    // sah) — bukan cuma kecocokan warna/simbol biasa.
    const legal = bolehFn ? !!bolehFn(kartu) : (atas ? bolehDimainkan(kartu, atas, warnaAktif) : true);

    ctx.save();
    ctx.globalAlpha = legal ? 1 : 0.34;
    const img = await loadImage(buf);
    ctx.drawImage(img, x, y);
    ctx.restore();

    // Lencana nomor slot
    const cx = x + LEBAR_KARTU / 2;
    const cy = y - tinggiNomor / 2 - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 19, 0, Math.PI * 2);
    ctx.fillStyle = legal ? '#22c55e' : '#475569';
    ctx.fill();
    ctx.fillStyle = legal ? '#052e16' : '#0f172a';
    ctx.font = `bold 22px ${FONT_TEKS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), cx, cy + 1);
  }

  return cv.toBuffer('image/png');
}

/** Menghapus cache — dipakai kalau desain kartunya diubah. */
export async function bersihkanCacheKartuUno() {
  try {
    const berkas = await fs.readdir(DIR_CACHE);
    await Promise.all(berkas.map(f => fs.unlink(path.join(DIR_CACHE, f)).catch(() => {})));
    return berkas.length;
  } catch {
    return 0;
  }
}

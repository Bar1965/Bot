/**
 * PENGGAMBAR KARTU ARENA
 *
 * Gambar kartu itu deterministik: CMN01 pada Lv.3 selalu tampak sama. Jadi tiap
 * wajah kartu digambar SEKALI lalu disimpan ke disk, dan pemakaian berikutnya
 * cuma membaca file. Drop tinggal menempelkan tiga berkas yang sudah jadi.
 *
 * Konsekuensinya, biaya render dibayar sekali seumur hidup per kartu — bukan
 * tiap kali kartu itu muncul — dan kalau nanti kamu punya gambar monster yang
 * sesungguhnya, cukup timpa berkasnya tanpa mengubah satu baris kode di sini.
 */

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'fs';
import path from 'path';
import { ELEMEN, STAT_RARITY, statKartu, SKILL, costKartu, getPeran } from './cards.js';

const DIR_CACHE = path.join(process.cwd(), 'public', 'tcg-cards');
// Naikkan angka ini setiap kali desain kartu diubah. Tanpa penanda versi di
// nama berkas, gambar lama di cache disajikan selamanya dan pemain melihat
// kartu yang tidak sesuai statistiknya. `bersihkanCacheKartu()` ada tapi tidak
// dipanggil dari mana pun, jadi jangan mengandalkannya.
// Dinaikkan ke 2 pada 27 Agu 2026: `peran` mengubah ATK/HP setiap kartu, jadi
// SEMUA gambar yang tersimpan di cache menampilkan angka yang sudah salah.
// Menaikkan versi ini adalah satu-satunya cara membuangnya.
// Dinaikkan ke 3: tiap kartu sekarang punya ATK/HP sendiri di katalog, plus
// stat KRITIS yang belum pernah tergambar. Seluruh cache lama salah lagi.
const VERSI_KARTU = 3;

export const LEBAR_KARTU = 300;
export const TINGGI_KARTU = 420;

// Font emoji berwarna wajib disebut eksplisit; tanpa itu napi-rs jatuh ke font
// teks biasa dan emoji elemen keluar sebagai kotak kosong.
const FONT_EMOJI = GlobalFonts.families.some(f => /Segoe UI Emoji/i.test(f.family))
  ? '"Segoe UI Emoji"'
  : 'sans-serif';

const WARNA_RARITY = {
  COMMON:    { garis: '#9aa4b2', teks: '#e2e8f0' },
  RARE:      { garis: '#4a9eff', teks: '#dbeafe' },
  EPIC:      { garis: '#a855f7', teks: '#f3e8ff' },
  LEGENDARY: { garis: '#f5a524', teks: '#fef3c7' },
  MYTHIC:    { garis: '#ef4444', teks: '#fee2e2' }
};

const WARNA_ELEMEN = {
  API:   ['#450a0a', '#b91c1c'],
  AIR:   ['#082f49', '#0369a1'],
  ANGIN: ['#052e16', '#15803d'],
  PETIR: ['#422006', '#a16207'],
  DARK:  ['#1e1b4b', '#5b21b6']
};

/**
 * Bintang digambar sebagai bentuk, bukan karakter.
 *
 * Font sans-serif di canvas tidak punya glif untuk ★ dan ☆, jadi memakainya
 * sebagai teks menghasilkan deretan kotak kosong. Menggambarnya sendiri juga
 * lebih tajam dan ukurannya bisa diatur bebas.
 */
function gambarSatuBintang(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const jari = i % 2 === 0 ? r : r * 0.45;
    const sudut = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + Math.cos(sudut) * jari;
    const y = cy + Math.sin(sudut) * jari;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function gambarBarisBintang(ctx, cx, cy, terisi, warnaIsi, total = 5, r = 11) {
  const jarak = r * 2.3;
  const mulai = cx - ((total - 1) * jarak) / 2;
  for (let i = 0; i < total; i++) {
    gambarSatuBintang(ctx, mulai + i * jarak, cy, r);
    if (i < terisi) {
      ctx.fillStyle = warnaIsi;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }
}

/** Kotak bersudut tumpul — dipakai berulang untuk bingkai dan panel stat. */
function kotakTumpul(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Mengecilkan ukuran font sampai teks muat di lebar yang tersedia. */
function tulisMuat(ctx, teks, x, y, lebarMaks, ukuranAwal, gaya = 'bold') {
  let ukuran = ukuranAwal;
  do {
    ctx.font = `${gaya} ${ukuran}px sans-serif`;
    if (ctx.measureText(teks).width <= lebarMaks) break;
    ukuran -= 2;
  } while (ukuran > 10);
  ctx.fillText(teks, x, y);
  return ukuran;
}

function gambarWajahKartu(kartu, level) {
  const cv = createCanvas(LEBAR_KARTU, TINGGI_KARTU);
  const ctx = cv.getContext('2d');
  const el = ELEMEN[kartu.elemen];
  const info = STAT_RARITY[kartu.rarity];
  const warna = WARNA_RARITY[kartu.rarity];
  const [atas, bawah] = WARNA_ELEMEN[kartu.elemen] || WARNA_ELEMEN.DARK;
  const s = statKartu(kartu, level);

  // Latar
  const grad = ctx.createLinearGradient(0, 0, 0, TINGGI_KARTU);
  grad.addColorStop(0, atas);
  grad.addColorStop(1, bawah);
  ctx.fillStyle = grad;
  kotakTumpul(ctx, 0, 0, LEBAR_KARTU, TINGGI_KARTU, 18);
  ctx.fill();

  // Bingkai tebal berwarna rarity — penanda paling cepat dibaca dari kejauhan.
  ctx.strokeStyle = warna.garis;
  ctx.lineWidth = 8;
  kotakTumpul(ctx, 4, 4, LEBAR_KARTU - 8, TINGGI_KARTU - 8, 15);
  ctx.stroke();

  // Bintang rarity. Jumlah bintang sekaligus menyatakan biaya dek kartu ini,
  // jadi tidak perlu diulang lagi sebagai angka di baris bawah.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  gambarBarisBintang(ctx, LEBAR_KARTU / 2, 38, info.bintang, warna.garis);

  // Emoji elemen sebagai gambar utama
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.font = `130px ${FONT_EMOJI}`;
  ctx.fillText(el.emoji, LEBAR_KARTU / 2, 150);
  ctx.restore();

  // Nama
  ctx.fillStyle = '#ffffff';
  tulisMuat(ctx, kartu.nama.toUpperCase(), LEBAR_KARTU / 2, 246, LEBAR_KARTU - 36, 26);

  // Baris elemen + biaya bintang
  ctx.fillStyle = warna.teks;
  ctx.font = '15px sans-serif';
  // Rarity sudah terbaca dua kali dari bintang dan warna bingkai, jadi tempatnya
  // dipakai untuk PERAN — satu-satunya info di kartu yang belum tergambar di mana pun.
  ctx.fillText(`${el.nama} · ${getPeran(kartu).nama} · biaya ${costKartu(kartu)}`, LEBAR_KARTU / 2, 272);

  // Panel stat — dua baris.
  //
  // KRITIS dan CP ikut digambar karena keduanya bukan hiasan: kritis adalah
  // sumbu stat ketiga yang dibayar dari anggaran daya (kartu ber-kritis tinggi
  // HP-nya sengaja dipotong), dan CP adalah satu-satunya angka yang bisa
  // dibandingkan langsung antar kartu dengan peran berbeda.
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  kotakTumpul(ctx, 22, 288, LEBAR_KARTU - 44, 78, 10);
  ctx.fill();

  ctx.fillStyle = '#fca5a5';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('ATK', 84, 302);
  ctx.fillStyle = '#93c5fd';
  ctx.fillText('HP', LEBAR_KARTU - 84, 302);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 21px sans-serif';
  ctx.fillText(String(s.atk), 84, 322);
  ctx.fillText(String(s.hp), LEBAR_KARTU - 84, 322);

  ctx.fillStyle = '#fcd34d';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('KRIT', 84, 342);
  ctx.fillStyle = '#a7f3d0';
  ctx.fillText('CP', LEBAR_KARTU - 84, 342);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`${Math.round((s.kritis || 0) * 100)}%`, 84, 358);
  ctx.fillText(String(s.cp), LEBAR_KARTU - 84, 358);

  // Skill
  if (kartu.skill && SKILL[kartu.skill]) {
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    kotakTumpul(ctx, 22, 372, LEBAR_KARTU - 44, 38, 10);
    ctx.fill();
    ctx.fillStyle = warna.garis;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(SKILL[kartu.skill].nama, LEBAR_KARTU / 2, 386);
    ctx.fillStyle = '#cbd5e1';
    tulisMuat(ctx, SKILL[kartu.skill].teks, LEBAR_KARTU / 2, 402, LEBAR_KARTU - 52, 11, '');
  }

  // ID dan level di sudut
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(kartu.id, 18, 36);
  ctx.textAlign = 'right';
  ctx.fillText(`Lv.${s.level}`, LEBAR_KARTU - 18, 36);

  return cv.toBuffer('image/png');
}

/**
 * Buffer PNG satu kartu, dari cache kalau ada.
 * Kegagalan menulis cache tidak boleh menggagalkan pengiriman gambar.
 */
export async function bufferKartu(kartu, level = 1) {
  if (!kartu) return null;
  const lv = Math.max(1, Math.min(5, Math.floor(level) || 1));
  const berkas = path.join(DIR_CACHE, `${kartu.id}_${lv}_v${VERSI_KARTU}.png`);

  try {
    return await fs.readFile(berkas);
  } catch {
    // belum ada di cache — gambar sekarang
  }

  const buf = gambarWajahKartu(kartu, lv);
  try {
    await fs.mkdir(DIR_CACHE, { recursive: true });
    await fs.writeFile(berkas, buf);
  } catch (e) {
    console.warn('[TCG_GBR] Gagal menyimpan cache kartu:', e?.message || e);
  }
  return buf;
}

/**
 * Menempel beberapa kartu berdampingan dengan nomor pilihan di atasnya.
 * Dipakai untuk drop di grup dan hasil tarikan gacha.
 */
export async function bufferBanyakKartu(daftar, opts = {}) {
  const kartuValid = (daftar || []).filter(Boolean);
  if (!kartuValid.length) return null;

  const bernomor = opts.bernomor !== false;
  const perBaris = Math.min(kartuValid.length, opts.perBaris || 3);
  const baris = Math.ceil(kartuValid.length / perBaris);
  const jarak = 16;
  const tinggiNomor = bernomor ? 44 : 0;

  const lebar = perBaris * LEBAR_KARTU + (perBaris + 1) * jarak;
  const tinggi = baris * (TINGGI_KARTU + tinggiNomor) + (baris + 1) * jarak;

  const cv = createCanvas(lebar, tinggi);
  const ctx = cv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, tinggi);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#020617');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, lebar, tinggi);

  for (let i = 0; i < kartuValid.length; i++) {
    const item = kartuValid[i];
    const kartu = item.kartu || item;
    const level = item.level || 1;
    const buf = await bufferKartu(kartu, level);
    if (!buf) continue;

    const kol = i % perBaris;
    const brs = Math.floor(i / perBaris);
    const x = jarak + kol * (LEBAR_KARTU + jarak);
    const y = jarak + brs * (TINGGI_KARTU + tinggiNomor) + tinggiNomor;

    const img = await loadImage(buf);
    ctx.drawImage(img, x, y);

    if (bernomor) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cx = x + LEBAR_KARTU / 2;
      const cy = y - tinggiNomor / 2 - 2;
      ctx.fillStyle = WARNA_RARITY[kartu.rarity].garis;
      ctx.beginPath();
      ctx.arc(cx, cy, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(String(i + 1), cx, cy + 1);
    }
  }

  return cv.toBuffer('image/png');
}

/** Menghapus cache — dipakai kalau desain kartunya diubah. */
export async function bersihkanCacheKartu() {
  try {
    const berkas = await fs.readdir(DIR_CACHE);
    await Promise.all(berkas.filter(f => f.endsWith('.png')).map(f => fs.unlink(path.join(DIR_CACHE, f))));
    return berkas.length;
  } catch {
    return 0;
  }
}

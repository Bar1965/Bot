/**
 * Uji gerbang `siapkanMediaWA` dengan berkas contoh sungguhan yang dibuat ffmpeg.
 *
 * Menjawab keluhan "sudah terunduh tapi tidak bisa dibuka / tidak valid":
 * memastikan hanya berkas media yang benar-benar bisa diputar WhatsApp yang
 * lolos, dan halaman galat CDN (HTML/JSON) ditolak sebelum sempat dikirim.
 *
 * Jalankan: node scripts/mediaValidasiTest.mjs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { siapkanMediaWA, pesanGagalMedia } from '../mediaHandler.js';

const FF = ffmpegInstaller.path;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ujimedia-'));
const p = (n) => path.join(dir, n);

function ff(args) {
  const r = spawnSync(FF, args, { windowsHide: true });
  if (r.status !== 0) console.log('  (ffmpeg exit', r.status, ')', r.stderr?.toString().slice(-300));
}

console.log('Membuat berkas contoh di', dir);
// MP4 H.264 + AAC — satu-satunya kombinasi yang pasti diputar WhatsApp
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('ok.mp4')]);
// WebM VP9 + Opus — wadah dan codec yang tidak didukung
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', '-shortest', p('vp9.webm')]);
// MP4 dengan audio Opus — wadah benar, isi tetap tidak bisa diputar
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-strict', '-2', '-shortest', p('opus.mp4')]);
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1', '-frames:v', '1', '-c:v', 'libwebp', p('foto.webp')]);
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', p('anim.gif')]);
ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', p('lagu.mp3')]);
ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', p('lagu.m4a')]);
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1', '-frames:v', '1', p('foto.jpg')]);

// Halaman galat CDN & JSON galat API — inilah yang dulu lolos jadi "video"
fs.writeFileSync(p('galat.html'), '<!DOCTYPE html><html><head><title>Login</title></head><body>' + 'x'.repeat(9000) + '</body></html>');
fs.writeFileSync(p('galat.json'), JSON.stringify({ error: 'not found', detail: 'y'.repeat(9000) }));

const kasus = [
  ['ok.mp4', 'video', 'mp4 h264/aac -> lolos apa adanya', false],
  ['vp9.webm', 'video', 'webm vp9/opus -> dikonversi ke mp4', false],
  ['opus.mp4', 'video', 'mp4 audio opus -> audio disandi ulang', false],
  ['foto.webp', undefined, 'webp -> jadi jpeg', false],
  ['foto.jpg', undefined, 'jpeg -> lolos apa adanya', false],
  ['anim.gif', undefined, 'gif -> jadi mp4 gifPlayback', false],
  ['lagu.mp3', 'audio', 'mp3 -> audio/mpeg', false],
  ['lagu.m4a', 'audio', 'm4a -> audio/mp4', false],
  ['lagu.m4a', 'video', 'audio dikira video -> HARUS ditolak', true],
  ['galat.html', 'video', 'halaman HTML CDN -> HARUS ditolak', true],
  ['galat.json', 'image', 'JSON galat API -> HARUS ditolak', true]
];

let gagalUji = 0;
for (const [nama, tipe, ket, harusDitolak] of kasus) {
  const buffer = fs.readFileSync(p(nama));
  const hasil = await siapkanMediaWA({ buffer, type: tipe });
  const ringkas = hasil.ok
    ? `ok kategori=${hasil.kategori} mime=${hasil.mimetype} ${hasil.gifPlayback ? 'gifPlayback ' : ''}${(hasil.buffer.length / 1024).toFixed(0)}KB`
    : `DITOLAK alasan=${hasil.alasan} | ${pesanGagalMedia(hasil, 'Media').slice(0, 70)}`;
  console.log(`\n[${nama} sebagai ${tipe || '-'}] ${ket}\n   -> ${ringkas}`);
  if (harusDitolak === Boolean(hasil.ok)) {
    console.log('   !! HASIL TIDAK SESUAI HARAPAN');
    gagalUji++;
  }
}

// Hasil konversi harus benar-benar terbaca ffmpeg sebagai h264/aac
const cek = await siapkanMediaWA({ buffer: fs.readFileSync(p('vp9.webm')), type: 'video' });
if (cek.ok) {
  const outPath = p('hasil-konversi.mp4');
  fs.writeFileSync(outPath, cek.buffer);
  const info = spawnSync(FF, ['-hide_banner', '-i', outPath], { windowsHide: true }).stderr.toString();
  const v = info.match(/ Video: ([a-z0-9]+)/);
  const a = info.match(/ Audio: ([a-z0-9]+)/);
  console.log(`\nVerifikasi hasil konversi webm -> mp4: video=${v?.[1]} audio=${a?.[1]}`);
  if (v?.[1] !== 'h264' || a?.[1] !== 'aac') {
    console.log('   !! codec hasil bukan h264/aac');
    gagalUji++;
  }
}

console.log(gagalUji === 0 ? '\nSEMUA UJI SESUAI HARAPAN' : `\n${gagalUji} UJI TIDAK SESUAI`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(gagalUji === 0 ? 0 : 1);

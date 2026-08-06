import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';

const outputDirectory = path.join(process.cwd(), 'public', 'game-images', 'rebus');

const puzzles = [
  ['MATAHARI', ['👁️', '☀️']],
  ['KAKI LIMA', ['🦶', '5️⃣']],
  ['RUMAH SAKIT', ['🏠', '🏥']],
  ['MEJA MAKAN', ['🪑', '🍽️']],
  ['BUAH TANGAN', ['🍎', '✋']],
  ['KAMBING HITAM', ['🐐', '⚫']],
  ['ANAK AYAM', ['👶', '🐔']],
  ['JAM TANGAN', ['⏰', '✋']],
  ['AIR MATA', ['💧', '👁️']],
  ['KAPAL API', ['🚢', '🔥']],
  ['NASI GORENG', ['🍚', '🔥']],
  ['SATE AYAM', ['🍢', '🐔']],
  ['LAMPU MERAH', ['💡', '🔴']],
  ['BAJU TIDUR', ['👕', '😴']],
  ['KERETA API', ['🚆', '🔥']],
  ['BUKU TULIS', ['📖', '✍️']],
  ['RUMAH MAKAN', ['🏠', '🍽️']],
  ['TANGAN KANAN', ['✋', '➡️']],
  ['KEPALA BATU', ['🙂', '🪨']],
  ['BUNGA API', ['🌸', '🔥']],
  ['KOPI SUSU', ['☕', '🥛']],
  ['TEH MANIS', ['🍵', '🍬']],
  ['ES BATU', ['🧊', '🪨']],
  ['AIR PANAS', ['💧', '🔥']],
  ['IKAN ASIN', ['🐟', '🧂']],
  ['AYAM GORENG', ['🐔', '🔥']],
  ['BEBEK GORENG', ['🦆', '🔥']],
  ['SAPI PERAH', ['🐄', '🥛']],
  ['KAMBING GULING', ['🐐', '🔄']],
  ['KERJA KERAS', ['💼', '💪']],
  ['JATUH CINTA', ['⬇️', '❤️']],
  ['BUAH HATI', ['🍎', '❤️']],
  ['HATI HATI', ['❤️', '👁️']],
  ['MATA MATA', ['👁️', '👁️']],
  ['KEPALA DINGIN', ['🙂', '🧊']],
  ['TANGAN PANJANG', ['✋', '↔️']],
  ['MULUT MANIS', ['👄', '🍬']],
  ['BESAR KEPALA', ['⬆️', '🙂']],
  ['PANJANG TANGAN', ['↔️', '✋']],
  ['KAKI TANGAN', ['🦶', '✋']],
  ['GIGI MANIS', ['🦷', '🍬']],
  ['BINTANG FILM', ['⭐', '🎬']],
  ['LAYAR KACA', ['📺', '🪟']],
  ['KAMAR MANDI', ['🚪', '🚿']],
  ['KAMAR TIDUR', ['🚪', '😴']],
  ['BUKU HARIAN', ['📖', '☀️']],
  ['MATA UANG', ['👁️', '💰']],
  ['UANG KERTAS', ['💰', '📄']],
  ['KARTU NAMA', ['🃏', '🏷️']],
  ['SURAT CINTA', ['✉️', '❤️']],
  ['CINTA BUTA', ['❤️', '🙈']],
  ['HATI EMAS', ['❤️', '🪙']],
  ['MOBIL BALAP', ['🚗', '🏁']],
  ['MOTOR BALAP', ['🏍️', '🏁']],
  ['SEPEDA MOTOR', ['🚲', '🏍️']],
  ['KAPAL TERBANG', ['🚢', '✈️']],
  ['KERETA CEPAT', ['🚆', '⚡']],
  ['PESAWAT TEMPUR', ['✈️', '⚔️']],
  ['MOBIL BOX', ['🚗', '📦']],
  ['KAMERA DIGITAL', ['📷', '💻']],
  ['TELEPON GENGGAM', ['☎️', '✊']],
  ['RADIO AKTIF', ['📻', '⚡']],
  ['BOLA MATA', ['⚽', '👁️']],
  ['BOLA API', ['⚽', '🔥']],
  ['RUMAH KACA', ['🏠', '🪟']],
  ['KACA MATA', ['🪟', '👁️']],
  ['KACA PEMBESAR', ['🪟', '🔍']],
  ['JAM PASIR', ['⏰', '🏖️']],
  ['PASIR PUTIH', ['🏖️', '⚪']],
  ['LAUT BIRU', ['🌊', '🔵']],
  ['GUNUNG ES', ['🏔️', '🧊']],
  ['AIR TERJUN', ['💧', '⬇️']],
  ['HUJAN DERAS', ['🌧️', '💨']],
  ['ANGIN TOPAN', ['💨', '🌀']],
  ['PETIR MERAH', ['⚡', '🔴']],
  ['TAMAN BUNGA', ['🌳', '🌸']],
  ['SINGA LAUT', ['🦁', '🌊']],
  ['KUDA LAUT', ['🐎', '🌊']],
  ['TELUR MATA SAPI', ['🥚', '👁️', '🐄']],
  ['NASI KUNING', ['🍚', '🟡']],
  ['NASI MERAH', ['🍚', '🔴']],
  ['KUE ULANG TAHUN', ['🍰', '🎂']],
  ['ROTI BAKAR', ['🍞', '🔥']],
  ['ES TEH', ['🧊', '🍵']],
  ['TEH BOTOL', ['🍵', '🍼']],
  ['SUSU KAMBING', ['🥛', '🐐']],
  ['MADU MANIS', ['🍯', '🍬']],
  ['SAMBAL PEDAS', ['🌶️', '🔥']],
  ['BUAH NAGA', ['🍎', '🐉']],
  ['IKAN TERBANG', ['🐟', '✈️']],
  ['BURUNG HANTU', ['🐦', '👻']],
  ['KEPALA DESA', ['🙂', '🏘️']],
  ['RAJA HUTAN', ['👑', '🌳']],
  ['RATU KECANTIKAN', ['👸', '✨']],
  ['PANGERAN CINTA', ['🤴', '❤️']],
  ['PUTRI SALJU', ['👸', '❄️']],
  ['KOTA TUA', ['🏙️', '👴']],
  ['BUKIT BINTANG', ['⛰️', '⭐']],
  ['BATU BARA', ['🪨', '🔥']],
  ['EMAS HITAM', ['🪙', '⚫']],
  ['AIR KERAS', ['💧', '💪']],
  ['SUARA HATI', ['🔊', '❤️']],
  ['HARI LIBUR', ['☀️', '🏖️']],
  ['MALAM MINGGU', ['🌙', '📅']],
  ['PAGI BUTA', ['🌅', '🙈']],
  ['LAPANG DADA', ['🏟️', '🫁']],
  ['PANJANG UMUR', ['↔️', '🎂']],
  ['BESAR HATI', ['⬆️', '❤️']],
  ['RENDAH HATI', ['⬇️', '❤️']],
  ['TINGGI HATI', ['⬆️', '❤️']]
];

function drawRoundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
}

function renderPuzzle(index, answer, parts) {
  const canvas = createCanvas(1200, 760);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff8ef';
  context.fillRect(0, 0, 1200, 760);

  context.fillStyle = '#12304a';
  context.fillRect(0, 0, 1200, 112);
  context.fillStyle = '#ffd166';
  context.font = 'bold 42px sans-serif';
  context.fillText('TEBAK GAMBAR', 54, 70);
  context.fillStyle = '#ffffff';
  context.font = 'bold 28px sans-serif';
  context.fillText(`LEVEL ${String(index).padStart(3, '0')}`, 956, 67);

  const gap = 34;
  const cardWidth = (1080 - gap * (parts.length - 1)) / parts.length;
  const startX = 60;
  const cardY = 178;
  const cardHeight = 370;
  context.textAlign = 'center';
  parts.forEach((part, partIndex) => {
    const x = startX + partIndex * (cardWidth + gap);
    context.fillStyle = partIndex % 2 === 0 ? '#dff6ff' : '#ffe2ec';
    drawRoundRect(context, x, cardY, cardWidth, cardHeight, 28);
    context.fillStyle = '#ffffff';
    drawRoundRect(context, x + 18, cardY + 18, cardWidth - 36, cardHeight - 36, 20);
    context.fillStyle = '#12304a';
    context.font = '180px "Segoe UI Emoji"';
    context.fillText(part, x + cardWidth / 2, cardY + 250);
    context.fillStyle = '#78909c';
    context.font = 'bold 22px sans-serif';
    context.fillText(`GAMBAR ${partIndex + 1}`, x + cardWidth / 2, cardY + 325);
    if (partIndex < parts.length - 1) {
      context.fillStyle = '#ef476f';
      context.font = 'bold 64px sans-serif';
      context.fillText('+', x + cardWidth + gap / 2, cardY + 210);
    }
  });

  context.fillStyle = '#12304a';
  context.font = 'bold 30px sans-serif';
  context.fillText('Gabungkan arti semua gambar menjadi satu kata atau frasa.', 600, 635);
  context.fillStyle = '#78909c';
  context.font = '24px sans-serif';
  context.fillText('Ketik jawaban langsung di chat sebelum waktu habis.', 600, 690);
  context.textAlign = 'start';

  return canvas.toBuffer('image/png');
}

fs.mkdirSync(outputDirectory, { recursive: true });

for (const [index, [answer, parts]] of puzzles.entries()) {
  const slug = answer.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const pngBuffer = renderPuzzle(index + 1, answer, parts);
  const outputPath = path.join(outputDirectory, `${slug}-${String(index + 1).padStart(3, '0')}.jpg`);
  await sharp(pngBuffer).jpeg({ quality: 72, mozjpeg: true }).toFile(outputPath);
}

console.log(`Generated ${puzzles.length} original rebus cards in ${outputDirectory}`);

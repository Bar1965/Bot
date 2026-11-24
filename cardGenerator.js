import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import axios from 'axios';
import fs from 'fs';

// Registrasi font emoji Windows jika tersedia agar Skia/canvas merender emote berwarna
try {
  if (process.platform === 'win32') {
    const emojiFontPath = 'C:\\Windows\\Fonts\\seguiemj.ttf';
    if (fs.existsSync(emojiFontPath)) {
      GlobalFonts.registerFromPath(emojiFontPath, 'Segoe UI Emoji');
    }
  }
} catch (e) {
  console.warn('[CARD_GEN_EMOJI] Warning registrasi font emoji:', e.message);
}

const EMOJI_FONT_STACK = '"Segoe UI", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

/**
 * Utility to safely fetch and load an image from URL or return a fallback avatar
 */
async function safeLoadImage(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    return await loadImage(Buffer.from(response.data));
  } catch (err) {
    console.warn(`[CARD_GEN] Failed to load image from ${url}:`, err.message);
    return null;
  }
}

/**
 * Draw a default fallback avatar on canvas context
 */
function drawDefaultAvatar(ctx, x, y, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2, true);
  ctx.fillStyle = '#3a3f58';
  ctx.fill();

  // Draw head
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.2, radius * 0.35, 0, Math.PI * 2, true);
  ctx.fillStyle = '#8c94b8';
  ctx.fill();

  // Draw shoulders
  ctx.beginPath();
  ctx.arc(x, y + radius * 0.7, radius * 0.6, Math.PI, 0, true);
  ctx.fillStyle = '#8c94b8';
  ctx.fill();
  ctx.restore();
}

/**
 * 1. Generate Welcome or Goodbye Card (1024 x 500 px)
 */
export async function createWelcomeGoodbyeCard({
  avatarUrl,
  username = 'Member',
  groupName = 'WhatsApp Group',
  memberCount = 1,
  type = 'welcome',
  premiumTier = 'Free'
}) {
  const width = 1024;
  const height = 500;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const isWelcome = type === 'welcome';
  const isGold = premiumTier === 'Gold';
  const isDiamond = premiumTier === 'Diamond';

  // Base colors
  let primaryColor = isWelcome ? '#00f2fe' : '#ff4b2b';
  let secondaryColor = isWelcome ? '#4facfe' : '#ff416c';
  let bgColor1 = '#090a0f';
  let bgColor2 = '#151722';

  if (isDiamond) {
    primaryColor = '#00ffff';
    secondaryColor = '#3b82f6';
  } else if (isGold) {
    primaryColor = '#ffd700';
    secondaryColor = '#f59e0b';
  }

  // Draw Background Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, bgColor1);
  bgGrad.addColorStop(1, bgColor2);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Draw Glowing Orbs with Blur
  ctx.save();
  ctx.filter = 'blur(80px)';
  
  ctx.beginPath();
  ctx.arc(150, 100, 200, 0, Math.PI * 2);
  ctx.fillStyle = primaryColor;
  ctx.globalAlpha = 0.3;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(874, 400, 220, 0, Math.PI * 2);
  ctx.fillStyle = secondaryColor;
  ctx.globalAlpha = 0.3;
  ctx.fill();
  
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, 250, 0, Math.PI * 2);
  ctx.fillStyle = isWelcome ? '#1e3a8a' : '#881337';
  ctx.globalAlpha = 0.2;
  ctx.fill();
  
  ctx.restore();

  // Glassmorphism Card Frame
  ctx.save();
  const margin = 40;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  const radius = 30;

  ctx.beginPath();
  ctx.roundRect(margin, margin, cardW, cardH, radius);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.fill();
  
  // Inner stroke (glass reflection)
  ctx.lineWidth = 2;
  const strokeGrad = ctx.createLinearGradient(margin, margin, margin + cardW, margin + cardH);
  strokeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
  strokeGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
  ctx.strokeStyle = strokeGrad;
  ctx.stroke();
  ctx.restore();

  // Avatar Setup
  const avatarX = width / 2;
  const avatarY = 200;
  const avatarRadius = 85;

  // Avatar Glowing Ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius + 8, 0, Math.PI * 2);
  const ringGrad = ctx.createLinearGradient(avatarX - avatarRadius, avatarY - avatarRadius, avatarX + avatarRadius, avatarY + avatarRadius);
  ringGrad.addColorStop(0, primaryColor);
  ringGrad.addColorStop(1, secondaryColor);
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth = 6;
  ctx.shadowColor = primaryColor;
  ctx.shadowBlur = 20;
  ctx.stroke();
  ctx.restore();

  // Load and Draw Avatar
  const img = await safeLoadImage(avatarUrl);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    ctx.restore();
  } else {
    drawDefaultAvatar(ctx, avatarX, avatarY, avatarRadius);
  }

  // Welcome / Goodbye Text (Above Avatar)
  ctx.save();
  ctx.font = '900 48px "Impact", "Segoe UI Black", sans-serif';
  ctx.textAlign = 'center';
  const titleText = isWelcome ? 'WELCOME' : 'GOODBYE';
  
  // Text Gradient
  const textGrad = ctx.createLinearGradient(0, 50, 0, 100);
  textGrad.addColorStop(0, '#ffffff');
  textGrad.addColorStop(1, '#a1a1aa');
  ctx.fillStyle = textGrad;
  
  // Letter spacing workaround (manual or just rely on font)
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillText(titleText, width / 2, 95);
  ctx.restore();

  // Username
  ctx.save();
  ctx.font = 'bold 38px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  const cleanName = username.length > 22 ? username.substring(0, 22) + '...' : username;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.fillText(cleanName, width / 2, 350);
  ctx.restore();

  // Group Name
  ctx.save();
  ctx.font = '500 24px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  const cleanGroup = groupName.length > 35 ? groupName.substring(0, 35) + '...' : groupName;
  ctx.fillText(isWelcome ? `Joined ${cleanGroup}` : `Left ${cleanGroup}`, width / 2, 385);
  ctx.restore();

  // Member Count Badge
  ctx.save();
  const badgeText = isWelcome ? `MEMBER #${memberCount}` : `TOTAL MEMBERS: ${memberCount}`;
  ctx.font = 'bold 18px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const badgeW = ctx.measureText(badgeText).width + 50;
  const badgeH = 38;
  const badgeX = width / 2 - badgeW / 2;
  const badgeY = 410;

  // Badge background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 19);
  ctx.fill();
  
  // Badge stroke
  ctx.strokeStyle = primaryColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(badgeText, width / 2, badgeY + 25);
  ctx.restore();

  return canvas.toBuffer('image/jpeg');
}

/**
 * 2. Generate Level Up Card (1024 x 500 px)
 */
export async function createLevelUpCard({
  avatarUrl,
  username = 'Player',
  oldLevel = 1,
  newLevel = 2,
  titleBadge = 'Warga Aktif',
  xp = 200
}) {
  const width = 1024;
  const height = 500;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background Dark Cyberpunk Theme
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0a0a0a');
  bgGrad.addColorStop(0.5, '#120524');
  bgGrad.addColorStop(1, '#0f172a');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Glowing Orbs
  ctx.save();
  ctx.filter = 'blur(90px)';
  
  ctx.beginPath();
  ctx.arc(850, 120, 200, 0, Math.PI * 2);
  ctx.fillStyle = '#f43f5e';
  ctx.globalAlpha = 0.35;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(150, 400, 250, 0, Math.PI * 2);
  ctx.fillStyle = '#8b5cf6';
  ctx.globalAlpha = 0.35;
  ctx.fill();
  
  ctx.beginPath();
  ctx.arc(500, 250, 200, 0, Math.PI * 2);
  ctx.fillStyle = '#0ea5e9';
  ctx.globalAlpha = 0.2;
  ctx.fill();
  ctx.restore();

  // Glass Frame
  ctx.save();
  const margin = 35;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  
  ctx.beginPath();
  ctx.roundRect(margin, margin, cardW, cardH, 24);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.fill();
  
  const strokeGrad = ctx.createLinearGradient(margin, margin, margin + cardW, margin + cardH);
  strokeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
  strokeGrad.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.strokeStyle = strokeGrad;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Title "LEVEL UP"
  ctx.save();
  ctx.font = '900 56px "Impact", "Segoe UI Black", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#f43f5e';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 2;
  ctx.fillText('LEVEL UP', 80, 100);
  ctx.restore();

  // Avatar Left Side
  const avatarX = 170;
  const avatarY = 260;
  const avatarRadius = 85;

  // Gold/Pink Glowing Ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius + 8, 0, Math.PI * 2);
  const ringGrad = ctx.createLinearGradient(avatarX - avatarRadius, avatarY - avatarRadius, avatarX + avatarRadius, avatarY + avatarRadius);
  ringGrad.addColorStop(0, '#fbbf24');
  ringGrad.addColorStop(1, '#f43f5e');
  ctx.strokeStyle = ringGrad;
  ctx.lineWidth = 6;
  ctx.shadowColor = '#f43f5e';
  ctx.shadowBlur = 25;
  ctx.stroke();
  ctx.restore();

  const img = await safeLoadImage(avatarUrl);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
    ctx.restore();
  } else {
    drawDefaultAvatar(ctx, avatarX, avatarY, avatarRadius);
  }

  // User Info & Level Badges (Right Side)
  const textX = 300;

  // Username
  ctx.save();
  ctx.font = 'bold 42px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5;
  const cleanName = username.length > 20 ? username.substring(0, 20) + '...' : username;
  ctx.fillText(cleanName, textX, 200);
  ctx.restore();

  // Title Badge Pill
  ctx.save();
  ctx.font = 'bold 18px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const badgeTextStr = `RANK: ${titleBadge.toUpperCase()}`;
  const pillW = ctx.measureText(badgeTextStr).width + 40;
  
  ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';
  ctx.beginPath();
  ctx.roundRect(textX, 220, pillW, 36, 18);
  ctx.fill();
  
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#fbbf24';
  ctx.fillText(badgeTextStr, textX + 20, 245);
  ctx.restore();

  // Level Indicator (Level X -> Level Y)
  ctx.save();
  ctx.font = 'bold 48px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`LVL ${oldLevel}`, textX, 320);

  ctx.font = 'bold 48px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#475569';
  ctx.fillText(`➔`, textX + 180, 318);

  ctx.font = '900 58px "Segoe UI Black", "Impact", sans-serif';
  ctx.fillStyle = '#4ade80';
  ctx.shadowColor = '#4ade80';
  ctx.shadowBlur = 20;
  ctx.fillText(`LVL ${newLevel}`, textX + 250, 320);
  ctx.restore();

  // XP Progress Bar
  ctx.save();
  const barX = textX;
  const barY = 365;
  const barW = 600;
  const barH = 26;

  // Track Background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 13);
  ctx.fill();

  // Progress Fill
  const currentXpInLevel = xp % 100;
  const progressRatio = Math.min(1, Math.max(0.05, currentXpInLevel / 100));
  const fillW = barW * progressRatio;

  const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  barGrad.addColorStop(0, '#8b5cf6');
  barGrad.addColorStop(1, '#0ea5e9');
  
  ctx.fillStyle = barGrad;
  ctx.shadowColor = '#0ea5e9';
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.roundRect(barX, barY, fillW, barH, 13);
  ctx.fill();
  ctx.restore();

  // XP Text
  ctx.save();
  ctx.font = 'bold 18px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(`Total XP: ${xp.toLocaleString('id-ID')} XP`, barX, barY + 55);
  ctx.restore();

  return canvas.toBuffer('image/jpeg');
}

/**
 * 3. Generate Official Transaction / Testimoni Receipt Card (1024 x 620 px)
 */
export async function createTransactionReceiptCard({
  orderId = 'ORD-0000',
  customerName = 'Pelanggan',
  customerNumber = '',
  totalAmount = 0,
  items = [],
  paymentStatus = 'LUNAS',
  paymentMethod = 'QRIS / Transfer Bank',
  dateStr = '',
  timeStr = '',
  storeName = 'Akbar Store',
  isDeposit = false
} = {}) {
  const width = 1024;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background Dark Theme
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#090d16');
  bgGrad.addColorStop(0.5, '#0f172a');
  bgGrad.addColorStop(1, '#020617');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Glowing Orbs
  ctx.save();
  ctx.filter = 'blur(90px)';

  // Emerald glow for payment success / Sky for deposit
  ctx.beginPath();
  ctx.arc(880, 100, 220, 0, Math.PI * 2);
  ctx.fillStyle = isDeposit ? '#0284c7' : '#10b981';
  ctx.globalAlpha = 0.28;
  ctx.fill();

  // Cyan/Indigo secondary glow
  ctx.beginPath();
  ctx.arc(140, 500, 240, 0, Math.PI * 2);
  ctx.fillStyle = '#6366f1';
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.restore();

  // Glass Frame Container
  ctx.save();
  const margin = 35;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  const radius = 24;

  ctx.beginPath();
  ctx.roundRect(margin, margin, cardW, cardH, radius);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.fill();

  const strokeGrad = ctx.createLinearGradient(margin, margin, margin + cardW, margin + cardH);
  strokeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
  strokeGrad.addColorStop(0.5, 'rgba(16, 185, 129, 0.2)');
  strokeGrad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
  ctx.strokeStyle = strokeGrad;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Header: Store Name & Subtitle
  const startX = 70;
  ctx.save();
  ctx.font = '900 36px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(storeName.toUpperCase(), startX, 90);

  ctx.font = '600 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('OFFICIAL TRANSACTION RECEIPT • BUKTI TRANSAKSI DIGITAL RESMI', startX, 115);
  ctx.restore();

  // Status Badge Pill (Top Right)
  ctx.save();
  const statusText = isDeposit ? 'TOP UP SALDO BERHASIL' : 'TRANSAKSI LUNAS & SELESAI';
  ctx.font = 'bold 16px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const pillW = ctx.measureText(statusText).width + 46;
  const pillH = 38;
  const pillX = width - startX - pillW;
  const pillY = 72;

  ctx.fillStyle = isDeposit ? 'rgba(14, 165, 233, 0.15)' : 'rgba(16, 185, 129, 0.15)';
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 19);
  ctx.fill();

  ctx.strokeStyle = isDeposit ? '#38bdf8' : '#34d399';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = isDeposit ? '#38bdf8' : '#34d399';
  ctx.shadowBlur = 10;
  ctx.stroke();

  ctx.fillStyle = isDeposit ? '#38bdf8' : '#34d399';
  ctx.fillText(`✓ ${statusText}`, pillX + 23, pillY + 24);
  ctx.restore();

  // Horizontal Divider
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(startX, 140);
  ctx.lineTo(width - startX, 140);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // Two-Column Grid: Transaction & Customer Details
  const col1X = startX;
  const col2X = startX + 460;
  const row1Y = 175;
  const row2Y = 240;

  // Box 1: Order ID
  ctx.save();
  ctx.font = '600 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('ORDER / TRANSACTION ID', col1X, row1Y);
  ctx.font = 'bold 24px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(orderId, col1X, row1Y + 28);

  // Box 2: Tanggal & Waktu
  ctx.font = '600 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('TANGGAL & WAKTU', col1X, row2Y);
  ctx.font = '600 20px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#e2e8f0';
  const waktuGabung = [dateStr, timeStr ? `${timeStr} WIB` : ''].filter(Boolean).join(' • ') || 'Barusan';
  ctx.fillText(waktuGabung, col1X, row2Y + 26);

  // Box 3: Pelanggan
  ctx.font = '600 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('PELANGGAN', col2X, row1Y);
  ctx.font = 'bold 22px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#ffffff';
  const cleanName = customerName.length > 20 ? customerName.slice(0, 20) + '...' : customerName;
  const buyerStr = customerNumber ? `${cleanName} (${customerNumber})` : cleanName;
  ctx.fillText(buyerStr, col2X, row1Y + 28);

  // Box 4: Metode Pembayaran
  ctx.font = '600 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('METODE TRANSAKSI', col2X, row2Y);
  ctx.font = '600 20px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(paymentMethod, col2X, row2Y + 26);
  ctx.restore();

  // Order Items Card Container
  const itemBoxY = 300;
  const itemBoxW = width - startX * 2;
  const itemBoxH = 150;

  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.beginPath();
  ctx.roundRect(startX, itemBoxY, itemBoxW, itemBoxH, 16);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Section Header: RINCIAN PESANAN
  ctx.font = 'bold 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('RINCIAN PESANAN / PRODUK:', startX + 24, itemBoxY + 32);

  // Normalize Items List
  let itemList = [];
  if (Array.isArray(items) && items.length > 0) {
    itemList = items.map(it => {
      if (typeof it === 'string') return it;
      const nama = it.produk_nama || it.name || it.nama || 'Produk Digital';
      const qty = it.qty || it.jumlah || 1;
      return `${nama} ×${qty}`;
    });
  } else if (typeof items === 'string' && items.trim().length > 0) {
    itemList = items.split('\n').filter(Boolean).map(s => s.replace(/^[•\-\*]\s*/, '').trim());
  } else {
    itemList = [isDeposit ? 'Deposit Saldo Akun Toko' : 'Produk Digital'];
  }

  // Draw Items (up to 3 items)
  const displayItems = itemList.slice(0, 3);
  let curItemY = itemBoxY + 65;
  ctx.font = '500 18px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#f8fafc';

  for (const itemText of displayItems) {
    const cleanItem = itemText.length > 55 ? itemText.slice(0, 55) + '...' : itemText;
    ctx.fillText(`•  ${cleanItem}`, startX + 26, curItemY);
    curItemY += 28;
  }

  if (itemList.length > 3) {
    ctx.font = 'italic 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`+ ${itemList.length - 3} produk lainnya`, startX + 30, curItemY);
  }
  ctx.restore();

  // Total Section (Bottom Row)
  const totalY = 490;
  ctx.save();
  ctx.font = '600 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('TOTAL TRANSAKSI', startX, totalY);

  const formattedTotal = 'Rp ' + Number(totalAmount || 0).toLocaleString('id-ID');
  ctx.font = '900 36px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = isDeposit ? '#38bdf8' : '#34d399';
  ctx.shadowColor = isDeposit ? 'rgba(56, 189, 248, 0.4)' : 'rgba(52, 211, 153, 0.4)';
  ctx.shadowBlur = 12;
  ctx.fillText(formattedTotal, startX, totalY + 40);
  ctx.restore();

  // Security Guarantee Seal (Bottom Right)
  ctx.save();
  ctx.font = 'bold 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#10b981';
  ctx.textAlign = 'right';
  ctx.fillText('🛡️ 100% VERIFIED & GUARANTEED', width - startX, totalY + 20);

  ctx.font = '500 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('Pengiriman Otomatis & Aman via WhatsApp Bot', width - startX, totalY + 42);
  ctx.restore();

  // Bottom Security Line
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(startX, height - 48);
  ctx.lineTo(width - startX, height - 48);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = '500 13px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#475569';
  ctx.textAlign = 'center';
  ctx.fillText('Terima kasih atas kepercayaan Anda berbelanja di toko kami! 🙏', width / 2, height - 25);
  ctx.restore();

  return canvas.toBuffer('image/jpeg');
}

/**
 * 4. Generate Store Reputation & Testimonials Card (1024 x 580 px)
 */
export async function createStoreReputationCard({
  storeName = 'Akbar Store',
  totalOrders = 0,
  deliverySpeed = '< 5 Detik',
  averageRating = 5.0,
  totalReviews = 0,
  recentReviews = []
} = {}) {
  const width = 1024;
  const height = 580;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background Dark Theme
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#090d16');
  bgGrad.addColorStop(0.5, '#111827');
  bgGrad.addColorStop(1, '#030712');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Glowing Orbs (Gold / Amber & Indigo)
  ctx.save();
  ctx.filter = 'blur(90px)';
  ctx.beginPath();
  ctx.arc(880, 120, 240, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.globalAlpha = 0.25;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(150, 480, 220, 0, Math.PI * 2);
  ctx.fillStyle = '#6366f1';
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.restore();

  // Outer Frame
  const margin = 35;
  const cardW = width - margin * 2;
  const cardH = height - margin * 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(margin, margin, cardW, cardH, 24);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  // Header Title
  const startX = 70;
  ctx.save();
  ctx.font = '900 36px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(storeName.toUpperCase(), startX, 90);

  ctx.font = '600 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('REPUTASI TOKO & BUKTI KEPERCAYAAN PELANGGAN', startX, 115);
  ctx.restore();

  // Top Right Badge
  ctx.save();
  const verifiedBadge = '100% TERPERCAYA & BERGARANSI';
  ctx.font = 'bold 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  const badgeW = ctx.measureText(verifiedBadge).width + 40;
  const badgeX = width - startX - badgeW;
  const badgeY = 74;

  ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, 36, 18);
  ctx.fill();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`⭐ ${verifiedBadge}`, badgeX + 20, badgeY + 23);
  ctx.restore();

  // 3 Metric Stat Cards
  const stats = [
    { label: 'PESANAN TERKIRIM', val: `${Number(totalOrders || 0).toLocaleString('id-ID')}+ Order`, color: '#38bdf8' },
    { label: 'KECEPATAN KIRIM', val: deliverySpeed || 'Otomatis', color: '#34d399' },
    { label: 'RATING PEMBELI', val: `⭐ ${Number(averageRating || 5).toFixed(1)} / 5.0 (${totalReviews || 0} ulasan)`, color: '#fbbf24' }
  ];

  const statBoxW = (cardW - 60) / 3;
  const statBoxH = 100;
  const statBoxY = 145;

  stats.forEach((s, idx) => {
    const sX = margin + 15 + idx * (statBoxW + 15);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.beginPath();
    ctx.roundRect(sX, statBoxY, statBoxW, statBoxH, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 13px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(s.label, sX + 20, statBoxY + 35);

    ctx.font = 'bold 22px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillStyle = s.color;
    ctx.fillText(s.val, sX + 20, statBoxY + 72);
    ctx.restore();
  });

  // Recent Feedback / Reviews Box
  const reviewBoxY = 265;
  const reviewBoxW = cardW - 30;
  const reviewBoxH = 180;
  const reviewBoxX = margin + 15;

  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.beginPath();
  ctx.roundRect(reviewBoxX, reviewBoxY, reviewBoxW, reviewBoxH, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = 'bold 16px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('💬 KATA PEMBELI TERBARU:', reviewBoxX + 24, reviewBoxY + 36);

  if (recentReviews && recentReviews.length > 0) {
    let rY = reviewBoxY + 70;
    for (const r of recentReviews.slice(0, 3)) {
      const stars = '⭐'.repeat(Math.max(1, Math.min(5, Math.round(r.rating || 5))));
      const name = r.nama_pembeli || 'Pelanggan';
      const comment = (r.comment || 'Puas belanja di sini, sangat cepat!').trim();
      const cleanComment = comment.length > 50 ? comment.slice(0, 50) + '...' : comment;

      ctx.font = 'bold 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(stars, reviewBoxX + 24, rY);

      ctx.font = 'bold 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(name, reviewBoxX + 110, rY);

      ctx.font = 'italic 15px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`"${cleanComment}"`, reviewBoxX + 240, rY);

      rY += 32;
    }
  } else {
    ctx.font = 'italic 16px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('Semua transaksi terenkripsi & diproses otomatis dalam hitungan detik.', reviewBoxX + 24, reviewBoxY + 80);
  }
  ctx.restore();

  // Footer Guarantees
  ctx.save();
  ctx.font = '600 14px "Segoe UI", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('🔒 Kredensial Otomatis Bot', startX, height - 55);
  ctx.fillText('🛡️ Garansi Akun Aktif (.garansi)', startX + 280, height - 55);
  ctx.fillText('⚡ Pembayaran QRIS Resmi Bebas Tipu', startX + 570, height - 55);
  ctx.restore();

  return canvas.toBuffer('image/jpeg');
}

/**
 * 5. Generate Spotify-Style Lyrics Card (800 x 900 px)
 */
export async function createSpotifyLyricsCard({
  title = 'Lagu',
  artist = 'Artis',
  coverBuffer = null,
  lyricsLines = [],
  duration = '03:45'
}) {
  const width = 800;
  const height = 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Background Gradient (Spotify Emerald Green to Midnight Black)
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#133e28');
  bgGrad.addColorStop(0.4, '#121212');
  bgGrad.addColorStop(1, '#0a0a0a');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle decorative radial glow
  const glow = ctx.createRadialGradient(width - 80, 80, 10, width - 80, 80, 250);
  glow.addColorStop(0, 'rgba(30, 215, 96, 0.15)');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // 2. Spotify Brand Header
  const iconX = 50;
  const iconY = 55;
  ctx.save();
  ctx.beginPath();
  ctx.arc(iconX + 16, iconY + 16, 16, 0, Math.PI * 2);
  ctx.fillStyle = '#1DB954';
  ctx.fill();

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const yOff = iconY + 11 + i * 5;
    const curve = 3.5 - i * 0.5;
    ctx.beginPath();
    ctx.moveTo(iconX + 9 + i, yOff);
    ctx.quadraticCurveTo(iconX + 16, yOff - curve, iconX + 23 - i, yOff);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 22px "Arial", sans-serif';
  ctx.fillText('Spotify', iconX + 42, iconY + 23);

  ctx.fillStyle = '#1DB954';
  ctx.font = 'bold 14px "Arial", sans-serif';
  ctx.fillText('• LYRICS CARD', iconX + 130, iconY + 22);

  // 3. Album Art Cover
  const coverSize = 110;
  const coverX = 50;
  const coverY = 115;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(coverX, coverY, coverSize, coverSize, 12);
  ctx.clip();

  if (coverBuffer) {
    try {
      const img = await loadImage(coverBuffer);
      ctx.drawImage(img, coverX, coverY, coverSize, coverSize);
    } catch {
      ctx.fillStyle = '#282828';
      ctx.fillRect(coverX, coverY, coverSize, coverSize);
    }
  } else {
    ctx.fillStyle = '#282828';
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
    ctx.fillStyle = '#1DB954';
    ctx.font = 'bold 36px "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎵', coverX + coverSize / 2, coverY + coverSize / 2 + 12);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // Song Title & Artist
  const metaX = coverX + coverSize + 25;
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 30px "Arial", sans-serif';
  const cleanTitle = (title || 'Judul Lagu').length > 25 ? (title || 'Judul Lagu').substring(0, 24) + '...' : (title || 'Judul Lagu');
  ctx.fillText(cleanTitle, metaX, coverY + 45);

  ctx.fillStyle = '#b3b3b3';
  ctx.font = '500 20px "Arial", sans-serif';
  const cleanArtist = (artist || 'Artis').length > 30 ? (artist || 'Artis').substring(0, 29) + '...' : (artist || 'Artis');
  ctx.fillText(cleanArtist, metaX, coverY + 80);

  // 4. Subtle separator
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 255);
  ctx.lineTo(width - 50, 255);
  ctx.stroke();

  // 5. Lyrics Content (Spotify Highlight Typography)
  ctx.textAlign = 'left';
  let lyricY = 325;
  const linesToDraw = (lyricsLines && lyricsLines.length > 0)
    ? lyricsLines.slice(0, 6)
    : ['(Lirik instrumental / ketik .lirik untuk melihat teks lengkap)'];

  for (let i = 0; i < linesToDraw.length; i++) {
    const line = linesToDraw[i].trim();
    if (!line) continue;

    if (i < 3) {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 34px "Arial", sans-serif';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = 'bold 30px "Arial", sans-serif';
    }

    const displayLine = line.length > 40 ? line.substring(0, 39) + '...' : line;
    ctx.fillText(displayLine, 50, lyricY);
    lyricY += 65;
  }

  // 6. Spotify Progress Bar & Player Footer
  const barY = height - 120;
  const barWidth = width - 100;

  ctx.fillStyle = '#404040';
  ctx.beginPath();
  ctx.roundRect(50, barY, barWidth, 6, 3);
  ctx.fill();

  const activeWidth = barWidth * 0.42;
  ctx.fillStyle = '#1DB954';
  ctx.beginPath();
  ctx.roundRect(50, barY, activeWidth, 6, 3);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(50 + activeWidth, barY + 3, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  ctx.fillStyle = '#8a8a8a';
  ctx.font = '14px "Arial", sans-serif';
  ctx.fillText('01:32', 50, barY + 28);
  ctx.textAlign = 'right';
  ctx.fillText(duration || '03:45', width - 50, barY + 28);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.font = '13px "Arial", sans-serif';
  ctx.fillText('• SPOTIFY LYRICS EXPERIENCE •', width / 2, height - 35);

  return canvas.toBuffer('image/jpeg');
}

/**
 * Generator Gambar Vertikal 9:16 Ala Spotify Canvas (720x1280)
 * Digunakan sebagai latar visual video MP4 Spotify Canvas.
 */
export async function createSpotifyCanvasImage({
  title = 'Judul Lagu',
  artist = 'Artis',
  coverBuffer = null,
  lyricsLines = [],
  duration = '03:45'
}) {
  const width = 720;
  const height = 1280;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Background Gradient (Spotify Emerald Green ke Midnight Black)
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#133e28');
  grad.addColorStop(0.35, '#121212');
  grad.addColorStop(1, '#0a0a0a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle radial glow di atas
  const glow = ctx.createRadialGradient(width / 2, 200, 10, width / 2, 200, 350);
  glow.addColorStop(0, 'rgba(30, 215, 96, 0.12)');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // 2. Spotify Brand Header
  ctx.fillStyle = '#1DB954';
  ctx.beginPath();
  ctx.arc(60, 80, 18, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 24px "Arial", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Spotify', 90, 88);

  ctx.fillStyle = '#1DB954';
  ctx.font = 'bold 15px "Arial", sans-serif';
  ctx.fillText('• CANVAS', 185, 87);

  // 3. Album Art Cover Tengah
  const coverSize = 440;
  const coverX = (width - coverSize) / 2;
  const coverY = 160;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(coverX, coverY, coverSize, coverSize, 20);
  ctx.clip();

  if (coverBuffer) {
    try {
      const img = await loadImage(coverBuffer);
      ctx.drawImage(img, coverX, coverY, coverSize, coverSize);
    } catch {
      ctx.fillStyle = '#282828';
      ctx.fillRect(coverX, coverY, coverSize, coverSize);
    }
  } else {
    ctx.fillStyle = '#282828';
    ctx.fillRect(coverX, coverY, coverSize, coverSize);
    ctx.fillStyle = '#1DB954';
    ctx.font = 'bold 64px "Arial", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎵', width / 2, coverY + coverSize / 2 + 20);
  }
  ctx.restore();

  // 4. Judul Lagu & Artis
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 36px "Arial", sans-serif';
  const cleanTitle = (title || 'Judul Lagu').length > 25 ? (title || 'Judul Lagu').substring(0, 24) + '...' : (title || 'Judul Lagu');
  ctx.fillText(cleanTitle, width / 2, coverY + coverSize + 65);

  ctx.fillStyle = '#b3b3b3';
  ctx.font = '500 24px "Arial", sans-serif';
  const cleanArtist = (artist || 'Artis').length > 30 ? (artist || 'Artis').substring(0, 29) + '...' : (artist || 'Artis');
  ctx.fillText(cleanArtist, width / 2, coverY + coverSize + 105);

  // 5. Kotak Cuplikan Lirik Spotify
  const lyricBoxY = coverY + coverSize + 145;
  const lyricBoxW = width - 100;
  const lyricBoxH = 175;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.beginPath();
  ctx.roundRect(50, lyricBoxY, lyricBoxW, lyricBoxH, 16);
  ctx.fill();

  ctx.fillStyle = '#1DB954';
  ctx.font = 'bold 14px "Arial", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('SPOTIFY LYRICS', 75, lyricBoxY + 35);

  const lines = (lyricsLines && lyricsLines.length > 0) ? lyricsLines.slice(0, 3) : ['Mendengarkan di Spotify Player'];
  let curLineY = lyricBoxY + 75;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    ctx.fillStyle = i === 0 ? '#FFFFFF' : 'rgba(255, 255, 255, 0.65)';
    ctx.font = i === 0 ? 'bold 24px "Arial", sans-serif' : '500 20px "Arial", sans-serif';
    const displayL = l.length > 38 ? l.substring(0, 37) + '...' : l;
    ctx.fillText(displayL, 75, curLineY);
    curLineY += 36;
  }

  // 6. Audio Progress Bar
  const barY = height - 160;
  ctx.fillStyle = '#333333';
  ctx.beginPath();
  ctx.roundRect(50, barY, width - 100, 6, 3);
  ctx.fill();

  ctx.fillStyle = '#1DB954';
  ctx.beginPath();
  ctx.roundRect(50, barY, (width - 100) * 0.45, 6, 3);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(50 + (width - 100) * 0.45, barY + 3, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  ctx.fillStyle = '#8a8a8a';
  ctx.font = '14px "Arial", sans-serif';
  ctx.fillText('01:32', 50, barY + 28);
  ctx.textAlign = 'right';
  ctx.fillText(duration || '03:45', width - 50, barY + 28);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.font = '13px "Arial", sans-serif';
  ctx.fillText('• SPOTIFY CANVAS & OFFLINE PLAYER •', width / 2, height - 35);

  return canvas.toBuffer('image/jpeg');
}


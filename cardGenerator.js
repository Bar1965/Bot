import { createCanvas, loadImage } from '@napi-rs/canvas';
import axios from 'axios';

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
  ctx.font = 'bold 38px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  const cleanName = username.length > 22 ? username.substring(0, 22) + '...' : username;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.fillText(cleanName, width / 2, 350);
  ctx.restore();

  // Group Name
  ctx.save();
  ctx.font = '500 24px "Segoe UI", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  const cleanGroup = groupName.length > 35 ? groupName.substring(0, 35) + '...' : groupName;
  ctx.fillText(isWelcome ? `Joined ${cleanGroup}` : `Left ${cleanGroup}`, width / 2, 385);
  ctx.restore();

  // Member Count Badge
  ctx.save();
  const badgeText = isWelcome ? `MEMBER #${memberCount}` : `TOTAL MEMBERS: ${memberCount}`;
  ctx.font = 'bold 18px "Segoe UI", sans-serif';
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
  ctx.font = 'bold 42px "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 5;
  const cleanName = username.length > 20 ? username.substring(0, 20) + '...' : username;
  ctx.fillText(cleanName, textX, 200);
  ctx.restore();

  // Title Badge Pill
  ctx.save();
  ctx.font = 'bold 18px "Segoe UI", sans-serif';
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
  ctx.font = 'bold 48px "Segoe UI", sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`LVL ${oldLevel}`, textX, 320);

  ctx.font = 'bold 48px "Segoe UI", sans-serif';
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
  ctx.font = 'bold 18px "Segoe UI", sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(`Total XP: ${xp.toLocaleString('id-ID')} XP`, barX, barY + 55);
  ctx.restore();

  return canvas.toBuffer('image/jpeg');
}

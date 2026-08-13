const fs = require('fs');

const originalBot = fs.readFileSync('bot_backup.js', 'utf8');

const custStart = originalBot.indexOf('  // 1. DAFTAR MEMBER / PELANGGAN BARU');
const custEnd = originalBot.indexOf('  if (isGroup && cleanCmd === \\'group\\') {'); // The start of groupAdmin commands

let customerHandlerContent = originalBot.substring(custStart, custEnd);

customerHandlerContent = \import * as db from '../../database.js';
import { config } from '../../config.js';
import { jidNormalizedUser, downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { createMidtransTransaction, botState } from '../../server.js';
import { buildCommandMenu } from '../../commandRegistry.js';
import * as mediaHandler from '../../mediaHandler.js';
import * as ent from '../../entertainmentHandler.js';
import { sendInteractiveButtons } from '../../bot.js';

export function createCustomerHandler(ctx) {
    const { sock, botSettings, userPushNamesMap, messageCache, formatPhoneNumber, react, sendInteractiveButtons } = ctx;

    return async function handleCustomerMessage(jid, senderNumber, messageObj, text, isFromGroup = false, actor = {}) {
  const textLower = text.toLowerCase();
  const cleanTextLower = textLower.replace(/^[./#]/, '').trim();
  const args = text.trim().split(/\\s+/);
  const rawCmd = args[0].toLowerCase();
  const cleanCmd = rawCmd.replace(/^[./#]/, '');

  const customerName = messageObj.pushName || "Pelanggan";
  await db.getOrCreateCustomer(senderNumber, customerName);

  const memberProfile = await db.getCustomerMembershipProfile(senderNumber);
  const isPrivateCommand =
    ['beli', 'buy'].includes(cleanCmd) ||
    ['cart', 'keranjang', 'checkout', 'bayar', 'cancel', 'batal', 'status', 'riwayat', 'history'].includes(cleanCmd);
  const responseJid = (isFromGroup && isPrivateCommand) ? senderNumber : jid;

  if (memberProfile?.account_status === 'BANNED' && !actor.isAdmin) {
    await sock.sendMessage(jid, { text: '🚫 Akun kamu sedang diblokir dari layanan bot. Hubungi Owner jika merasa ini kesalahan.' });
    return true;
  }
\ + "\\n" + customerHandlerContent + "\\n}\\n}\\n";

fs.writeFileSync('src/handlers/customerHandler.js', customerHandlerContent);
console.log('Restored customerHandler.js');

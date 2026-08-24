import * as db from '../../database.js';
import { send } from './helpers.js';

// ─── 7. BANK POIN & BUNGA HARIAN ─────────────────────────────
async function handleBankEconomy(sock, jid, senderNumber, messageObj, args, command) {
  const prof = await db.getGameProfile(senderNumber);
  const currentWallet = prof?.points || 0;
  const currentBank = prof?.bank_points || 0;
  const cust = await db.getCustomerByPhone(senderNumber);
  const senderPhone = senderNumber.split('@')[0];
  const userLabel = cust?.nama ? `*${cust.nama}* (@${senderPhone})` : `@${senderPhone}`;

  if (['bank', 'brankas'].includes(command)) {
    const estInterest = Math.floor(currentBank * 0.02);
    const bankCard = 
`🏦 *REKENING BANK POIN AKBAR STORE* 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Nasabah: ${userLabel}
💰 Dompet Utama: *${currentWallet.toLocaleString('id-ID')} Poin* (Bisa dimaling)
🔒 Saldo Rekening Bank: *${currentBank.toLocaleString('id-ID')} Poin* (100% Aman)
📈 Bunga Harian: *2% per hari* (+${estInterest.toLocaleString('id-ID')} Poin/hari)

📌 *Petunjuk Transaksi:*
▫️ \`.depo [jumlah/all]\` - Simpan poin ke bank
▫️ \`.tarik [jumlah/all]\` - Tarik poin ke dompet (Pajak 2%)

_Catatan: Poin di bank aman 100% dari aksi .steal / maling member lain._`;

    await send(sock, jid, messageObj, bankCard, {
      title: '🏦 BANK POIN',
      buttons: [
        { type: 'reply', text: '📥 Setor Semua Poin', id: '.depo all' },
        { type: 'reply', text: '📤 Tarik 100 Poin', id: '.tarik 100' },
        { type: 'reply', text: '👤 Profil Game', id: '.poin' }
      ],
      mentions: [senderNumber]
    });
    return true;
  }

  if (['depo', 'setor'].includes(command)) {
    let amount = 0;
    if (args[1]?.toLowerCase() === 'all' || args[1]?.toLowerCase() === 'semua') {
      amount = currentWallet;
    } else {
      amount = parseInt(args[1], 10);
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "⚠️ *Format Setor Salah!*\nGunakan: `.depo [jumlah]` atau `.depo all`\n_Contoh:_ `.depo 500`");
      return true;
    }

    if (currentWallet < amount) {
      await send(sock, jid, messageObj, `❌ Saldo dompetmu tidak mencukupi! (Dompet: ${currentWallet} Poin)`);
      return true;
    }

    const res = await db.bankDeposit(senderNumber, amount);
    if (res.success) {
      const updated = await db.getGameProfile(senderNumber);
      await send(sock, jid, messageObj, `✅ *SETORAN BANK BERHASIL!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📥 Jumlah Disetor: *+${amount.toLocaleString('id-ID')} Poin*\n🔒 Saldo Bank Sekarang: *${updated.bank_points.toLocaleString('id-ID')} Poin*\n💰 Sisa Dompet: *${updated.points.toLocaleString('id-ID')} Poin*`, { mentions: [senderNumber] });
    } else {
      await send(sock, jid, messageObj, "❌ Gagal memproses setoran bank.");
    }
    return true;
  }

  if (['tarik', 'withdraw'].includes(command)) {
    let amount = 0;
    if (args[1]?.toLowerCase() === 'all' || args[1]?.toLowerCase() === 'semua') {
      amount = currentBank;
    } else {
      amount = parseInt(args[1], 10);
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      await send(sock, jid, messageObj, "⚠️ *Format Tarik Salah!*\nGunakan: `.tarik [jumlah]` atau `.tarik all`\n_Contoh:_ `.tarik 500`");
      return true;
    }

    if (currentBank < amount) {
      await send(sock, jid, messageObj, `❌ Saldo rekening bankmu tidak mencukupi! (Saldo Bank: ${currentBank} Poin)`);
      return true;
    }

    const res = await db.bankWithdraw(senderNumber, amount, 0.02);
    if (res.success) {
      const updated = await db.getGameProfile(senderNumber);
      await send(sock, jid, messageObj, `✅ *PENARIKAN BANK BERHASIL!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📤 Jumlah Ditarik: *${amount.toLocaleString('id-ID')} Poin*\n💸 Pajak Admin (2%): *${(amount - res.received).toLocaleString('id-ID')} Poin*\n💰 Masuk ke Dompet: *+${res.received.toLocaleString('id-ID')} Poin*\n🔒 Sisa Saldo Bank: *${updated.bank_points.toLocaleString('id-ID')} Poin*`, { mentions: [senderNumber] });
    } else {
      await send(sock, jid, messageObj, "❌ Gagal memproses penarikan bank.");
    }
    return true;
  }

  return false;
}


export { handleBankEconomy };
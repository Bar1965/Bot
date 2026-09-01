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
    const estInterest = db.hitungBungaHarian(currentBank);
    const kenaBatas = currentBank > db.BANK_BUNGA_TIER;
    // Jangan menulis "100% Aman" kalau di layar yang sama ada dana yang belum
    // mengendap — itu kontradiksi yang bikin pemain merasa dibohongi.
    const rawan = await db.getSaldoRawan(senderNumber);
    const labelAman = rawan.endap > 0
      ? `(${(currentBank - rawan.endap).toLocaleString('id-ID')} aman · ${rawan.endap.toLocaleString('id-ID')} belum mengendap)`
      : '(100% Aman)';
    const bankCard = 
`🏦 *REKENING BANK POIN AKBAR STORE* 💳
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Nasabah: ${userLabel}
💰 Dompet Utama: *${currentWallet.toLocaleString('id-ID')} Poin* (Bisa dimaling)
🔒 Saldo Rekening Bank: *${currentBank.toLocaleString('id-ID')} Poin* ${labelAman}
📈 Bunga Harian: *+${estInterest.toLocaleString('id-ID')} Poin/hari*
   └ _${db.BANK_BUNGA_RATE * 100}% untuk ${db.BANK_BUNGA_TIER.toLocaleString('id-ID')} poin pertama, maksimal ${db.BANK_BUNGA_CAP} poin/hari_${kenaBatas ? '\n   └ ⚠️ _Saldomu di atas batas bunga — kelebihannya tidak berbunga lagi._' : ''}

📌 *Petunjuk Transaksi:*
▫️ \`.depo [jumlah/all]\` - Simpan poin ke bank
▫️ \`.tarik [jumlah/all]\` - Tarik poin ke dompet *(gratis, tanpa pajak)*

🔒 *Soal keamanan:*
Poin di bank aman dari \`.steal\`, *kecuali setoran yang baru masuk* — dana perlu *${Math.round(db.BANK_ENDAP_MS / 60000)} menit* untuk mengendap. Menyetor tepat saat mau dicopet tidak menyelamatkanmu.`;

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
      await send(sock, jid, messageObj, `✅ *SETORAN BANK BERHASIL!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📥 Jumlah Disetor: *+${amount.toLocaleString('id-ID')} Poin*\n🔒 Saldo Bank Sekarang: *${updated.bank_points.toLocaleString('id-ID')} Poin*\n💰 Sisa Dompet: *${updated.points.toLocaleString('id-ID')} Poin*\n\n⏳ *Dana baru mengendap dalam ${Math.round(db.BANK_ENDAP_MS / 60000)} menit.* Sebelum itu, setoran ini masih bisa dijangkau \`.steal\`.`, { mentions: [senderNumber] });
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

    const res = await db.bankWithdraw(senderNumber, amount);
    if (res.success) {
      const updated = await db.getGameProfile(senderNumber);
      await send(sock, jid, messageObj, `✅ *PENARIKAN BANK BERHASIL!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📤 Jumlah Ditarik: *${amount.toLocaleString('id-ID')} Poin*\n💰 Masuk ke Dompet: *+${res.received.toLocaleString('id-ID')} Poin* _(tanpa potongan)_\n🔒 Sisa Saldo Bank: *${updated.bank_points.toLocaleString('id-ID')} Poin*\n\n_Menarik uangmu sendiri tidak dipajaki._`, { mentions: [senderNumber] });
    } else {
      await send(sock, jid, messageObj, "❌ Gagal memproses penarikan bank.");
    }
    return true;
  }

  return false;
}


export { handleBankEconomy };
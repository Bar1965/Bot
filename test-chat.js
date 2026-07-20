import * as db from './database.js';
import * as chatManager from './chatManager.js';
import { botState } from './server.js';

async function runTests() {
  console.log("=== MEMULAI PENGUJIAN INTEGRASI LIVE CHAT & CONVERSATIONS ===");

  try {
    // 1. Inisialisasi Database
    console.log("🛠️ Inisialisasi Database...");
    await db.initDb();
    console.log("✅ Database berhasil terinisialisasi.");

    // Gunakan nomor telepon dummy untuk pengujian
    const testJid = '628999999999@s.whatsapp.net';

    // Bersihkan data lama jika ada
    await db.runQuery("DELETE FROM messages WHERE customer_jid = ?", [testJid]);
    await db.runQuery("DELETE FROM conversations WHERE customer_jid = ?", [testJid]);
    await db.runQuery("DELETE FROM customers WHERE nomor = ?", [testJid]);

    // 2. Buat Customer & Sesi Percakapan Baru
    console.log("🛠️ Membuat data Percakapan untuk nomor:", testJid);
    const conv = await db.getOrCreateConversation(testJid);
    console.log("✅ Percakapan awal dibuat:", JSON.stringify(conv));

    if (conv.conversation_state !== 'BOT') {
      throw new Error(`Ekspektasi state awal 'BOT', tetapi bernilai: ${conv.conversation_state}`);
    }

    // 3. Simpan Pesan Masuk dari Customer
    console.log("🛠️ Menyimpan pesan masuk ke-1...");
    await chatManager.saveIncomingMessage({
      id: 'msg_001',
      customerJid: testJid,
      messageType: 'text',
      message: 'Halo Kak, ada produk Netflix?',
      quotedId: '',
      timestamp: Date.now() - 5000
    });

    console.log("🛠️ Menyimpan pesan masuk ke-2...");
    await chatManager.saveIncomingMessage({
      id: 'msg_002',
      customerJid: testJid,
      messageType: 'text',
      message: 'Saya butuh cepat.',
      quotedId: '',
      timestamp: Date.now() - 2000
    });

    // Ambil list conversation dan cek unread count (Ekspektasi: 2)
    let list = await db.getConversationsList();
    let testConv = list.find(c => c.customer_jid === testJid);
    console.log(`✅ Unread Count (Ekspektasi: 2) -> Hasil: ${testConv.unread_count}`);
    if (testConv.unread_count !== 2) {
      throw new Error(`Ekspektasi unread count 2, tetapi bernilai: ${testConv.unread_count}`);
    }

    // 4. Kirim Balasan dari Admin (Fase 2)
    console.log("🛠️ Menyimpan pesan keluar dari Admin...");
    await chatManager.saveOutgoingMessage({
      id: 'msg_admin_001',
      customerJid: testJid,
      sender: 'admin_cs01',
      messageType: 'text',
      message: 'Halo! Tentu kak, silakan ketik /beli NET01.',
      quotedId: 'msg_002',
      timestamp: Date.now(),
      status: 'sent'
    });

    // Ambil list conversation kembali (Ekspektasi unread count: 0 karena Admin membalas pesan)
    list = await db.getConversationsList();
    testConv = list.find(c => c.customer_jid === testJid);
    console.log(`✅ Unread Count setelah dibalas Admin (Ekspektasi: 0) -> Hasil: ${testConv.unread_count}`);
    if (testConv.unread_count !== 0) {
      throw new Error(`Ekspektasi unread count 0 setelah dibalas, tetapi bernilai: ${testConv.unread_count}`);
    }

    // 5. Uji Coba State Takeover (Fase 5)
    console.log("🛠️ Menguji coba take over percakapan ke ADMIN...");
    await db.updateConversationState(testJid, 'ADMIN', 'admin_cs01');
    
    let updatedConv = await db.getOrCreateConversation(testJid);
    console.log(`✅ State Percakapan (Ekspektasi: ADMIN) -> Hasil: ${updatedConv.conversation_state}`);
    console.log(`✅ Assigned Admin (Ekspektasi: admin_cs01) -> Hasil: ${updatedConv.assigned_admin_id}`);

    if (updatedConv.conversation_state !== 'ADMIN' || updatedConv.assigned_admin_id !== 'admin_cs01') {
      throw new Error("Gagal melakukan takeover state percakapan.");
    }

    // 6. Uji Coba Catatan Internal & Label (Fase 3 & 4)
    console.log("🛠️ Menambahkan Catatan Internal & Label...");
    await db.updateConversationNotes(testJid, 'Customer langganan Netflix, VIP tier.');
    await db.updateConversationLabels(testJid, 'VIP,Priority');

    list = await db.getConversationsList();
    testConv = list.find(c => c.customer_jid === testJid);
    console.log(`✅ Catatan Internal -> Hasil: "${testConv.internal_notes}"`);
    console.log(`✅ Labels -> Hasil: "${testConv.labels}"`);

    if (testConv.internal_notes !== 'Customer langganan Netflix, VIP tier.' || testConv.labels !== 'VIP,Priority') {
      throw new Error("Gagal menyimpan Catatan Internal atau Label.");
    }

    // 7. Uji Coba Antrean Pesan Keluar (Message Queue) saat Offline (Fase 17)
    console.log("🛠️ Menguji Message Queue saat Bot WhatsApp Offline...");
    botState.whatsappConnected = false;
    botState.sock = null;

    console.log("⚡ Memasukkan pesan baru ke dalam antrean (enqueue)...");
    const queuedMsg = await chatManager.enqueueOutgoingMessage({
      customerJid: testJid,
      messageType: 'text',
      message: 'Halo Kak, apakah pesan ini masuk antrean?',
      quotedId: '',
      adminUsername: 'admin_cs01'
    });

    console.log(`✅ Status pesan di DB (Ekspektasi: sending) -> Hasil:`);
    const dbMsg = await db.getQuery("SELECT * FROM messages WHERE id = ?", [queuedMsg.id]);
    console.log(JSON.stringify(dbMsg));
    
    if (dbMsg.status !== 'sending') {
      throw new Error(`Ekspektasi status sending, tetapi bernilai: ${dbMsg.status}`);
    }

    console.log("\n⭐️ SELURUH PENGUJIAN INTEGRASI LIVE CHAT BERHASIL 100%! ⭐️");
    process.exit(0);

  } catch (err) {
    console.error("❌ PENGUJIAN GAGAL:", err.message);
    process.exit(1);
  }
}

runTests();

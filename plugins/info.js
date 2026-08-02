export default {
  name: 'info',
  commands: ['ping', 'runtime', 'botinfo'],
  handler: async ({ sock, jid, cleanCmd }) => {
    if (cleanCmd === 'ping') {
      const start = Date.now();
      await sock.sendMessage(jid, { text: `🏓 *Pong!* Respon: *${Date.now() - start}ms*` });
      return true;
    }
    if (['runtime', 'botinfo'].includes(cleanCmd)) {
      const uptimeSec = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const secs = uptimeSec % 60;
      await sock.sendMessage(jid, { 
        text: `🤖 *BOT INFORMATION & STATUS*
        
⏱️ Uptime: *${hours}j ${mins}m ${secs}d*
⚡ Status: *Online & Synchronized*
📦 Engine: *Baileys Multi-Device v2.3000*
🧩 Modular Plugins: *Active*` 
      });
      return true;
    }
    return false;
  }
};

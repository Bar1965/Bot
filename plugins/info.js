export default {
  name: 'info',
  commands: ['runtime', 'botinfo'],
  handler: async ({ sock, jid, cleanCmd }) => {
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

const fs = require('fs');

let content = fs.readFileSync('src/handlers/groupAdminHandler.js', 'utf8');

const anchor = \if (isGroup && cleanCmd === 'close') {\;
const replacement = \if (isGroup && cleanCmd === 'fitur') {
      if (!isAdmin) {
        await sock.sendMessage(jid, { text: '⚠️ Perintah ini hanya untuk admin grup.' });
        return true;
      }
      
      const featureName = args[1]?.toLowerCase();
      const action = args[2]?.toLowerCase();
      const validFeatures = ['ai', 'lens', 'brat', 'totalchat', 'rvo'];
      
      const currentSettings = await db.getGroupSettings(jid);
      const featuresConfig = currentSettings.features_config || {};
      
      if (!featureName || !action || !validFeatures.includes(featureName) || !['on', 'off'].includes(action)) {
        let msg = \🛠️ *PENGATURAN FITUR GRUP* 🛠️\\n\\nGunakan perintah: \\\.fitur <nama_fitur> <on/off>\\\\\n\\n*Daftar Fitur:*\\n\;
        validFeatures.forEach(f => {
            const status = featuresConfig[f] !== false ? '✅ (ON)' : '❌ (OFF)';
            msg += \- *\\\* : \\\\\n\;
        });
        msg += \\\nContoh: \\\.fitur ai off\\\\\n_(Pengaturan ini HANYA berlaku di grup ini)_\;
        
        await sock.sendMessage(jid, { text: msg });
        return true;
      }
      
      featuresConfig[featureName] = (action === 'on');
      await db.updateGroupSettings(jid, { features_config: featuresConfig });
      await sock.sendMessage(jid, { text: \✅ Fitur *\\\* berhasil di-\\\-kan untuk grup ini.\ });
      return true;
    }

    if (isGroup && cleanCmd === 'close') {\;

if (content.includes(anchor)) {
    content = content.replace(anchor, replacement);
    fs.writeFileSync('src/handlers/groupAdminHandler.js', content);
    console.log('groupAdminHandler.js patched with .fitur command');
} else {
    console.log('anchor not found in groupAdminHandler.js');
}

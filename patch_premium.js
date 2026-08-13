const fs = require('fs');
let content = fs.readFileSync('premiumHandler.js', 'utf8');

// Add aiContextMap
if (!content.includes('const aiContextMap = new Map();')) {
  content = content.replace(
    '// ============================================================',
    \const aiContextMap = new Map();\\n\\n// ============================================================\
  );
}

// Modify ai command
const targetAI = \        aiResponse = await askGeminiText({ prompt: promptText });\;
const replacementAI = \        
        // Conversational AI context
        if (!aiContextMap.has(senderNumber)) {
          aiContextMap.set(senderNumber, []);
        }
        const context = aiContextMap.get(senderNumber);
        
        let contextualPrompt = "";
        if (context.length > 0) {
          contextualPrompt += "Konteks percakapan sebelumnya:\\n";
          context.forEach(msg => {
             contextualPrompt += \User: \\\nAI: \\\n\;
          });
          contextualPrompt += "\\nSekarang jawab pertanyaan berikut dari User:\\nUser: " + promptText;
        } else {
          contextualPrompt = promptText;
        }

        aiResponse = await askGeminiText({ prompt: contextualPrompt });
        
        // Save history
        context.push({ user: promptText, bot: aiResponse });
        if (context.length > 5) {
          context.shift();
        }
        aiContextMap.set(senderNumber, context);\;
content = content.replace(targetAI, replacementAI);

const targetResetAI = \    return true;
  }\;
const replacementResetAI = \    return true;
  }

  // ─── .resetai — Reset AI Context ───────
  if (cmd === 'resetai') {
    if (aiContextMap.has(senderNumber)) {
      aiContextMap.delete(senderNumber);
      await sock.sendMessage(jid, { text: "✅ Ingatan percakapan AI telah dihapus. Mari mulai dari awal!" }, { quoted: messageObj });
    } else {
      await sock.sendMessage(jid, { text: "⚠️ Kamu belum memiliki percakapan dengan AI." }, { quoted: messageObj });
    }
    return true;
  }\;
  
if (!content.includes("cmd === 'resetai'")) {
  content = content.replace(targetResetAI, replacementResetAI);
  fs.writeFileSync('premiumHandler.js', content);
  console.log("Patched premiumHandler.js successfully!");
} else {
  console.log("Failed to patch or already patched.");
}

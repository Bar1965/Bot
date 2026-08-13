const fs = require('fs');
let lines = fs.readFileSync('src/handlers/customerHandler.js', 'utf8').split('\n');

// Find the FAQ section
let faqIdx = lines.findIndex(l => l.includes('// FAQ OTOMATIS'));

// Remove all closing braces after FAQ until the Utility Commands
for (let i = faqIdx; i < lines.length; i++) {
  if (lines[i].includes('// ==========================================')) {
     // delete from faqIdx + 6 (which is the closing brace) to i
     let startBrace = faqIdx + 7;
     let deleteCount = i - startBrace;
     if (deleteCount > 0) {
        lines.splice(startBrace, deleteCount);
     }
     break;
  }
}

fs.writeFileSync('src/handlers/customerHandler.js', lines.join('\n'));
console.log('Fixed file');

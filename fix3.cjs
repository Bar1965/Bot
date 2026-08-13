const fs = require('fs');
let lines = fs.readFileSync('src/handlers/customerHandler.js', 'utf8').split('\n');

const faqIndex = lines.findIndex(l => l.includes('// FAQ OTOMATIS'));
const badBrace = lines.indexOf('}', faqIndex + 5);

if (badBrace !== -1) {
  lines.splice(badBrace, 1);
  lines.push('}');
  lines.push('}');
  fs.writeFileSync('src/handlers/customerHandler.js', lines.join('\n'));
  console.log('Fixed brace placement');
} else {
  console.log('Could not find bad brace');
}

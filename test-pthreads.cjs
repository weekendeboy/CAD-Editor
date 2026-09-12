const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
console.log(js.includes('worker.js') || js.includes('pthread-main.js'));

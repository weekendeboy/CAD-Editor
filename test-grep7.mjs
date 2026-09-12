import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const lines = js.split('\n');
const matching = lines.filter(l => l.includes('wasmBinary')).map(l => l.trim().substring(0, 150));
console.log(matching.join('\n'));

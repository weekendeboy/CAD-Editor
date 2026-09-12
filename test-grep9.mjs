import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('var wasmBinary');
console.log(js.substring(Math.max(0, idx - 100), idx + 200));

import fs from 'fs';
const wasm = fs.readFileSync('public/occ/opencascade.wasm.wasm');
console.log(wasm.byteLength);

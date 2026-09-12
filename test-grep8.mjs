import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const regex = /.{0,50}wasmBinary.{0,50}/g;
const matches = [...js.matchAll(regex)];
console.log(matches.slice(0, 10).map(m => m[0]).join('\n'));

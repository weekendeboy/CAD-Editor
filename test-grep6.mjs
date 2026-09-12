import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('wasmBinary = Module["wasmBinary"]');
if (idx !== -1) {
  console.log("Found");
} else {
  console.log("Not found");
}

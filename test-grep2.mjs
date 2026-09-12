import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('instantiateWasm');
if (idx !== -1) {
  console.log(js.substring(Math.max(0, idx - 200), idx + 200));
} else {
  console.log("Not found");
}

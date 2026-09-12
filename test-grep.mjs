import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('transfer');
if (idx !== -1) {
  console.log(js.substring(Math.max(0, idx - 100), idx + 100));
} else {
  console.log("Not found");
}

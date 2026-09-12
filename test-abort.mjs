import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('function abort(');
if (idx !== -1) {
  console.log(js.substring(Math.max(0, idx - 100), idx + 500));
} else {
  console.log("Not found");
}

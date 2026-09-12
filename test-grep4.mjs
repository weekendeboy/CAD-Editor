import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const idx = js.indexOf('function getBinaryPromise');
if (idx !== -1) {
  console.log(js.substring(Math.max(0, idx - 100), idx + 1000));
} else {
  const idx2 = js.indexOf('getBinaryPromise');
  console.log(js.substring(Math.max(0, idx2 - 100), idx2 + 1000));
}

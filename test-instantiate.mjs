import fs from 'fs';
const wasm = fs.readFileSync('public/occ/opencascade.wasm.wasm');
WebAssembly.instantiate(wasm).then(res => {
  console.log("Instantiated!", !!res.instance);
}).catch(e => console.error("Error:", e));

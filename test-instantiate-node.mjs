import fs from 'fs';
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');

const wasm = fs.readFileSync('public/occ/opencascade.wasm.wasm');
const Module = {
  wasmBinary: wasm
};

const fakeSelf = {};
eval(js.replace('self.initOpenCascade', 'fakeSelf.initOpenCascade'));
fakeSelf.initOpenCascade(Module).then(() => {
  console.log("Success in Node");
}).catch(e => {
  console.error("Error in Node:", e);
});

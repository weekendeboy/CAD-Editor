const fs = require('fs');
const path = require('path');

const occDir = path.resolve(__dirname, '../public/occ');
fs.mkdirSync(occDir, { recursive: true });

const srcJs = path.resolve(__dirname, '../node_modules/opencascade.js/dist/opencascade.wasm.js');
const srcWasm = path.resolve(__dirname, '../node_modules/opencascade.js/dist/opencascade.wasm.wasm');

if (fs.existsSync(srcJs)) {
  fs.copyFileSync(srcJs, path.join(occDir, 'opencascade.wasm.js'));
  let content = fs.readFileSync(path.join(occDir, 'opencascade.wasm.js'), 'utf8');
  content = content.replace('export default opencascade;', 'self.initOpenCascade = opencascade;');
  fs.writeFileSync(path.join(occDir, 'opencascade.wasm.js'), content);
  console.log('Successfully prepared opencascade.wasm.js');
}

const wasmFile = fs.existsSync(srcWasm) ? srcWasm : path.join(occDir, 'opencascade.wasm.wasm');
if (fs.existsSync(wasmFile)) {
  if (wasmFile !== path.join(occDir, 'opencascade.wasm.wasm')) {
    fs.copyFileSync(wasmFile, path.join(occDir, 'opencascade.wasm.wasm'));
  }
  const wasmBuffer = fs.readFileSync(path.join(occDir, 'opencascade.wasm.wasm'));
  const totalSize = wasmBuffer.byteLength;
  const CHUNK_SIZE = 18 * 1024 * 1024; // 18MB per chunk (safely under Cloud Run 32MB limit)
  const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const parts = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = wasmBuffer.subarray(start, end);
    const partName = `opencascade.wasm.part${i}.bin`;
    fs.writeFileSync(path.join(occDir, partName), chunk);
    parts.push(partName);
  }

  fs.writeFileSync(
    path.join(occDir, 'manifest.json'),
    JSON.stringify({ totalSize, parts }, null, 2)
  );
  console.log(`Successfully generated ${parts.length} chunks and manifest.json`);
}

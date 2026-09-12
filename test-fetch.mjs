fetch('http://localhost:3000/occ/opencascade.wasm.wasm')
  .then(res => res.arrayBuffer())
  .then(buf => console.log("Fetched size:", buf.byteLength))
  .catch(err => console.error("Error:", err));

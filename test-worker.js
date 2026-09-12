const workerCode = `
importScripts('http://localhost:3000/occ/opencascade.wasm.js');
self.initOpenCascade({
  locateFile: (path) => 'http://localhost:3000/occ/' + path
}).then(oc => {
  postMessage('ok: ' + !!oc);
}).catch(e => {
  postMessage('error: ' + e);
});
`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));
worker.onmessage = e => console.log(e.data);

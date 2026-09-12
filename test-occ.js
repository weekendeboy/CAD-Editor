const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const fakeSelf = {};
eval(js.replace('self.initOpenCascade', 'fakeSelf.initOpenCascade'));
console.log(typeof fakeSelf.initOpenCascade);

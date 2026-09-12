const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const self = {};
eval(js);
const config = {
  mainScriptUrlOrBlob: 'http://localhost:3000/occ/opencascade.wasm.js',
  locateFile: (path, prefix) => {
    console.log("locateFile called with path:", path, "prefix:", prefix);
    return 'http://localhost:3000/occ/' + path;
  }
};
self.initOpenCascade(config).catch(e => console.log(e));

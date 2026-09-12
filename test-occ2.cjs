const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const self = {};
eval(js);
const config = {
  locateFile: (path, prefix) => {
    console.log("Locate file called for:", path, "prefix:", prefix);
    return '/occ/' + path;
  }
};
self.initOpenCascade(config).catch(e => console.log(e));

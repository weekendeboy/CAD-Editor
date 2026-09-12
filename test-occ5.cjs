const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const self = {};
eval(js);
const config = {
  locateFile: (path, prefix) => {
    return 'http://localhost:3000/occ/' + path;
  }
};
self.initOpenCascade(config).then(oc => {
  console.log("Success!");
}).catch(e => console.log(e));

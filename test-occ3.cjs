const fs = require('fs');
const js = fs.readFileSync('public/occ/opencascade.wasm.js', 'utf8');
const self = {};
eval(js);
const config = {
  locateFile: (path, prefix) => {
    console.log("locateFile called:", path);
    return 'public/occ/' + path;
  }
};
self.initOpenCascade(config).then(oc => {
  console.log("Success! BRepBuilderAPI_MakeWire:", !!oc.BRepBuilderAPI_MakeWire);
}).catch(e => {
  console.error("Failed:", e);
});

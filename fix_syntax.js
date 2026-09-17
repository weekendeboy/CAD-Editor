const fs = require('fs');
let code = fs.readFileSync('src/store/cadStore.ts', 'utf8');

// I need to change addEntity and importDxfData to have `{ set(`
code = code.replace(
  /addEntity: \(sketchIdOrEntity: any, entity\?: any\) => set\(\(state\) => \{/g,
  `addEntity: (sketchIdOrEntity: any, entity?: any) => { set((state) => {`
);

code = code.replace(
  /importDxfData: \(entities, layers\) => set\(\(state\) => \{/g,
  `importDxfData: (entities, layers) => { set((state) => {`
);

fs.writeFileSync('src/store/cadStore.ts', code);

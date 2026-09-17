const fs = require('fs');
let code = fs.readFileSync('src/store/cadStore.ts', 'utf8');

// We need to fix addEntity and importDxfData.
// First, find the end of addEntity:
// Object.assign(state, {document: docDirty,});
//     }),

code = code.replace(
  /Object\.assign\(state, \{document: docDirty,\}\);\s*\}\),/g,
  `Object.assign(state, {document: docDirty,});
    });
    get().regenerateFeatureTree();
  },`
);

code = code.replace(
  /Object\.assign\(state, \{document: docDirty,\s*selectedEntityIds: \[\],\}\);\s*\}\),/g,
  `Object.assign(state, {document: docDirty, selectedEntityIds: []});
    });
    get().regenerateFeatureTree();
  },`
);

fs.writeFileSync('src/store/cadStore.ts', code);

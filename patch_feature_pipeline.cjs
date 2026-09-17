const fs = require('fs');
let code = fs.readFileSync('src/core/3d/FeaturePipelineAdapter.ts', 'utf-8');

// Add import if missing
if (!code.includes('findClosedProfiles')) {
  code = code.replace("import { RuntimeCADFeature }", "import { findClosedProfiles } from '../2d/TopologyEngine';\nimport { RuntimeCADFeature }");
}

code = code.replace(/if \(sketch && sketch\.profiles && sketch\.profiles\.length > 0\) {/g, `
        let availableProfiles = sketch ? sketch.profiles : [];
        if (sketch && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sketch.entities, sketch.constraints);
        }
        if (sketch && availableProfiles && availableProfiles.length > 0) {
`);

code = code.replace(/if \(sk && sk\.profiles && sk\.profiles\.length > 0\) {/g, `
        let availableProfiles = sk ? sk.profiles : [];
        if (sk && (!availableProfiles || availableProfiles.length === 0)) {
          availableProfiles = findClosedProfiles(sk.entities, sk.constraints);
        }
        if (sk && availableProfiles && availableProfiles.length > 0) {
`);

// Also need to replace `sketch.profiles.filter` with `availableProfiles.filter`
code = code.replace(/\? sketch\.profiles\.filter/g, '? availableProfiles.filter');
code = code.replace(/: sketch\.profiles;/g, ': availableProfiles;');
code = code.replace(/\? sk\.profiles\.filter/g, '? availableProfiles.filter');
code = code.replace(/: sk\.profiles;/g, ': availableProfiles;');

fs.writeFileSync('src/core/3d/FeaturePipelineAdapter.ts', code);

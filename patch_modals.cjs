const fs = require('fs');

function patchModal(file, isRevolve) {
  let code = fs.readFileSync(file, 'utf-8');
  if (!code.includes('findClosedProfiles')) {
    code = code.replace("import { SketchFeature", "import { findClosedProfiles } from '../core/2d/TopologyEngine';\nimport { SketchFeature");
  }
  
  if (code.includes('const computedProfiles = React.useMemo')) return;
  
  code = code.replace(/const targetSketch = sketches\.find\(\(s\) => s\.id === selectedSketchId\);/, `const targetSketch = sketches.find((s) => s.id === selectedSketchId);
  const computedProfiles = React.useMemo(() => {
    if (!targetSketch) return [];
    if (targetSketch.profiles && targetSketch.profiles.length > 0) return targetSketch.profiles;
    return findClosedProfiles(targetSketch.entities, targetSketch.constraints);
  }, [targetSketch]);`);

  code = code.replace(/const sketchProfileCount = targetSketch\?\.profiles\?\.length \|\| 0;/, `const sketchProfileCount = computedProfiles.length;`);
  
  code = code.replace(/const profileIds = targetSketch\?\.profiles\n\s*\? targetSketch\.profiles\.map\(\(p\) => p\.id\)\n\s*: \[\];/, `const profileIds = computedProfiles.map((p) => p.id);`);
  code = code.replace(/const profileIds = targetSketch\?\.profiles\s*\? targetSketch\.profiles\.map\(\(p\) => p\.id\)\s*: \[\];/, `const profileIds = computedProfiles.map((p) => p.id);`);

  fs.writeFileSync(file, code);
}

patchModal('src/components/ExtrudeFeatureModal.tsx', false);
patchModal('src/components/RevolveFeatureModal.tsx', true);

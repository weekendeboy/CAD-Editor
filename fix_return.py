import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# We need to change:
# name: (args) => set((state) => {
#    ...
#    return someId;
# }),
# To:
# name: (args) => {
#    let retVal: any;
#    set((state) => {
#       ...
#       retVal = someId;
#    });
#    return retVal;
# },

# Let's do this for `addOffsetDatumPlane`
code = re.sub(
    r'addOffsetDatumPlane:\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{([\s\S]*?)return\s+newFeatureId;\s*\}\),',
    r'addOffsetDatumPlane: (\1) => { let retId = ""; set((state) => {\2retId = newFeatureId; }); return retId; },',
    code
)

# `createSketchOnPlane` returns `newSketchId`
code = re.sub(
    r'createSketchOnPlane:\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{([\s\S]*?)return\s+newSketchId;\s*\}\),',
    r'createSketchOnPlane: (\1) => { let retId = ""; set((state) => {\2retId = newSketchId; }); return retId; },',
    code
)

# `createSketchOnFacePlane` returns `newSketchId`
code = re.sub(
    r'createSketchOnFacePlane:\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{([\s\S]*?)return\s+newSketchId;\s*\}\),',
    r'createSketchOnFacePlane: (\1) => { let retId = ""; set((state) => {\2retId = newSketchId; }); return retId; },',
    code
)

# `addExtrudeFeature` returns `newFeatureId`
code = re.sub(
    r'addExtrudeFeature:\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{([\s\S]*?)return\s+newFeatureId;\s*\}\),',
    r'addExtrudeFeature: (\1) => { let retId = ""; set((state) => {\2retId = newFeatureId; }); return retId; },',
    code
)

# Let's write the modified code.
with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

methods_to_fix = [
    'removeFeature', 'updateFeature', 'toggleFeatureSuppression', 
    'reorderFeature', 'setRollbackIndex', 'addOffsetDatumPlane', 
    'updateDatumPlaneOffset', 'createSketchOnPlane', 'createSketchOnFacePlane', 
    'addExtrudeFeature', 'addEntity', 'importDxfData', 'addDimension', 
    'updateConstraintValue', 'updateDimensionValue', 'dragVertexCommit', 
    'trimEntity'
]

for method in methods_to_fix:
    pattern = r'(' + method + r'\s*:\s*\([^)]*\)\s*=>\s*set\(\(state\)\s*=>\s*\{)'
    match = re.search(pattern, code)
    if not match:
        continue
    
    # We need to find the matching '}' for this action
    # But it's easier to find the last `},` before the NEXT method, or just parse the brace depth.
    
    start_idx = match.end()
    brace_count = 1
    idx = start_idx
    while idx < len(code) and brace_count > 0:
        if code[idx] == '{':
            brace_count += 1
        elif code[idx] == '}':
            brace_count -= 1
        idx += 1
        
    end_idx = idx
    # The string from start to end_idx is the body. The last character is `}`.
    # We want to change the ending `}` to `})`
    # Wait, the method itself is `name: (...) => set((state) => { ... })`
    # The original was `name: (...) => { ... }` so the `}` we found was the end of the action body.
    # It should become `})`. And since it's an object property, it usually had a `,` after it.
    
    # Let's just check the characters around end_idx
    # code[end_idx-1] is '}'
    # If the next character is ',', we change it to '}),'
    if code[end_idx:end_idx+1] == ',':
        code = code[:end_idx-1] + '})' + code[end_idx:]
    else:
        # maybe there's spaces or newlines before `,`
        # let's just insert `)` before the `}`
        code = code[:end_idx-1] + '})' + code[end_idx:]


with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


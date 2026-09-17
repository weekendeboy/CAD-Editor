import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# Match the entire method from `name: (args) => {` to the matching closing `}`
# Since regex for balanced brackets is hard in standard re, we'll do it sequentially.

def convert_method(code, method_name):
    # Find the start of the method
    pattern = r'(' + method_name + r'\s*:\s*\([^)]*\)\s*=>\s*)\{\s*const\s+state\s*=\s*get\(\);\s*'
    match = re.search(pattern, code)
    if not match:
        return code
    
    start_idx = match.start()
    body_start_idx = match.end() - len('const state = get();\n')
    
    # Find the closing brace of the method body by counting braces
    brace_count = 1
    idx = match.end(1) + 1 # just after {
    while idx < len(code) and brace_count > 0:
        if code[idx] == '{':
            brace_count += 1
        elif code[idx] == '}':
            brace_count -= 1
        idx += 1
        
    end_idx = idx
    
    # The method text
    method_text = code[match.start():end_idx]
    
    # Replace signature to `name: (args) => set((state) => {`
    # Replace `const state = get();` with nothing.
    new_method_text = re.sub(
        r'(' + method_name + r'\s*:\s*\([^)]*\)\s*=>\s*)\{\s*const\s+state\s*=\s*get\(\);[ \t]*\n?',
        r'\1set((state) => {\n',
        method_text
    )
    
    # Replace the inner set((draft) => { ... }) with the direct state mutations
    def replace_inner_set(m):
        props_str = m.group(1).strip()
        # props_str is something like:
        # document: docDirty,
        # selectedEntityIds: ...
        return f"""
    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    Object.assign(state, {{{props_str}}});
"""
    
    new_method_text = re.sub(
        r'set\(\(draft\)\s*=>\s*\{\s*const\s+undoState\s*=\s*pushUndoState\(draft\);\s*draft\.undoStack\s*=\s*undoState\.undoStack;\s*draft\.redoStack\s*=\s*undoState\.redoStack;\s*if\s*\(\s*Object\.keys\(\{\s*([\s\S]*?)\s*\}\)\.length\s*>\s*0\s*\)\s*\{\s*Object\.assign\(draft,\s*\{[\s\S]*?\}\);\s*\}\s*\}\);',
        replace_inner_set,
        new_method_text
    )
    
    # If the method had `get().regenerateFeatureTree();` at the end, it will now be inside the `set((state) => { ... })`.
    # Wait, we need to move `get().regenerateFeatureTree();` outside if it exists.
    # Actually, we can just leave it inside `set` if we change it to a normal function call, but `get()` inside `set` gets the draft? No, `get()` inside immer recipe gets the CURRENT state (proxy) or original? Actually it's better to move it out.
    # We can match `get().regenerateFeatureTree();` at the end of `new_method_text` and move it.
    
    if 'get().regenerateFeatureTree();' in new_method_text:
        new_method_text = new_method_text.replace('get().regenerateFeatureTree();', '')
        # add it after the closing `})`
        # new_method_text ends with `}`. We change it to `}),` then `get().regenerateFeatureTree();`
        # But wait, it might end with `  },`
        new_method_text = re.sub(r'\}\s*,\s*$', '});\n    get().regenerateFeatureTree();\n  },', new_method_text)
    else:
        new_method_text = re.sub(r'\}\s*,\s*$', '}),\n', new_method_text)
        
    return code[:match.start()] + new_method_text + code[end_idx:]


methods_to_fix = [
    'removeFeature', 'updateFeature', 'toggleFeatureSuppression', 
    'reorderFeature', 'setRollbackIndex', 'addOffsetDatumPlane', 
    'updateDatumPlaneOffset', 'createSketchOnPlane', 'createSketchOnFacePlane', 
    'addExtrudeFeature', 'addEntity', 'importDxfData', 'addDimension', 
    'updateConstraintValue', 'updateDimensionValue', 'dragVertexCommit', 
    'trimEntity'
]

for method in methods_to_fix:
    code = convert_method(code, method)
    
with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


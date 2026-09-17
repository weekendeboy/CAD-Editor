import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# For any method that ends with `}); get().regenerateFeatureTree(); },`, 
# if the signature is `name: (args) => set((state) => {`, we need to change it to:
# `name: (args) => { set((state) => {`

# Let's find all methods.
pattern = r'(\w+):\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{'
# We will just replace all `=> set((state) => {` with `=> { set((state) => {` IF it ends with `}); get().regenerateFeatureTree(); },`
# Since it's easier, let's just find them iteratively.

def process(code):
    matches = list(re.finditer(pattern, code))
    for m in reversed(matches):
        start = m.start()
        # Find the matching `}` for `set((state) => {`
        brace_count = 1
        idx = m.end()
        while idx < len(code) and brace_count > 0:
            if code[idx] == '{':
                brace_count += 1
            elif code[idx] == '}':
                brace_count -= 1
            idx += 1
        
        end = idx
        # The text immediately after `}` should be `);` 
        # Then maybe `get().regenerateFeatureTree();`
        tail = code[end:end+100]
        if ');' in tail and 'get().regenerateFeatureTree();' in tail:
            # Check if there is already a `{` before `set((state) => {`
            # Look at `m.group(0)` -> `name: (args) => set((state) => {`
            # We replace it with `name: (args) => { set((state) => {`
            # But wait! Some might already have it if they were modified by the other script!
            # The pattern is exactly `=> set((state) => {`
            new_sig = m.group(1) + ': (' + m.group(2) + ') => { set((state) => {'
            code = code[:start] + new_sig + code[m.end():]
    return code

code = process(code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


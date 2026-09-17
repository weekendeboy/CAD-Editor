import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# Pattern to find:
# \n  name: (args) => set((state) => {
#     ...
#     });
#     get().regenerateFeatureTree();
#   },
# Note that there are methods without `get().regenerateFeatureTree();` that were closed with `  }),`
# For those without it, `name: (args) => set((state) => {` is CORRECT.
# For those WITH it, they are closed with `    });\n    get().regenerateFeatureTree();\n  },`.
# So we just need to find all `name: (args) => set((state) => {` where the body ends with `get().regenerateFeatureTree();`.

# Since we don't want to parse, we can just replace ALL `name: (args) => set((state) => {` with `name: (args) => { set((state) => {`
# AND replace all `  }),\n` with `  }); },\n` !
# But some of them are already `name: (args) => { set((state) => {` ?
# Let's normalize everything!

def normalize(code):
    # 1. Change all `name: (args) => set((state) => {` to `name: (args) => { set((state) => {`
    # But only if it's at the top level of the store.
    code = re.sub(r'^(\s*)(\w+):\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{', r'\1\2: (\3) => { set((state) => {', code, flags=re.MULTILINE)
    
    # Now all actions start with `=> { set((state) => {`
    # 2. Fix the endings!
    # If an action ended with `  }),`, it now needs to end with `  }); },`
    code = re.sub(r'^(\s*)\}\),\s*$', r'\1}); },', code, flags=re.MULTILINE)
    
    return code

code = normalize(code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


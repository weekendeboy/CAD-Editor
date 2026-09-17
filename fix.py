import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# Fix 1: get().regenerateFeatureTree() inside set((state) => { ... })
# We want to move get().regenerateFeatureTree(); outside the set() block.
# Specifically, we have patterns like:
#   removeEntity: (id) => set((state) => {
#     ...
#     get().regenerateFeatureTree();
#   }),
# We want to change this to:
#   removeEntity: (id) => {
#     set((state) => {
#       ...
#     });
#     get().regenerateFeatureTree();
#   },

# Let's just fix the calls that have get().regenerateFeatureTree() inside set((state) => {
# A regex to match:
#   (someName): (args) => set((state) => {
#     ...
#     get().regenerateFeatureTree();
#   }),

def fix_regenerate(match):
    name = match.group(1)
    args = match.group(2)
    body = match.group(3)
    # remove get().regenerateFeatureTree(); from body
    body = re.sub(r'get\(\)\.regenerateFeatureTree\(\);\s*', '', body)
    
    return f"{name}: ({args}) => {{\n    set((state) => {{{body}}});\n    get().regenerateFeatureTree();\n  }},"

code = re.sub(r'(\w+):\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{([\s\S]*?)get\(\)\.regenerateFeatureTree\(\);\s*\}\),', fix_regenerate, code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


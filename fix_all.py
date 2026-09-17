import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# We need to find all `name: (args) => { set((state) => {`
# And for each of them, find their corresponding `}),` and change it to `}); },`
# Or, even better, just replace `name: (args) => { set((state) => {` with `name: (args) => set((state) => {` and then they will match `}),` properly!
# Let's do that!

code = re.sub(r'(\w+):\s*\((.*?)\)\s*=>\s*\{\s*set\(\(state\)\s*=>\s*\{', r'\1: (\2) => set((state) => {', code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


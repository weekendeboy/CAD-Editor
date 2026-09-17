import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# Step 1: Strip ALL `{ set((state) => {` back to `set((state) => {`
code = re.sub(r'(\w+):\s*\((.*?)\)\s*=>\s*\{\s*set\(\(state\)\s*=>\s*\{', r'\1: (\2) => set((state) => {', code)

# Now everything is `name: (...) => set((state) => {`.
# Step 2: For any action that ends with `}); get().regenerateFeatureTree(); },`, we must wrap it in `{ }`.
# But wait, what if we just move `get().regenerateFeatureTree();` INSIDE the `set((state) => { ... })`?
# Is it allowed to call `get()` inside `set()`?
# Yes! `get()` is available from the closure in Zustand, but inside `set(state => ...)`, we should just use `state` if it's an Immer draft.
# BUT `regenerateFeatureTree()` is an ACTION on the store. It modifies the state!
# If we call `get().regenerateFeatureTree()` inside `set(state => ...)`, it will call ANOTHER action which calls `set` internally!
# Zustand does NOT allow calling `set` inside `set` (it can cause infinite loops or overwrite drafts).
# So we MUST call it outside `set`!

# So we must wrap them.
# How to find them?
# Let's find all `name: (...) => set((state) => {`
pattern = r'(\w+):\s*\((.*?)\)\s*=>\s*set\(\(state\)\s*=>\s*\{'

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
        
        # Now check if after `}` there is `); get().regenerateFeatureTree(); },`
        # Because of formatting, it might be:
        # });
        # get().regenerateFeatureTree();
        # },
        tail = code[end:end+100]
        if re.search(r'^\);\s*get\(\)\.regenerateFeatureTree\(\);\s*\},', tail):
            # It has the regenerate call! We MUST wrap it.
            new_sig = f"{m.group(1)}: ({m.group(2)}) => {{ set((state) => {{"
            code = code[:start] + new_sig + code[m.end():]
        elif re.search(r'^\)\s*,', tail):
            # It just ends with `}),`
            # This is fine, since it's `name: (...) => set(...)`
            pass
            
    return code

code = process(code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


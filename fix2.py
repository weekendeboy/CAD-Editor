import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# We want to replace:
# set({
#   ...pushUndoState(state),
#   <other_props>
# });
# 
# With:
# set((draft) => {
#   const undoState = pushUndoState(draft);
#   draft.undoStack = undoState.undoStack;
#   draft.redoStack = undoState.redoStack;
#   Object.assign(draft, { <other_props> });
# });
#
# BUT wait, the `state` object inside the action is `const state = get();`, which is FROZEN.
# If they do `set({ ...pushUndoState(state), document: docDirty })`, they are creating `docDirty` from the FROZEN `state.document`.
# If we change `set({ ... })` to `set((draft) => { ... Object.assign(draft, { document: docDirty }) })`, we assign the new `docDirty` to the draft. This works perfectly fine!

# We need to find `set({ \s* \.\.\.pushUndoState\(state\), \s* ([\s\S]*?) \s* });`
def replace_set(match):
    props = match.group(1).strip()
    return f"""set((draft) => {{
      const undoState = pushUndoState(draft);
      draft.undoStack = undoState.undoStack;
      draft.redoStack = undoState.redoStack;
      if (Object.keys({{{props}}}).length > 0) {{
        Object.assign(draft, {{{props}}});
      }}
    }});"""

code = re.sub(r'set\(\{\s*\.\.\.pushUndoState\(state\),?\s*([\s\S]*?)\s*\}\);', replace_set, code)
code = re.sub(r'set\(\{\s*\.\.\.pushUndoState\(state\)\s*\}\)', 'set((draft) => { const undoState = pushUndoState(draft); draft.undoStack = undoState.undoStack; draft.redoStack = undoState.redoStack; })', code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


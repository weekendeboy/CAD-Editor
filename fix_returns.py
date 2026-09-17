import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# We want to replace:
# return {
#   ...pushUndoState(state),
#   <other_props>
# };
# 
# With:
# const undoState = pushUndoState(state);
# state.undoStack = undoState.undoStack;
# state.redoStack = undoState.redoStack;
# Object.assign(state, { <other_props> });

def replace_return(match):
    props = match.group(1).strip()
    return f"""const undoState = pushUndoState(state);
      state.undoStack = undoState.undoStack;
      state.redoStack = undoState.redoStack;
      if (Object.keys({{{props}}}).length > 0) {{
        Object.assign(state, {{{props}}});
      }}"""

code = re.sub(r'return\s*\{\s*\.\.\.pushUndoState\(state\),?\s*([\s\S]*?)\s*\};', replace_return, code)
code = re.sub(r'return\s*\{\s*\.\.\.pushUndoState\(state\)\s*\};', 'const undoState = pushUndoState(state); state.undoStack = undoState.undoStack; state.redoStack = undoState.redoStack;', code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


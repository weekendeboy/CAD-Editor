const fs = require('fs');

let content = fs.readFileSync('src/store/cadStore.ts', 'utf-8');

// We have many actions like:
// someAction: (...) => {
//   const state = get();
//   ...
//   set({
//      ...pushUndoState(state),
//      document: ...
//   });
// }

// Let's replace the whole set({ ...pushUndoState(state), ... }) with:
// const undoState = pushUndoState(state);
// state.undoStack = undoState.undoStack;
// state.redoStack = undoState.redoStack;
// Object.assign(state, { whatever_was_in_set }); // or just assign individually

// But wait, it's easier to just do regex or AST transform.

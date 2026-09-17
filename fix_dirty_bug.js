const fs = require('fs');
let code = fs.readFileSync('src/store/cadStore.ts', 'utf8');

const regex = /markSketchDirtyInDoc\(state\.document,\s*state\.activeSketchId\);\s*const undoState = pushUndoState\(state\);\s*state\.undoStack = undoState\.undoStack;\s*state\.redoStack = undoState\.redoStack;/g;

const replacement = `const docDirty = markSketchDirtyInDoc(state.document, state.activeSketchId);

    const undoState = pushUndoState(state);
    state.undoStack = undoState.undoStack;
    state.redoStack = undoState.redoStack;
    state.document = docDirty;`;

const newCode = code.replace(regex, replacement);
fs.writeFileSync('src/store/cadStore.ts', newCode);
console.log('Fixed instances:', (code.match(regex) || []).length);

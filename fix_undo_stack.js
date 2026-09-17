const fs = require('fs');
let code = fs.readFileSync('src/store/cadStore.ts', 'utf8');

// The pattern to look for is inside `set((state) => { ... })`
// We will look for pushUndoState calls and move them up.

// Wait, the easiest way is to use regex. But since it's a bit complex,
// maybe we can just do a regex replace on the specific blocks:
// First, remove all pushUndoState blocks.
// Wait, no, we need to insert it right before the first mutation.
// Let's print out the occurrences.

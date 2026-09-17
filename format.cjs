const fs = require('fs');

let code = fs.readFileSync('src/store/cadStore.ts', 'utf-8');
const prettier = require('prettier');

async function run() {
    try {
        const formatted = await prettier.format(code, { parser: "typescript" });
        console.log("Prettier formatted successfully!");
    } catch (e) {
        console.error("Syntax Error at:", e.message);
    }
}
run();

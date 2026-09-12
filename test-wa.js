try {
  WebAssembly.instantiate(new Uint8Array(0));
} catch (e) {
  console.log("Zero len:", e.message);
}
try {
  WebAssembly.instantiate(new TextEncoder().encode("<!DOCTYPE html>"));
} catch (e) {
  console.log("HTML len:", e.message);
}

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

code = code.replace("  setSelectedFaceInfo: (face) => {\n    set({ selectedFaceInfo: face }),", "  setSelectedFaceInfo: (face) => set((state) => { state.selectedFaceInfo = face; }),")

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)

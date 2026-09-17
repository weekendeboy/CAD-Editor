with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

code = code.replace(
    '  toggleShow3DEdges: () => {\n    set((state) => { state.show3DEdges = !state.show3DEdges; }),',
    '  toggleShow3DEdges: () => set((state) => { state.show3DEdges = !state.show3DEdges; }),'
)

code = code.replace(
"""
    });

    },
  removeFeature: (id) => set((state) => {
""",
"""
    });
  },
  removeFeature: (id) => set((state) => {
"""
)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


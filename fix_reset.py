with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

code = code.replace("      kernelDiagnostics: [],\n    }),\n})));", "      kernelDiagnostics: [],\n    });\n  },\n})));")

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


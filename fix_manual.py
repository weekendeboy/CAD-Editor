import re
with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

# Fix addFeature
code = code.replace("    });\n\n    },\n\n  removeFeature", "  }),\n\n  removeFeature")

# Fix line 396: removeFeature closing
code = code.replace("      activeSketchId: nextActiveSketchId,});\n\n\n    },\n\n  updateFeature", "      activeSketchId: nextActiveSketchId,});\n    get().regenerateFeatureTree();\n  },\n\n  updateFeature")
# Wait, removeFeature ends with `activeSketchId: nextActiveSketchId,});\n\n\n    },`? Let me just use regex!

code = re.sub(r'\}\);\s*\}\,', r'}),', code)

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


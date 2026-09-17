import re

with open('src/store/cadStore.ts', 'r') as f:
    code = f.read()

code = code.replace('}); },', '}),')

with open('src/store/cadStore.ts', 'w') as f:
    f.write(code)


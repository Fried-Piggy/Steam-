import json, re

games = json.load(open('steam-library-2026-06-09 (1).json', 'r', encoding='utf-8'))
named = [g for g in games if not g['name'].startswith('Game ')]

# Use indented JSON — safe for embedding in JS (all special chars properly escaped)
indented = json.dumps(named, ensure_ascii=False, indent=2)

html = open('index.html', 'r', encoding='utf-8').read()
html = re.sub(r'const DEFAULT_GAMES = \[[\s\S]*?\n\];', f'const DEFAULT_GAMES = {indented};\n', html, count=1)
open('index.html', 'w', encoding='utf-8').write(html)
print(f'Done: {len(named)} games embedded')

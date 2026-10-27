with open('index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if 'const DEFAULT_GAMES' in line:
        print(f'Line {i+1}: length={len(line)}')
        # Count literal newlines
        cnt = line.count('\n')
        cnt_r = line.count('\r')
        print(f'Literal NL count: {cnt}, CR count: {cnt_r}')
        # Check if the line looks like valid JS
        if line.strip().startswith('const DEFAULT_GAMES') and line.strip().endswith(';'):
            print('Looks like valid single-line JS assignment')
        else:
            print('MIGHT BE BROKEN: does not start/end as expected')
            print(f'Starts with: {repr(line[:60])}')
            print(f'Ends with: {repr(line[-60:])}')
        break

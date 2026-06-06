import requests, json

r = requests.get(
    'https://api.sleeper.app/projections/nfl/2026/1'
    '?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE',
    timeout=20
)
data = r.json()
print(f'Total players: {len(data)}')

# Show first QB, RB, WR, TE
shown = set()
for entry in data:
    pos = entry.get('position') or (entry.get('player', {}) or {}).get('position', '')
    pid = entry.get('player_id') or entry.get('id', '')
    name = (entry.get('player') or {}).get('full_name', pid) if isinstance(entry.get('player'), dict) else str(pid)
    stats = entry.get('stats', {})

    if pos not in shown and pos in ('QB','RB','WR','TE'):
        shown.add(pos)
        print(f'\n--- {pos}: {name} (id={pid}) ---')
        # Show all stat keys
        for k, v in stats.items():
            if v and v != 0:
                print(f'  {k}: {v}')

    if len(shown) == 4:
        break

# Check stat key names specifically
print('\n\nStat keys with passing/rushing/receiving data:')
for entry in data[:50]:
    stats = entry.get('stats', {})
    has_pass = any(k.startswith('pass') for k in stats)
    has_rush = any(k.startswith('rush') for k in stats)
    has_rec  = any(k.startswith('rec') for k in stats)
    if has_pass or has_rush or has_rec:
        name = (entry.get('player') or {}).get('full_name', entry.get('player_id','?'))
        pos = entry.get('position','?')
        pass_yd = stats.get('pass_yd', stats.get('pass_yds', 0))
        rush_yd = stats.get('rush_yd', stats.get('rush_yds', 0))
        rec_yd  = stats.get('rec_yd',  stats.get('rec_yds',  0))
        rec     = stats.get('rec', 0)
        pass_td = stats.get('pass_td', stats.get('pass_tds', 0))
        rush_td = stats.get('rush_td', stats.get('rush_tds', 0))
        rec_td  = stats.get('rec_td',  stats.get('rec_tds',  0))
        pts     = stats.get('pts_ppr', 0)
        print(f'  [{pos}] {str(name)[:22]:22} pass_yd={pass_yd} rush_yd={rush_yd} rec={rec} rec_yd={rec_yd} pts_ppr={pts}')
        break

print('\n\nRaw keys in first entry with nonzero values:')
for entry in data[:5]:
    stats = entry.get('stats', {})
    nonzero = {k: v for k, v in stats.items() if v}
    if nonzero:
        print(list(nonzero.keys()))
        break

"""
explore_dk_api.py — Discovers DraftKings NFL season player prop endpoints.
Run: python scripts/explore_dk_api.py
No API key needed. Prints the category tree so we can find season props.
"""

import requests, json, sys

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
}

def get(url):
    r = requests.get(url, headers=HEADERS, timeout=20)
    print(f'  {r.status_code} {url[:100]}')
    if r.status_code == 200:
        return r.json()
    return None

print('\n=== Step 1: Find NFL on DraftKings ===')
data = get('https://api.draftkings.com/lineups/v1/sports')
print(json.dumps(data, indent=2)[:3000] if data else 'FAILED')

print('\n=== Step 2: NFL Event Groups (futures / season specials) ===')
# DK NFL futures are typically under sport "NFL" → eventgroup for the season
nfl_futures = get('https://api.draftkings.com/offerings/v1/eventgroups?format=json')
if nfl_futures:
    groups = nfl_futures if isinstance(nfl_futures, list) else nfl_futures.get('eventGroups', nfl_futures.get('data', []))
    for g in groups if isinstance(groups, list) else []:
        name = g.get('name', g.get('eventGroupName', ''))
        gid  = g.get('id', g.get('eventGroupId', ''))
        if 'nfl' in name.lower() or 'football' in name.lower():
            print(f'  [{gid}] {name}')

print('\n=== Step 3: Try known NFL event group IDs ===')
# Community-known DK NFL event group IDs (changes each season but ballpark range)
for eid in [88808, 88671, 88670, 42648, 42133, 9, 1, 2, 3]:
    url = f'https://api.draftkings.com/offerings/v1/eventgroups/{eid}?format=json'
    d = get(url)
    if d:
        name = d.get('eventGroupName', d.get('name', str(d)[:60]))
        print(f'  → Group {eid}: {name}')

print('\n=== Step 4: NFL categories (player props / futures) ===')
cats = get('https://api.draftkings.com/lineups/v1/sports/nfl/categories?format=json')
if cats:
    print(json.dumps(cats, indent=2)[:3000])

print('\n=== Step 5: Direct player props endpoint ===')
for path in [
    'https://api.draftkings.com/sites/US-SB/eventgroups/88808/categories/1000?format=json',
    'https://api.draftkings.com/sites/US-SB/sports/2/categories?format=json',
    'https://api.draftkings.com/sites/US-SB/sports/football/categories?format=json',
    'https://api.draftkings.com/offerings/v2/leagues/nfl/seasonProps?format=json',
    'https://api.draftkings.com/offerings/v2/leagues/nfl/playerProps?format=json',
    'https://api.draftkings.com/odds/v1/eventgroups/nfl/season?format=json',
]:
    d = get(path)
    if d:
        print(f'  Got data ({len(json.dumps(d))} bytes):')
        print(json.dumps(d, indent=2)[:1000])

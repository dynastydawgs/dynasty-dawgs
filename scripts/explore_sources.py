"""
explore_sources.py — Tests multiple sources for NFL season-long player prop lines.
Run: python scripts/explore_sources.py
"""

import requests, json, sys

H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'en-US,en;q=0.9',
}

def get(label, url, extra_headers=None):
    try:
        hdrs = {**H, **(extra_headers or {})}
        r = requests.get(url, headers=hdrs, timeout=15, allow_redirects=True)
        size = len(r.content)
        snippet = r.text[:300].replace('\n', ' ')
        print(f'  [{r.status_code}] {size:>8} bytes  {label}')
        if r.status_code == 200 and size > 200:
            print(f'           preview: {snippet[:200]}')
            return r
        return None
    except Exception as e:
        print(f'  [ERR] {label}: {e}')
        return None

print('\n' + '='*60)
print('BOVADA — offshore, typically not geofenced')
print('='*60)
get('NFL futures/specials',
    'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl-player-specials')
get('NFL season props',
    'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl-season-props')
get('NFL futures',
    'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl-futures')
get('NFL player props',
    'https://www.bovada.lv/services/sports/event/v2/events/A/description/football/nfl-player-props')

print('\n' + '='*60)
print('ACTION NETWORK — odds aggregator')
print('='*60)
get('NFL games',     'https://api.actionnetwork.com/web/v1/games?sport=NFL&limit=5')
get('NFL futures',   'https://api.actionnetwork.com/web/v1/nfl/futures')
get('NFL props',     'https://api.actionnetwork.com/web/v1/nfl/props')

print('\n' + '='*60)
print('MYBOOKIE — offshore book')
print('='*60)
get('NFL player props',
    'https://mybookie.ag/api/v1/sports/NFL/events/player-props')
get('NFL specials',
    'https://mybookie.ag/api/v1/sports/NFL/events/specials')

print('\n' + '='*60)
print('BETONLINE — offshore book')
print('='*60)
get('NFL feed',
    'https://www.betonline.ag/api/sportsbook/nfl/player-props')

print('\n' + '='*60)
print('PINNACLE — sharpest offshore book, documented API')
print('='*60)
get('Sports list',  'https://api.pinnacle.com/v1/sports', {'Authorization': 'Basic'})
get('NFL fixtures', 'https://api.pinnacle.com/v1/fixtures?sportId=889&leagueIds=236030')
get('NFL specials', 'https://api.pinnacle.com/v3/odds?sportId=889&oddsFormat=American')

print('\n' + '='*60)
print('ODDS SHARK — public aggregator')
print('='*60)
get('NFL player props', 'https://www.oddsshark.com/api/nfl/player-props')
get('NFL futures',      'https://www.oddsshark.com/api/nfl/futures')

print('\n' + '='*60)
print('VEGAS INSIDER — public aggregator')
print('='*60)
get('NFL props', 'https://www.vegasinsider.com/api/nfl/player-props/')
get('NFL futures','https://www.vegasinsider.com/api/nfl/futures/')

print('\n' + '='*60)
print('DRAFTKINGS (alternate paths)')
print('='*60)
get('DK offerings',    'https://api.dk.live/v1/sports/nfl/offers?type=season')
get('DK sportsbook v2','https://sportsbook-us-ga.draftkings.com/sites/US-GA-SB/api/v5/eventgroups/88808?format=json')
get('DK live API',     'https://api.dk.live/sports/nfl/upcoming?limit=5')
get('DK futures',      'https://sportsbook.draftkings.com/api/v5/eventgroups/nfl/categories/season-props')

print('\n' + '='*60)
print('SLEEPER projections (we already use Sleeper)')
print('='*60)
r = get('2026 season projections',
    'https://api.sleeper.app/projections/nfl/2026/1?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE')
if r and r.status_code == 200:
    try:
        d = r.json()
        sample = list(d.items())[:3] if isinstance(d, dict) else d[:3]
        print(f'  Sample: {json.dumps(sample, indent=2)[:400]}')
    except: pass

"""
fetch_props.py — Dynasty Dawgs Vegas Props Pipeline
Fetches NFL player prop lines from odds-api.io (DraftKings + FanDuel),
computes PPR PPG equivalents, and writes data/vegasprops.json.

Runs via GitHub Actions every Tuesday during the NFL season.
Off-season: exits cleanly and preserves existing data.
"""

import os
import json
import time
import requests
from datetime import datetime, timedelta, timezone

# ── Config ──────────────────────────────────────────────────────────────────
API_KEY    = os.environ.get('ODDS_API_KEY', '')
BASE_URL   = 'https://api.odds-api.io/v3'
BOOKMAKERS = 'DraftKings,FanDuel'
OUT_PATH   = 'data/vegasprops.json'

# PPR scoring weights (standard PPR, 4-pt pass TD)
PPR = {
    'pass_yds' : 0.04,   # 1 pt per 25 yds
    'pass_tds' : 4.0,
    'rush_yds' : 0.1,    # 1 pt per 10 yds
    'rush_tds' : 6.0,
    'rec'      : 1.0,    # full PPR
    'rec_yds'  : 0.1,
    'rec_tds'  : 6.0,
}

# Market name fragments → internal stat key
# odds-api.io names vary slightly; we do substring matching
MARKET_PATTERNS = {
    'pass_yds' : ['passing yards'],
    'pass_tds' : ['passing touchdown', 'passing td'],
    'rush_yds' : ['rushing yards'],
    'rush_tds' : ['rushing touchdown', 'rushing td'],
    'rec'      : ['receptions'],
    'rec_yds'  : ['receiving yards'],
    'rec_tds'  : ['receiving touchdown', 'receiving td'],
}

# NFL season anchor (update each year)
NFL_SEASON_YEAR  = 2026
NFL_SEASON_START = datetime(2026, 9, 10, tzinfo=timezone.utc)


# ── Helpers ──────────────────────────────────────────────────────────────────
def api_get(path, params=None, retries=3):
    """GET from odds-api.io with retry on 429/5xx."""
    url = f'{BASE_URL}/{path}'
    p   = {'apiKey': API_KEY, **(params or {})}
    for attempt in range(retries):
        try:
            r = requests.get(url, params=p, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get('Retry-After', 10))
                print(f'  Rate limited — waiting {wait}s…')
                time.sleep(wait)
                continue
            return r
        except requests.RequestException as e:
            print(f'  Request error (attempt {attempt+1}): {e}')
            time.sleep(3)
    return None


def classify_market(market_name):
    """Return internal stat key for a market name, or None."""
    mn = market_name.lower()
    for stat, patterns in MARKET_PATTERNS.items():
        if any(p in mn for p in patterns):
            return stat
    return None


def current_nfl_week():
    now = datetime.now(timezone.utc)
    if now < NFL_SEASON_START:
        return None   # off-season
    week = int((now - NFL_SEASON_START).days / 7) + 1
    return min(week, 18)


def compute_ppg(stats):
    """PPR PPG from averaged stat lines."""
    ppg = 0.0
    for stat, weight in PPR.items():
        ppg += stats.get(stat, 0.0) * weight
    return round(ppg, 2)


# ── Core fetch logic ─────────────────────────────────────────────────────────
def get_nfl_events():
    """Return list of upcoming NFL game events."""
    r = api_get('events', {
        'sport'      : 'american-football',
        'bookmakers' : BOOKMAKERS,
        'status'     : 'pending',
    })
    if not r or r.status_code != 200:
        print(f'Events fetch failed: {r.status_code if r else "no response"}')
        return []

    all_events = r.json() if isinstance(r.json(), list) else []

    # Filter: league name or slug must contain 'nfl'
    nfl = [
        e for e in all_events
        if 'nfl' in e.get('league', {}).get('name',  '').lower() or
           'nfl' in e.get('league', {}).get('slug',  '').lower()
    ]

    print(f'Found {len(nfl)} NFL events (of {len(all_events)} american-football events)')
    return nfl


def get_props_for_event(event_id):
    """Return raw odds payload for one event."""
    r = api_get('odds', {'eventId': event_id, 'bookmakers': BOOKMAKERS})
    if not r or r.status_code != 200:
        print(f'  Props fetch failed for event {event_id}: {r.status_code if r else "no response"}')
        return None
    return r.json()


def extract_player_stats(event_data):
    """
    Parse bookmaker markets → dict of:
      player_name → { stat_key → [line_book1, line_book2, …] }
    """
    players = {}
    for bookmaker, markets in event_data.get('bookmakers', {}).items():
        for market in markets:
            stat = classify_market(market.get('name', ''))
            if stat is None:
                continue
            for entry in market.get('odds', []):
                name = entry.get('label', '').strip()
                line = entry.get('hdp')
                if not name or line is None:
                    continue
                players.setdefault(name, {}).setdefault(stat, []).append(float(line))
    return players


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    if not API_KEY:
        print('ERROR: ODDS_API_KEY environment variable not set.')
        return

    week = current_nfl_week()
    now  = datetime.now(timezone.utc)

    print(f'Dynasty Dawgs — Vegas Props Fetch')
    print(f'Time : {now.isoformat()}')
    print(f'Week : {week if week else "off-season"}')
    print()

    # ── Load existing data (preserve bye-week players) ──
    existing_players = {}
    try:
        with open(OUT_PATH) as f:
            existing_players = json.load(f).get('players', {})
        print(f'Loaded {len(existing_players)} players from existing {OUT_PATH}')
    except (FileNotFoundError, json.JSONDecodeError):
        print(f'No existing {OUT_PATH} — starting fresh')

    # ── Off-season guard ──
    events = get_nfl_events()
    if not events:
        print()
        print('No NFL events found — likely off-season or lines not yet posted.')
        print('Preserving existing data unchanged. Exiting.')
        return

    # ── Fetch props for every game this week ──
    week_players = {}   # merged across all games
    for event in events:
        eid  = event['id']
        home = event.get('home', '?')
        away = event.get('away', '?')
        print(f'  Fetching: {away} @ {home}  (id={eid})')

        data = get_props_for_event(eid)
        if not data:
            continue

        game_players = extract_player_stats(data)
        print(f'    → {len(game_players)} players with props')

        for name, stats in game_players.items():
            week_players[name] = stats

        time.sleep(0.25)   # gentle rate limiting

    if not week_players:
        print()
        print('No player props returned for any game. Exiting without update.')
        return

    # ── Build output: average lines across books, compute PPG ──
    # Start from existing (bye-week players keep last week's line)
    output_players = dict(existing_players)

    updated_count = 0
    for name, stats in week_players.items():
        averaged = {stat: round(sum(lines) / len(lines), 1)
                    for stat, lines in stats.items()}
        ppg = compute_ppg(averaged)

        output_players[name] = {
            **averaged,
            'ppg'     : ppg,
            'updated' : now.strftime('%Y-%m-%d'),
        }
        updated_count += 1

    # ── Write JSON ──
    os.makedirs('data', exist_ok=True)
    output = {
        'meta': {
            'season'      : NFL_SEASON_YEAR,
            'week'        : week,
            'updatedAt'   : now.isoformat(),
            'playerCount' : len(output_players),
            'updatedCount': updated_count,
            'books'       : ['DraftKings', 'FanDuel'],
        },
        'players': output_players,
    }

    with open(OUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)

    print()
    print(f'Done — {updated_count} players updated, {len(output_players)} total in {OUT_PATH}')


if __name__ == '__main__':
    main()

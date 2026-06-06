"""
scrape_props_local.py — Dynasty Dawgs Local Season Props Scraper
Reads player prop lines directly from the rendered page text.
No network interception needed — if it's visible on screen, we capture it.

Run:
    pip install playwright
    playwright install chromium
    python scripts/scrape_props_local.py
"""

import json, re, sys, time, pathlib
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

# ── PPR scoring ──────────────────────────────────────────────────────────────
PPR = dict(pass_yds=0.04, pass_tds=4.0, rush_yds=0.1, rush_tds=6.0,
           rec=1.0, rec_yds=0.1, rec_tds=6.0)

SEASON_SECTIONS = {
    'pass_yds': ['regular season passing yards', 'passing yards'],
    'pass_tds': ['regular season passing touchdowns', 'passing touchdowns', 'passing tds'],
    'rush_yds': ['regular season rushing yards', 'rushing yards'],
    'rush_tds': ['regular season rushing touchdowns', 'rushing touchdowns', 'rushing tds'],
    'rec_yds':  ['regular season receiving yards', 'receiving yards'],
    'rec_tds':  ['regular season receiving touchdowns', 'receiving touchdowns', 'receiving tds'],
    'rec':      ['regular season receptions', 'receptions'],
}

def compute_ppg(stats):
    # Stats are season totals — divide by 17 to get per-game rate, then apply PPR weights
    return round(sum(stats.get(k, 0) / 17 * w for k, w in PPR.items()), 2)

def detect_section(line_lower):
    for stat, keywords in SEASON_SECTIONS.items():
        if any(kw in line_lower for kw in keywords):
            return stat
    return None

def parse_page_text(text):
    """
    Parse the full visible text of the FanDuel page.
    Finds patterns like:
      'Aaron Rodgers Over 3025.5'
      'Baker Mayfield Under 3500.5'
    grouped by which section they appear under.
    """
    players = {}
    lines   = [l.strip() for l in text.splitlines() if l.strip()]

    current_stat = None

    for line in lines:
        ll = line.lower()

        # Detect section header
        stat = detect_section(ll)
        if stat:
            current_stat = stat
            print(f'  Section → {stat}: "{line[:60]}"')
            continue

        if not current_stat:
            continue

        # Match: "Player Name Over 1234.5" or "Player Name Under 1234.5"
        m = re.match(r'^(.+?)\s+(over|under)\s+(\d+\.?\d*)\s*$', line, re.I)
        if m:
            player_name = m.group(1).strip()
            direction   = m.group(2).lower()
            value       = float(m.group(3))

            # Skip entries that look like team names or garbage
            if len(player_name) < 4 or len(player_name) > 50:
                continue
            # Only use the Over line (it's the handicap value; Under is the same number)
            if direction == 'over':
                players.setdefault(player_name, {})
                players[player_name].setdefault(current_stat, []).append(value)
                print(f'    ✓ {player_name}: {current_stat} = {value}')

    return players

def scrape_fanduel(page):
    print('\n=== FanDuel Season Player Props ===')
    url = 'https://sportsbook.fanduel.com/navigation/nfl?tab=player-props'
    print(f'  Loading {url}')

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=60000)
    except Exception as e:
        print(f'  Nav timeout (continuing): {str(e)[:60]}')

    print('  Waiting for page to settle...')
    time.sleep(4)

    print()
    print('  ============================================================')
    print('  ACTION REQUIRED:')
    print('  In the browser window, manually scroll through ALL sections:')
    print('    - Regular Season Passing Yards')
    print('    - Regular Season Rushing Yards')
    print('    - Regular Season Receiving Yards')
    print('    - Regular Season Touchdowns')
    print('    - Regular Season Receptions')
    print()
    print('  Scroll slowly so each section fully loads.')
    print('  When you have scrolled through everything, come back here')
    print('  and press ENTER to capture the data.')
    print('  ============================================================')
    input()

    # Read all visible text from the page
    print('  Reading page text...')
    text = page.inner_text('body')
    print(f'  Page text length: {len(text)} chars')

    # Save raw text for debugging
    debug_path = pathlib.Path(__file__).parent.parent / 'data' / 'fanduel_page_text.txt'
    debug_path.write_text(text, encoding='utf-8')
    print(f'  Raw text saved to data/fanduel_page_text.txt')

    players = parse_page_text(text)
    print(f'\n  Players found: {len(players)}')
    return players

def main():
    print('Dynasty Dawgs — Season Props Scraper (DOM text reader)')
    print(f'Time: {datetime.now(timezone.utc).isoformat()}\n')

    all_players = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
        )
        ctx = browser.new_context(
            viewport={'width': 1440, 'height': 900},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale='en-US',
            timezone_id='America/New_York',
            geolocation={'latitude': 40.7128, 'longitude': -74.0060},
            permissions=['geolocation'],
        )
        ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )

        page = ctx.new_page()
        fd_players = scrape_fanduel(page)
        for name, stats in fd_players.items():
            all_players.setdefault(name, {})
            for stat, lines in stats.items():
                all_players[name].setdefault(stat, []).extend(lines)

        browser.close()

    total = len(all_players)
    print(f'\nTotal players: {total}')

    if not total:
        print('\nNo players found.')
        print('Check data/fanduel_page_text.txt — does it contain player prop lines?')
        print('If so, paste the first 50 lines here and we will fix the parser.')
        sys.exit(0)

    # Build output
    out = {}
    for name, stats in all_players.items():
        avg = {s: round(sum(ls)/len(ls), 1) for s, ls in stats.items()}
        out[name] = {**avg, 'ppg': compute_ppg(avg),
                     'updated': datetime.now().strftime('%Y-%m-%d')}

    sorted_out = dict(sorted(out.items(), key=lambda x: x[1]['ppg'], reverse=True))

    now       = datetime.now(timezone.utc)
    nfl_start = datetime(2026, 9, 10, tzinfo=timezone.utc)
    week_num  = min(18, int((now - nfl_start).days / 7) + 1) if now >= nfl_start else None

    out_path = pathlib.Path(__file__).parent.parent / 'data' / 'vegasprops.json'
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps({
        'meta': {
            'season': 2026, 'week': week_num, 'type': 'season-long',
            'updatedAt': now.isoformat(),
            'playerCount': len(sorted_out),
            'books': ['FanDuel'],
        },
        'players': sorted_out,
    }, indent=2))

    print('\nTop 10 by PPG:')
    for i, (name, p) in enumerate(list(sorted_out.items())[:10], 1):
        print(f'  {i:2}. {name:<24} {p["ppg"]:.1f} PPG')

    print(f'\nSaved → data/vegasprops.json')
    print('\nNow run:')
    print('  git add data/vegasprops.json')
    print('  git commit -m "update: 2026 season player props"')
    print('  git push')

if __name__ == '__main__':
    main()

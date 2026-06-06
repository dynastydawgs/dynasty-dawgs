"""
scrape_props_local.py — Dynasty Dawgs FanDuel Season Props Scraper
Auto-scrolls the page, then auto-clicks every collapsed player accordion
to reveal Over/Under lines. No manual scrolling or clicking needed.

Run:
    python scripts/scrape_props_local.py
"""

import json, re, sys, time, pathlib
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

# ── FanDuel URL ───────────────────────────────────────────────────────────────
FD_URL = 'https://sportsbook.fanduel.com/navigation/nfl?tab=player-props'

# ── Stat section keywords (matched against page section headers) ──────────────
SEASON_SECTIONS = {
    'pass_yds': ['regular season passing yards', 'passing yards'],
    'pass_tds': ['regular season passing touchdowns', 'passing touchdowns', 'passing tds'],
    'rush_yds': ['regular season rushing yards', 'rushing yards'],
    'rush_tds': ['regular season rushing touchdowns', 'rushing touchdowns', 'rushing tds'],
    'rec_yds':  ['regular season receiving yards', 'receiving yards'],
    'rec_tds':  ['regular season receiving touchdowns', 'receiving touchdowns', 'receiving tds'],
    'rec':      ['regular season receptions', 'receptions'],
}

# ── Garbage filter ────────────────────────────────────────────────────────────
BAD_WORDS_FD = [
    'office', 'jersey', 'boston', 'hoboken', 'london', 'soho',
    'sportsbook', 'fanduel', 'parlay', 'gaming', 'responsible',
    'casino', 'racing', 'support', 'service', 'center', 'network',
    'lottery', 'rewards', 'predictions', 'pools', 'social',
    'betslip', 'wager', 'moneyline', 'futures', 'teaser',
    'division', 'conference', 'national', 'american', 'super bowl',
    'sign up', 'log in', 'how to', 'view all', 'more bets',
]

def looks_like_player(name):
    name = name.strip()
    if len(name) < 5 or len(name) > 42:
        return False
    parts = name.split()
    if len(parts) < 2:
        return False
    if not all(p[0].isupper() for p in parts if p):
        return False
    nl = name.lower()
    if any(bw in nl for bw in BAD_WORDS_FD):
        return False
    # Reject all-caps nav words (NFL, PPG, etc.)
    if any(p.isupper() and len(p) > 2 for p in parts):
        return False
    return True

# ── Auto-scroll ───────────────────────────────────────────────────────────────
def auto_scroll(page, pause=0.9):
    """Scroll from top to bottom slowly so lazy-loaded content renders."""
    print('  Auto-scrolling to load all sections...')
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(1.5)
    step = 0
    while True:
        step += 1
        page.evaluate('window.scrollBy(0, 600)')
        time.sleep(pause)
        pos    = page.evaluate('window.scrollY + window.innerHeight')
        height = page.evaluate('document.body.scrollHeight')
        if pos >= height - 100 and step > 5:
            print(f'  Reached bottom ({step} steps).')
            break
        if step > 500:
            print(f'  Scroll cap hit.')
            break
    time.sleep(1.5)
    # Scroll back to top so accordion clicks start from the top
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(1)

# ── Auto-click accordions ─────────────────────────────────────────────────────
def expand_all_accordions(page):
    """
    Click every collapsed accordion row (aria-expanded=false) to reveal
    the Over/Under lines for each player. Repeats until none remain.
    """
    for round_num in range(1, 12):
        els = page.query_selector_all('[aria-expanded="false"]')
        if not els:
            print(f'  ✓ All accordions expanded (finished in {round_num - 1} round(s)).')
            break
        print(f'  Round {round_num}: clicking {len(els)} collapsed rows...')
        for el in els:
            try:
                el.scroll_into_view_if_needed()
                el.click()
                time.sleep(0.07)   # small delay so animations don't stack up
            except Exception:
                pass
        time.sleep(1.5)   # let newly-revealed content render
    else:
        print('  Warning: still collapsed rows remaining after max rounds.')

# ── Parser ────────────────────────────────────────────────────────────────────
def detect_section(line_lower):
    for stat, keywords in SEASON_SECTIONS.items():
        if any(kw in line_lower for kw in keywords):
            return stat
    return None

def parse_page_text(text, label=''):
    """
    Parse rendered page text. Looks for lines like:
        'Aaron Rodgers Over 3025.5'
        'Baker Mayfield Under 3500.5'
    grouped under their stat section header.
    """
    players = {}
    lines   = [l.strip() for l in text.splitlines() if l.strip()]
    current_stat = None

    for line in lines:
        ll = line.lower()

        stat = detect_section(ll)
        if stat:
            current_stat = stat
            print(f'  Section → {stat}: "{line[:70]}"')
            continue

        if not current_stat:
            continue

        m = re.match(r'^(.+?)\s+(over|under)\s+(\d+\.?\d*)\s*$', line, re.I)
        if m:
            player_name = m.group(1).strip()
            direction   = m.group(2).lower()
            value       = float(m.group(3))

            if not looks_like_player(player_name):
                continue
            if direction == 'over':
                players.setdefault(player_name, {})
                players[player_name].setdefault(current_stat, []).append(value)
                print(f'    ✓ {player_name}: {current_stat} = {value}')

    return players

# ── Main scrape function ──────────────────────────────────────────────────────
def scrape_fanduel(page):
    print('\n=== FanDuel Season Player Props ===')
    print(f'  Loading {FD_URL}')

    try:
        page.goto(FD_URL, wait_until='domcontentloaded', timeout=60000)
    except Exception as e:
        print(f'  Nav timeout (continuing): {str(e)[:80]}')

    time.sleep(4)

    print()
    print('  ──────────────────────────────────────────────────────────')
    print('  If FanDuel shows a CAPTCHA or location prompt, handle it')
    print('  in the browser window now. Then press ENTER to continue.')
    print('  (If the page looks fine, just press ENTER immediately.)')
    print('  ──────────────────────────────────────────────────────────')
    input()

    # 1. Auto-scroll to trigger lazy loading of all prop sections
    auto_scroll(page)

    # 2. Auto-click every collapsed player accordion
    print()
    print('  Expanding player rows...')
    expand_all_accordions(page)

    # 3. One more scroll pass to catch anything that lazy-loaded after clicks
    print()
    print('  Final scroll pass...')
    auto_scroll(page)

    # 4. One more accordion pass in case new rows appeared
    els_remaining = page.query_selector_all('[aria-expanded="false"]')
    if els_remaining:
        print(f'  Clicking {len(els_remaining)} newly-loaded collapsed rows...')
        expand_all_accordions(page)

    # 5. Read the full rendered page text
    print()
    print('  Reading page text...')
    text = page.inner_text('body')
    print(f'  Page text: {len(text):,} chars')

    debug_path = pathlib.Path(__file__).parent.parent / 'data' / 'fanduel_page_text.txt'
    debug_path.write_text(text, encoding='utf-8')
    print(f'  Raw text saved → data/fanduel_page_text.txt')

    players = parse_page_text(text)
    print(f'\n  Players found: {len(players)}')
    return players

# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    print('Dynasty Dawgs — FanDuel Season Props Scraper')
    print(f'Time: {datetime.now(timezone.utc).isoformat()}\n')

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=['--disable-blink-features=AutomationControlled',
                  '--window-size=1440,900', '--start-maximized'],
        )
        ctx = browser.new_context(
            viewport={'width': 1440, 'height': 900},
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            ),
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
        browser.close()

    if not fd_players:
        print('\nNo players found.')
        print('Check data/fanduel_page_text.txt for clues.')
        sys.exit(0)

    # Build and save output
    out = {}
    for name, stats in fd_players.items():
        avg = {s: round(sum(ls) / len(ls), 1) for s, ls in stats.items()}
        out[name] = {**avg, 'updated': datetime.now().strftime('%Y-%m-%d')}

    sorted_out = dict(sorted(out.items()))

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

    print(f'\nTotal: {len(sorted_out)} players saved → data/vegasprops.json')
    print('\nNext: run DraftKings scraper to merge DK lines in:')
    print('  python scripts/scrape_dk_props.py')

if __name__ == '__main__':
    main()

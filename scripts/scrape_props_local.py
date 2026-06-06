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

# Stat label → DOM row label (what FanDuel shows in the accordion header text)
STAT_LABELS = {
    'pass_yds': 'Regular Season Passing Yards',
    'pass_tds': 'Regular Season Passing TDs',
    'rush_yds': 'Regular Season Rushing Yards',
    'rush_tds': 'Regular Season Rushing TDs',
    'rec_yds':  'Regular Season Receiving Yards',
    'rec_tds':  'Regular Season Receiving TDs',
    'rec':      'Regular Season Receptions',
}

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
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(1)

# ── Find collapsed rows ───────────────────────────────────────────────────────
def find_collapsed_rows(text):
    """
    Parse visible page text. Return list of (stat, player_name, full_row_text)
    for rows that have a header but no Over/Under value following them.
    """
    lines   = [l.strip() for l in text.splitlines() if l.strip()]
    n       = len(lines)
    found   = []

    for i, line in enumerate(lines):
        for stat, label in STAT_LABELS.items():
            if label not in line or '2026-27' not in line:
                continue
            player = line.replace(f' {label} 2026-27', '').strip()
            if not looks_like_player(player):
                break
            # Look at the next 3 lines for an Over/Under value
            next_lines = lines[i+1 : i+4]
            has_value  = any(
                re.match(r'^(Over|Under)\s+[\d.]+', nl, re.I) or
                re.match(rf'^{re.escape(player)}\s+(Over|Under)\s+[\d.]+', nl, re.I)
                for nl in next_lines
            )
            if not has_value:
                found.append((stat, player, line))
            break

    return found

# ── Click collapsed rows via Playwright native click ─────────────────────────
def click_collapsed_rows(page, collapsed):
    """
    Click each collapsed accordion row using Playwright's native .click(),
    which goes through CDP and produces isTrusted=true events.
    JavaScript's dispatchEvent produces isTrusted=false, which React ignores.
    """
    clicked = 0
    skipped = 0

    for stat, player, row_text in collapsed:
        loc = None
        try:
            # 1. Best shot: find a <button> that contains the row text
            loc = page.locator('button').filter(has_text=re.compile(re.escape(row_text)))
            if loc.count() == 0:
                # 2. Try [role="button"]
                loc = page.locator('[role="button"]').filter(
                    has_text=re.compile(re.escape(row_text)))
            if loc.count() == 0:
                # 3. Any element whose visible text is exactly this string
                loc = page.get_by_text(row_text, exact=True)
            if loc.count() == 0:
                # 4. Looser: any element containing the text
                loc = page.get_by_text(row_text, exact=False)

            if loc.count() > 0:
                loc.first.scroll_into_view_if_needed()
                loc.first.click(timeout=3000)
                time.sleep(0.07)
                clicked += 1
            else:
                skipped += 1

        except Exception as e:
            skipped += 1

    if skipped:
        print(f'    ⚠ {skipped} rows had no clickable element')
    return clicked

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
    print('  now.  Then press ENTER to start automated scraping.')
    print('  (If the page looks fine, just press ENTER immediately.)')
    print('  ──────────────────────────────────────────────────────────')
    input()

    # ── Pass 1: scroll to load all lazy sections ──────────────────────────────
    auto_scroll(page)

    # ── Pass 2: read visible text; find + click collapsed rows ────────────────
    max_rounds = 5
    for rnd in range(1, max_rounds + 1):
        text      = page.inner_text('body')
        collapsed = find_collapsed_rows(text)

        if not collapsed:
            print(f'  ✓ All rows expanded after {rnd - 1} round(s).')
            break

        print(f'  Round {rnd}: {len(collapsed)} collapsed rows → clicking...')
        n_clicked = click_collapsed_rows(page, collapsed)
        print(f'    Clicked {n_clicked} row(s)')

        if n_clicked == 0:
            print('  ⚠ Could not click any rows. First 5 still collapsed:')
            for stat, player, rt in collapsed[:5]:
                print(f'    [{stat}] {rt}')
            break

        time.sleep(3.5)   # wait for React re-render + any animation
    else:
        remaining = find_collapsed_rows(page.inner_text('body'))
        print(f'  ⚠ {len(remaining)} rows still collapsed after {max_rounds} rounds.')

    # ── Final read ────────────────────────────────────────────────────────────
    print()
    print('  Reading final page text...')
    text = page.inner_text('body')
    print(f'  Page text: {len(text):,} chars')

    debug_path = pathlib.Path(__file__).parent.parent / 'data' / 'fanduel_page_text.txt'
    debug_path.write_text(text, encoding='utf-8')
    print(f'  Raw text saved → data/fanduel_page_text.txt')

    players = parse_page_text(text)
    print(f'\n  Players captured: {len(players)}')
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

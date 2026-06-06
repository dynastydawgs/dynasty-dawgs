"""
scrape_dk_props.py — Dynasty Dawgs DraftKings Season Props Scraper
Auto-scrolls each page and advances automatically. No user input needed.
Merges results with existing vegasprops.json (averages FD + DK lines).

Run:
    python scripts/scrape_dk_props.py
"""

import json, re, sys, time, pathlib
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

# ── PPR scoring ──────────────────────────────────────────────────────────────
PPR = dict(pass_yds=0.04, pass_tds=4.0, rush_yds=0.1, rush_tds=6.0,
           rec=1.0, rec_yds=0.1, rec_tds=6.0)

def compute_ppg(stats):
    return round(sum(stats.get(k, 0) / 17 * w for k, w in PPR.items()), 2)

# ── Pages to scrape (O/U only — clean handicap lines) ───────────────────────
DK_PAGES = [
    ('pass_yds', 'player-stats-o-u', 'pass-yards',  'Passing Yards O/U'),
    ('pass_tds', 'player-stats-o-u', 'pass-tds',    'Passing TDs O/U'),
    ('rush_yds', 'player-stats-o-u', 'rush-yards',  'Rushing Yards O/U'),
    ('rush_tds', 'player-stats-o-u', 'rush-tds',    'Rushing TDs O/U'),
    ('rec_yds',  'player-stats-o-u', 'rec-yards',   'Receiving Yards O/U'),
    ('rec_tds',  'player-stats-o-u', 'rec-tds',     'Receiving TDs O/U'),
    ('rec',      'player-milestones','rec-yards',    'Receptions (milestones)'),
]

BASE = 'https://sportsbook.draftkings.com/leagues/football/nfl'

def make_url(subcategory, nav):
    return f'{BASE}?category=futures&subcategory={subcategory}&nav_1={nav}'

# ── Parser ───────────────────────────────────────────────────────────────────
PLAYER_RE = re.compile(r"^[A-Z][a-z''\.\-]+(?:\s+[A-Z][a-z''\.\-]+){1,2}$")

# Stat-specific valid handicap ranges — keeps random page numbers from matching
STAT_RANGES = {
    'pass_yds': (1500, 6500),
    'pass_tds': (5,    60),
    'rush_yds': (200,  2500),
    'rush_tds': (1,    22),
    'rec_yds':  (200,  2000),
    'rec_tds':  (1,    20),
    'rec':      (10,   150),
}

# Words that appear in player names but are NOT NFL players
BAD_WORDS = [
    'Over','Under','Parlay','DraftKings','Sportsbook','More Wagers',
    'Futures','Player','Season','Regular','Super Bowl','Conference',
    'Division','National','American','Same Game','SGP','Rookie',
    'Milestones','Matchups','Specials','View All','Log In','Sign Up',
    'How To','Responsible','Gaming','Office','Support','Service','Center',
    'Network','Casino','Racing','Lottery','Predictions','Pools','Social',
    'Rewards','Betting','Spread','Moneyline','Parlay','Teaser',
    # US states / cities that appear in DK footer links
    'Jersey','York','Angeles','Francisco','Chicago','Vegas','Texas',
    'Florida','Ohio','Carolina','England','Orleans','Minnesota',
    'Seattle','Denver','Baltimore','Pittsburgh','Indianapolis',
    'Tennessee','Arizona','Colorado','Michigan','Virginia','Iowa',
    'Wyoming','Illinois','Louisiana','Kansas','Maryland','Oregon',
    'Massachusetts','Connecticut','Washington','Pennsylvania',
]

def looks_like_player(s):
    s = s.strip()
    # Must match "Firstname Lastname" or "Firstname M. Lastname" — all capitalized words
    if not PLAYER_RE.match(s): return False
    if len(s) < 6 or len(s) > 42: return False
    sl = s.lower()
    return not any(b.lower() in sl for b in BAD_WORDS)

def parse_number(s, stat=None):
    s = s.strip().replace(',', '').replace('−', '-').replace('–', '-')
    # Skip odds lines (always start with + or -)
    if s.startswith('+') or s.startswith('-'): return None
    try:
        v = float(s)
        lo, hi = STAT_RANGES.get(stat, (0.5, 9000))
        if lo <= v <= hi: return v
    except ValueError: pass
    return None

def parse_ou_text(text, stat, label):
    """
    DraftKings O/U format (confirmed):
        NFL 2026/27 - Tyler Shough
        Sun Sep 13th 11:00 AM
        NFL 2026/27 - Tyler Shough Regular Season Passing Yards
        Over 3649.5
        −110
        Under 3649.5
        −110

    Strategy: extract player name from 'NFL 2026/27 - Name ...' lines,
    capture handicap from 'Over X.X' lines. No guessing needed.
    """
    players = {}
    lines   = [l.strip() for l in text.splitlines() if l.strip()]

    current_player = None

    for line in lines:
        # ── Detect player from "NFL 2026/27 - Name [Regular Season ...]" ──
        m = re.match(r'^NFL\s+2026/27\s*[-–]\s*(.+)$', line, re.I)
        if m:
            raw = m.group(1).strip()
            # Strip trailing stat description ("Regular Season Passing Yards" etc.)
            name = re.sub(r'\s+Regular Season\b.*$', '', raw, flags=re.I).strip()
            name = re.sub(r'\s+(Passing|Rushing|Receiving)\b.*$', '', name, flags=re.I).strip()
            # Valid if no digits and reasonable length
            if 3 < len(name) < 50 and not re.search(r'\d', name):
                current_player = name
            continue

        # ── Capture handicap from "Over X.X" line ──
        m2 = re.match(r'^Over\s+([\d,\.]+)', line, re.I)
        if m2 and current_player:
            val = parse_number(m2.group(1), stat)
            if val:
                if current_player not in players:   # take first Over line per player
                    players[current_player] = val
                    print(f'  ✓ {current_player}: {stat} = {val}')
            continue

        # ── Reset player context on blank / date / nav lines ──
        if re.match(r'^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s', line):
            pass   # date line — keep current_player

    return players

def auto_scroll(page, pause=1.2):
    """Scroll down slowly, stopping as soon as 'NFL Betting News' appears."""
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(1)

    step = 0
    while True:
        step += 1
        page.evaluate(f'window.scrollBy(0, 400)')
        time.sleep(pause)

        # Stop scrolling once we hit the bottom-of-page news section
        body_text = page.inner_text('body')
        if 'NFL Betting News' in body_text:
            print('  Reached "NFL Betting News" — stopping scroll.')
            break

        # Safety cap — never scroll more than 300 steps (~120 seconds)
        if step > 300:
            print('  Scroll cap reached.')
            break

    time.sleep(1.5)

def scrape_page(page, stat, subcategory, nav, label, page_num, total_pages):
    url = make_url(subcategory, nav)
    print(f'\n{"="*60}')
    print(f'[{page_num}/{total_pages}] {label}')
    print(f'  {url}')

    try:
        page.goto(url, wait_until='domcontentloaded', timeout=60000)
    except Exception as e:
        print(f'  Nav timeout (continuing): {str(e)[:60]}')

    time.sleep(3)
    print(f'  Auto-scrolling...')
    auto_scroll(page)

    text = page.inner_text('body')

    # Save raw text with unique filename
    slug = f'{subcategory}_{nav}'
    debug = pathlib.Path(__file__).parent.parent / 'data' / f'dk_{slug}.txt'
    debug.write_text(text, encoding='utf-8')

    print(f'  Parsing {len(text):,} chars...')
    players = parse_ou_text(text, stat, label)
    print(f'  → {len(players)} players found')
    return players

def main():
    print('Dynasty Dawgs — DraftKings Season Props Scraper (Auto-scroll)')
    print(f'Time: {datetime.now(timezone.utc).isoformat()}')
    print(f'Pages: {len(DK_PAGES)} | Fully automated — sit back\n')

    # Load existing FanDuel data
    vp_path  = pathlib.Path(__file__).parent.parent / 'data' / 'vegasprops.json'
    existing = {}
    if vp_path.exists():
        try:
            existing = json.loads(vp_path.read_text()).get('players', {})
            print(f'Loaded {len(existing)} players from vegasprops.json (FanDuel baseline)\n')
        except Exception: pass

    dk_data = {}   # player → stat → [values]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=['--disable-blink-features=AutomationControlled',
                  '--window-size=1440,900', '--start-maximized'],
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

        for i, (stat, subcategory, nav, label) in enumerate(DK_PAGES, 1):
            players = scrape_page(page, stat, subcategory, nav, label, i, len(DK_PAGES))
            for name, val in players.items():
            dk_data.setdefault(name, {}).setdefault(stat, []).append(val)

        browser.close()

    # ── Merge FD + DK ─────────────────────────────────────────────────────────
    merged    = {}
    all_names = set(existing.keys()) | set(dk_data.keys())

    for name in all_names:
        fd = existing.get(name, {})
        dk = dk_data.get(name, {})
        entry = {}

        for stat in PPR:
            vals = []
            if fd.get(stat) is not None and isinstance(fd[stat], (int, float)):
                vals.append(fd[stat])
            if stat in dk:
                vals.extend(dk[stat])
            if vals:
                entry[stat] = round(sum(vals) / len(vals), 1)

        if entry:
            entry['ppg']     = compute_ppg(entry)
            entry['updated'] = datetime.now().strftime('%Y-%m-%d')
            merged[name]     = entry

    sorted_out = dict(sorted(merged.items(), key=lambda x: x[1].get('ppg', 0), reverse=True))

    # ── Save ──────────────────────────────────────────────────────────────────
    now       = datetime.now(timezone.utc)
    nfl_start = datetime(2026, 9, 10, tzinfo=timezone.utc)
    week_num  = min(18, int((now - nfl_start).days / 7) + 1) if now >= nfl_start else None

    vp_path.write_text(json.dumps({
        'meta': {
            'season': 2026, 'week': week_num, 'type': 'season-long',
            'updatedAt': now.isoformat(),
            'playerCount': len(sorted_out),
            'books': ['FanDuel', 'DraftKings'],
        },
        'players': sorted_out,
    }, indent=2))

    dk_only  = sum(1 for n in sorted_out if n in dk_data and n not in existing)
    fd_only  = sum(1 for n in sorted_out if n in existing and n not in dk_data)
    both     = sum(1 for n in sorted_out if n in existing and n in dk_data)

    print(f'\n{"="*60}')
    print('DONE')
    print(f'  FD only:  {fd_only} players')
    print(f'  DK only:  {dk_only} players')
    print(f'  FD + DK:  {both} players (lines averaged)')
    print(f'  Total:    {len(sorted_out)} players')
    print()
    print('Top 10 by PPG:')
    for i, (name, p) in enumerate(list(sorted_out.items())[:10], 1):
        src = ('FD+DK' if name in existing and name in dk_data
               else 'FD only' if name in existing else 'DK only')
        print(f'  {i:2}. {name:<24} {p["ppg"]:.1f} PPG  [{src}]')

    print(f'\nSaved → data/vegasprops.json')
    print('\nNext:')
    print('  git add data/vegasprops.json')
    print('  git commit -m "update: FanDuel + DraftKings 2026 season props"')
    print('  git push')

if __name__ == '__main__':
    main()

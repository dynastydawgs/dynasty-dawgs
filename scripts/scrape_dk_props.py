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
PLAYER_RE = re.compile(r"^[A-Z][a-zA-Z''\.\-]+(?:\s+[A-Z][a-zA-Z''\.\-]+)+$")
BAD_WORDS  = ['Over','Under','Parlay','DraftKings','Sportsbook','More Wagers',
              'Futures','Player','Season','Regular','Super Bowl','Conference',
              'Division','National','American','NFL','Same Game','SGP',
              'Fast Futures','Player Milestones','Player Stats','Rookie',
              'Player Matchups','Team Specials','Pass Yards','Rec Yards',
              'Rush Yards','Pass Tds','Rec Tds','Rush Tds','View All',
              'Log In','Sign Up','How To Bet','Responsible Gaming']

def looks_like_player(s):
    s = s.strip()
    if not PLAYER_RE.match(s): return False
    if len(s) < 5 or len(s) > 45: return False
    return not any(b.lower() == s.lower() or b.lower() in s.lower() for b in BAD_WORDS)

def parse_number(s):
    s = s.strip().replace(',', '').replace('−', '-').replace('–', '-')
    try:
        v = float(s)
        if 0.5 <= v <= 9000: return v   # prop handicap range
    except ValueError: pass
    return None

def parse_ou_text(text, stat, label):
    """
    DraftKings O/U page format (typical):
        Player Name
        OVER  4500.5
        -115
        UNDER  4500.5
        -105
    OR:
        Player Name
        4500.5
        -115
        4500.5
        -105
    OR inline:
        Player Name  Over  4500.5
    """
    players = {}
    lines   = [l.strip() for l in text.splitlines() if l.strip()]

    i = 0
    while i < len(lines):
        line = lines[i]

        # Inline: "Player Name Over 1234.5"
        m = re.match(r'^(.+?)\s+(over|under)\s+([\d,\.]+)\s*(?:[+\-]\d+)?$', line, re.I)
        if m and looks_like_player(m.group(1)):
            if m.group(2).lower() == 'over':
                val = parse_number(m.group(3))
                if val:
                    players.setdefault(m.group(1).strip(), []).append(val)
                    print(f'  ✓ {m.group(1).strip()}: {stat} = {val}')
            i += 1
            continue

        # Player name on its own line — scan ahead for handicap
        if looks_like_player(line):
            player = line.strip()
            # Scan next ~8 lines for a handicap number
            found_val = None
            for j in range(i+1, min(i+9, len(lines))):
                nxt = lines[j]
                # Stop if we hit another player name
                if looks_like_player(nxt): break
                val = parse_number(nxt)
                if val:
                    found_val = val
                    break
                # "OVER 4500.5" on one line
                m2 = re.match(r'^(?:over|o/?u|o/u)\s+([\d,\.]+)', nxt, re.I)
                if m2:
                    val = parse_number(m2.group(1))
                    if val:
                        found_val = val
                        break
            if found_val:
                players.setdefault(player, []).append(found_val)
                print(f'  ✓ {player}: {stat} = {found_val}')
            i += 1
            continue

        i += 1

    # Average duplicates
    return {name: round(sum(ls)/len(ls), 1) for name, ls in players.items() if ls}

def auto_scroll(page, total_scrolls=30, pause=1.2):
    """Scroll slowly from top to bottom, triggering lazy loads."""
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(1)
    for step in range(1, total_scrolls + 1):
        page.evaluate(f'''
            window.scrollTo({{
                top: {step} * document.body.scrollHeight / {total_scrolls},
                behavior: "smooth"
            }})
        ''')
        time.sleep(pause)
    # Scroll back to top, then bottom once more
    page.evaluate('window.scrollTo(0, 0)')
    time.sleep(0.8)
    for step in range(1, 15):
        page.evaluate(f'window.scrollTo(0, {step} * document.body.scrollHeight / 14)')
        time.sleep(0.7)
    time.sleep(2)

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

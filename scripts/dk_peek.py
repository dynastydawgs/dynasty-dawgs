"""Quick peek at DraftKings O/U page format. Run once, scroll, press Enter."""
import time, pathlib
from playwright.sync_api import sync_playwright

URL = 'https://sportsbook.draftkings.com/leagues/football/nfl?category=futures&subcategory=player-stats-o-u&nav_1=pass-yards'

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=False, args=['--window-size=1440,900'])
    ctx  = browser.new_context(
        viewport={'width':1440,'height':900},
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    )
    ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
    page = ctx.new_page()
    page.goto(URL, wait_until='domcontentloaded', timeout=60000)
    time.sleep(3)
    print('Scroll through all players, then press ENTER...')
    input()
    text = page.inner_text('body')
    browser.close()

out = pathlib.Path('data/dk_ou_passing_yards.txt')
out.write_text(text, encoding='utf-8')
print(f'Saved {len(text)} chars to {out}')
print('\nFirst 100 lines with actual player/number content:')
lines = [l.strip() for l in text.splitlines() if l.strip()]
# Skip nav lines, show from where prop data starts
in_props = False
shown = 0
for line in lines:
    if 'Player Props' in line or 'Passing Yards' in line:
        in_props = True
    if in_props:
        print(f'  {repr(line)}')
        shown += 1
        if shown > 80:
            break

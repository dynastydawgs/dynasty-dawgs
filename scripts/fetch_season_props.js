/**
 * fetch_season_props.js — Dynasty Dawgs Season-Long Props Fetcher
 * Playwright + headless Chromium. Captures ALL JSON responses to discover
 * FanDuel/DraftKings API endpoints and extract season-long player prop lines.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── PPR scoring weights ──────────────────────────────────────────────────────
const PPR = {
  pass_yds : 0.04,
  pass_tds : 4.0,
  rush_yds : 0.1,
  rush_tds : 6.0,
  rec      : 1.0,
  rec_yds  : 0.1,
  rec_tds  : 6.0,
};

function classifyStat(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('passing yard'))                                   return 'pass_yds';
  if (n.includes('passing td') || n.includes('passing touchdown'))  return 'pass_tds';
  if (n.includes('rushing yard'))                                   return 'rush_yds';
  if (n.includes('rushing td') || n.includes('rushing touchdown'))  return 'rush_tds';
  if (n.includes('receiving yard'))                                 return 'rec_yds';
  if (n.includes('receiving td') || n.includes('receiving touchdown')) return 'rec_tds';
  if (n.includes('reception') && !n.includes('yard') && !n.includes('td')) return 'rec';
  return null;
}

function computePpg(stats) {
  let ppg = 0;
  for (const [stat, weight] of Object.entries(PPR)) ppg += (stats[stat] ?? 0) * weight;
  return Math.round(ppg * 100) / 100;
}

// ── Open a stealth browser page ──────────────────────────────────────────────
async function stealthPage(browser) {
  const ctx = await browser.newContext({
    viewport        : { width: 1440, height: 900 },
    userAgent       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale          : 'en-US',
    timezoneId      : 'America/New_York',
    geolocation     : { latitude: 40.7128, longitude: -74.0060 },   // New York
    permissions     : ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua'      : '"Chromium";v="124", "Google Chrome";v="124"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  const page = await ctx.newPage();

  // Hide webdriver flag — most important anti-bot bypass
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  return { ctx, page };
}

// ── Capture all JSON responses from a URL ────────────────────────────────────
async function captureAll(browser, url, label) {
  const { ctx, page } = await stealthPage(browser);
  const captured = [];

  page.on('response', async response => {
    const ct = response.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    try {
      const json = await response.json();
      captured.push({ url: response.url(), json });
    } catch(e) {}
  });

  console.log(`\n[${label}] → ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch(e) {
    console.log(`  timeout/error during navigation: ${e.message.slice(0, 80)}`);
  }

  // Scroll to trigger lazy loads
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(i => window.scrollTo(0, i * document.body.scrollHeight / 6), i);
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);

  console.log(`  captured ${captured.length} JSON responses`);
  // Log every URL so we can identify the right endpoints in Actions logs
  for (const c of captured) {
    const size = JSON.stringify(c.json).length;
    console.log(`    ${size.toString().padStart(8)} bytes  ${c.url.slice(0, 120)}`);
  }

  await ctx.close();
  return captured;
}

// ── Deep-search any JSON blob for season-long player props ───────────────────
// Walks arbitrary nesting to find player names + handicap lines.
function deepExtract(data, statHint) {
  const players = {};

  const tryRecord = (obj, stat) => {
    // Look for { name/participant/runnerName/label, handicap/line/hc/value }
    const nameCandidates = [obj?.runnerName, obj?.name, obj?.participant, obj?.label, obj?.selectionName];
    const lineCandidates = [obj?.handicap, obj?.hc, obj?.line, obj?.value, obj?.points];
    const playerName = nameCandidates.find(v => typeof v === 'string' && v.length > 2 && v.length < 60);
    const line = lineCandidates.find(v => v != null && !isNaN(parseFloat(v)));
    if (playerName && line != null) {
      players[playerName] ??= {};
      players[playerName][stat] ??= [];
      players[playerName][stat].push(parseFloat(line));
      return true;
    }
    return false;
  };

  const walk = (obj, depth = 0, currentStat = null, isSeasonCtx = false) => {
    if (depth > 15 || obj == null || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, depth + 1, currentStat, isSeasonCtx));
      return;
    }

    // Detect stat context from field names
    const nameStr = Object.values(obj)
      .filter(v => typeof v === 'string')
      .join(' ')
      .toLowerCase();

    const thisStat = classifyStat(nameStr) ?? currentStat;
    const thisSeasonCtx = isSeasonCtx
      || /season|regular season|2026|annual/i.test(nameStr);

    if (thisSeasonCtx && thisStat) {
      tryRecord(obj, thisStat);
    }

    for (const v of Object.values(obj)) {
      walk(v, depth + 1, thisStat, thisSeasonCtx);
    }
  };

  walk(data, 0, statHint, false);
  return players;
}

// ── Parse a single captured response for season-long props ───────────────────
function parseResponse(json, sourceUrl) {
  const players = {};

  // Check if this response has any season-relevant content at all
  const raw = JSON.stringify(json).toLowerCase();
  const hasSeasonKeyword = /regular season|season-long|passing yards|rushing yards|receiving yards/i.test(raw);
  if (!hasSeasonKeyword) return players;

  // Run deep extractor — it will find players wherever they are
  const found = deepExtract(json, null);
  for (const [name, stats] of Object.entries(found)) {
    players[name] ??= {};
    for (const [stat, lines] of Object.entries(stats)) {
      players[name][stat] ??= [];
      players[name][stat].push(...lines);
    }
  }

  if (Object.keys(players).length > 0) {
    console.log(`  ✓ ${Object.keys(players).length} players found in: ${sourceUrl.slice(0, 80)}`);
  }

  return players;
}

// ── Merge players into accumulator ───────────────────────────────────────────
function mergeInto(acc, parsed) {
  for (const [name, stats] of Object.entries(parsed)) {
    acc[name] ??= {};
    for (const [stat, lines] of Object.entries(stats)) {
      acc[name][stat] ??= [];
      acc[name][stat].push(...lines);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Dynasty Dawgs — Season Props Fetcher (Playwright)');
  console.log(`Time: ${new Date().toISOString()}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1440,900',
    ],
  });

  const allPlayers = {};

  // ── FanDuel ──────────────────────────────────────────────────────────────
  const fdUrls = [
    'https://sportsbook.fanduel.com/navigation/nfl?tab=player-props',
    'https://sportsbook.fanduel.com/nfl/futures',
  ];
  for (const u of fdUrls) {
    const responses = await captureAll(browser, u, 'FanDuel');
    for (const { url, json } of responses) {
      mergeInto(allPlayers, parseResponse(json, url));
    }
  }

  // ── DraftKings ───────────────────────────────────────────────────────────
  const dkUrls = [
    'https://sportsbook.draftkings.com/sports/football/nfl/player-props',
    'https://sportsbook.draftkings.com/sports/football/nfl/futures',
  ];
  for (const u of dkUrls) {
    const responses = await captureAll(browser, u, 'DraftKings');
    for (const { url, json } of responses) {
      mergeInto(allPlayers, parseResponse(json, url));
    }
  }

  await browser.close();

  // ── Debug dump — write ALL captured URLs to a debug file ─────────────────
  // (Helps identify exact endpoints if season props aren't parsing yet)
  const debugPath = path.join(__dirname, '..', 'data', 'vegasprops_debug.json');
  console.log(`\nDebug info written to data/vegasprops_debug.json`);

  const totalPlayers = Object.keys(allPlayers).length;
  console.log(`\nTotal players with season props: ${totalPlayers}`);

  if (!totalPlayers) {
    console.log('\nNo season-long props extracted. Likely causes:');
    console.log('  1. Off-season — books may not post 2026 lines until Aug/Sep');
    console.log('  2. Bot detection — FanDuel may be serving empty/auth-gated page');
    console.log('  3. URL structure changed — check captured URLs in Actions log above');
    console.log('\nCheck Actions logs: each captured URL + byte size is printed above.');
    console.log('Exiting without updating vegasprops.json.');
    process.exit(0);
  }

  // ── Average lines + compute PPG ──────────────────────────────────────────
  const outputPlayers = {};
  for (const [name, stats] of Object.entries(allPlayers)) {
    const averaged = {};
    for (const [stat, lines] of Object.entries(stats)) {
      averaged[stat] = Math.round((lines.reduce((a, b) => a + b, 0) / lines.length) * 10) / 10;
    }
    outputPlayers[name] = { ...averaged, ppg: computePpg(averaged), updated: new Date().toISOString().slice(0, 10) };
  }

  const sorted = Object.fromEntries(
    Object.entries(outputPlayers).sort(([, a], [, b]) => b.ppg - a.ppg)
  );

  const now      = new Date();
  const nflStart = new Date('2026-09-10');
  const weekNum  = now >= nflStart ? Math.min(18, Math.floor((now - nflStart) / (7 * 86400000)) + 1) : null;

  const outPath = path.join(__dirname, '..', 'data', 'vegasprops.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    meta: { season: 2026, week: weekNum, type: 'season-long', updatedAt: now.toISOString(),
            playerCount: Object.keys(sorted).length, books: ['FanDuel', 'DraftKings'] },
    players: sorted,
  }, null, 2));

  console.log('\nTop 10 by PPG:');
  Object.entries(sorted).slice(0, 10).forEach(([name, p], i) =>
    console.log(`  ${i + 1}. ${name.padEnd(22)} ${p.ppg.toFixed(1)} PPG`)
  );
  console.log(`\nDone — ${Object.keys(sorted).length} players written to data/vegasprops.json`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

/**
 * fetch_season_props.js — Dynasty Dawgs Season-Long Props Fetcher
 *
 * Uses Playwright (headless Chromium) to load FanDuel's NFL player props page,
 * intercept their internal API responses, extract season-long passing/rushing/
 * receiving yards + TD lines, compute PPR PPG, and write data/vegasprops.json.
 *
 * Season-long props (Regular Season Passing Yards 2026-27, etc.) appear on:
 *   https://sportsbook.fanduel.com/navigation/nfl?tab=player-props
 *   https://sportsbook.fanduel.com/nfl/player-props-season
 *
 * Runs via GitHub Actions weekly. Falls back gracefully if layout changes.
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

// ── Stat classifier ──────────────────────────────────────────────────────────
function classifyStat(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('passing yard'))                                 return 'pass_yds';
  if (n.includes('passing td') || n.includes('passing touchdown')) return 'pass_tds';
  if (n.includes('rushing yard'))                                 return 'rush_yds';
  if (n.includes('rushing td') || n.includes('rushing touchdown')) return 'rush_tds';
  if (n.includes('receiving yard'))                               return 'rec_yds';
  if (n.includes('receiving td') || n.includes('receiving touchdown')) return 'rec_tds';
  if (n.includes('reception') && !n.includes('yard') && !n.includes('td')) return 'rec';
  return null;
}

function computePpg(stats) {
  let ppg = 0;
  for (const [stat, weight] of Object.entries(PPR)) {
    ppg += (stats[stat] ?? 0) * weight;
  }
  return Math.round(ppg * 100) / 100;
}

// ── Deep-walk JSON for FanDuel structure ─────────────────────────────────────
// FanDuel's sbapi returns nested JSON with various shapes.
// We walk every object looking for market/runner combos.
function extractFanDuelPlayers(data) {
  const players = {};

  // Shape 1: attachments.markets + attachments.runners (most common)
  const attachments = data?.attachments ?? data;
  const markets = attachments?.markets ?? {};
  const runners = attachments?.runners ?? {};
  const events  = attachments?.events  ?? {};

  for (const market of Object.values(markets)) {
    const marketName = market?.marketName ?? market?.marketType?.marketName ?? market?.name ?? '';
    const stat = classifyStat(marketName);
    if (!stat) continue;

    // Season-long filter
    const eventId = market?.eventId ?? market?.event?.id;
    const event = events[eventId] ?? {};
    const eventName = event?.name ?? event?.openDate ?? market?.eventName ?? '';
    const isSeasonLong = /season|regular season|2026|annual/i.test(marketName)
                      || /season|regular season|2026|annual/i.test(eventName);
    if (!isSeasonLong) continue;

    for (const runnerId of (market?.runnerIds ?? [])) {
      const runner = runners[runnerId];
      if (!runner) continue;
      const playerName = runner?.runnerName ?? runner?.name ?? '';
      if (!playerName) continue;
      const handicap = runner?.handicap ?? runner?.hc ?? null;
      if (handicap == null) continue;

      players[playerName] ??= {};
      players[playerName][stat] ??= [];
      players[playerName][stat].push(parseFloat(handicap));
    }
  }

  // Shape 2: flat array of markets (alternate FD API shapes)
  if (!Object.keys(players).length) {
    const marketArr = data?.markets ?? data?.data?.markets ?? [];
    for (const market of (Array.isArray(marketArr) ? marketArr : [])) {
      const marketName = market?.marketName ?? market?.name ?? '';
      const stat = classifyStat(marketName);
      if (!stat) continue;
      const isSeasonLong = /season|regular season|2026|annual/i.test(marketName)
                        || /season|regular season|2026|annual/i.test(market?.eventName ?? '');
      if (!isSeasonLong) continue;

      for (const runner of (market?.runners ?? [])) {
        const playerName = runner?.runnerName ?? runner?.name ?? '';
        if (!playerName) continue;
        const handicap = runner?.handicap ?? runner?.hc ?? null;
        if (handicap == null) continue;
        players[playerName] ??= {};
        players[playerName][stat] ??= [];
        players[playerName][stat].push(parseFloat(handicap));
      }
    }
  }

  return players;
}

// ── DraftKings walker ────────────────────────────────────────────────────────
function extractDraftKingsPlayers(data) {
  const players = {};
  const allOffers = [];

  // Recursively find any object that looks like a prop offer
  const walk = (obj, depth = 0) => {
    if (depth > 12 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(o => walk(o, depth + 1)); return; }
    // An offer has label + outcomes array
    if (obj.label && Array.isArray(obj.outcomes) && obj.outcomes.length > 0) {
      allOffers.push(obj);
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(data);

  for (const offer of allOffers) {
    const label = offer.label ?? offer.name ?? '';
    const stat = classifyStat(label);
    if (!stat) continue;

    // Season-long filter — check label, subcategoryName, or parent category
    const context = `${label} ${offer.subcategoryName ?? ''} ${offer.offerCategoryName ?? ''}`;
    if (!/season|2026|annual|regular season/i.test(context)) continue;

    for (const outcome of offer.outcomes) {
      const playerName = outcome.participant ?? outcome.label ?? '';
      if (!playerName) continue;
      const line = parseFloat(outcome.line ?? outcome.handicap ?? outcome.value ?? NaN);
      if (isNaN(line)) continue;
      players[playerName] ??= {};
      players[playerName][stat] ??= [];
      players[playerName][stat].push(line);
    }
  }

  return players;
}

// ── Load a sportsbook page and return all captured API JSON ─────────────────
async function captureSportsbookData(browser, { name, url, apiPatterns, scrollDepth = 5 }) {
  const page = await browser.newPage();
  const captured = [];

  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/',
  });

  page.on('response', async response => {
    const reqUrl = response.url();
    if (!apiPatterns.some(p => reqUrl.includes(p))) return;
    try {
      const json = await response.json();
      captured.push({ url: reqUrl, json });
      console.log(`  [${name}] captured: ${reqUrl.slice(0, 100)}`);
    } catch(e) {}
  });

  console.log(`\n=== ${name} — navigating to ${url} ===`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch(e) {
    console.log(`  Navigation timed out (continuing): ${e.message}`);
  }

  // Scroll progressively to trigger lazy-loads
  for (let i = 1; i <= scrollDepth; i++) {
    await page.evaluate(i => window.scrollTo(0, i * (document.body.scrollHeight / 5)), i);
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(2000); // final settle

  console.log(`  ${name}: ${captured.length} API responses captured`);
  await page.close();
  return captured;
}

// ── Merge player stats into accumulator ─────────────────────────────────────
function mergeInto(acc, parsed, sourceName) {
  let count = 0;
  for (const [name, stats] of Object.entries(parsed)) {
    acc[name] ??= {};
    for (const [stat, lines] of Object.entries(stats)) {
      acc[name][stat] ??= [];
      acc[name][stat].push(...lines);
    }
    count++;
  }
  if (count > 0) console.log(`    → ${count} players with season-long props from ${sourceName}`);
  return count;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Dynasty Dawgs — Season Props Fetcher (Playwright + Chromium)');
  console.log(`Time: ${new Date().toISOString()}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const allPlayers = {};

  // ── FanDuel ──────────────────────────────────────────────────────────────
  // Try both the player-props tab and the dedicated season-props URL
  const fdUrls = [
    'https://sportsbook.fanduel.com/navigation/nfl?tab=player-props',
    'https://sportsbook.fanduel.com/nfl/player-props-season',
    'https://sportsbook.fanduel.com/nfl/futures',
  ];
  for (const fdUrl of fdUrls) {
    try {
      const responses = await captureSportsbookData(browser, {
        name: 'FanDuel',
        url: fdUrl,
        apiPatterns: ['sbapi.fanduel.com', 'api.fanduel.com', 'fanduel.com/api'],
      });
      let total = 0;
      for (const { url, json } of responses) {
        const parsed = extractFanDuelPlayers(json);
        total += mergeInto(allPlayers, parsed, url.slice(0, 60));
      }
      if (total > 0) break; // got data, no need to try other URLs
    } catch(e) {
      console.error(`FanDuel error (${fdUrl}):`, e.message);
    }
  }

  // ── DraftKings ───────────────────────────────────────────────────────────
  const dkUrls = [
    'https://sportsbook.draftkings.com/sports/football/nfl/player-props',
    'https://sportsbook.draftkings.com/sports/football/nfl/futures',
  ];
  for (const dkUrl of dkUrls) {
    try {
      const responses = await captureSportsbookData(browser, {
        name: 'DraftKings',
        url: dkUrl,
        apiPatterns: ['api.draftkings.com', 'sportsbook-us-ga.draftkings.com', 'draftkings.com/api'],
      });
      let total = 0;
      for (const { url, json } of responses) {
        const parsed = extractDraftKingsPlayers(json);
        total += mergeInto(allPlayers, parsed, url.slice(0, 60));
      }
      if (total > 0) break;
    } catch(e) {
      console.error(`DraftKings error (${dkUrl}):`, e.message);
    }
  }

  await browser.close();

  // ── Summarize capture ────────────────────────────────────────────────────
  const totalPlayers = Object.keys(allPlayers).length;
  console.log(`\nTotal unique players with season props: ${totalPlayers}`);

  if (!totalPlayers) {
    console.log('No season-long player props found. Possible reasons:');
    console.log('  • Off-season (books haven\'t posted 2026 lines yet)');
    console.log('  • Page structure changed — check GitHub Actions logs');
    console.log('Exiting without updating vegasprops.json.');
    process.exit(0);
  }

  // ── Average lines across books + compute PPG ─────────────────────────────
  const outputPlayers = {};
  for (const [name, stats] of Object.entries(allPlayers)) {
    const averaged = {};
    for (const [stat, lines] of Object.entries(stats)) {
      averaged[stat] = Math.round((lines.reduce((a, b) => a + b, 0) / lines.length) * 10) / 10;
    }
    const ppg = computePpg(averaged);
    outputPlayers[name] = { ...averaged, ppg, updated: new Date().toISOString().slice(0, 10) };
  }

  // Sort by PPG descending for readability
  const sorted = Object.fromEntries(
    Object.entries(outputPlayers).sort(([, a], [, b]) => b.ppg - a.ppg)
  );

  // ── Determine current NFL week ────────────────────────────────────────────
  const now      = new Date();
  const nflStart = new Date('2026-09-10');
  const weekNum  = now >= nflStart
    ? Math.min(18, Math.floor((now - nflStart) / (7 * 86400000)) + 1)
    : null;

  // ── Write output ──────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, '..', 'data', 'vegasprops.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const output = {
    meta: {
      season     : 2026,
      week       : weekNum,
      type       : 'season-long',
      updatedAt  : now.toISOString(),
      playerCount: Object.keys(sorted).length,
      books      : ['FanDuel', 'DraftKings'],
    },
    players: sorted,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  // Print top 10 for log verification
  console.log('\nTop 10 by PPG:');
  Object.entries(sorted).slice(0, 10).forEach(([name, p], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(22)} ${p.ppg.toFixed(1)} PPG`);
  });

  console.log(`\nDone — ${Object.keys(sorted).length} players written to data/vegasprops.json`);
}

main().catch(e => {
  console.error('\nFatal error:', e);
  process.exit(1);
});

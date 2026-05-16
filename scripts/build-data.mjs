// scripts/build-data.mjs
// Pre-builds static JSON files served from data/ on GitHub Pages.
// Run locally:  node scripts/build-data.mjs
// Also runs automatically every Tuesday via .github/workflows/build-data.yml
//
// Output files:
//   data/compdb.json      — comp buckets: "POS_tier_carYr" → [p15, p50, p85]
//   data/careerdb.json    — pid → [{season, ppr, ppg, games, touches}]
//   data/benchmarks.json  — { avgRbCarryPct }

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', 'data');

// ── Config ────────────────────────────────────────────────────────────────────
const currentYear  = new Date().getFullYear();
const HIST_SEASONS = Array.from({ length: currentYear - 2014 }, (_, i) => 2015 + i);
const NFL_AVG_RUSH_ATT_PG = 26.0; // league-average fallback for carry-share normalisation

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(vals, p) {
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Mirrors draftTier() in the HTML exactly — must stay in sync.
function draftTier(round, pick) {
  if (!round) return 'udfa';
  const overall = pick ?? (round - 1) * 32 + 16;
  if (overall <= 10) return 'r1_top10';
  if (overall <= 20) return 'r1_mid';
  if (round === 1)   return 'r1_late';
  if (overall <= 48) return 'r2_early';
  if (round === 2)   return 'r2_late';
  if (overall <= 80) return 'r3_early';
  if (round === 3)   return 'r3_late';
  if (round <= 5)    return 'r4r5';
  return 'udfa';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function progress(pct, msg) {
  const filled = Math.round(pct / 5);
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stdout.write(`\r  [${bar}] ${pct}%  ${msg.padEnd(55)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏈  Dynasty Hub — Static Data Build');
  console.log(`    Seasons: ${HIST_SEASONS[0]}–${HIST_SEASONS.at(-1)}\n`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // ── Step 1: Sleeper player directory ─────────────────────────────────────
  progress(0, 'Fetching Sleeper player directory…');
  const sleeperPlayers = await fetchJson('https://api.sleeper.app/v1/players/nfl');
  progress(10, `Player directory loaded (${Object.keys(sleeperPlayers).length.toLocaleString()} players)`);
  console.log();

  // ── Step 2: Historical season stats (all years in parallel) ──────────────
  progress(10, `Fetching ${HIST_SEASONS.length} seasons from Sleeper…`);
  const seasonFetches = HIST_SEASONS.map(yr =>
    fetchJson(
      `https://api.sleeper.app/stats/nfl/${yr}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=pts_ppr`
    ).catch(() => ({}))
  );
  const seasonResults = await Promise.all(seasonFetches);
  const seasonMaps    = {};
  HIST_SEASONS.forEach((yr, i) => { seasonMaps[yr] = seasonResults[i] || {}; });
  progress(40, `${HIST_SEASONS.length} seasons loaded`);
  console.log();

  // ── Step 3: Build careerDB ────────────────────────────────────────────────
  progress(40, 'Building career database…');
  const rawCareers = {};
  const pidToPos   = {};

  for (const yr of HIST_SEASONS) {
    for (const [pid, stats] of Object.entries(seasonMaps[yr])) {
      const ppr   = parseFloat(stats.pts_ppr   ?? 0);
      const games = parseFloat(stats.gms_active ?? stats.gp ?? stats.gms ?? 0);
      if (ppr < 15 || games < 5) continue;
      if (stats.pos && !pidToPos[pid]) pidToPos[pid] = stats.pos;
      if (!rawCareers[pid]) rawCareers[pid] = [];
      const touches = Math.round(+(stats.rush_att ?? 0) + +(stats.rec ?? 0));
      rawCareers[pid].push({ season: yr, ppr: Math.round(ppr * 10) / 10, games, touches });
    }
  }

  const careerDB = {};
  for (const [pid, seasons] of Object.entries(rawCareers)) {
    const sorted = seasons.sort((a, b) => a.season - b.season);
    careerDB[pid] = sorted.map(s => ({
      ...s,
      ppg: Math.round((s.ppr / s.games) * 10) / 10,
    }));
  }
  progress(60, `Career DB: ${Object.keys(careerDB).length.toLocaleString()} players`);
  console.log();

  // ── Step 4: Build compDB ──────────────────────────────────────────────────
  progress(60, 'Building comp buckets…');
  const compBuckets = {};

  for (const [pid, seasons] of Object.entries(careerDB)) {
    const sp  = sleeperPlayers[pid];
    const pos = sp?.position ?? pidToPos[pid];
    if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
    const tier = draftTier(sp?.draft_round ?? null, sp?.draft_pick ?? null);

    seasons.forEach((s, i) => {
      const key = `${pos}_${tier}_${i}`;
      if (!compBuckets[key]) compBuckets[key] = [];
      compBuckets[key].push(s.ppr);
    });
  }

  const compDB = {};
  for (const [key, vals] of Object.entries(compBuckets)) {
    if (vals.length < 3) continue; // need at least 3 comps
    compDB[key] = [
      Math.round(pct(vals, 15)),
      Math.round(pct(vals, 50)),
      Math.round(pct(vals, 85)),
    ];
  }
  progress(80, `Comp DB: ${Object.keys(compDB).length.toLocaleString()} buckets`);
  console.log();

  // ── Step 5: Compute avgRbCarryPct from most recent completed season ───────
  progress(85, 'Computing avg RB carry share…');
  const recentYr    = currentYear - 1;
  const recentStats = seasonMaps[recentYr] ?? seasonMaps[currentYear] ?? {};
  const rbRows      = [];

  for (const [pid, st] of Object.entries(recentStats)) {
    const rushAtt = +(st.rush_att ?? 0);
    if (rushAtt < 1) continue;
    const sp  = sleeperPlayers[pid];
    const pos = sp?.position ?? st.pos ?? null;
    if (pos !== 'RB') continue;
    const games = Math.max(1, +(st.gms_active ?? st.gp ?? 1) || 1);
    rbRows.push({ rushAtt, carryPct: (rushAtt / games) / NFL_AVG_RUSH_ATT_PG * 100 });
  }
  rbRows.sort((a, b) => b.rushAtt - a.rushAtt);
  const top64        = rbRows.slice(0, 64);
  const avgRbCarryPct = top64.length >= 10
    ? Math.round(top64.reduce((s, r) => s + r.carryPct, 0) / top64.length * 10) / 10
    : 44.1;
  progress(90, `Avg carry share: ${avgRbCarryPct}%`);
  console.log();

  // ── Step 6: Write output files ────────────────────────────────────────────
  progress(95, 'Writing data files…');
  const compJson    = JSON.stringify(compDB);
  const careerJson  = JSON.stringify(careerDB);
  const benchJson   = JSON.stringify({ avgRbCarryPct });

  writeFileSync(join(DATA_DIR, 'compdb.json'),     compJson);
  writeFileSync(join(DATA_DIR, 'careerdb.json'),   careerJson);
  writeFileSync(join(DATA_DIR, 'benchmarks.json'), benchJson);
  progress(100, 'Done!');
  console.log('\n');

  const kb = str => (str.length / 1024).toFixed(0) + ' KB';
  console.log('  ✅  data/compdb.json     ', kb(compJson));
  console.log('  ✅  data/careerdb.json   ', kb(careerJson));
  console.log('  ✅  data/benchmarks.json ', kb(benchJson));
  console.log('\n  Next: git add data/ && git commit && git push\n');
}

main().catch(err => {
  console.error('\n❌  Build failed:', err.message);
  process.exit(1);
});

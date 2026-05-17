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

  // ── Step 5b: Build teamDB ─────────────────────────────────────────────────
  // Aggregate team-level stats from the most recent season using the same
  // recentStats map already in memory.  QB records provide pass volume;
  // all positions contribute rush volume.
  progress(92, 'Building team context database…');
  const teamAgg = {};
  for (const [pid, st] of Object.entries(recentStats)) {
    const sp  = sleeperPlayers[pid];
    // Use the team recorded in the stats row first — it reflects which team the
    // player was actually on during that season, not their current (possibly
    // traded/FA) team.  Fall back to the player-directory team only if missing.
    const team = st.team ?? sp?.team ?? null;
    if (!team || team === 'FA' || team === 'UFA') continue;

    if (!teamAgg[team]) teamAgg[team] = {
      rushAtt: 0, rushYd: 0, rushTd: 0,
      passAtt: 0, passYd: 0, passTd: 0,
      gpMax: 0,
    };
    const t  = teamAgg[team];
    const gp = Math.max(1, +(st.gms_active ?? st.gp ?? st.gms ?? 1) || 1);
    t.gpMax   = Math.max(t.gpMax, gp);
    t.rushAtt += +(st.rush_att ?? 0);
    t.rushYd  += +(st.rush_yd  ?? 0);
    t.rushTd  += +(st.rush_td  ?? 0);
    // Use stats-row position first to avoid current-team-after-trade misattribution
    const pos = st.pos ?? sp?.position ?? null;
    if (pos === 'QB') {
      t.passAtt += +(st.pass_att ?? 0);
      t.passYd  += +(st.pass_yd  ?? 0);
      t.passTd  += +(st.pass_td  ?? 0);
    }
  }

  // 2025 team rushing benchmarks — same source as the hardcoded HTML table.
  // Used as a fallback when Sleeper aggregation produces bad data for a team.
  // Pass att estimated as (65 avg total plays − rush att/g); teamYpc at league avg.
  const RUSH_ATT_2025 = {
    BUF:32.2,NYG:30.1,BAL:29.8,SEA:29.8,CHI:29.7,NE:29.1,GB:28.9,JAX:28.8,
    WAS:28.5,SF:28.3,PHI:28.1,ATL:28.1,HOU:27.9,TB:27.8,LAC:27.4,DAL:27.4,
    LAR:27.4,CAR:27.1,DEN:26.8,NYJ:26.8,IND:26.0,DET:26.0,NO:25.6,MIA:25.4,
    KC:25.3,CLE:24.8,MIN:24.1,PIT:23.9,CIN:22.4,TEN:22.2,LV:21.7,ARI:21.5,
  };

  const teamDB = {};
  let liveTeams = 0, fallbackTeams = 0;

  // ── Try live Sleeper aggregation first ──────────────────────────────────
  for (const [team, t] of Object.entries(teamAgg)) {
    const gp          = Math.max(1, t.gpMax);
    const rushAttPg   = +(t.rushAtt / gp).toFixed(1);
    const passAttPg   = +(t.passAtt / gp).toFixed(1);

    // Sanity-check: a real NFL team in a full season has ≥ 15 rush att/g and
    // ≥ 15 pass att/g.  Values below that flag corrupted team attribution
    // (e.g. a traded QB's pass stats landed on the wrong team).
    if (rushAttPg < 15 || passAttPg < 15) continue;

    const offPlaysPg  = +(rushAttPg + passAttPg).toFixed(1);
    const runRate     = +(rushAttPg / offPlaysPg * 100).toFixed(1);
    const passRate    = +(100 - runRate).toFixed(1);
    const teamYpc     = +(t.rushYd / t.rushAtt).toFixed(2);
    const totalYd     = t.rushYd + t.passYd;
    const totalAtt    = t.rushAtt + t.passAtt;
    const ypp         = +(totalYd / totalAtt).toFixed(2);
    const totalTd     = t.rushTd + t.passTd;
    const tdPg        = +(totalTd / gp).toFixed(2);
    const yppNorm    = Math.min(100, Math.max(0, (ypp - 4.5) / 3.0 * 100));
    const tdNorm     = Math.min(100, Math.max(0, (tdPg - 2.0) / 3.0 * 100));
    const offRating  = Math.round(yppNorm * 0.5 + tdNorm * 0.5);

    teamDB[team] = { rushAttPg, passAttPg, offPlaysPg, runRate, passRate,
                     teamYpc, ypp, tdPg, offRating };
    liveTeams++;
  }

  // ── Fallback: fill any missing team using 2025 hardcoded rush data ───────
  // Uses avg 65 total plays/g and 4.3 teamYpc when Sleeper aggregation failed.
  for (const [team, rushAttPg] of Object.entries(RUSH_ATT_2025)) {
    if (teamDB[team]) continue; // live data already present
    const passAttPg  = +(65 - rushAttPg).toFixed(1);
    const offPlaysPg = +(rushAttPg + passAttPg).toFixed(1);
    const runRate    = +(rushAttPg / offPlaysPg * 100).toFixed(1);
    const passRate   = +(100 - runRate).toFixed(1);
    // Off. Rating: neutral 50 since we don't have reliable pass yard/TD data
    teamDB[team] = { rushAttPg, passAttPg, offPlaysPg, runRate, passRate,
                     teamYpc: 4.3, ypp: 5.7, tdPg: 3.8, offRating: 50, estimated: true };
    fallbackTeams++;
  }

  progress(95, `Team DB: ${liveTeams} live + ${fallbackTeams} estimated teams`);
  console.log();

  // ── Step 6: Write output files ────────────────────────────────────────────
  progress(97, 'Writing data files…');
  const compJson    = JSON.stringify(compDB);
  const careerJson  = JSON.stringify(careerDB);
  const benchJson   = JSON.stringify({ avgRbCarryPct });
  const teamJson    = JSON.stringify(teamDB);

  writeFileSync(join(DATA_DIR, 'compdb.json'),     compJson);
  writeFileSync(join(DATA_DIR, 'careerdb.json'),   careerJson);
  writeFileSync(join(DATA_DIR, 'benchmarks.json'), benchJson);
  writeFileSync(join(DATA_DIR, 'teamdb.json'),     teamJson);
  progress(100, 'Done!');
  console.log('\n');

  const kb = str => (str.length / 1024).toFixed(0) + ' KB';
  console.log('  ✅  data/compdb.json     ', kb(compJson));
  console.log('  ✅  data/careerdb.json   ', kb(careerJson));
  console.log('  ✅  data/benchmarks.json ', kb(benchJson));
  console.log('  ✅  data/teamdb.json     ', kb(teamJson));
  console.log('\n  Next: git add data/ && git commit && git push\n');
}

main().catch(err => {
  console.error('\n❌  Build failed:', err.message);
  process.exit(1);
});

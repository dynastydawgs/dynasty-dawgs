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

  // ── Step 5b: Build teamDB from ESPN ──────────────────────────────────────
  // ESPN sports.core.api provides pre-computed perGameValue for all key stats
  // (rush att/g, pass att/g, YPC, TDs/g, total plays/g) without any offseason
  // player-directory misattribution issues.
  progress(92, 'Building team context database from ESPN…');

  // ESPN uses different abbreviations for a handful of teams
  const ESPN_ABBR_MAP = { WSH: 'WAS', JAC: 'JAX' };
  const normalizeAbbr = abbr => ESPN_ABBR_MAP[abbr] ?? abbr;

  // Step 1: fetch team list to resolve ESPN internal IDs → our abbreviations
  const espnTeamsData = await fetchJson(
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40'
  );
  const espnTeams = espnTeamsData.sports[0].leagues[0].teams.map(t => ({
    id:   t.team.id,
    abbr: normalizeAbbr(t.team.abbreviation),
  }));

  // Step 2: fetch regular-season stats for all 32 teams in parallel
  const ESPN_STATS_BASE =
    'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons';
  const espnFetches = espnTeams.map(({ id, abbr }) =>
    fetchJson(`${ESPN_STATS_BASE}/${recentYr}/types/2/teams/${id}/statistics`)
      .then(data => ({ abbr, data }))
      .catch(() => ({ abbr, data: null }))
  );
  const espnResults = await Promise.all(espnFetches);

  // Hardcoded rush att/g — last-resort fallback if ESPN is unavailable
  const RUSH_ATT_FALLBACK = {
    BUF:32.2,NYG:30.1,BAL:29.8,SEA:29.8,CHI:29.7,NE:29.1,GB:28.9,JAX:28.8,
    WAS:28.5,SF:28.3,PHI:28.1,ATL:28.1,HOU:27.9,TB:27.8,LAC:27.4,DAL:27.4,
    LAR:27.4,CAR:27.1,DEN:26.8,NYJ:26.8,IND:26.0,DET:26.0,NO:25.6,MIA:25.4,
    KC:25.3,CLE:24.8,MIN:24.1,PIT:23.9,CIN:22.4,TEN:22.2,LV:21.7,ARI:21.5,
  };

  const teamDB = {};
  let liveTeams = 0, fallbackTeams = 0;

  for (const { abbr, data } of espnResults) {
    if (!data?.splits?.categories) continue;

    // Flatten all stat entries across all category buckets into one lookup map
    const statMap = {};
    for (const cat of data.splits.categories) {
      for (const stat of cat.stats) statMap[stat.name] = stat;
    }

    // Use gamesPlayed stat for exact per-game division (perGameValue is int-rounded)
    const gp         = statMap['gamesPlayed']?.value               ?? 17;
    const rushAtt    = statMap['rushingAttempts']?.value            ?? null;
    const passAtt    = statMap['passingAttempts']?.value            ?? null;
    const totalPlays = statMap['totalOffensivePlays']?.value        ?? null;
    const totalYd    = statMap['totalYards']?.value                 ?? null;
    const totalPts   = statMap['totalPoints']?.value                ?? null;
    const teamYpc    = statMap['yardsPerRushAttempt']?.value        ?? null; // already a rate

    const rushAttPg  = rushAtt    !== null ? +(rushAtt    / gp).toFixed(1) : null;
    const passAttPg  = passAtt    !== null ? +(passAtt    / gp).toFixed(1) : null;
    const offPlaysPg = totalPlays !== null ? +(totalPlays / gp).toFixed(1)
                       : (rushAttPg !== null && passAttPg !== null
                           ? +(rushAttPg + passAttPg).toFixed(1) : null);
    const ppg        = totalPts   !== null ? +(totalPts   / gp).toFixed(1) : null;
    const ypp        = (totalYd !== null && totalPlays > 0)
                       ? +(totalYd / totalPlays).toFixed(2) : null;

    if (rushAttPg === null || passAttPg === null || rushAttPg < 15 || passAttPg < 15) continue;

    const runRate   = +(rushAttPg / offPlaysPg * 100).toFixed(1);
    const passRate  = +(100 - runRate).toFixed(1);
    // Off. Rating: yards/play (efficiency per snap) + pts/game (scoring output)
    // PPG and PPD rank teams identically (ESPN's totalDrives is broken/zero);
    // normalised so 14 ppg = 0, 35 ppg = 100 (NFL range ≈ 14–38).
    const yppNorm   = ypp !== null ? Math.min(100, Math.max(0, (ypp - 4.5) / 3.0 * 100)) : 50;
    const ppgNorm   = ppg !== null ? Math.min(100, Math.max(0, (ppg - 14) / (35 - 14) * 100)) : 50;
    const offRating = Math.round(yppNorm * 0.5 + ppgNorm * 0.5);

    teamDB[abbr] = {
      rushAttPg:  +rushAttPg.toFixed(1),
      passAttPg:  +passAttPg.toFixed(1),
      offPlaysPg: offPlaysPg ?? +(rushAttPg + passAttPg).toFixed(1),
      runRate,
      passRate,
      teamYpc:    teamYpc !== null ? +teamYpc.toFixed(2) : 4.3,
      ypp:        ypp     !== null ? +ypp.toFixed(2)     : 5.7,
      ppg:        ppg     !== null ? +ppg.toFixed(1)     : null,
      offRating,
    };
    liveTeams++;
  }

  // Fallback: any team ESPN didn't cover gets hardcoded estimates
  for (const [team, rushAttPg] of Object.entries(RUSH_ATT_FALLBACK)) {
    if (teamDB[team]) continue;
    const passAttPg  = +(65 - rushAttPg).toFixed(1);
    const offPlaysPg = 65.0;
    const runRate    = +(rushAttPg / offPlaysPg * 100).toFixed(1);
    const passRate   = +(100 - runRate).toFixed(1);
    teamDB[team] = { rushAttPg, passAttPg, offPlaysPg, runRate, passRate,
                     teamYpc: 4.3, ypp: 5.7, tdPg: 3.8, offRating: 50, estimated: true };
    fallbackTeams++;
  }

  progress(95, `Team DB: ${liveTeams} live (ESPN) + ${fallbackTeams} estimated teams`);
  console.log();

  // ── Step 5c: Build depthDB from ESPN depth charts + rosters ──────────────
  // Fetches the offensive formation depth chart (rank 1 = starter) and roster
  // for all 32 teams.  Athlete IDs are parsed from $ref URLs and cross-referenced
  // with the inline roster response — no additional per-athlete requests needed.
  progress(96, 'Building depth chart database from ESPN…');

  const ESPN_DEPTH_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
  const ESPN_ROSTER_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const SKILL_POS = { qb: 'QB', rb: 'RB', wr: 'WR', te: 'TE' };

  const depthFetches = espnTeams.map(({ id, abbr }) =>
    Promise.all([
      fetchJson(`${ESPN_DEPTH_BASE}/seasons/${recentYr}/teams/${id}/depthcharts`).catch(() => null),
      fetchJson(`${ESPN_ROSTER_BASE}/teams/${id}/roster`).catch(() => null),
    ]).then(([dcData, rosterData]) => ({ abbr, dcData, rosterData }))
  );
  const depthResults = await Promise.all(depthFetches);

  const depthDB = {};
  let depthTeams = 0;

  for (const { abbr, dcData, rosterData } of depthResults) {
    // Build ESPN player ID → { name, status } from roster (all inline, no $refs)
    const rosterMap = {};
    for (const player of (rosterData?.athletes ?? [])) {
      const injStatus    = player.injuries?.[0]?.status ?? null;
      const activeStatus = player.status?.name ?? 'Active';
      rosterMap[player.id] = {
        name:   player.displayName ?? `${player.firstName} ${player.lastName}`,
        status: injStatus ?? (activeStatus !== 'Active' ? activeStatus : null),
      };
    }

    // Offensive formation = the one that has a 'qb' position group
    const offFormation = (dcData?.items ?? []).find(f => f.positions?.qb);
    if (!offFormation) continue;

    const teamDepth = {};
    for (const [dcKey, posAbbr] of Object.entries(SKILL_POS)) {
      const posGroup = offFormation.positions[dcKey];
      if (!posGroup?.athletes?.length) continue;

      // Extract ESPN athlete ID from the $ref URL without a follow-up fetch
      teamDepth[posAbbr] = posGroup.athletes
        .sort((a, b) => a.rank - b.rank)
        .map(a => {
          const espnId = a.athlete.$ref.split('/').pop();
          const info   = rosterMap[espnId] ?? {};
          return { name: info.name ?? null, rank: a.rank, status: info.status ?? null };
        })
        .filter(e => e.name !== null);
    }

    if (Object.keys(teamDepth).length) { depthDB[abbr] = teamDepth; depthTeams++; }
  }

  progress(97, `Depth DB: ${depthTeams} teams`);
  console.log();

  // ── Step 6: Write output files ────────────────────────────────────────────
  progress(98, 'Writing data files…');
  const compJson    = JSON.stringify(compDB);
  const careerJson  = JSON.stringify(careerDB);
  const benchJson   = JSON.stringify({ avgRbCarryPct });
  const teamJson    = JSON.stringify(teamDB);
  const depthJson   = JSON.stringify(depthDB);

  writeFileSync(join(DATA_DIR, 'compdb.json'),     compJson);
  writeFileSync(join(DATA_DIR, 'careerdb.json'),   careerJson);
  writeFileSync(join(DATA_DIR, 'benchmarks.json'), benchJson);
  writeFileSync(join(DATA_DIR, 'teamdb.json'),     teamJson);
  writeFileSync(join(DATA_DIR, 'depthdb.json'),    depthJson);
  progress(100, 'Done!');
  console.log('\n');

  const kb = str => (str.length / 1024).toFixed(0) + ' KB';
  console.log('  ✅  data/compdb.json     ', kb(compJson));
  console.log('  ✅  data/careerdb.json   ', kb(careerJson));
  console.log('  ✅  data/benchmarks.json ', kb(benchJson));
  console.log('  ✅  data/teamdb.json     ', kb(teamJson));
  console.log('  ✅  data/depthdb.json    ', kb(depthJson));
  console.log('\n  Next: git add data/ && git commit && git push\n');
}

main().catch(err => {
  console.error('\n❌  Build failed:', err.message);
  process.exit(1);
});

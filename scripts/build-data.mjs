// scripts/build-data.mjs  [v2-id-join]
// Pre-builds static JSON files served from data/ on GitHub Pages.
// Run locally:  node scripts/build-data.mjs
// Also runs automatically every Tuesday via .github/workflows/build-data.yml
//
// Output files:
//   data/compdb.json      — comp buckets: "POS_tier_carYr" → [p15, p50, p85]
//   data/careerdb.json    — pid → [{season, ppr, ppg, games, touches}]
//   data/benchmarks.json  — { avgRb*, avgTeam* } — workload, receiving, speed, efficiency medians for top-32 RBs
//   data/teamdb.json      — teamAbbr → {rushAttPg, passAttPg, offPlaysPg, …, offRating}
//   data/depthdb.json     — teamAbbr → {QB/RB/WR/TE: [{name, rank, status}]}
//   data/ryoedb.json      — playerName → {ryoeTotal, ryoePerAtt, expectedYards, pctOverExpected}
//   data/advstatsdb.json  — playerName → {successPct, mtfPerAtt, brkTkl, att}

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';

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

// Fetch a .csv.gz file and return parsed rows as array-of-objects.
// Uses only Node.js built-ins (zlib + stream) — no npm packages needed.
function parseCSVLine(line) {
  const fields = []; let field = ''; let inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { fields.push(field); field = ''; }
    else { field += c; }
  }
  fields.push(field);
  return fields;
}
async function fetchGzipCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const chunks = [];
  for await (const chunk of Readable.fromWeb(res.body).pipe(createGunzip())) chunks.push(chunk);
  const lines   = Buffer.concat(chunks).toString('utf-8').split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row  = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    return row;
  });
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

  // ── Step 3: Build careerDB ────────────────────────────────────────────────
  progress(40, 'Building career database…');
  const rawCareers = {};
  const pidToPos   = {};

  for (const yr of HIST_SEASONS) {
    const raw = seasonMaps[yr];
    // Sleeper API v2 returns an array; v1 returned a pid-keyed object.
    // Normalize to a flat list of { pid, stats, pos }.
    const entries = Array.isArray(raw)
      ? raw.map(e => ({ pid: String(e.player_id), stats: e.stats ?? {}, pos: e.player?.position ?? null }))
      : Object.entries(raw).map(([pid, stats]) => ({ pid, stats, pos: stats.pos ?? null }));

    for (const { pid, stats, pos } of entries) {
      const ppr   = parseFloat(stats.pts_ppr   ?? 0);
      const games = parseFloat(stats.gms_active ?? stats.gp ?? stats.gms ?? 0);
      if (ppr < 15 || games < 5) continue;
      if (pos && !pidToPos[pid]) pidToPos[pid] = pos;
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

  // ── Step 5: Fetch nflverse player stats (used by Step 5e for statTeamDB) ────
  // Benchmark computation moved to Step 5f where the PBP is already available —
  // carries/rec/targets extracted from PBP in one pass, snap% from snap_counts.
  progress(85, 'Fetching nflverse player stats…');
  const recentYr        = currentYear - 1;
  const AVG_TEAM_TGT_PG = 33.5;  // stable league-avg pass targets/game
  const AVG_TEAM_REC_PG = 22.0;  // stable league-avg receptions/game

  // Team situation benchmarks — seeded with estimates, updated from teamDB in Step 5a.
  let avgTeamRushPg    = 26.0;  // avg team rush att/game across all 32 teams
  let avgTeamPassPg    = 33.0;  // avg team pass att/game
  let avgTeamOffPlaysPg= 63.0;  // avg team off plays/game (rush + pass att)
  let avgTeamRunRate   = 41.0;  // avg team run rate %
  let avgTeamYpc       =  4.2;  // avg team rush yards/attempt

  // RB workload benchmarks — seeded with estimates, updated from PBP in Step 5f.
  let avgRbCarryPct       = 44.1;
  let avgRbTouchesPg      = 15.0;
  let avgRbTouchShare     = 31.0;
  let avgRbTargetShare    =  9.0;
  let avgRbSnapPct        = 62.0;
  let avgRbRzCarryShare   = 38.0; // median RZ carry share among top-32 RBs
  let avgRbRzCarries      = 22.0; // median RZ carries among top-32 RBs
  let avgRbRzTdRate       = 17.0; // mean RZ TD rate % (TDs / RZ carries) among top-32 RBs
  let avgRbSuccessPct     = 41.0; // mean success rate % among top-32 RBs
  let avgRbMtfPerAtt      = 0.063;// mean missed tackles forced per attempt among top-32 RBs
  let avgRbThirdDownSnaps = 30.0; // mean 3rd-down snap % (player snaps / team 3rd-dn plays) among top-32 RBs
  let avgRbTgtPg          =  3.5; // median tgt/g among top-32 RBs by carries
  let avgRbRecPg          =  2.5; // median rec/g among top-32 RBs by carries
  let avgRbRecYdPg        = 22.0; // median rec yds/g among top-32 RBs by carries
  let avgRbRushYdPg       = 60.0; // median rush yds/g among top-32 RBs by carries
  // Speed benchmarks — seeded with 2025 NGS estimates, updated from top-32 pool below
  let avgRbMaxSpeed       = 20.5; // median top speed (mph) among top-32 RBs by carries
  let avgRbAvgTimeToLos   =  2.5; // median avg time to LOS (sec) among top-32 RBs
  let avgRbEfficiency     = 65.0; // median NGS efficiency score among top-32 RBs
  // RB efficiency benchmarks — seeded with estimates, updated below.
  let avgRbYpc         =  4.3;   // avg yards/carry (from PBP, same top-64 pool)
  let avgRbYpcN        =  0;
  let avgRbPpt         =  0.90;  // avg PPR pts/touch (from careerDB, recentYr only)
  let avgRbPptN        =  0;

  let psRows = [];
  try {
    psRows = await fetchGzipCSV(
      `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${recentYr}.csv.gz`
    );
    console.log(`\n  player_stats: ${psRows.length} rows`);
  } catch(e) {
    // 404 is expected — nflverse doesn't always publish per-year player_stats files.
    // statTeamDB falls back to the roster pass; benchmarks are sourced from PBP.
  }
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

  // Compute league-average team situation benchmarks from real (non-estimated) teams only
  const _liveTeamRows = Object.values(teamDB).filter(t => !t.estimated);
  if (_liveTeamRows.length >= 20) {
    const _tmMean = field => {
      const vals = _liveTeamRows.map(t => t[field]).filter(v => v != null);
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null;
    };
    avgTeamRushPg     = _tmMean('rushAttPg')  ?? avgTeamRushPg;
    avgTeamPassPg     = _tmMean('passAttPg')  ?? avgTeamPassPg;
    avgTeamOffPlaysPg = _tmMean('offPlaysPg') ?? avgTeamOffPlaysPg;
    avgTeamRunRate    = _tmMean('runRate')     ?? avgTeamRunRate;
    avgTeamYpc        = _tmMean('teamYpc')    ?? avgTeamYpc;
    console.log(`  Team bench (${_liveTeamRows.length} live teams, mean) — rush: ${avgTeamRushPg}/g · pass: ${avgTeamPassPg}/g · plays: ${avgTeamOffPlaysPg}/g · run%: ${avgTeamRunRate}% · ypc: ${avgTeamYpc}`);
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

  // Depth charts are always current — try the upcoming season first (2026),
  // fall back to recentYr (2025) if ESPN hasn't published it yet.
  const depthFetches = espnTeams.map(({ id, abbr }) =>
    Promise.all([
      fetchJson(`${ESPN_DEPTH_BASE}/seasons/${currentYear}/teams/${id}/depthcharts`)
        .catch(() => fetchJson(`${ESPN_DEPTH_BASE}/seasons/${recentYr}/teams/${id}/depthcharts`)
        .catch(() => null)),
      fetchJson(`${ESPN_ROSTER_BASE}/teams/${id}/roster`).catch(() => null),
    ]).then(([dcData, rosterData]) => ({ abbr, dcData, rosterData }))
  );
  const depthResults = await Promise.all(depthFetches);

  const depthDB = {};
  let depthTeams = 0;

  for (const { abbr, dcData, rosterData } of depthResults) {
    // Build ESPN player ID → { name, status } from roster (all inline, no $refs)
    // ESPN roster endpoint returns position groups: athletes[i].items = [player, ...]
    const rosterMap = {};
    const _rosterPlayers = (rosterData?.athletes ?? []).flatMap(g => g.items ?? []);
    for (const player of _rosterPlayers) {
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
          const espnId = a.athlete.$ref.split('/').pop().split('?')[0];
          const info   = rosterMap[espnId] ?? {};
          return { name: info.name ?? null, rank: a.rank, status: info.status ?? null };
        })
        .filter(e => e.name !== null);
    }

    if (Object.keys(teamDepth).length) { depthDB[abbr] = teamDepth; depthTeams++; }
  }

  progress(97, `Depth DB: ${depthTeams} teams`);
  console.log();

  // ── Step 5d: Build ryoeDB from nflverse Next Gen Stats ───────────────────
  // nflverse mirrors official NFL NGS tracking data. The ngs_rushing.csv.gz
  // file has rush_yards_over_expected and rush_yards_over_expected_per_att for
  // all ball-carriers. Week 0 rows are season aggregates.
  progress(97, 'Building RYOE database from nflverse/NGS…');
  const ryoeDB = {};
  let ryoePlayers = 0;
  try {
    const NGS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_rushing.csv.gz';
    const ngsRows = await fetchGzipCSV(NGS_URL);
    const ngsYear = String(recentYr);
    for (const row of ngsRows) {
      if (row.season !== ngsYear || row.week !== '0') continue;
      const name     = row.player_display_name?.trim();
      const attempts = parseFloat(row.rush_attempts ?? 0);
      if (!name || attempts < 10) continue;
      const ryoeTotal   = parseFloat(row.rush_yards_over_expected         ?? 'NaN');
      const ryoePerAtt  = parseFloat(row.rush_yards_over_expected_per_att ?? 'NaN');
      const expYards    = parseFloat(row.expected_rush_yards              ?? 'NaN');
      const pctOver     = parseFloat(row.rush_pct_over_expected           ?? 'NaN');
      const maxSpeed    = parseFloat(row.max_speed                        ?? 'NaN');
      const avgTimeToLos= parseFloat(row.avg_time_to_los                  ?? 'NaN');
      const efficiency  = parseFloat(row.efficiency                       ?? 'NaN');
      if (isNaN(ryoeTotal) || isNaN(ryoePerAtt)) continue;
      // team_abbr is the team the player was on during this stat season —
      // used client-side to detect when a player switched teams in the offseason.
      const rawTeam = row.team_abbr?.trim() ?? '';
      const ngsTeam = rawTeam === 'JAC' ? 'JAX' : rawTeam === 'LA' ? 'LAR' : rawTeam;
      ryoeDB[name] = {
        ryoeTotal:       Math.round(ryoeTotal  * 10) / 10,
        ryoePerAtt:      Math.round(ryoePerAtt * 1000) / 1000,
        expectedYards:   Math.round(expYards),
        pctOverExpected: isNaN(pctOver)      ? null : Math.round(pctOver      * 1000) / 10,
        maxSpeed:        isNaN(maxSpeed)     ? null : Math.round(maxSpeed     * 10)   / 10,
        avgTimeToLos:    isNaN(avgTimeToLos) ? null : Math.round(avgTimeToLos * 100)  / 100,
        efficiency:      isNaN(efficiency)   ? null : Math.round(efficiency   * 10)   / 10,
        attempts:        Math.round(attempts),
        team:            ngsTeam || null,
      };
      ryoePlayers++;
    }
  } catch(e) {
    console.warn('\n  ⚠️  RYOE fetch failed:', e.message, '— ryoedb.json will be empty');
  }
  progress(98, `RYOE DB: ${ryoePlayers} players (NGS)`);
  console.log();

  // ── Step 5e: Build statTeamDB (sleeper_id → 2025 team) ──────────────────
  // Two-pass strategy for maximum coverage:
  //   Pass 1: player_stats_2025 (actual game-log data) — most reliable; covers
  //           every player who appeared in a 2025 regular-season game.
  //   Pass 2: roster_2025 (weekly roster snapshots) — catches players who were
  //           on a roster but didn't play (IR, inactive). Acts as fallback.
  // Both passes use a gsis_id → sleeper_id bridge built from players.csv to
  // resolve IDs when the sleeper_id column is blank in the source files.
  progress(98, 'Building 2025 player-team lookup…');
  const statTeamDB = {};
  let statTeamCount = 0;
  try {
    // nflverse → Sleeper team abbreviation differences
    // nflverse → Sleeper team abbreviation differences
    const NV_ABBR = { LA: 'LAR', JAC: 'JAX' };

    // ── Bridge: players.csv  →  gsis_id → sleeper_id ────────────────────────
    const gsisBridge = {};
    try {
      const res = await fetch('https://github.com/nflverse/nflverse-data/releases/download/players/players.csv');
      if (res.ok) {
        const lines = (await res.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        for (const line of lines.slice(1)) {
          const vals = parseCSVLine(line);
          const row  = {};
          hdrs.forEach((h, i) => { row[h] = vals[i] ?? ''; });
          const g = row.gsis_id?.trim(), s = row.sleeper_id?.trim();
          if (g && s) gsisBridge[g] = s;
        }
        console.log(`  gsis→sleeper bridge: ${Object.keys(gsisBridge).length} entries`);
      }
    } catch(e) { console.warn('  ⚠️  players.csv bridge failed:', e.message); }

    // Resolve a row's sleeper_id: direct column → gsis bridge (stats files
    // use player_id for GSIS; roster files use gsis_id).
    const resolveSid = row =>
      row.sleeper_id?.trim()
      || gsisBridge[row.player_id?.trim()]
      || gsisBridge[row.gsis_id?.trim()]
      || '';

    // Latest-week tracker: keeps the highest-week entry so mid-season trades
    // resolve to the team the player finished the season with.
    const latest = {}; // sleeper_id → { week, team }
    const bump   = (sid, week, rawTeam) => {
      if (!sid || !rawTeam) return;
      const team = NV_ABBR[rawTeam] ?? rawTeam;
      if (!latest[sid] || week > latest[sid].week) latest[sid] = { week, team };
    };

    // ── Pass 1: player_stats (reused from Step 5 — no duplicate fetch) ──────
    {
      let hits = 0;
      for (const row of psRows) {
        if (row.season_type?.trim() !== 'REG') continue;
        const sid = resolveSid(row);
        bump(sid, parseInt(row.week) || 0, row.recent_team?.trim());
        if (sid) hits++;
      }
      console.log(`  player_stats pass: ${hits} rows resolved`);
    }

    // ── Pass 2: weekly roster (IR / inactive fallback) ────────────────────────
    try {
      const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${recentYr}.csv`);
      if (res.ok) {
        const lines = (await res.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        let hits = 0;
        for (const line of lines.slice(1)) {
          const vals = parseCSVLine(line);
          const row  = {};
          hdrs.forEach((h, i) => { row[h] = vals[i] ?? ''; });
          if (row.game_type && row.game_type !== 'REG') continue;
          const sid = resolveSid(row);
          bump(sid, parseInt(row.week) || 0, row.team?.trim());
          if (sid) hits++;
        }
        console.log(`  roster pass: ${hits} rows resolved`);
      }
    } catch(e) { console.warn('  ⚠️  roster fetch failed:', e.message); }

    for (const [sid, { team }] of Object.entries(latest)) {
      if (sid && team) { statTeamDB[sid] = team; statTeamCount++; }
    }
  } catch(e) {
    console.warn('\n  ⚠️  statTeamDB build failed:', e.message, '— statteamdb.json will be empty');
  }
  progress(99, `Stat-team DB: ${statTeamCount} players`);
  console.log();

  // ── Step 5f: Build advstatsDB (Success% + MTF/att) ───────────────────────
  // Success%  — nflverse play-by-play, pre-computed `success` column.
  //   Definition: ≥40% of needed yards on 1st down, ≥60% on 2nd, 100% on 3rd/4th.
  // MTF/att   — PFR advanced rushing stats via nflverse (brk_tkl / att).
  // Both keyed by player display name (matches ryoedb.json / Sleeper full_name).
  //
  // Name normalisation: PFR strips apostrophes ("DAndre Swift") and omits suffixes;
  // nflverse keeps them ("D'Andre Swift", "Kenneth Walker III").  Normalise both
  // sides before merging so every player gets one unified entry.
  // Also filter out QBs (≥50 rush att catches scrambles) using the nflverse position field.
  progress(99, 'Building advanced RB stats (Success% + MTF/att)…');
  const advstatsDB = {};
  let advstatsCount = 0;
  try {
    // Shared name-normalisation: strip apostrophes/periods, collapse whitespace,
    // drop name suffixes (Jr./Sr./II/III/IV/V).  Used as dict key for merging.
    const normKey = n => (n ?? '')
      .replace(/['.]/g, '')
      .replace(/\s+(jr|sr|ii|iii|iv|v)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // ── 1. players.csv → GSIS ↔ normalised-name + position ──────────────────
    // Built first so both MTF and success lookups can use it.
    const gsisToNormName = {};  // gsis_id → normKey(display_name)
    const normToDisplay  = {};  // normKey  → canonical display_name (for final key)
    const gsisToPos      = {};  // gsis_id  → position (to filter QBs)
    const pfrToGsis      = {};  // pfr_id   → gsis_id (for snap_counts bridge)
    try {
      const res = await fetch(
        'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv'
      );
      if (res.ok) {
        const lines = (await res.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        const [gI, dI, pI, pfrI] = ['gsis_id', 'display_name', 'position', 'pfr_id'].map(h => hdrs.indexOf(h));
        for (const line of lines.slice(1)) {
          const v = parseCSVLine(line);
          const g = v[gI]?.trim(), d = v[dI]?.trim(), p = v[pI]?.trim();
          if (!g || !d) continue;
          const nk = normKey(d);
          gsisToNormName[g] = nk;
          gsisToPos[g]      = p;
          if (!normToDisplay[nk]) normToDisplay[nk] = d; // first-seen wins
          const pfr = pfrI >= 0 ? v[pfrI]?.trim() : null;
          if (pfr) pfrToGsis[pfr] = g;
        }
        console.log(`\n  GSIS→name bridge: ${Object.keys(gsisToNormName).length} entries, PFR→GSIS: ${Object.keys(pfrToGsis).length} entries`);
      }
    } catch(e) { console.warn('\n  ⚠️  players.csv bridge failed:', e.message); }

    // ── 2. PFR advanced rushing → MTF per attempt ───────────────────────────
    const mtfMap = {};  // normKey → { mtfPerAtt, brkTkl, att }
    try {
      const pfrRes = await fetch(
        'https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_season_rush.csv'
      );
      if (pfrRes.ok) {
        const lines = (await pfrRes.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        const [sI, nI, aI, bI, posI] = ['season', 'player', 'att', 'brk_tkl', 'pos']
          .map(h => hdrs.indexOf(h));
        for (const line of lines.slice(1)) {
          const v   = parseCSVLine(line);
          if (v[sI] !== String(recentYr)) continue;
          if (posI >= 0 && v[posI]?.trim() === 'QB') continue; // skip QBs
          const att = parseFloat(v[aI]) || 0;
          if (att < 50) continue;
          const brkTkl = parseFloat(v[bI]) || 0;
          const name   = v[nI]?.trim();
          if (!name) continue;
          const nk = normKey(name);
          mtfMap[nk] = {
            mtfPerAtt: Math.round(brkTkl / att * 1000) / 1000,
            brkTkl:    Math.round(brkTkl),
            att:       Math.round(att),
          };
          if (!normToDisplay[nk]) normToDisplay[nk] = name;
        }
        console.log(`  PFR advstats MTF: ${Object.keys(mtfMap).length} players`);
      }
    } catch(e) { console.warn('\n  ⚠️  PFR advstats fetch failed:', e.message); }

    // ── 3. Play-by-play → success rate + workload by GSIS ───────────────────
    // Single pass: rush plays → success rate + carries; pass plays → targets/rec.
    // workloadByGsis is used below (step 6) to compute RB workload benchmarks.
    // thirdDownKeys is used in step 3b to filter participation rows.
    const successByGsis        = {};
    const workloadByGsis       = {}; // gsis_id → { carries, rzCarries, rushYds, tgts, rec, gameIds, team }
    const teamCarriesPerGame   = {}; // gameId → { posteam → total rush attempts (incl. QB) }
    const teamRzCarriesPerGame = {}; // gameId → { posteam → RZ rush attempts (yardline_100 ≤ 20) }
    const teamThirdDownPlaysPerGame = {}; // gameId → { posteam → 3rd-down play count } (denominator for snap%)
    const thirdDownMap         = new Map(); // game_id → Set<play_id (int)> for REG 3rd-down plays
    try {
      const pbpRes = await fetch(
        `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${recentYr}.csv`
      );
      if (!pbpRes.ok) {
        console.warn(`  ⚠️  PBP fetch returned HTTP ${pbpRes.status} for play_by_play_${recentYr}.csv`);
      } else {
        const lines = (await pbpRes.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        const [raI, stI, ridI, sucI, paI, recvI, cpI, gidI, ryI, pteamI, ylI, rtdI, dnI, pidI, ydsI] =
          ['rush_attempt', 'season_type', 'rusher_player_id', 'success',
           'pass_attempt', 'receiver_player_id', 'complete_pass', 'game_id',
           'rushing_yards', 'posteam', 'yardline_100', 'rush_touchdown', 'down', 'play_id',
           'yards_gained']
          .map(h => hdrs.indexOf(h));
        for (const line of lines.slice(1)) {
          const v = parseCSVLine(line);
          if (v[stI] !== 'REG') continue;
          const gameId = gidI >= 0 ? v[gidI]?.trim() : null;

          // Track 3rd-down plays for participation join + per-game team totals for snap% denominator
          if (dnI >= 0 && v[dnI] === '3' && pidI >= 0 && gameId) {
            const pid3 = parseInt(v[pidI], 10);
            if (!isNaN(pid3)) {
              if (!thirdDownMap.has(gameId)) thirdDownMap.set(gameId, new Set());
              thirdDownMap.get(gameId).add(pid3);
            }
            const pteam3 = pteamI >= 0 ? v[pteamI]?.trim() : null;
            if (pteam3) {
              if (!teamThirdDownPlaysPerGame[gameId]) teamThirdDownPlaysPerGame[gameId] = {};
              teamThirdDownPlaysPerGame[gameId][pteam3] = (teamThirdDownPlaysPerGame[gameId][pteam3] ?? 0) + 1;
            }
          }

          if (v[raI] === '1') {
            const gsis  = v[ridI]?.trim();
            const pteam = pteamI >= 0 ? v[pteamI]?.trim() : null;
            const yl    = ylI >= 0 ? parseFloat(v[ylI]) : NaN;
            const inRz  = !isNaN(yl) && yl <= 20;

            // Track ALL team rushes (incl. QB) for carry-share denominator
            if (gameId && pteam) {
              if (!teamCarriesPerGame[gameId]) teamCarriesPerGame[gameId] = {};
              teamCarriesPerGame[gameId][pteam] = (teamCarriesPerGame[gameId][pteam] ?? 0) + 1;
              if (inRz) {
                if (!teamRzCarriesPerGame[gameId]) teamRzCarriesPerGame[gameId] = {};
                teamRzCarriesPerGame[gameId][pteam] = (teamRzCarriesPerGame[gameId][pteam] ?? 0) + 1;
              }
            }

            if (gsis) {
              const isQb = gsisToPos[gsis] === 'QB';
              const succ = v[sucI];
              if (!isQb && succ && succ !== 'NA') {
                if (!successByGsis[gsis]) successByGsis[gsis] = { sum: 0, n: 0 };
                successByGsis[gsis].sum += parseFloat(succ) || 0;
                successByGsis[gsis].n++;
              }
              if (!isQb) {
                if (!workloadByGsis[gsis]) workloadByGsis[gsis] = { carries: 0, rzCarries: 0, rzTDs: 0, rushYds: 0, tgts: 0, rec: 0, recYds: 0, gameIds: new Set(), team: null };
                workloadByGsis[gsis].carries++;
                if (inRz) {
                  workloadByGsis[gsis].rzCarries++;
                  if (rtdI >= 0 && v[rtdI] === '1') workloadByGsis[gsis].rzTDs++;
                }
                workloadByGsis[gsis].rushYds += ryI >= 0 ? (parseFloat(v[ryI]) || 0) : 0;
                if (gameId) workloadByGsis[gsis].gameIds.add(gameId);
                if (pteam && !workloadByGsis[gsis].team) workloadByGsis[gsis].team = pteam;
              }
            }
          }

          if (paI >= 0 && v[paI] === '1') {
            const gsis = recvI >= 0 ? v[recvI]?.trim() : null;
            if (gsis) {
              if (!workloadByGsis[gsis]) workloadByGsis[gsis] = { carries: 0, rzCarries: 0, rzTDs: 0, rushYds: 0, tgts: 0, rec: 0, recYds: 0, gameIds: new Set(), team: null };
              workloadByGsis[gsis].tgts++;
              if (gameId) workloadByGsis[gsis].gameIds.add(gameId);
              if (cpI >= 0 && v[cpI] === '1') {
                workloadByGsis[gsis].rec++;
                workloadByGsis[gsis].recYds += ydsI >= 0 ? (parseFloat(v[ydsI]) || 0) : 0;
              }
            }
          }
        }
        console.log(`  PBP: ${Object.keys(successByGsis).length} players w/ success rate, ${Object.keys(workloadByGsis).length} w/ workload`);
      }
    } catch(e) { console.warn('\n  ⚠️  PBP fetch failed:', e.message); }

    // ── 3b. Participation → 3rd-down snaps on field per GSIS (RBs only) ────────
    // pbp_participation has one row per play with offense_players as space-separated GSIS IDs.
    // Join to PBP via game_id + play_id to filter REG 3rd-down plays only.
    const thirdDownSnapsByGsis  = {};  // gsis_id → count of REG 3rd-down snaps on field
    const thirdDownGamesByGsis  = {};  // gsis_id → Set<gameId> games appeared in on 3rd down
    try {
      const partRes = await fetch(
        `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${recentYr}.csv`
      );
      if (partRes.ok) {
        const lines = (await partRes.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        // nflverse participation uses 'nflverse_game_id' in some releases, 'game_id' in others
        const pgidI = ['nflverse_game_id', 'game_id'].reduce((found, col) => found >= 0 ? found : hdrs.indexOf(col), -1);
        const ppidI = hdrs.indexOf('play_id');
        const offI  = hdrs.indexOf('offense_players');
        if (pgidI >= 0 && ppidI >= 0 && offI >= 0) {
          for (const line of lines.slice(1)) {
            const v      = parseCSVLine(line);
            const gameId = v[pgidI]?.trim();
            const pid    = parseInt(v[ppidI], 10);
            if (!gameId || isNaN(pid)) continue;
            if (!thirdDownMap.has(gameId)) continue;
            if (!thirdDownMap.get(gameId).has(pid)) continue;
            const players = (v[offI] ?? '').trim().split(';').filter(Boolean);
            for (const gsis of players) {
              if (gsisToPos[gsis] !== 'RB') continue;
              thirdDownSnapsByGsis[gsis] = (thirdDownSnapsByGsis[gsis] ?? 0) + 1;
              if (!thirdDownGamesByGsis[gsis]) thirdDownGamesByGsis[gsis] = new Set();
              thirdDownGamesByGsis[gsis].add(gameId);
            }
          }
        } else {
          console.warn(`  ⚠️  Participation: missing required columns. Headers: ${hdrs.join(', ')}`);
        }
        console.log(`  3rd-down snaps: ${Object.keys(thirdDownSnapsByGsis).length} RBs tracked (${thirdDownMap.size} games, ${[...thirdDownMap.values()].reduce((s,v)=>s+v.size,0)} plays)`);
      } else {
        console.warn(`  ⚠️  Participation fetch returned ${partRes.status}`);
      }
    } catch(e) { console.warn('\n  ⚠️  Participation fetch failed:', e.message); }

    // ── 4. Build success rate by normKey ────────────────────────────────────
    const successMap = {};  // normKey → successPct
    for (const [gsis, { sum, n }] of Object.entries(successByGsis)) {
      if (n < 50) continue;
      const nk = gsisToNormName[gsis];
      if (!nk) continue;
      successMap[nk] = Math.round((sum / n) * 1000) / 10;
    }
    console.log(`  Success rate: ${Object.keys(successMap).length} qualified players`);

    // ── 5a. Build carry share + RZ carry share maps from PBP ─────────────────
    const carryShareMap   = {};  // normKey → carrySharePct
    const rzCarryShareMap = {};  // normKey → rzCarrySharePct
    const rzCarriesMap    = {};  // normKey → rzCarries count
    for (const [gsis, d] of Object.entries(workloadByGsis)) {
      if (!d.team) continue;
      const nk = gsisToNormName[gsis];
      if (!nk) continue;

      // Overall carry share (min 20 carries)
      if (d.carries >= 20) {
        const teamCarries = [...d.gameIds].reduce((sum, gid) =>
          sum + (teamCarriesPerGame[gid]?.[d.team] ?? 0), 0);
        if (teamCarries >= 1) {
          carryShareMap[nk] = Math.round(d.carries / teamCarries * 1000) / 10;
          if (!normToDisplay[nk]) normToDisplay[nk] = gsisToNormName[gsis];
        }
      }

      // RZ carry share + RZ TD rate (min 8 RZ carries — starters average ~20-35/season)
      if ((d.rzCarries ?? 0) >= 8) {
        const teamRzCarries = [...d.gameIds].reduce((sum, gid) =>
          sum + (teamRzCarriesPerGame[gid]?.[d.team] ?? 0), 0);
        if (teamRzCarries >= 1) {
          rzCarryShareMap[nk] = Math.round(d.rzCarries / teamRzCarries * 1000) / 10;
          rzCarriesMap[nk]    = d.rzCarries;
          if (!normToDisplay[nk]) normToDisplay[nk] = gsisToNormName[gsis];
        }
      }
    }
    console.log(`  Carry share: ${Object.keys(carryShareMap).length} players`);
    console.log(`  RZ carry share: ${Object.keys(rzCarryShareMap).length} players`);

    // ── 5a-ii. RZ TD rate (rzTDs / rzCarries, min 8 RZ carries) ─────────────
    const rzTdRateMap = {};  // normKey → rzTdRate (0–100 pct)
    const rzTdMap     = {};  // normKey → rzTDs count
    for (const [gsis, d] of Object.entries(workloadByGsis)) {
      if ((d.rzCarries ?? 0) < 8) continue;
      const nk = gsisToNormName[gsis];
      if (!nk) continue;
      rzTdRateMap[nk] = Math.round(d.rzTDs / d.rzCarries * 1000) / 10;
      rzTdMap[nk]     = d.rzTDs;
    }
    console.log(`  RZ TD rate: ${Object.keys(rzTdRateMap).length} players`);

    // Build thirdDownSnapPctMap: normKey → snap% (player 3rd-dn snaps / team 3rd-dn plays
    // in games the player actually appeared in — same denominator pattern as carry share).
    // Min 5 snaps to exclude garbage-time / injury-limited players.
    const thirdDownSnapPctMap  = {};  // normKey → snap%
    const thirdDownSnapRawMap  = {};  // normKey → { snaps, games }
    for (const [gsis, snaps] of Object.entries(thirdDownSnapsByGsis)) {
      if (snaps < 20) continue;
      const nk = gsisToNormName[gsis];
      if (!nk) continue;
      const d = workloadByGsis[gsis];
      if (!d?.team) continue;
      // Use the games the player actually appeared in on 3rd down (from participation),
      // not their PBP carry/target games — blocks without touches would inflate the %.
      const snapGameIds = thirdDownGamesByGsis[gsis] ?? d.gameIds;
      const teamTotal = [...snapGameIds].reduce((sum, gid) =>
        sum + (teamThirdDownPlaysPerGame[gid]?.[d.team] ?? 0), 0);
      if (teamTotal < 1) continue;
      thirdDownSnapPctMap[nk] = Math.round(snaps / teamTotal * 1000) / 10;
      thirdDownSnapRawMap[nk] = { snaps, games: snapGameIds.size };
    }
    console.log(`  3rd-down snap%: ${Object.keys(thirdDownSnapPctMap).length} qualified RBs`);

    // ── 5b. Merge into advstatsDB keyed by canonical display name ─────────────
    const allNormKeys = new Set([
      ...Object.keys(mtfMap), ...Object.keys(successMap),
      ...Object.keys(carryShareMap), ...Object.keys(rzCarryShareMap),
      ...Object.keys(rzTdRateMap), ...Object.keys(thirdDownSnapPctMap),
    ]);
    for (const nk of allNormKeys) {
      const entry = {};
      if (mtfMap[nk])                Object.assign(entry, mtfMap[nk]);
      if (successMap[nk])            entry.successPct        = successMap[nk];
      if (carryShareMap[nk])         entry.carryShare        = carryShareMap[nk];
      if (rzCarryShareMap[nk])       entry.rzCarryShare      = rzCarryShareMap[nk];
      if (rzCarriesMap[nk])          entry.rzCarries         = rzCarriesMap[nk];
      if (rzTdRateMap[nk])           entry.rzTdRate          = rzTdRateMap[nk];
      if (rzTdMap[nk])               entry.rzTDs             = rzTdMap[nk];
      if (thirdDownSnapPctMap[nk])   entry.thirdDownSnapPct  = thirdDownSnapPctMap[nk];
      if (thirdDownSnapRawMap[nk])   Object.assign(entry, thirdDownSnapRawMap[nk]);  // snaps, games
      if (!Object.keys(entry).length) continue;
      const displayName = normToDisplay[nk] ?? nk;
      advstatsDB[displayName] = entry;
      advstatsCount++;
    }

    // ── 6. Snap counts + RB workload benchmarks ──────────────────────────────
    // Snap % via nflverse snap_counts (offense_pct per game, 0–1 fraction),
    // averaged over games where the player took at least one offensive snap.
    // Workload metrics (carry%, touches/g, touch share, target share) come from
    // the PBP workloadByGsis collected above.
    const snapPctByGsis = {};
    try {
      const scRes = await fetch(
        `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${recentYr}.csv`
      );
      if (scRes.ok) {
        const lines = (await scRes.text()).split('\n').filter(l => l.trim());
        const hdrs  = parseCSVLine(lines[0]);
        // snap_counts uses pfr_player_id (not GSIS) — bridge via pfrToGsis from players.csv
        const pfrI  = hdrs.indexOf('pfr_player_id');
        const pctI  = hdrs.indexOf('offense_pct');
        const snpsI = hdrs.indexOf('offense_snaps');
        const gtI   = hdrs.indexOf('game_type');
        const snapAgg = {};
        for (const line of lines.slice(1)) {
          const v    = parseCSVLine(line);
          if (gtI >= 0 && v[gtI] !== 'REG') continue;
          const pfrId = pfrI >= 0 ? v[pfrI]?.trim() : null;
          const gsis  = pfrId ? pfrToGsis[pfrId] : null;
          const pct   = pctI >= 0 ? parseFloat(v[pctI]) : NaN;
          const snps  = snpsI >= 0 ? parseFloat(v[snpsI]) || 0 : 0;
          if (!gsis || isNaN(pct) || snps === 0) continue;
          if (!snapAgg[gsis]) snapAgg[gsis] = { sum: 0, n: 0 };
          snapAgg[gsis].sum += pct * 100;
          snapAgg[gsis].n++;
        }
        for (const [gsis, { sum, n }] of Object.entries(snapAgg)) {
          if (n >= 4) snapPctByGsis[gsis] = Math.round(sum / n * 10) / 10;
        }
        console.log(`  Snap counts: ${Object.keys(snapPctByGsis).length} players`);
      } else {
        console.error(`  ⚠️  snap_counts HTTP ${scRes.status} — snap% will use fallback`);
      }
    } catch(e2) { console.error('  ⚠️  snap_counts failed:', e2.message); }

    // Pts/touch benchmark — previous season (recentYr) only so it reflects the
    // current scoring environment rather than blending 10 years of careerDB data.
    {
      let pts = 0, touches = 0, n = 0;
      for (const [pid, seasons] of Object.entries(careerDB)) {
        const pos = pidToPos[pid];
        if (pos !== 'RB') continue;
        const s = seasons.find(s => s.season === recentYr);
        if (!s || (s.touches ?? 0) < 50 || (s.games ?? 0) < 8) continue;
        pts += s.ppr ?? 0;
        touches += s.touches;
        n++;
      }
      if (touches > 100) { avgRbPpt = Math.round(pts / touches * 1000) / 1000; avgRbPptN = n; }
      console.log(`  Pts/touch bench: ${avgRbPpt} pts/touch · ${avgRbPptN} RBs (${recentYr})`);
    }

    // Top 32 by carries = true RB1 starters. Median is robust to outliers
    // (e.g. Henry's ~50 RZ carries won't inflate the benchmark for everyone else).
    const rbBenchRows = Object.entries(workloadByGsis)
      .filter(([gsis, d]) => d.carries >= 50 && gsisToPos[gsis] === 'RB')
      .map(([gsis, d]) => {
        const games     = d.gameIds.size || 1;
        const touchesPg = (d.carries + d.rec) / games;
        const nk        = gsisToNormName[gsis];
        return {
          carries:        d.carries,
          carryPct:       (d.carries / games) / NFL_AVG_RUSH_ATT_PG * 100,
          touchesPg,
          touchSharePct:  touchesPg / (NFL_AVG_RUSH_ATT_PG + AVG_TEAM_REC_PG) * 100,
          targetSharePct: (d.tgts / games) / AVG_TEAM_TGT_PG * 100,
          tgtPg:          d.tgts   / games,
          recPg:          d.rec    / games,
          recYdPg:        d.recYds / games,
          rushYdPg:       d.rushYds / games,
          snapPct:        snapPctByGsis[gsis] ?? null,
          ypc:            d.carries > 0 ? d.rushYds / d.carries : null,
          rzCarryShare:   nk ? (rzCarryShareMap[nk] ?? null) : null,
          rzCarries:      d.rzCarries > 0 ? d.rzCarries : null,
          rzTdRate:       nk ? (rzTdRateMap[nk] ?? null) : null,
          successPct:        nk ? (successMap[nk] ?? null) : null,
          mtfPerAtt:         nk ? (mtfMap[nk]?.mtfPerAtt ?? null) : null,
          thirdDownSnapPct:  nk ? (thirdDownSnapPctMap[nk] ?? null) : null,
          maxSpeed:          nk ? (ryoeDB[normToDisplay[nk]]?.maxSpeed      ?? null) : null,
          avgTimeToLos:      nk ? (ryoeDB[normToDisplay[nk]]?.avgTimeToLos  ?? null) : null,
          efficiency:        nk ? (ryoeDB[normToDisplay[nk]]?.efficiency    ?? null) : null,
        };
      })
      .sort((a, b) => b.carries - a.carries)
      .slice(0, 32);

    if (rbBenchRows.length >= 8) {
      const _bm = (field, fb) => {
        const vals = rbBenchRows.map(r => r[field]).filter(v => v != null).sort((a, b) => a - b);
        if (vals.length < 5) return fb;
        const mid = Math.floor(vals.length / 2);
        const median = vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
        return Math.round(median * 10) / 10;
      };
      avgRbCarryPct     = _bm('carryPct',       44.1);
      avgRbTouchesPg    = _bm('touchesPg',      15.0);
      avgRbTouchShare   = _bm('touchSharePct',  31.0);
      avgRbTargetShare  = _bm('targetSharePct',  9.0);
      avgRbTgtPg        = _bm('tgtPg',           3.5);
      avgRbRecPg        = _bm('recPg',           2.5);
      avgRbRecYdPg      = _bm('recYdPg',        22.0);
      avgRbRushYdPg     = _bm('rushYdPg',       60.0);
      avgRbMaxSpeed     = _bm('maxSpeed',        20.5);
      avgRbAvgTimeToLos = _bm('avgTimeToLos',    2.5);
      avgRbEfficiency   = _bm('efficiency',      65.0);
      avgRbSnapPct      = _bm('snapPct',         62.0);
      avgRbRzCarryShare = _bm('rzCarryShare',    38.0);
      avgRbRzCarries    = _bm('rzCarries',       22.0);
      // Success rate + MTF are efficiency metrics — use mean
      const _sucVals    = rbBenchRows.map(r => r.successPct).filter(v => v != null);
      avgRbSuccessPct   = _sucVals.length >= 5 ? Math.round(_sucVals.reduce((s, v) => s + v, 0) / _sucVals.length * 10) / 10 : 41.0;
      const _mtfVals    = rbBenchRows.map(r => r.mtfPerAtt).filter(v => v != null);
      avgRbMtfPerAtt    = _mtfVals.length >= 5 ? Math.round(_mtfVals.reduce((s, v) => s + v, 0) / _mtfVals.length * 1000) / 1000 : 0.063;
      const _tdSnapVals = rbBenchRows.map(r => r.thirdDownSnapPct).filter(v => v != null);
      avgRbThirdDownSnaps = _tdSnapVals.length >= 5 ? Math.round(_tdSnapVals.reduce((s, v) => s + v, 0) / _tdSnapVals.length * 10) / 10 : 30.0;
      // YPC + RZ TD rate are efficiency metrics — use mean
      const _ypcVals    = rbBenchRows.map(r => r.ypc).filter(v => v != null);
      avgRbYpc          = _ypcVals.length >= 5 ? Math.round(_ypcVals.reduce((s, v) => s + v, 0) / _ypcVals.length * 10) / 10 : 4.3;
      avgRbYpcN         = _ypcVals.length;
      const _rzTdVals   = rbBenchRows.map(r => r.rzTdRate).filter(v => v != null && !isNaN(v));
      avgRbRzTdRate     = _rzTdVals.length >= 5 ? Math.round(_rzTdVals.reduce((s, v) => s + v, 0) / _rzTdVals.length * 10) / 10 : 17.0;
      console.log(`  Workload bench (top 32, median) — carry: ${avgRbCarryPct}% · snap: ${avgRbSnapPct}% · tch/g: ${avgRbTouchesPg} · tch%: ${avgRbTouchShare}% · tgt%: ${avgRbTargetShare}% · tgt/g: ${avgRbTgtPg} · rec/g: ${avgRbRecPg} · recYd/g: ${avgRbRecYdPg} · rushYd/g: ${avgRbRushYdPg} · rz%: ${avgRbRzCarryShare}% · rz carries: ${avgRbRzCarries}`);
      console.log(`  Efficiency bench (mean) — ypc: ${avgRbYpc} · success: ${avgRbSuccessPct}% · mtf/att: ${avgRbMtfPerAtt} · rz td rate: ${avgRbRzTdRate}% · 3rd-dn snaps: ${avgRbThirdDownSnaps}`);
      console.log(`  Efficiency bench — ypc: ${avgRbYpc} yds (mean, n=${avgRbYpcN})`)
    } else {
      console.error(`  ⚠️  Only ${rbBenchRows.length} qualifying RBs found in PBP — using fallback benchmarks`);
    }
  } catch(e) {
    console.warn('\n  ⚠️  advstats build failed:', e.message, '— advstatsdb.json will be empty');
  }
  progress(99, `Adv Stats DB: ${advstatsCount} players`);
  console.log();

  // ── Step 6: Write output files ────────────────────────────────────────────
  progress(99, 'Writing data files…');
  const compJson      = JSON.stringify(compDB);
  const careerJson    = JSON.stringify(careerDB);
  const benchJson     = JSON.stringify({ avgTeamRushPg, avgTeamPassPg, avgTeamOffPlaysPg, avgTeamRunRate, avgTeamYpc, avgRbCarryPct, avgRbTouchesPg, avgRbTouchShare, avgRbTargetShare, avgRbTgtPg, avgRbRecPg, avgRbRecYdPg, avgRbRushYdPg, avgRbSnapPct, avgRbRzCarryShare, avgRbRzCarries, avgRbRzTdRate, avgRbSuccessPct, avgRbMtfPerAtt, avgRbThirdDownSnaps, avgRbYpc, avgRbYpcN, avgRbPpt, avgRbPptN, avgRbMaxSpeed, avgRbAvgTimeToLos, avgRbEfficiency });
  const teamJson      = JSON.stringify(teamDB);
  const depthJson     = JSON.stringify(depthDB);
  const ryoeJson      = JSON.stringify(ryoeDB);
  const statTeamJson  = JSON.stringify(statTeamDB);
  const advstatsJson  = JSON.stringify(advstatsDB);

  writeFileSync(join(DATA_DIR, 'compdb.json'),      compJson);
  writeFileSync(join(DATA_DIR, 'careerdb.json'),    careerJson);
  writeFileSync(join(DATA_DIR, 'benchmarks.json'),  benchJson);
  writeFileSync(join(DATA_DIR, 'teamdb.json'),      teamJson);
  writeFileSync(join(DATA_DIR, 'depthdb.json'),     depthJson);
  writeFileSync(join(DATA_DIR, 'ryoedb.json'),      ryoeJson);
  writeFileSync(join(DATA_DIR, 'statteamdb.json'),  statTeamJson);
  writeFileSync(join(DATA_DIR, 'advstatsdb.json'),  advstatsJson);
  progress(100, 'Done!');
  console.log('\n');

  const kb = str => (str.length / 1024).toFixed(0) + ' KB';
  console.log('  ✅  data/compdb.json     ', kb(compJson));
  console.log('  ✅  data/careerdb.json   ', kb(careerJson));
  console.log('  ✅  data/benchmarks.json ', kb(benchJson));
  console.log('  ✅  data/teamdb.json     ', kb(teamJson));
  console.log('  ✅  data/depthdb.json    ', kb(depthJson));
  console.log('  ✅  data/ryoedb.json     ', kb(ryoeJson));
  console.log('  ✅  data/statteamdb.json ', kb(statTeamJson));
  console.log('  ✅  data/advstatsdb.json ', kb(advstatsJson));
  console.log('\n  Next: git add data/ && git commit && git push\n');
}

main().catch(err => {
  console.error('\n❌  Build failed:', err.message);
  process.exit(1);
});

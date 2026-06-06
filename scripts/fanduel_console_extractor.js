// ============================================================
// Dynasty Dawgs — FanDuel Season Props Console Extractor
// ============================================================
// HOW TO USE:
//
//  1. Open Chrome → sportsbook.fanduel.com/navigation/nfl?tab=player-props
//  2. Open DevTools (F12) → Console tab
//  3. Paste this ENTIRE script and press Enter
//  4. Refresh the page (Ctrl+R) — the interceptor will capture every API call
//  5. Scroll slowly through ALL sections (Passing Yards, Rushing Yards,
//     Receiving Yards, Touchdowns, Receptions) to load them all
//  6. Type:  __exportVegasProps()  and press Enter
//  7. vegasprops.json downloads automatically
//  8. Move it to your dynasty-dawgs/data/ folder, then:
//       git add data/vegasprops.json
//       git commit -m "update: FanDuel season-long player props"
//       git push
// ============================================================

(function () {
  'use strict';

  // ── PPR scoring ──────────────────────────────────────────────────────────
  const PPR = {
    pass_yds: 0.04, pass_tds: 4.0,
    rush_yds: 0.10, rush_tds: 6.0,
    rec: 1.00, rec_yds: 0.10, rec_tds: 6.0,
  };

  function classifyStat(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('passing yard'))                                    return 'pass_yds';
    if (n.includes('passing td') || n.includes('passing touchdown'))   return 'pass_tds';
    if (n.includes('rushing yard'))                                    return 'rush_yds';
    if (n.includes('rushing td') || n.includes('rushing touchdown'))   return 'rush_tds';
    if (n.includes('receiving yard'))                                  return 'rec_yds';
    if (n.includes('receiving td') || n.includes('receiving touchdown')) return 'rec_tds';
    if (n.includes('reception') && !n.includes('yard') && !n.includes('td')) return 'rec';
    return null;
  }

  function computePpg(stats) {
    let ppg = 0;
    for (const [k, w] of Object.entries(PPR)) ppg += (stats[k] || 0) * w;
    return Math.round(ppg * 100) / 100;
  }

  // ── Accumulated data store ────────────────────────────────────────────────
  // players[name][stat] = [line1, line2, ...]  (averaged at export time)
  const players = {};

  // ── FanDuel-specific parser ───────────────────────────────────────────────
  // FanDuel API shape: { attachments: { markets: {...}, runners: {...}, events: {...} } }
  function parseFanDuelShape(data) {
    const att   = data?.attachments ?? data;
    const mkts  = att?.markets  ?? {};
    const rnrs  = att?.runners  ?? {};
    const evts  = att?.events   ?? {};

    let found = 0;
    for (const mkt of Object.values(mkts)) {
      const mktName = mkt?.marketName ?? mkt?.marketType?.marketName ?? mkt?.name ?? '';
      const stat = classifyStat(mktName);
      if (!stat) continue;

      // Season-long guard
      const evtName = evts[mkt?.eventId]?.name ?? mkt?.eventName ?? '';
      if (!/season|regular season|2026|annual/i.test(mktName + ' ' + evtName)) continue;

      for (const rid of (mkt?.runnerIds ?? [])) {
        const r = rnrs[rid];
        if (!r) continue;
        const name = r.runnerName ?? r.name ?? '';
        const hc   = r.handicap ?? r.hc ?? null;
        if (!name || hc == null || isNaN(parseFloat(hc))) continue;

        players[name] ??= {};
        players[name][stat] ??= [];
        players[name][stat].push(parseFloat(hc));
        found++;
      }
    }
    return found;
  }

  // ── Generic deep-walker (fallback for unexpected shapes) ─────────────────
  function deepWalk(data, depth, ctx) {
    if (depth > 14 || !data || typeof data !== 'object') return;
    if (Array.isArray(data)) { data.forEach(d => deepWalk(d, depth + 1, ctx)); return; }

    const vals  = Object.values(data).filter(v => typeof v === 'string').join(' ');
    const stat  = classifyStat(vals);
    const isSzn = /regular season|season-long|2026|annual/i.test(vals);
    const thisStat = stat ?? ctx.stat;
    const thisSzn  = isSzn || ctx.isSzn;

    if (thisStat && thisSzn) {
      const nameKeys = ['runnerName','selectionName','participant','name','label'];
      const lineKeys = ['handicap','hc','line','value','points','handicapValue'];
      const name = nameKeys.map(k => data[k]).find(v => typeof v === 'string' && v.length > 2 && v.length < 60);
      const line = lineKeys.map(k => data[k]).find(v => v != null && !isNaN(parseFloat(v)));
      if (name && line != null) {
        const l = parseFloat(line);
        if (l > 0) {
          players[name] ??= {};
          players[name][thisStat] ??= [];
          players[name][thisStat].push(l);
        }
      }
    }
    for (const v of Object.values(data)) deepWalk(v, depth + 1, { stat: thisStat, isSzn: thisSzn });
  }

  // ── Process each intercepted response ────────────────────────────────────
  function processJson(json, url) {
    const raw = JSON.stringify(json);
    // Quick pre-filter: skip tiny responses or ones with no season keywords
    if (raw.length < 50) return;
    if (!/season|passing yard|rushing yard|receiving yard|touchdown|reception/i.test(raw)) return;

    // Try FanDuel-specific shape first, fall back to generic walker
    const fdFound = parseFanDuelShape(json);
    if (fdFound === 0) deepWalk(json, 0, { stat: null, isSzn: false });

    const total = Object.keys(players).length;
    if (total > 0) {
      console.log(`[DD] ${total} players accumulated | last response: ${url.slice(0, 80)}`);
    }
  }

  // ── Intercept fetch ───────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const clone = res.clone();
      clone.json().then(j => processJson(j, String(args[0]?.url ?? args[0]))).catch(() => {});
    } catch(e) {}
    return res;
  };

  // ── Intercept XMLHttpRequest ──────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__dd_url = url;
    return _open.apply(this, arguments);
  };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try { processJson(JSON.parse(this.responseText), this.__dd_url); } catch(e) {}
    });
    return _send.apply(this, arguments);
  };

  // ── Export function ───────────────────────────────────────────────────────
  window.__exportVegasProps = function () {
    if (!Object.keys(players).length) {
      console.warn('[DD] No players captured yet. Scroll through all prop sections and try again.');
      return;
    }

    // Average lines across captures, compute PPG
    const out = {};
    for (const [name, stats] of Object.entries(players)) {
      const avg = {};
      for (const [stat, lines] of Object.entries(stats)) {
        avg[stat] = Math.round(lines.reduce((a, b) => a + b, 0) / lines.length * 10) / 10;
      }
      out[name] = { ...avg, ppg: computePpg(avg), updated: new Date().toISOString().slice(0, 10) };
    }

    // Sort by PPG desc
    const sorted = Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => b.ppg - a.ppg));

    const payload = {
      meta: {
        season: 2026, week: null, type: 'season-long',
        updatedAt: new Date().toISOString(),
        playerCount: Object.keys(sorted).length,
        books: ['FanDuel'],
      },
      players: sorted,
    };

    console.log('%c Dynasty Dawgs Export ', 'background:#f59e0b;color:#000;font-weight:bold;padding:2px 6px;');
    console.log(`${Object.keys(sorted).length} players exported. Top 10:`);
    Object.entries(sorted).slice(0, 10).forEach(([n, p], i) =>
      console.log(`  ${i + 1}. ${n.padEnd(22)} ${p.ppg.toFixed(1)} PPG`)
    );

    // Trigger download
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: 'vegasprops.json',
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    return payload;
  };

  console.log('%c Dynasty Dawgs Season Props Extractor Ready ', 'background:#10b981;color:#fff;font-weight:bold;padding:4px 10px;font-size:14px;');
  console.log('→ Refresh the page, then scroll through ALL season prop sections');
  console.log('→ When done, type:  __exportVegasProps()');
})();

import { PlayoffRoom } from './room.js';
export { PlayoffRoom };

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ['https://playoff.ffhistorian.com', 'https://ffhistorian.com'];
  const o = allowed.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResp(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errResp(msg, status = 400, origin = '') {
  return jsonResp({ error: msg }, status, origin);
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/playoff/rooms  — create a new league
    if (path === '/api/playoff/rooms' && request.method === 'POST') {
      return handleCreateRoom(request, env, origin);
    }

    // GET /api/playoff/schedule
    if (path === '/api/playoff/schedule' && request.method === 'GET') {
      return handleSchedule(request, env, origin);
    }

    // GET /api/playoff/boxscore
    if (path === '/api/playoff/boxscore' && request.method === 'GET') {
      return handleBoxscore(request, env, origin);
    }

    // /api/playoff/rooms/:id[/action]  — proxy to Durable Object
    const roomMatch = path.match(/^\/api\/playoff\/rooms\/([^/]+)(\/.*)?$/);
    if (roomMatch) {
      return handleRoomProxy(request, env, origin, roomMatch[1]);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Create Room ───────────────────────────────────────────────────────────────

async function handleCreateRoom(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return errResp('Invalid JSON', 400, origin); }

  const { name, numTeams, teamNames, season } = body;
  if (!name || !numTeams || !teamNames || !season) {
    return errResp('Missing required fields: name, numTeams, teamNames, season', 400, origin);
  }
  if (numTeams < 2 || numTeams > 8) {
    return errResp('numTeams must be between 2 and 8', 400, origin);
  }
  if (!Array.isArray(teamNames) || teamNames.length !== numTeams) {
    return errResp('teamNames must be an array with numTeams entries', 400, origin);
  }

  // Build player pool from Sleeper + ESPN
  let assets;
  try {
    assets = await buildPlayerPool(String(season), env);
  } catch (e) {
    return errResp(`Failed to build player pool: ${e.message}`, 502, origin);
  }

  if (!assets.length) {
    return errResp('No players found. Playoff teams may not be set yet for this season.', 404, origin);
  }

  // Generate room
  const roomId = generateId(10);
  const commissionerCode = generateCode(8);
  const teamSlots = teamNames.map((tname, i) => ({
    index: i,
    name: String(tname).slice(0, 40),
    claimCode: generateCode(6),
    sessionToken: null,
    claimed: false,
  }));

  const room = {
    roomId,
    commissionerCode,
    name: String(name).slice(0, 60),
    season: String(season),
    numTeams,
    status: 'active',
    currentOverallPick: 1,
    expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days
    teamSlots,
    draftOrder: teamSlots.map((_, i) => i),
    assets,
    picks: [],
  };

  const doId = env.PLAYOFF_ROOM.idFromName(roomId);
  const stub = env.PLAYOFF_ROOM.get(doId);
  await stub.fetch(new Request('http://do/init', {
    method: 'POST',
    body: JSON.stringify(room),
    headers: { 'Content-Type': 'application/json' },
  }));

  return jsonResp({
    roomId,
    commissionerCode,
    teamSlots: teamSlots.map(s => ({ name: s.name, claimCode: s.claimCode })),
  }, 200, origin);
}

// ── Room Proxy ────────────────────────────────────────────────────────────────

async function handleRoomProxy(request, env, origin, roomId) {
  const doId = env.PLAYOFF_ROOM.idFromName(roomId);
  const stub = env.PLAYOFF_ROOM.get(doId);

  // WebSocket upgrade — forward directly
  if (request.headers.get('Upgrade') === 'websocket') {
    return stub.fetch(request);
  }

  const resp = await stub.fetch(request);

  // Pass through non-JSON responses (errors, 404, etc.)
  const ct = resp.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return new Response(resp.body, {
      status: resp.status,
      headers: { ...Object.fromEntries(resp.headers), ...corsHeaders(origin) },
    });
  }

  const data = await resp.json();
  return jsonResp(data, resp.status, origin);
}

// ── Playoff Schedule ──────────────────────────────────────────────────────────

async function handleSchedule(request, env, origin) {
  const url = new URL(request.url);
  const season = url.searchParams.get('season') || new Date().getFullYear();
  const cacheKey = `sched_${season}`;

  const cached = await env.PLAYOFF_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return jsonResp(cached, 200, origin);

  // Weeks 1-4: Wild Card, Divisional, Conference Championship, Super Bowl
  const weekNames = ['Wild Card', 'Divisional', 'Conference Championship', 'Super Bowl'];
  const fetches = [1, 2, 3, 4].map(w =>
    fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=3&week=${w}&season=${season}`)
      .then(r => r.ok ? r.json() : { events: [] })
      .catch(() => ({ events: [] }))
  );

  const results = await Promise.all(fetches);
  const games = [];

  for (const [i, data] of results.entries()) {
    const weekName = weekNames[i];
    const weekNum = i + 1;
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      games.push({
        id: event.id,
        week: weekNum,
        weekName,
        date: event.date,
        completed: event.status?.type?.completed ?? false,
        homeTeam: home?.team?.abbreviation,
        awayTeam: away?.team?.abbreviation,
        homeScore: home?.score ?? null,
        awayScore: away?.score ?? null,
      });
    }
  }

  // Cache for 5 min while games are live; longer once SB is done
  const allDone = games.length > 0 && games.every(g => g.completed);
  await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(games), {
    expirationTtl: allDone ? 86400 * 30 : 300,
  });

  return jsonResp(games, 200, origin);
}

// ── Box Score ─────────────────────────────────────────────────────────────────

async function handleBoxscore(request, env, origin) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get('event');
  if (!eventId) return errResp('Missing event ID', 400, origin);

  const cacheKey = `box_${eventId}`;
  const cached = await env.PLAYOFF_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return jsonResp(cached, 200, origin);

  const r = await fetch(
    `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`
  );
  if (!r.ok) return errResp('ESPN fetch failed', 502, origin);

  const data = await r.json();
  const completed = data.header?.competitions?.[0]?.status?.type?.completed ?? false;

  // Build player stats map: fullName -> { team, passing, rushing, receiving, fumbles }
  const playerStats = {};
  for (const teamData of (data.boxscore?.players || [])) {
    const teamAbbr = teamData.team?.abbreviation;
    for (const group of (teamData.statistics || [])) {
      const groupName = group.name; // 'passing', 'rushing', 'receiving', 'fumbles'
      const keys = group.keys || [];
      for (const entry of (group.athletes || [])) {
        const name = entry.athlete?.fullName;
        if (!name) continue;
        if (!playerStats[name]) playerStats[name] = { team: teamAbbr };
        const stats = {};
        (entry.stats || []).forEach((val, i) => { stats[keys[i]] = val; });
        playerStats[name][groupName] = stats;
      }
    }
  }

  await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(playerStats), {
    expirationTtl: completed ? 86400 * 30 : 60,
  });

  return jsonResp(playerStats, 200, origin);
}

// ── Player Pool Builder ───────────────────────────────────────────────────────

async function buildPlayerPool(season, env) {
  const [playoffTeams, players, seasonStats] = await Promise.all([
    getPlayoffTeams(season, env),
    getSleeperPlayers(env),
    getSeasonStats(season, env),
  ]);

  if (!playoffTeams.length) throw new Error('Playoff teams not yet available for this season');

  const playoffSet = new Set(playoffTeams.map(t => t.toUpperCase()));
  const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  const assets = [];

  for (const [pid, player] of Object.entries(players)) {
    const pos = normalizePos(player);
    if (!POSITIONS.has(pos)) continue;

    const playerTeam = (player.team || '').toUpperCase();
    if (!playerTeam || !playoffSet.has(playerTeam)) continue;

    // Skip players on IR or inactive without active designation
    if (player.injury_status === 'IR' || player.status === 'Inactive') continue;

    const stats = seasonStats[pid] || {};
    const seasonPts = calcFpts(stats, pos);
    const gp = stats.gp || 0;

    assets.push({
      id: pid,
      name: player.full_name || `${player.first_name || ''} ${player.last_name || ''}`.trim(),
      position: pos,
      nflTeam: player.team || '',
      age: player.age || null,
      seasonPts: Math.round(seasonPts * 10) / 10,
      gp,
      pickedBy: null,
    });
  }

  // Sort by FPts/game descending, then by name
  assets.sort((a, b) => {
    const aGpg = a.gp > 0 ? a.seasonPts / a.gp : 0;
    const bGpg = b.gp > 0 ? b.seasonPts / b.gp : 0;
    return bGpg - aGpg || a.name.localeCompare(b.name);
  });

  return assets;
}

function normalizePos(player) {
  const pos = (player.fantasy_positions?.[0] || player.position || '').toUpperCase();
  // Collapse any edge-case position strings
  if (pos === 'FB') return 'RB';
  return pos;
}

function calcFpts(stats, position) {
  const recPerReception = position === 'TE' ? 1.75 : 1.0; // TEP: +0.75 for TEs
  return (
    (stats.pass_yd  || 0) * 0.05 +
    (stats.pass_td  || 0) * 6 +
    (stats.pass_int || 0) * -2 +
    (stats.rush_yd  || 0) * 0.1 +
    (stats.rush_td  || 0) * 6 +
    (stats.rec      || 0) * recPerReception +
    (stats.rec_yd   || 0) * 0.1 +
    (stats.rec_td   || 0) * 6 +
    (stats.fum_lost || 0) * -2
  );
}

// ── ESPN Playoff Teams ────────────────────────────────────────────────────────

async function getPlayoffTeams(season, env) {
  const cacheKey = `pteams_${season}`;
  const cached = await env.PLAYOFF_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return cached;

  // Try scoreboard for playoff week 1 (Wild Card)
  const sbResp = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=3&week=1&season=${season}`
  ).catch(() => null);

  if (sbResp?.ok) {
    const sbData = await sbResp.json();
    const teams = new Set();
    for (const event of (sbData.events || [])) {
      for (const comp of (event.competitions || [])) {
        for (const c of (comp.competitors || [])) {
          const abbr = c.team?.abbreviation;
          if (abbr) teams.add(abbr.toUpperCase());
        }
      }
    }
    if (teams.size >= 8) {
      const result = [...teams];
      // Cache 30 days once we have real games
      await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 * 30 });
      return result;
    }
  }

  // Fall back to standings: top 7 from each conference = 14 playoff teams
  const stResp = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/standings?season=${season}`
  ).catch(() => null);

  if (!stResp?.ok) return [];

  const stData = await stResp.json();
  const playoffTeams = [];

  for (const conference of (stData.children || [])) {
    const teams = [];
    // Standings may be nested by division
    const entries = conference.standings?.entries ||
      (conference.children || []).flatMap(d => d.standings?.entries || []);

    for (const entry of entries) {
      const abbr = entry.team?.abbreviation;
      if (!abbr) continue;
      const statsMap = {};
      for (const s of (entry.stats || [])) statsMap[s.name] = s.value;
      teams.push({ abbr: abbr.toUpperCase(), wins: statsMap.wins || 0 });
    }

    teams.sort((a, b) => b.wins - a.wins);
    for (const t of teams.slice(0, 7)) playoffTeams.push(t.abbr);
  }

  // Cache for 1 hour (less reliable estimate before bracket set)
  if (playoffTeams.length > 0) {
    await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(playoffTeams), { expirationTtl: 3600 });
  }

  return playoffTeams;
}

// ── Sleeper Players ───────────────────────────────────────────────────────────

async function getSleeperPlayers(env) {
  const cacheKey = 'sleeper_players';
  const cached = await env.PLAYOFF_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return cached;

  const r = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!r.ok) throw new Error('Sleeper players fetch failed');
  const data = await r.json();

  // Cache 2 hours
  await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 7200 });
  return data;
}

// ── Sleeper Season Stats ──────────────────────────────────────────────────────

async function getSeasonStats(season, env) {
  const cacheKey = `szn_stats_${season}`;
  const cached = await env.PLAYOFF_KV.get(cacheKey, 'json').catch(() => null);
  if (cached) return cached;

  // Fetch all 18 regular season weeks in parallel
  const statKeys = ['pass_yd','pass_td','pass_int','rush_yd','rush_td','rec','rec_yd','rec_td','fum_lost','gp'];
  const weekFetches = Array.from({ length: 18 }, (_, i) =>
    fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${season}/${i + 1}`)
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}))
  );

  const weekResults = await Promise.all(weekFetches);
  const agg = {};

  for (const weekData of weekResults) {
    for (const [pid, stats] of Object.entries(weekData)) {
      if (!agg[pid]) agg[pid] = {};
      for (const k of statKeys) {
        agg[pid][k] = (agg[pid][k] || 0) + (Number(stats[k]) || 0);
      }
    }
  }

  // Cache 24 hours
  await env.PLAYOFF_KV.put(cacheKey, JSON.stringify(agg), { expirationTtl: 86400 });
  return agg;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function generateId(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 lookalikes
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

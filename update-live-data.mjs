import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "wc2026_live_data.js");

const endpoints = {
  groups: "https://worldcup26.ir/get/groups",
  teams: "https://worldcup26.ir/get/teams",
  games: "https://worldcup26.ir/get/games",
  naverTopPlayers: "https://api-gw.sports.naver.com/statistics/categories/worldcup/seasons/3F9X/top-players?includeFields=goals,assists,mom,bestEleven,indexScore,cleanSheets&limit=10",
};

const fifa = {
  apiBase: "https://api.fifa.com/api/v3",
  webBase: "https://www.fifa.com/en/match-centre/match",
  competitionId: "17",
  seasonId: "285023",
  language: "en",
};

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "wc2026-pages-updater/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function assertShape(data) {
  if (!data.groups || !Array.isArray(data.groups.groups)) {
    throw new Error("groups response shape changed");
  }
  if (!data.teams || !Array.isArray(data.teams.teams)) {
    throw new Error("teams response shape changed");
  }
  if (!data.games || !Array.isArray(data.games.games)) {
    throw new Error("games response shape changed");
  }
}

function fifaText(value) {
  if (!Array.isArray(value)) return "";
  return (
    value.find((item) => String(item.Locale || "").toLowerCase().startsWith("en")) ||
    value[0] ||
    {}
  ).Description || "";
}

function stripMarks(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeTeamName(value) {
  let name = stripMarks(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  const aliases = {
    "bosnia herzegovina": "bosnia and herzegovina",
    "bosnia and herzegovina": "bosnia and herzegovina",
    "cabo verde": "cape verde",
    "cape verde": "cape verde",
    "cote d ivoire": "ivory coast",
    "cote divoire": "ivory coast",
    "czech republic": "czechia",
    "czechia": "czechia",
    "curacao": "curacao",
    "congo dr": "congo dr",
    "democratic republic of the congo": "congo dr",
    "dr congo": "congo dr",
    "ivory coast": "ivory coast",
    "ir iran": "iran",
    "iran": "iran",
    "korea republic": "south korea",
    "south korea": "south korea",
    "turkey": "turkiye",
    "turkiye": "turkiye",
    "usa": "usa",
    "united states": "usa",
    "united states of america": "usa",
  };

  return aliases[name] || name;
}

function fifaMatchUrl(match) {
  return [
    fifa.webBase,
    match.IdCompetition,
    match.IdSeason,
    match.IdStage,
    match.IdMatch,
  ].join("/");
}

function positionLabel(position) {
  return {
    0: "GK",
    1: "DF",
    2: "MF",
    3: "FW",
  }[position] || "";
}

function fifaPlayer(player) {
  return {
    name: fifaText(player.PlayerName) || fifaText(player.ShortName) || String(player.IdPlayer || ""),
    shortName: fifaText(player.ShortName),
    number: player.ShirtNumber ?? "",
    position: positionLabel(player.Position),
    captain: Boolean(player.Captain),
    fifaId: player.IdPlayer || "",
    lineupX: player.LineupX ?? null,
    lineupY: player.LineupY ?? null,
  };
}

function fifaTeamLineup(team) {
  const players = Array.isArray(team?.Players) ? team.Players : [];
  const starters = players.filter((player) => player.Status === 1).map(fifaPlayer);
  const substitutes = players.filter((player) => player.Status === 2).map(fifaPlayer);
  const coaches = Array.isArray(team?.Coaches) ? team.Coaches : [];

  return {
    team: fifaText(team?.TeamName),
    code: team?.Abbreviation || "",
    formation: team?.Tactics || "",
    coach: fifaText(coaches[0]?.Name) || fifaText(coaches[0]?.Alias),
    starters,
    substitutes,
  };
}

function indexFifaMatches(matches) {
  const byTeams = new Map();

  for (const match of matches) {
    const home = normalizeTeamName(fifaText(match.Home?.TeamName));
    const away = normalizeTeamName(fifaText(match.Away?.TeamName));
    if (!home || !away) continue;

    byTeams.set(`${home}::${away}`, match);
    byTeams.set(`${away}::${home}`, match);
  }

  return byTeams;
}

function teamIdByNormalizedName(data) {
  const byName = new Map();
  for (const team of data.teams.teams) {
    const normalized = normalizeTeamName(team.name_en);
    if (normalized) byName.set(normalized, String(team.id));
  }
  return byName;
}

function blankStanding(team) {
  return {
    team_id: String(team.id),
    mp: "0",
    w: "0",
    l: "0",
    d: "0",
    pts: "0",
    gf: "0",
    ga: "0",
    gd: "0",
  };
}

function addStandingResult(row, gf, ga) {
  const mp = Number(row.mp) + 1;
  const w = Number(row.w) + (gf > ga ? 1 : 0);
  const d = Number(row.d) + (gf === ga ? 1 : 0);
  const l = Number(row.l) + (gf < ga ? 1 : 0);
  const totalGf = Number(row.gf) + gf;
  const totalGa = Number(row.ga) + ga;

  row.mp = String(mp);
  row.w = String(w);
  row.d = String(d);
  row.l = String(l);
  row.pts = String(w * 3 + d);
  row.gf = String(totalGf);
  row.ga = String(totalGa);
  row.gd = String(totalGf - totalGa);
}

function groupLetter(match) {
  const description = fifaText(match.GroupName);
  const found = description.match(/\bGroup\s+([A-L])\b/i);
  return found ? found[1].toUpperCase() : "";
}

function isCompletedGroupMatch(match) {
  return (
    fifaText(match.StageName).toLowerCase() === "first stage" &&
    groupLetter(match) &&
    match.Home &&
    match.Away &&
    Number(match.ResultType) > 0 &&
    Number.isFinite(Number(match.HomeTeamScore)) &&
    Number.isFinite(Number(match.AwayTeamScore))
  );
}

function rebuildGroupsFromFifa(data, matches) {
  const byName = teamIdByNormalizedName(data);
  const byGroup = new Map();

  for (const team of data.teams.teams) {
    const group = String(team.groups || "").toUpperCase();
    if (!group) continue;
    if (!byGroup.has(group)) byGroup.set(group, new Map());
    byGroup.get(group).set(String(team.id), blankStanding(team));
  }

  for (const match of matches) {
    if (!isCompletedGroupMatch(match)) continue;

    const group = groupLetter(match);
    const homeId = byName.get(normalizeTeamName(fifaText(match.Home.TeamName)));
    const awayId = byName.get(normalizeTeamName(fifaText(match.Away.TeamName)));
    const rows = byGroup.get(group);
    if (!homeId || !awayId || !rows?.has(homeId) || !rows?.has(awayId)) continue;

    const homeScore = Number(match.HomeTeamScore);
    const awayScore = Number(match.AwayTeamScore);
    addStandingResult(rows.get(homeId), homeScore, awayScore);
    addStandingResult(rows.get(awayId), awayScore, homeScore);
  }

  data.groups.groups = Array.from(byGroup.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, rows]) => ({
      name,
      teams: Array.from(rows.values()).sort((a, b) =>
        Number(b.pts) - Number(a.pts) ||
        Number(b.gd) - Number(a.gd) ||
        Number(b.gf) - Number(a.gf) ||
        Number(a.team_id) - Number(b.team_id)
      ),
    }));
}
function matchNeedsLiveFetch(match, now = new Date()) {
  const kickoff = new Date(match.Date);
  if (Number.isNaN(kickoff.getTime())) return false;

  const matchStatus = Number(match.MatchStatus);
  const isLineupOrLive = [3, 11, 12].includes(matchStatus);
  const hoursFromKickoff = (kickoff.getTime() - now.getTime()) / 36e5;

  return isLineupOrLive || (hoursFromKickoff >= -30 && hoursFromKickoff <= 48);
}

async function fetchFifaMatches() {
  const params = new URLSearchParams({
    idCompetition: fifa.competitionId,
    idSeason: fifa.seasonId,
    language: fifa.language,
    count: "200",
  });
  const response = await fetchJson(`${fifa.apiBase}/calendar/matches?${params}`);
  return Array.isArray(response.Results) ? response.Results : [];
}

async function fetchFifaLiveMatch(match) {
  const url = `${fifa.apiBase}/live/football/${match.IdCompetition}/${match.IdSeason}/${match.IdStage}/${match.IdMatch}?language=${fifa.language}`;
  return await fetchJson(url);
}

async function addOfficialLineups(data) {
  const fetchedAt = new Date().toISOString();
  const matches = await fetchFifaMatches();
  const matchesByTeams = indexFifaMatches(matches);
  const liveMatches = new Map();
  const games = data.games.games;

  rebuildGroupsFromFifa(data, matches);

  for (const game of games) {
    const home = normalizeTeamName(game.home_team_name_en);
    const away = normalizeTeamName(game.away_team_name_en);
    const fifaMatch = matchesByTeams.get(`${home}::${away}`);
    if (!fifaMatch) continue;

    game.official_match = {
      provider: "FIFA",
      idCompetition: fifaMatch.IdCompetition,
      idSeason: fifaMatch.IdSeason,
      idStage: fifaMatch.IdStage,
      idMatch: fifaMatch.IdMatch,
      matchStatus: fifaMatch.MatchStatus,
      url: fifaMatchUrl(fifaMatch),
    };

    if (!matchNeedsLiveFetch(fifaMatch)) continue;

    try {
      const live = await fetchFifaLiveMatch(fifaMatch);
      liveMatches.set(fifaMatch.IdMatch, live);
      const homeLineup = fifaTeamLineup(live.HomeTeam);
      const awayLineup = fifaTeamLineup(live.AwayTeam);
      const hasLineup = homeLineup.starters.length || awayLineup.starters.length;

      game.official_match.matchStatus = live.MatchStatus ?? fifaMatch.MatchStatus;
      game.official_match.fetchedAt = fetchedAt;

      if (hasLineup) {
        game.official_lineups = {
          provider: "FIFA",
          fetchedAt,
          url: fifaMatchUrl(fifaMatch),
          home: homeLineup,
          away: awayLineup,
        };
      }
    } catch (error) {
      game.official_match.lineupError = error.message;
    }
  }

  data.fifa = {
    provider: "FIFA",
    apiBase: fifa.apiBase,
    competitionId: fifa.competitionId,
    seasonId: fifa.seasonId,
    fetchedAt,
    matchCount: matches.length,
    liveCheckedCount: liveMatches.size,
    lineupMatchCount: games.filter((game) => game.official_lineups).length,
  };
}

const data = {
  fetchedAt: new Date().toISOString(),
  groups: await fetchJson(endpoints.groups),
  teams: await fetchJson(endpoints.teams),
  games: await fetchJson(endpoints.games),
};

assertShape(data);

try {
  data.naver = {
    provider: "NAVER Sports",
    fetchedAt: new Date().toISOString(),
    topPlayers: await fetchJson(endpoints.naverTopPlayers),
  };
} catch (error) {
  data.naver = {
    provider: "NAVER Sports",
    fetchedAt: new Date().toISOString(),
    error: error.message,
  };
  console.warn(`NAVER top players fetch skipped: ${error.message}`);
}

try {
  await addOfficialLineups(data);
} catch (error) {
  data.fifa = {
    provider: "FIFA",
    apiBase: fifa.apiBase,
    competitionId: fifa.competitionId,
    seasonId: fifa.seasonId,
    fetchedAt: new Date().toISOString(),
    error: error.message,
  };
  console.warn(`FIFA lineup fetch skipped: ${error.message}`);
}

const output = `window.WC2026_LIVE_DATA = ${JSON.stringify(data, null, 2)};\n`;
await writeFile(outputPath, output, "utf8");

console.log(`Updated ${outputPath}`);
console.log(`Fetched at ${data.fetchedAt}`);
if (data.fifa) {
  console.log(`FIFA matches: ${data.fifa.matchCount || 0}, live checked: ${data.fifa.liveCheckedCount || 0}, lineups: ${data.fifa.lineupMatchCount || 0}`);
}


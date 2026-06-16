import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "wc2026_live_data.js");

const endpoints = {
  groups: "https://worldcup26.ir/get/groups",
  teams: "https://worldcup26.ir/get/teams",
  games: "https://worldcup26.ir/get/games",
  naverTopPlayers: "https://api-gw.sports.naver.com/statistics/categories/worldcup/seasons/3F9X/top-players?includeFields=goals,assists,cleanSheets&limit=10",
  fifaPotmGames: "https://play.fifa.com/json/player_of_the_match_vote/games.json",
  fifaPotmPlayers: "https://play.fifa.com/json/player_of_the_match_vote/players.json",
};

const fifa = {
  apiBase: "https://api.fifa.com/api/v3",
  webBase: "https://www.fifa.com/en/match-centre/match",
  potmPage: "https://play.fifa.com/potm/en/",
  competitionId: "17",
  seasonId: "285023",
  language: "en",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonOnce(url) {
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

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`Fetch retry ${attempt}/${attempts}: ${url} (${error.message})`);
        await sleep(750 * attempt);
      }
    }
  }
  throw lastError;
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
    image: player.PlayerPicture?.PictureUrl || "",
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

function fifaScore(match, side) {
  const teamKey = side === "home" ? "HomeTeam" : "AwayTeam";
  const calendarKey = side === "home" ? "HomeTeamScore" : "AwayTeamScore";
  const value = match?.[calendarKey] ?? match?.[teamKey]?.Score;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function fifaStatusValue(match) {
  const status = Number(match?.MatchStatus);
  const resultType = Number(match?.ResultType);
  const hasScore = fifaScore(match, "home") !== null && fifaScore(match, "away") !== null;

  if ((status === 0 || resultType > 0) && hasScore) return "finished";
  if (status === 12) return "lineups";
  if (status === 3) {
    const minute = String(match?.MatchTime || "").replace(/[^\d+]/g, "");
    return minute || "live";
  }
  return "notstarted";
}

function mergeFifaMatchIntoGame(game, match) {
  const homeScore = fifaScore(match, "home");
  const awayScore = fifaScore(match, "away");
  const status = fifaStatusValue(match);

  if (homeScore !== null) game.home_score = String(homeScore);
  if (awayScore !== null) game.away_score = String(awayScore);
  game.time_elapsed = status;
  game.finished = status === "finished" ? "TRUE" : "FALSE";
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

function playerPictureUrl(player) {
  return player?.PlayerPicture?.PictureUrl || player?.PictureUrl || "";
}

function findLivePlayerByFeedId(live, feedId) {
  if (!feedId) return null;
  const id = String(feedId);
  const players = [
    ...(Array.isArray(live?.HomeTeam?.Players) ? live.HomeTeam.Players : []),
    ...(Array.isArray(live?.AwayTeam?.Players) ? live.AwayTeam.Players : []),
  ];
  return players.find((player) => String(player.IdPlayer || "") === id) || null;
}

async function fetchPotmData() {
  const [games, players] = await Promise.all([
    fetchJson(endpoints.fifaPotmGames),
    fetchJson(endpoints.fifaPotmPlayers),
  ]);
  const playerMap = new Map(
    (Array.isArray(players) ? players : []).map((player) => [String(player.id), player])
  );

  return {
    games: Array.isArray(games) ? games : [],
    playerMap,
  };
}

function indexPotmMatches(matches) {
  const byTeams = new Map();

  for (const match of matches) {
    const home = normalizeTeamName(match.homeSquadName);
    const away = normalizeTeamName(match.awaySquadName);
    const time = Date.parse(match.date);
    if (!home || !away) continue;

    const entry = { match, time: Number.isFinite(time) ? time : 0 };
    for (const key of [`${home}::${away}`, `${away}::${home}`]) {
      if (!byTeams.has(key)) byTeams.set(key, []);
      byTeams.get(key).push(entry);
    }
  }

  return byTeams;
}

function findPotmMatch(index, match) {
  const home = normalizeTeamName(fifaText(match.Home?.TeamName));
  const away = normalizeTeamName(fifaText(match.Away?.TeamName));
  const candidates = index.get(`${home}::${away}`) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].match;

  const kickoff = Date.parse(match.Date);
  if (!Number.isFinite(kickoff)) return candidates[0].match;

  const best = candidates
    .map((candidate) => ({ ...candidate, diff: Math.abs(candidate.time - kickoff) }))
    .sort((a, b) => a.diff - b.diff)[0];

  return best && best.diff <= 12 * 60 * 60 * 1000 ? best.match : null;
}

function potmPayload(match, playerMap, livePlayer = null, fetchedAt = new Date().toISOString()) {
  if (!match || !match.winnerId || !match.winnerName) return null;

  const player = playerMap.get(String(match.winnerId)) || {};
  const name = player.knownName || match.winnerName || player.name || player.shortName || "";
  if (!name) return null;

  return {
    provider: "FIFA POTM",
    fetchedAt,
    status: match.status || "",
    matchId: match.id ?? "",
    matchFeedId: match.feedId ?? match.fifaId ?? "",
    playerId: match.winnerId,
    playerFeedId: player.feedId || "",
    name,
    shortName: player.shortName || match.winnerName || name,
    teamCode: player.squadAbbreviation || "",
    position: player.position || "",
    image: playerPictureUrl(livePlayer),
    url: fifa.potmPage,
  };
}

function mergePotmIntoGame(game, potmMatch, playerMap, livePlayer = null, fetchedAt = new Date().toISOString()) {
  const payload = potmPayload(potmMatch, playerMap, livePlayer, fetchedAt);
  if (!payload) return false;

  const previous = JSON.stringify(game.potm || null);
  const previousImage = game.potm?.image || "";
  game.potm = {
    ...(game.potm || {}),
    ...payload,
    image: payload.image || previousImage,
  };
  return JSON.stringify(game.potm) !== previous;
}

function enrichPotmImageFromLive(game, live) {
  if (!game.potm?.playerFeedId) return false;
  const player = findLivePlayerByFeedId(live, game.potm.playerFeedId);
  const image = playerPictureUrl(player);
  if (!image || game.potm.image === image) return false;
  game.potm.image = image;
  return true;
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
  let potmData = null;
  let potmError = "";

  try {
    potmData = await fetchPotmData();
  } catch (error) {
    potmError = error.message;
    console.warn(`FIFA POTM fetch skipped: ${error.message}`);
  }

  const potmIndex = potmData ? indexPotmMatches(potmData.games) : new Map();

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
    mergeFifaMatchIntoGame(game, fifaMatch);

    const potmMatch = findPotmMatch(potmIndex, fifaMatch);
    if (potmMatch) {
      mergePotmIntoGame(game, potmMatch, potmData.playerMap, null, fetchedAt);
    }

    if (!matchNeedsLiveFetch(fifaMatch)) continue;

    try {
      const live = await fetchFifaLiveMatch(fifaMatch);
      liveMatches.set(fifaMatch.IdMatch, live);
      const homeLineup = fifaTeamLineup(live.HomeTeam);
      const awayLineup = fifaTeamLineup(live.AwayTeam);
      const hasLineup = homeLineup.starters.length || awayLineup.starters.length;

      game.official_match.matchStatus = live.MatchStatus ?? fifaMatch.MatchStatus;
      game.official_match.fetchedAt = fetchedAt;
      mergeFifaMatchIntoGame(game, live);
      enrichPotmImageFromLive(game, live);

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
    potmMatchCount: games.filter((game) => game.potm).length,
  };

  data.potm = {
    provider: "FIFA POTM",
    pageUrl: fifa.potmPage,
    fetchedAt,
    matchCount: potmData?.games.length || 0,
    winnerCount: potmData ? potmData.games.filter((match) => match.winnerId && match.winnerName).length : 0,
    attachedCount: games.filter((game) => game.potm).length,
    ...(potmError ? { error: potmError } : {}),
  };
}

async function readPreviousLiveData() {
  try {
    const source = await readFile(outputPath, "utf8");
    const match = source.match(/window\.WC2026_LIVE_DATA\s*=\s*([\s\S]*?);\s*$/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function fetchCoreData() {
  const fetchedAt = new Date().toISOString();
  try {
    const [groups, teams, games] = await Promise.all([
      fetchJson(endpoints.groups),
      fetchJson(endpoints.teams),
      fetchJson(endpoints.games),
    ]);

    const fresh = { fetchedAt, groups, teams, games };
    assertShape(fresh);
    return fresh;
  } catch (error) {
    const previous = await readPreviousLiveData();
    if (!previous) throw error;

    console.warn(`Core data fetch failed; using previous live data: ${error.message}`);
    return {
      ...previous,
      fetchedAt,
      staleCoreData: true,
      coreDataError: {
        fetchedAt,
        message: error.message,
      },
    };
  }
}

const data = await fetchCoreData();

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


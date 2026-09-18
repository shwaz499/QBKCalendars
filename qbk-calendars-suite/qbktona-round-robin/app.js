const STATE_KEY = "roundRobinTournament:v4";
const LEGACY_STATE_KEY = "roundRobinTournament:v1";
const TEAM_COUNT_MIN = 3;
const TEAM_COUNT_MAX = 8;
const GAMES_PER_MATCH_MIN = 1;
const GAMES_PER_MATCH_MAX = 3;
const MATCHES_PER_TEAM_MIN = 1;
const PLAYOFF_TEAM_MIN = 2;
const POOLS_MIN_TEAM_COUNT = 4;
const POOLS_PLAYOFF_TEAM_COUNT = 4;
const TOURNAMENT_STATE_API = "/qbktona-round-robin/tournament-state";

const setupView = document.querySelector("#setupView");
const tvView = document.querySelector("#tvView");
const tournamentNameInput = document.querySelector("#tournamentNameInput");
const teamCountInput = document.querySelector("#teamCountInput");
const gamesPerMatchInput = document.querySelector("#gamesPerMatchInput");
const matchesPerTeamInput = document.querySelector("#matchesPerTeamInput");
const playoffTeamCountInput = document.querySelector("#playoffTeamCountInput");
const poolsModeInput = document.querySelector("#poolsModeInput");
const teamGrid = document.querySelector("#teamGrid");
const generateBtn = document.querySelector("#generateBtn");
const viewTvBtn = document.querySelector("#viewTvBtn");
const clearScoresBtn = document.querySelector("#clearScoresBtn");
const generatePlayoffBtn = document.querySelector("#generatePlayoffBtn");
const fullScreenBtn = document.querySelector("#fullScreenBtn");
const backToSetupBtn = document.querySelector("#backToSetupBtn");
const matchTitle = document.querySelector("#matchTitle");
const tvBoard = document.querySelector(".tv-board");
const poolTvBoard = document.querySelector("#poolTvBoard");
const globalMatchPanel = document.querySelector("#globalMatchPanel");
const matchList = document.querySelector("#matchList");
const playoffBracket = document.querySelector("#playoffBracket");
const emptyMatches = document.querySelector("#emptyMatches");
const standingsBody = document.querySelector("#standingsBody");
const standingsPanel = document.querySelector("#globalStandingsPanel");
const standingsTable = standingsPanel.querySelector(".standings-table");
const standingsTitle = document.querySelector("#standingsTitle");
const tvTournamentName = document.querySelector("#tvTournamentName");
const courtPicker = document.querySelector("#courtPicker");
const poolTvViews = [
  {
    label: "Pool A",
    matchTitle: document.querySelector("#poolAMatchTitle"),
    matchList: document.querySelector("#poolAMatchList"),
    emptyMatches: document.querySelector("#poolAEmptyMatches"),
    standingsTitle: document.querySelector("#poolAStandingsTitle"),
    standingsBody: document.querySelector("#poolAStandingsBody"),
    standingsPanel: document.querySelector("#poolAStandingsBody").closest(".standings-panel"),
  },
  {
    label: "Pool B",
    matchTitle: document.querySelector("#poolBMatchTitle"),
    matchList: document.querySelector("#poolBMatchList"),
    emptyMatches: document.querySelector("#poolBEmptyMatches"),
    standingsTitle: document.querySelector("#poolBStandingsTitle"),
    standingsBody: document.querySelector("#poolBStandingsBody"),
    standingsPanel: document.querySelector("#poolBStandingsBody").closest(".standings-panel"),
  },
];

let state = loadState();
let draggedMatchId = null;
let serverStateAvailable = Boolean(window.__QBK_TOURNAMENT_STATE_SERVER__);
let serverSaveTimer = null;
let serverSaveQueue = Promise.resolve();
let serverSavePending = false;

function loadState() {
  const saved = readStoredState(STATE_KEY) || readStoredState(LEGACY_STATE_KEY);
  const localState = normalizeStoredState(saved);
  const serverState = normalizeStoredState(window.__QBK_TOURNAMENT_STATE__);

  if (
    serverState &&
    (!localState ||
      !localState.matches.length ||
      (serverState.updatedAt && serverState.updatedAt >= localState.updatedAt))
  ) {
    return serverState;
  }

  return localState || {
    updatedAt: 0,
    tournamentName: "Round Robin Tournament",
    teams: buildTeams(5),
    gamesPerMatch: 2,
    matchesPerTeam: 4,
    playoffTeamCount: 3,
    poolsMode: false,
    matches: [],
    playoff: null,
  };
}

function normalizeStoredState(saved) {
  if (!saved || !Array.isArray(saved.teams) || !Array.isArray(saved.matches)) return null;

  const teams = normalizeTeams(saved.teams);
  const poolsMode = Boolean(saved.poolsMode || saved.format === "pools");
  const gamesPerMatch = clampGamesPerMatch(saved.gamesPerMatch);
  const matchesPerTeam = clampMatchesPerTeam(saved.matchesPerTeam, teams.length, poolsMode);
  const playoffTeamCount = poolsMode
    ? Math.min(POOLS_PLAYOFF_TEAM_COUNT, teams.length)
    : clampPlayoffTeamCount(saved.playoffTeamCount ?? saved.playoff?.teamCount, teams.length);

  return {
    updatedAt: Number.isFinite(Number(saved.updatedAt)) ? Number(saved.updatedAt) : 0,
    tournamentName: String(saved.tournamentName || "Round Robin Tournament"),
    teams,
    gamesPerMatch,
    matchesPerTeam,
    playoffTeamCount,
    poolsMode,
    matches: normalizeMatches(saved.matches, gamesPerMatch),
    playoff: normalizePlayoff(saved.playoff, playoffTeamCount, teams.length),
  };
}

function readStoredState(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function buildTeams(count, existingTeams = []) {
  const safeCount = clampTeamCount(count);
  return Array.from({ length: safeCount }, (_, index) => ({
    id: existingTeams[index]?.id || `team-${index + 1}`,
    name: String(existingTeams[index]?.name || ""),
  }));
}

function clampTeamCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 5;
  return Math.max(TEAM_COUNT_MIN, Math.min(TEAM_COUNT_MAX, Math.round(number)));
}

function splitTeamIdsIntoPools(teamIds) {
  const midpoint = Math.ceil(teamIds.length / 2);
  return [
    { label: "Pool A", teamIds: teamIds.slice(0, midpoint) },
    { label: "Pool B", teamIds: teamIds.slice(midpoint) },
  ];
}

function matchesPerTeamBounds(teamCount, poolsMode = false) {
  const safeTeamCount = clampTeamCount(teamCount);
  const poolSizes = poolsMode
    ? [Math.ceil(safeTeamCount / 2), Math.floor(safeTeamCount / 2)]
    : [safeTeamCount];
  const minimum = poolSizes.some((size) => size % 2 === 1) ? 2 : MATCHES_PER_TEAM_MIN;
  const maximum = Math.max(minimum, Math.min(...poolSizes.map((size) => size - 1)));
  return { minimum, maximum };
}

function clampPlayoffTeamCount(value, teamCount = currentTeamCount()) {
  const maximum = clampTeamCount(teamCount);
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.min(3, maximum);
  return Math.max(PLAYOFF_TEAM_MIN, Math.min(maximum, Math.round(number)));
}

function normalizeTeams(teams) {
  return buildTeams(teams.length || 5, teams);
}

function normalizeMatches(matches, gameCount = 2) {
  return matches
    .filter((match) => match?.teamA && match?.teamB)
    .map((match, index) => normalizeMatch(match, gameCount, index));
}

function normalizePlayoff(playoff, fallbackTeamCount = 3, totalTeamCount = fallbackTeamCount) {
  if (!playoff || !Array.isArray(playoff.matches) || !playoff.matches.length) return null;

  const teamCount = clampPlayoffTeamCount(
    playoff.teamCount ?? fallbackTeamCount,
    totalTeamCount
  );
  const isLegacy =
    playoff.matches.some((match) => match?.id === "playoff-semifinal") &&
    playoff.matches.every(
      (match) => match?.round === undefined && !match?.sourceA && !match?.sourceB
    );

  if (isLegacy) return normalizeLegacyPlayoff(playoff);

  const matches = playoff.matches
    .map((match, index) =>
      normalizePlayoffMatch(match, {
        id: `playoff-${index + 1}`,
        label: index === 0 ? "Semifinal" : "Final",
        round: index,
        position: 0,
        courtIndex: index,
      })
    )
    .sort(comparePlayoffMatches);

  return { teamCount, matches };
}

function normalizeLegacyPlayoff(playoff) {
  const legacySemifinal = playoff.matches.find((match) => match?.id === "playoff-semifinal");
  const legacyFinal = playoff.matches.find((match) => match?.id === "playoff-final") || {};
  const semifinal = normalizePlayoffMatch(legacySemifinal, {
    id: "playoff-semifinal",
    label: "Semifinal",
    round: 0,
    position: 0,
    seedA: 2,
    seedB: 3,
    placeholderA: "Seed",
    placeholderB: "Seed",
    courtIndex: 0,
  });
  const final = normalizePlayoffMatch(legacyFinal, {
    id: "playoff-final",
    label: "Final",
    round: 1,
    position: 0,
    seedA: 1,
    seedB: null,
    sourceB: "playoff-semifinal",
    placeholderA: "Seed",
    placeholderB: "Winner of #2 vs #3",
    courtIndex: 1,
  });

  return { teamCount: 3, matches: [semifinal, final] };
}

function normalizePlayoffMatch(match = {}, defaults = {}) {
  const round = Number(match.round);
  const position = Number(match.position);
  return {
    id: match.id || defaults.id || "playoff-match",
    label: String(match.label || defaults.label || "Round"),
    round: Number.isFinite(round) ? round : defaults.round ?? 0,
    position: Number.isFinite(position) ? position : defaults.position ?? 0,
    hidden: Boolean(match.hidden ?? defaults.hidden),
    seedA: match.seedA ?? defaults.seedA ?? null,
    seedB: match.seedB ?? defaults.seedB ?? null,
    seedLabelA: String(match.seedLabelA || defaults.seedLabelA || ""),
    seedLabelB: String(match.seedLabelB || defaults.seedLabelB || ""),
    sourceA: match.sourceA || defaults.sourceA || null,
    sourceB: match.sourceB || defaults.sourceB || null,
    teamA: match.teamA || null,
    teamB: match.teamB || null,
    teamAName: String(match.teamAName || ""),
    teamBName: String(match.teamBName || ""),
    placeholderA: String(match.placeholderA || defaults.placeholderA || "Seed"),
    placeholderB: String(match.placeholderB || defaults.placeholderB || "Seed"),
    court: normalizeCourtName(match.court, defaults.courtIndex ?? defaults.position ?? 0),
    games: buildGames(3, match.games),
  };
}

function comparePlayoffMatches(a, b) {
  return a.round - b.round || a.position - b.position;
}

function writeLocalState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

function saveState() {
  state.updatedAt = Date.now();
  writeLocalState();
  serverSavePending = true;
  queueServerSave();
}

function queueServerSave() {
  if (serverStateAvailable !== true) return;
  if (serverSaveTimer) clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => {
    serverSaveTimer = null;
    flushServerSave();
  }, 250);
}

function flushServerSave(keepalive = false) {
  if (serverStateAvailable !== true || !serverSavePending) return Promise.resolve(false);

  const snapshot = JSON.stringify(state);
  serverSavePending = false;
  serverSaveQueue = serverSaveQueue
    .catch(() => false)
    .then(async () => {
      const response = await fetch(TOURNAMENT_STATE_API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: snapshot,
        cache: "no-store",
        keepalive,
      });

      if (!response.ok) {
        if (response.status === 404) serverStateAvailable = false;
        serverSavePending = true;
        return false;
      }
      return true;
    })
    .catch(() => {
      try {
        const queued = navigator.sendBeacon(
          TOURNAMENT_STATE_API,
          new Blob([snapshot], { type: "application/json" })
        );
        if (queued) return true;
      } catch {
        serverSavePending = true;
        return false;
      }
      serverSavePending = true;
      return false;
    });
  return serverSaveQueue;
}

async function hydrateServerState() {
  const localChangedBeforeHydration = serverSavePending;

  try {
    const response = await fetch(`${TOURNAMENT_STATE_API}?t=${Date.now()}`, {
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";

    if (response.status === 404 && !contentType.includes("application/json")) {
      serverStateAvailable = false;
      return;
    }

    if (response.status === 404) {
      serverStateAvailable = true;
      if (state.matches.length) {
        serverSavePending = true;
        queueServerSave();
      }
      return;
    }

    if (!response.ok) return;

    const remoteState = normalizeStoredState(await response.json());
    if (!remoteState) return;

    serverStateAvailable = true;
    const localUpdatedAt = Number(state.updatedAt) || 0;
    const remoteUpdatedAt = Number(remoteState.updatedAt) || 0;
    const useRemoteState =
      !localChangedBeforeHydration &&
      (!state.matches.length || !localUpdatedAt || remoteUpdatedAt >= localUpdatedAt);

    if (useRemoteState) {
      state = remoteState;
      writeLocalState();
      renderTeamInputs();
      render();
      serverSavePending = false;
    } else {
      serverSavePending = true;
      queueServerSave();
    }
  } catch {
    return;
  }
}

function cleanScore(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : "";
}

function clampGamesPerMatch(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 2;
  return Math.max(GAMES_PER_MATCH_MIN, Math.min(GAMES_PER_MATCH_MAX, Math.round(number)));
}

function clampMatchesPerTeam(value, teamCount = TEAM_COUNT_MIN, poolsMode = false) {
  const safeTeamCount = clampTeamCount(teamCount);
  const { minimum, maximum } = matchesPerTeamBounds(safeTeamCount, poolsMode);
  const number = Number(value);
  if (!Number.isFinite(number)) return maximum;
  const bounded = Math.max(minimum, Math.min(maximum, Math.round(number)));
  return minimum === 2 && bounded % 2 === 1 ? bounded - 1 : bounded;
}

function buildGames(count, existingGames = []) {
  const safeCount = clampGamesPerMatch(count);
  return Array.from({ length: safeCount }, (_, gameIndex) => ({
    a: cleanScore(existingGames[gameIndex]?.a ?? ""),
    b: cleanScore(existingGames[gameIndex]?.b ?? ""),
  }));
}

function defaultCourtName(index) {
  return index % 2 === 0 ? "Middle Court" : "Left Court";
}

function normalizeCourtName(court, fallbackIndex = 0) {
  const value = String(court || defaultCourtName(fallbackIndex)).trim();
  const normalized = value.toLowerCase().replace(/\s+court$/, "").trim();
  const canonicalNames = {
    left: "Left Court",
    middle: "Middle Court",
    right: "Right Court",
  };
  return canonicalNames[normalized] || value;
}

function displayCourtName(court) {
  return normalizeCourtName(court).replace(/\s+court$/i, "").toUpperCase();
}

function normalizeMatch(match, gameCount = currentGamesPerMatch(), fallbackIndex = 0) {
  return {
    id: match.id || `${match.teamA}-${match.teamB}`,
    teamA: match.teamA,
    teamB: match.teamB,
    round: Number(match.round) || 1,
    court: normalizeCourtName(match.court, fallbackIndex),
    pool: normalizePoolName(match.pool),
    games: buildGames(gameCount, match.games),
  };
}

function normalizePoolName(pool) {
  const normalized = String(pool || "").trim().toLowerCase();
  if (normalized === "a" || normalized === "pool a") return "Pool A";
  if (normalized === "b" || normalized === "pool b") return "Pool B";
  return pool ? String(pool).trim() : null;
}

function currentTeamCount() {
  return clampTeamCount(state.teams.length);
}

function currentGamesPerMatch() {
  return clampGamesPerMatch(state.gamesPerMatch);
}

function currentMatchesPerTeam() {
  return clampMatchesPerTeam(state.matchesPerTeam, currentTeamCount(), isPoolsMode());
}

function currentPlayoffTeamCount() {
  return isPoolsMode()
    ? Math.min(POOLS_PLAYOFF_TEAM_COUNT, currentTeamCount())
    : clampPlayoffTeamCount(state.playoffTeamCount, currentTeamCount());
}

function isPoolsMode() {
  return Boolean(state.poolsMode);
}

function isPlayoffWindow() {
  return new URLSearchParams(window.location.search).get("view") === "playoff";
}

function teamName(teamId) {
  return state.teams.find((team) => team.id === teamId)?.name.trim() || "Unnamed";
}

function allTeamNamesValid() {
  const names = state.teams.map((team) => team.name.trim().toLowerCase());
  return names.every(Boolean) && new Set(names).size === names.length;
}

function poolConfigurationIsValid() {
  return (
    !isPoolsMode() ||
    (currentTeamCount() >= POOLS_MIN_TEAM_COUNT && currentTeamCount() % 2 === 0)
  );
}

function canGenerateTournament() {
  return allTeamNamesValid() && poolConfigurationIsValid();
}

function renderTeamInputs() {
  teamGrid.innerHTML = "";
  teamGrid.classList.toggle("pool-team-grid", isPoolsMode());

  if (isPoolsMode()) {
    teamGrid.style.gridTemplateColumns = "";
    const teamIds = state.teams.map((team) => team.id);

    splitTeamIdsIntoPools(teamIds).forEach((pool) => {
      const group = document.createElement("section");
      group.className = "pool-team-group";

      const heading = document.createElement("h3");
      heading.textContent = pool.label;

      const fields = document.createElement("div");
      fields.className = "pool-team-fields";
      pool.teamIds.forEach((teamId) => {
        const teamIndex = state.teams.findIndex((team) => team.id === teamId);
        if (teamIndex >= 0) {
          fields.append(createTeamField(state.teams[teamIndex], teamIndex));
        }
      });

      group.append(heading, fields);
      teamGrid.append(group);
    });
    return;
  }

  teamGrid.style.gridTemplateColumns = `repeat(${Math.min(currentTeamCount(), 4)}, minmax(140px, 1fr))`;
  state.teams.forEach((team, index) => {
    teamGrid.append(createTeamField(team, index));
  });
}

function createTeamField(team, index) {
  const field = document.createElement("label");
  field.className = "team-field";
  field.htmlFor = `team-${index}`;

  const label = document.createElement("span");
  label.textContent = `Team ${index + 1}`;

  const input = document.createElement("input");
  input.id = `team-${index}`;
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = `Team ${index + 1}`;
  input.value = team.name;
  input.addEventListener("input", () => {
    state.teams[index].name = input.value;
    saveState();
    render();
  });

  field.append(label, input);
  return field;
}

function setTeamCount(nextCount) {
  const count = clampTeamCount(nextCount);
  const previousCount = currentTeamCount();
  if (count === previousCount) return;

  const removedTeams = state.teams.slice(count);
  const removingNamedTeams = removedTeams.some((team) => team.name.trim());
  const removingScheduledTeams =
    state.matches.some(
      (match) => removedTeams.some((team) => team.id === match.teamA || team.id === match.teamB)
    ) || Boolean(state.playoff);

  if (count < previousCount && (removingNamedTeams || removingScheduledTeams)) {
    const keepGoing = window.confirm(
      "Reducing the number of teams will remove some team names, matchups, and playoff results. Continue?"
    );
    if (!keepGoing) {
      teamCountInput.value = String(previousCount);
      return;
    }
  }

  state.teams = buildTeams(count, state.teams);
  state.matchesPerTeam = clampMatchesPerTeam(state.matchesPerTeam, count, isPoolsMode());
  state.playoffTeamCount = isPoolsMode()
    ? Math.min(POOLS_PLAYOFF_TEAM_COUNT, count)
    : clampPlayoffTeamCount(state.playoffTeamCount, count);
  state.matches = [];
  state.playoff = null;
  saveState();
  renderTeamInputs();
  render();
}

function setGamesPerMatch(nextCount) {
  const count = clampGamesPerMatch(nextCount);
  const previousCount = currentGamesPerMatch();
  if (count === previousCount) return;

  const removingScoredGames =
    count < previousCount &&
    state.matches.some((match) =>
      match.games.slice(count).some((game) => game.a !== "" || game.b !== "")
    );

  if (removingScoredGames) {
    const keepGoing = window.confirm(
      "Reducing games per match will remove scores from the extra games. Continue?"
    );
    if (!keepGoing) {
      gamesPerMatchInput.value = String(previousCount);
      return;
    }
  }

  state.gamesPerMatch = count;
  state.matches = state.matches.map((match, index) => normalizeMatch(match, count, index));
  saveState();
  render();
}

function setMatchesPerTeam(nextCount) {
  const count = clampMatchesPerTeam(nextCount, currentTeamCount(), isPoolsMode());
  const previousCount = currentMatchesPerTeam();
  if (count === previousCount && state.matchesPerTeam === count) return;

  if (state.matches.length && count !== previousCount) {
    const keepGoing = window.confirm(
      "Changing matchups per team will replace the current match order and playoff results. Continue?"
    );
    if (!keepGoing) {
      matchesPerTeamInput.value = String(previousCount);
      return;
    }
  }

  state.matchesPerTeam = count;
  if (count !== previousCount) {
    state.matches = [];
    state.playoff = null;
  }
  saveState();
  render();
}

function setPlayoffTeamCount(nextCount) {
  const count = isPoolsMode()
    ? Math.min(POOLS_PLAYOFF_TEAM_COUNT, currentTeamCount())
    : clampPlayoffTeamCount(nextCount, currentTeamCount());
  const previousCount = currentPlayoffTeamCount();
  if (count === previousCount && state.playoffTeamCount === count) return;

  const hasPlayoffScores = state.playoff?.matches?.some((match) =>
    match.games.some((game) => game.a !== "" || game.b !== "")
  );

  if (hasPlayoffScores) {
    const keepGoing = window.confirm(
      "Changing playoff teams will clear the playoff bracket scores. Continue?"
    );
    if (!keepGoing) {
      playoffTeamCountInput.value = String(previousCount);
      return;
    }
  }

  state.playoffTeamCount = count;
  state.playoff = null;
  saveState();
  render();
}

function setPoolsMode(nextValue) {
  const enabled = Boolean(nextValue);
  if (enabled === isPoolsMode()) return;

  const hasScores =
    state.matches.some((match) => match.games.some((game) => game.a || game.b)) ||
    state.playoff?.matches?.some((match) =>
      match.games.some((game) => game.a || game.b)
    );

  if (hasScores) {
    const keepGoing = window.confirm(
      "Changing the tournament format will clear the current match and playoff scores. Continue?"
    );
    if (!keepGoing) {
      poolsModeInput.checked = isPoolsMode();
      return;
    }
  }

  state.poolsMode = enabled;
  state.matchesPerTeam = clampMatchesPerTeam(
    state.matchesPerTeam,
    currentTeamCount(),
    enabled
  );
  state.playoffTeamCount = enabled
    ? Math.min(POOLS_PLAYOFF_TEAM_COUNT, currentTeamCount())
    : clampPlayoffTeamCount(state.playoffTeamCount, currentTeamCount());
  state.matches = [];
  state.playoff = null;
  saveState();
  renderTeamInputs();
  render();
}

function buildScheduleRounds(teamIds, matchesPerTeam) {
  const rounds = [];
  const target = clampMatchesPerTeam(matchesPerTeam, teamIds.length);

  if (teamIds.length % 2 === 0) {
    const slots = [...teamIds];

    for (let round = 1; round <= target; round += 1) {
      const matches = [];
      for (let index = 0; index < slots.length / 2; index += 1) {
        matches.push({
          id: `match-${slots[index]}-${slots[slots.length - 1 - index]}`,
          teamA: slots[index],
          teamB: slots[slots.length - 1 - index],
          round,
          games: buildGames(currentGamesPerMatch()),
        });
      }

      rounds.push(matches);
      slots.splice(1, 0, slots.pop());
    }

    return rounds;
  }

  for (let distance = 1; distance <= target / 2; distance += 1) {
    rounds.push(
      teamIds.map((teamId, index) => {
        const opponent = teamIds[(index + distance) % teamIds.length];
        return {
          id: `match-${teamId}-${opponent}`,
          teamA: teamId,
          teamB: opponent,
          round: distance,
          games: buildGames(currentGamesPerMatch()),
        };
      })
    );
  }

  return rounds;
}

function buildPoolScheduleRounds(teamIds, matchesPerTeam) {
  const poolRounds = splitTeamIdsIntoPools(teamIds).map((pool) =>
    buildScheduleRounds(pool.teamIds, matchesPerTeam).map((round) =>
      round.map((match) => ({ ...match, pool: pool.label }))
    )
  );
  const rounds = [];
  const roundCount = Math.max(...poolRounds.map((pool) => pool.length), 0);

  for (let round = 0; round < roundCount; round += 1) {
    poolRounds.forEach((pool) => {
      if (pool[round]) rounds.push(pool[round]);
    });
  }

  return rounds;
}

function buildCompetitionSchedule(teamIds, matchesPerTeam) {
  return isPoolsMode()
    ? buildPoolScheduleRounds(teamIds, matchesPerTeam)
    : buildScheduleRounds(teamIds, matchesPerTeam);
}

function generateRoundRobin() {
  if (!canGenerateTournament()) return;

  if (state.matches.some((match) => match.games.some((game) => game.a || game.b))) {
    const keepGoing = window.confirm(
      "Generating a new order will clear the current match scores. Continue?"
    );
    if (!keepGoing) return;
  }

  const ids = state.teams.map((team) => team.id);
  const rounds = buildCompetitionSchedule(ids, currentMatchesPerTeam());

  state.matches = rounds.flat().map((match, index) => ({
    ...match,
    court: defaultCourtName(index),
  }));
  state.playoff = null;
  saveState();
  window.location.hash = "tv";
  render();
}

function showSetup() {
  saveState();
  window.location.hash = "setup";
  render();
}

function showTv() {
  if (!state.matches.length) return;
  saveState();
  window.location.hash = "tv";
  render();
}

function moveMatch(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.matches.length || fromIndex === toIndex) return;
  const [match] = state.matches.splice(fromIndex, 1);
  state.matches.splice(toIndex, 0, match);
  saveState();
  render();
}

function moveMatchBefore(matchId, targetId, poolLabel = null) {
  if (!matchId || !targetId || matchId === targetId) return;

  const source = state.matches.find((match) => match.id === matchId);
  const target = state.matches.find((match) => match.id === targetId);
  if (!source || !target) return;
  if (poolLabel && (source.pool !== poolLabel || target.pool !== poolLabel)) return;

  const sourceIndex = state.matches.findIndex((match) => match.id === matchId);
  const [match] = state.matches.splice(sourceIndex, 1);
  const targetIndex = state.matches.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) {
    state.matches.splice(sourceIndex, 0, match);
    return;
  }

  state.matches.splice(targetIndex, 0, match);
  saveState();
  render();
}

function moveMatchRelative(matchId, direction, poolLabel = null) {
  const orderedMatches = state.matches.filter(
    (match) => !poolLabel || match.pool === poolLabel
  );
  const currentIndex = orderedMatches.findIndex((match) => match.id === matchId);
  const target = orderedMatches[currentIndex + direction];
  if (target) moveMatchBefore(matchId, target.id, poolLabel);
}

function updateScore(matchId, gameIndex, side, value) {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match) return;
  match.games[gameIndex][side] = cleanScore(value);
  saveState();
  renderStandings();
}

function updatePlayoffScore(matchId, gameIndex, side, value) {
  const match = state.playoff?.matches.find((item) => item.id === matchId);
  if (!match) return;
  match.games[gameIndex][side] = cleanScore(value);
  syncPlayoffParticipants();
  saveState();
  renderPlayoff();
}

function clearScores() {
  state.matches = state.matches.map((match) => ({
    ...match,
    games: match.games.map(() => ({ a: "", b: "" })),
  }));
  if (state.playoff) {
    state.playoff.matches = state.playoff.matches.map((match) => ({
      ...match,
      games: match.games.map(() => ({ a: "", b: "" })),
    }));
    syncPlayoffParticipants();
  }
  saveState();
  render();
}

function renderMatches() {
  if (isPoolsMode()) {
    renderPoolMatches();
    return;
  }

  renderMatchList({
    list: matchList,
    emptyState: emptyMatches,
    title: matchTitle,
    matches: state.matches,
  });
}

function renderPoolMatches() {
  const pools = splitTeamIdsIntoPools(state.teams.map((team) => team.id));
  poolTvViews.forEach((view, index) => {
    const pool = pools[index];
    const poolMatches = state.matches.filter((match) => match.pool === pool.label);
    renderMatchList({
      list: view.matchList,
      emptyState: view.emptyMatches,
      title: view.matchTitle,
      matches: poolMatches,
      poolLabel: pool.label,
    });
  });
}

function renderMatchList({ list, emptyState, title, matches, poolLabel = null }) {
  list.innerHTML = "";
  list.hidden = matches.length === 0;
  emptyState.hidden = matches.length > 0;
  title.textContent = poolLabel ? `${poolLabel} Matchups` : "Matchups";

  matches.forEach((match, index) => {
    const stateIndex = state.matches.findIndex((item) => item.id === match.id);
    list.append(createMatchCard(match, stateIndex, index, poolLabel, list));
  });

  fitMatchList(list, matches.length);
  fitMatchTeamNames();
}

function createMatchCard(match, stateIndex, displayIndex, poolLabel, list) {
  const card = document.createElement("article");
  card.className = "match-card";
  card.draggable = true;
  card.dataset.matchId = match.id;

  card.addEventListener("dragstart", (event) => {
    draggedMatchId = match.id;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", match.id);
  });

  card.addEventListener("dragend", () => {
    draggedMatchId = null;
    card.classList.remove("dragging");
  });

  card.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });

  card.addEventListener("drop", (event) => {
    event.preventDefault();
    const fromId = draggedMatchId || event.dataTransfer.getData("text/plain");
    if (poolLabel) {
      moveMatchBefore(fromId, match.id, poolLabel);
      return;
    }

    const fromIndex = state.matches.findIndex((item) => item.id === fromId);
    moveMatch(fromIndex, stateIndex);
  });

  const number = document.createElement("div");
  number.className = "match-number";

  const matchOrdinal = document.createElement("span");
  matchOrdinal.className = "match-ordinal";
  matchOrdinal.textContent = String(displayIndex + 1);

  const court = document.createElement("span");
  court.className = "match-court";
  court.textContent = displayCourtName(match.court);
  court.title = "Click to choose";

  number.append(matchOrdinal, court);
  number.title = "Click to choose";
  number.setAttribute("role", "button");
  number.tabIndex = 0;
  number.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCourtPicker(match, stateIndex, list);
  });
  number.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openCourtPicker(match, stateIndex, list);
  });

  const main = document.createElement("div");
  main.className = "match-main";

  const teamA = document.createElement("div");
  teamA.className = "match-side";
  teamA.textContent = teamName(match.teamA);

  const games = document.createElement("div");
  games.className = "games";
  games.style.gridTemplateRows = `repeat(${match.games.length}, minmax(0, 1fr))`;
  match.games.forEach((game, gameIndex) => {
    games.append(renderGameRow(match, game, gameIndex));
  });

  const teamB = document.createElement("div");
  teamB.className = "match-side";
  teamB.textContent = teamName(match.teamB);

  main.append(teamA, games, teamB);

  const controls = document.createElement("div");
  controls.className = "reorder-controls";
  controls.append(
    makeMoveButton("Move up", "^", () => moveMatchRelative(match.id, -1, poolLabel)),
    makeMoveButton("Move down", "v", () => moveMatchRelative(match.id, 1, poolLabel))
  );

  card.append(number, main, controls);
  return card;
}

function fitMatchList(list, count = list.children.length) {
  const fitAll = count > 0 && window.innerWidth > 1100;
  list.classList.toggle("fit-all-matches", fitAll);
  list.classList.toggle("compact-matches", fitAll && count >= 10);
  list.style.gridTemplateRows = fitAll
    ? `repeat(${count}, minmax(0, 1fr))`
    : "";
}

function fitAllMatchLists() {
  document.querySelectorAll(".match-list").forEach((list) => {
    fitMatchList(list);
  });
}

function openCourtPicker(match, matchIndex, list = matchList) {
  courtPicker.dataset.matchId = match.id;
  courtPicker.dataset.matchIndex = String(matchIndex);
  courtPicker.dataset.matchListId = list.id;
  courtPicker.showModal();
}

function chooseCourt(court) {
  const matchIndex = Number(courtPicker.dataset.matchIndex);
  const matchId = courtPicker.dataset.matchId;
  const match = state.matches.find((item) => item.id === matchId);
  if (!match || !Number.isInteger(matchIndex)) return;

  match.court = normalizeCourtName(court, matchIndex);
  const sourceList = document.getElementById(courtPicker.dataset.matchListId) || matchList;
  const scrollTop = sourceList.scrollTop;
  saveState();
  courtPicker.close();
  renderMatches();
  const restoredList = document.getElementById(courtPicker.dataset.matchListId) || matchList;
  restoredList.scrollTop = scrollTop;
}

function fitMatchTeamNames() {
  document.querySelectorAll(".match-side").forEach((cell) => {
    if (!cell.clientWidth) return;

    cell.style.fontSize = "";
    let size = parseFloat(window.getComputedStyle(cell).fontSize);
    const minSize = 9;

    while (cell.scrollWidth > cell.clientWidth && size > minSize) {
      size -= 1;
      cell.style.fontSize = `${size}px`;
    }
  });
}

function fitTournamentName() {
  if (!tvTournamentName.clientWidth) return;

  tvTournamentName.style.fontSize = "";
  let size = parseFloat(window.getComputedStyle(tvTournamentName).fontSize);
  const minSize = 16;

  while (tvTournamentName.scrollWidth > tvTournamentName.clientWidth && size > minSize) {
    size -= 1;
    tvTournamentName.style.fontSize = `${size}px`;
  }
}

function nextBracketSize(teamCount) {
  let size = 2;
  while (size < teamCount) size *= 2;
  return size;
}

function seededBracketOrder(size) {
  let order = [1, 2];

  while (order.length < size) {
    const nextSize = order.length * 2;
    order = order.flatMap((seed) => [seed, nextSize + 1 - seed]);
  }

  return order;
}

function playoffRoundLabel(round, totalRounds) {
  if (round === totalRounds - 1) return "Final";
  if (round === totalRounds - 2) return "Semifinal";
  return "Quarterfinal";
}

function playoffSourceSeed(match) {
  if (!match?.hidden) return null;
  return match.seedA || match.seedB || null;
}

function playoffSeedLabel(seed, explicitLabel = "") {
  return explicitLabel || (seed ? `#${seed}` : "");
}

function playoffSourcePlaceholder(match) {
  if (!match) return "Winner";
  if (match.hidden) return "Seed";
  if (match.round === 0 && match.seedA && match.seedB) {
    return `Winner of ${playoffSeedLabel(match.seedA, match.seedLabelA)} vs ${playoffSeedLabel(
      match.seedB,
      match.seedLabelB
    )}`;
  }
  return "Winner";
}

function createPlayoffMatch(options = {}) {
  const {
    id,
    label,
    round,
    position,
    seedA = null,
    seedB = null,
    seedLabelA = "",
    seedLabelB = "",
    sourceA = null,
    sourceB = null,
    teamA = null,
    teamB = null,
    teamAName = "",
    teamBName = "",
    placeholderA = "Seed",
    placeholderB = "Seed",
    courtIndex = position,
  } = options;

  return {
    id,
    label,
    round,
    position,
    hidden: round === 0 && Boolean(seedA) !== Boolean(seedB),
    seedA,
    seedB,
    seedLabelA,
    seedLabelB,
    sourceA,
    sourceB,
    teamA,
    teamB,
    teamAName,
    teamBName,
    placeholderA,
    placeholderB,
    court: defaultCourtName(courtIndex),
    games: buildGames(3),
  };
}

function createPlayoffBracket(teamCount, seededTeams = []) {
  const safeCount = clampPlayoffTeamCount(teamCount, currentTeamCount());
  const size = nextBracketSize(safeCount);
  const totalRounds = Math.log2(size);
  const order = seededBracketOrder(size);
  const seededBySeed = new Map(
    seededTeams.map((team, index) => [Number(team.seed) || index + 1, team])
  );
  const rounds = [];
  const firstRound = [];

  for (let index = 0; index < order.length; index += 2) {
    const seedA = order[index] <= safeCount ? order[index] : null;
    const seedB = order[index + 1] <= safeCount ? order[index + 1] : null;
    const teamA = seededBySeed.get(seedA);
    const teamB = seededBySeed.get(seedB);

    firstRound.push(
      createPlayoffMatch({
        id: `playoff-r1-${index / 2 + 1}`,
        label: playoffRoundLabel(0, totalRounds),
        round: 0,
        position: index / 2,
        seedA,
        seedB,
        seedLabelA: teamA?.seedLabel || "",
        seedLabelB: teamB?.seedLabel || "",
        teamA: teamA?.id || null,
        teamB: teamB?.id || null,
        teamAName: teamA?.name || "",
        teamBName: teamB?.name || "",
        courtIndex: index / 2,
      })
    );
  }
  rounds.push(firstRound);

  for (let round = 1; round < totalRounds; round += 1) {
    const previous = rounds[round - 1];
    const current = [];

    for (let position = 0; position < previous.length / 2; position += 1) {
      const sourceA = previous[position * 2];
      const sourceB = previous[position * 2 + 1];

      current.push(
        createPlayoffMatch({
          id: `playoff-r${round + 1}-${position + 1}`,
          label: playoffRoundLabel(round, totalRounds),
          round,
          position,
          seedA: playoffSourceSeed(sourceA),
          seedB: playoffSourceSeed(sourceB),
          sourceA: sourceA.id,
          sourceB: sourceB.id,
          placeholderA: playoffSourcePlaceholder(sourceA),
          placeholderB: playoffSourcePlaceholder(sourceB),
          courtIndex: position,
        })
      );
    }

    rounds.push(current);
  }

  let visibleIndex = 0;
  const matches = rounds.flat();
  matches.forEach((match) => {
    match.court = match.label === "Final" ? "Left Court" : defaultCourtName(visibleIndex);
    if (!match.hidden) visibleIndex += 1;
  });

  return { teamCount: safeCount, matches };
}

function createPoolPlayoffBracket(poolStandings) {
  const qualifiedTeams = poolStandings.flatMap((pool) =>
    pool.teams.slice(0, 2).map((team, index) => ({
      ...team,
      pool: pool.label,
      poolRank: index + 1,
      seedLabel: `${pool.label} #${index + 1}`,
    }))
  );
  const poolA = qualifiedTeams.filter((team) => team.pool === "Pool A");
  const poolB = qualifiedTeams.filter((team) => team.pool === "Pool B");

  if (poolA.length < 2 || poolB.length < 2) return null;

  const semifinalTeams = [
    [poolA[0], poolB[1]],
    [poolB[0], poolA[1]],
  ];
  const semifinals = semifinalTeams.map(([teamA, teamB], index) =>
    createPlayoffMatch({
      id: `playoff-r1-${index + 1}`,
      label: "Semifinal",
      round: 0,
      position: index,
      seedA: teamA.poolRank,
      seedB: teamB.poolRank,
      seedLabelA: teamA.seedLabel,
      seedLabelB: teamB.seedLabel,
      teamA: teamA.id,
      teamB: teamB.id,
      teamAName: teamA.name,
      teamBName: teamB.name,
      courtIndex: index,
    })
  );
  const final = createPlayoffMatch({
    id: "playoff-r2-1",
    label: "Final",
    round: 1,
    position: 0,
    sourceA: semifinals[0].id,
    sourceB: semifinals[1].id,
    placeholderA: playoffSourcePlaceholder(semifinals[0]),
    placeholderB: playoffSourcePlaceholder(semifinals[1]),
    courtIndex: 1,
  });

  return { teamCount: POOLS_PLAYOFF_TEAM_COUNT, matches: [...semifinals, final] };
}

function generatePlayoff() {
  const playoffTeamCount = currentPlayoffTeamCount();
  if (!canGenerateTournament()) return;

  const standings = calculateStandings();
  const poolStandings = isPoolsMode() ? calculatePoolStandings(standings) : null;
  const seededStandings = poolStandings
    ? poolStandings.flatMap((pool) => pool.teams.slice(0, 2))
    : standings;
  if (seededStandings.length < playoffTeamCount) return;

  const hasExistingScores = state.playoff?.matches?.some((match) =>
    match.games.some((game) => game.a !== "" || game.b !== "")
  );

  if (hasExistingScores) {
    const keepGoing = window.confirm(
      "Generating the playoff again will replace the seeded teams and clear playoff scores. Continue?"
    );
    if (!keepGoing) return;
  }

  state.playoffTeamCount = playoffTeamCount;
  if (poolStandings) {
    state.playoff = createPoolPlayoffBracket(poolStandings);
  } else {
    const seededTeams = seededStandings.slice(0, playoffTeamCount).map((team, index) => ({
      seed: index + 1,
      id: team.id,
      name: team.name,
    }));
    state.playoff = createPlayoffBracket(playoffTeamCount, seededTeams);
  }
  if (!state.playoff) return;
  syncPlayoffParticipants();
  saveState();
  render();
  if (isPoolsMode() && !isPlayoffWindow()) openPlayoffWindow();
}

function openPlayoffWindow() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "playoff");
  url.hash = "tv";
  const playoffWindow = window.open(url.href, "qbk-playoff-window");
  playoffWindow?.focus();
}

function defaultPlayoffMatches() {
  if (isPoolsMode()) {
    return createPoolPlayoffBracket(calculatePoolStandings(calculateStandings()))?.matches || [];
  }
  return createPlayoffBracket(currentPlayoffTeamCount()).matches;
}

function playoffMatchWinner(match) {
  if (!match) return null;

  if (!match.sourceA && !match.sourceB) {
    if (match.teamA && !match.teamB) return match.teamA;
    if (match.teamB && !match.teamA) return match.teamB;
  }

  if (!match.teamA || !match.teamB) return null;

  let winsA = 0;
  let winsB = 0;

  match.games.forEach((game) => {
    if (game.a === "" || game.b === "") return;
    const scoreA = Number(game.a);
    const scoreB = Number(game.b);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return;
    if (scoreA > scoreB) winsA += 1;
    if (scoreB > scoreA) winsB += 1;
  });

  const winsNeeded = Math.ceil(match.games.length / 2);
  if (winsA >= winsNeeded) return match.teamA;
  if (winsB >= winsNeeded) return match.teamB;
  return null;
}

function playoffWinnerSeed(match) {
  const winnerId = playoffMatchWinner(match);
  if (!winnerId) return null;
  if (winnerId === match.teamA) return match.seedA;
  if (winnerId === match.teamB) return match.seedB;
  return null;
}

function playoffWinnerSeedLabel(match) {
  const winnerId = playoffMatchWinner(match);
  if (!winnerId) return null;
  if (winnerId === match.teamA) return playoffSeedLabel(match.seedA, match.seedLabelA);
  if (winnerId === match.teamB) return playoffSeedLabel(match.seedB, match.seedLabelB);
  return null;
}

function resolvePlayoffSource(sourceMatch) {
  if (!sourceMatch) return null;

  const winnerId = playoffMatchWinner(sourceMatch);
  if (!winnerId) return null;

  return {
    id: winnerId,
    seed: playoffWinnerSeed(sourceMatch),
    seedLabel: playoffWinnerSeedLabel(sourceMatch),
    name: teamName(winnerId),
  };
}

function syncPlayoffParticipants() {
  if (!state.playoff?.matches) return;

  const matches = state.playoff.matches.sort(comparePlayoffMatches);
  const byId = new Map(matches.map((match) => [match.id, match]));

  matches.forEach((match) => {
    const previousA = match.teamA || null;
    const previousB = match.teamB || null;

    if (match.sourceA) {
      const participantA = resolvePlayoffSource(byId.get(match.sourceA));
      match.teamA = participantA?.id || null;
      match.seedA = participantA?.seed || null;
      match.seedLabelA = participantA?.seedLabel || "";
      match.teamAName = participantA?.name || "";
    } else if (match.teamA) {
      match.teamAName = teamName(match.teamA);
    }

    if (match.sourceB) {
      const participantB = resolvePlayoffSource(byId.get(match.sourceB));
      match.teamB = participantB?.id || null;
      match.seedB = participantB?.seed || null;
      match.seedLabelB = participantB?.seedLabel || "";
      match.teamBName = participantB?.name || "";
    } else if (match.teamB) {
      match.teamBName = teamName(match.teamB);
    }

    if (previousA !== (match.teamA || null) || previousB !== (match.teamB || null)) {
      match.games = buildGames(3);
    }
  });
}

function renderPlayoff() {
  if (isPoolsMode() && !isPlayoffWindow()) {
    playoffBracket.hidden = true;
    return;
  }

  if (state.playoff) syncPlayoffParticipants();
  const playoffMatches = state.playoff?.matches || defaultPlayoffMatches();
  playoffBracket.hidden = false;
  playoffBracket.innerHTML = "";

  playoffMatches.filter((match) => !match.hidden).forEach((match) => {
    const card = document.createElement("article");
    card.className = `playoff-card ${match.label.toLowerCase()}`;

    const heading = document.createElement("div");
    heading.className = "playoff-heading";

    const headingLabel = document.createElement("span");
    headingLabel.textContent = match.label;

    const headingCourt = document.createElement("span");
    headingCourt.className = "playoff-court";
    headingCourt.textContent = displayCourtName(match.court);

    heading.append(headingLabel, headingCourt);

    const body = document.createElement("div");
    body.className = "playoff-body";

    const teamA = document.createElement("div");
    teamA.className = "playoff-team";
    teamA.innerHTML = playoffTeamMarkup(match, "A");

    const scores = document.createElement("div");
    scores.className = "playoff-scores";
    match.games.forEach((game, gameIndex) => {
      scores.append(renderPlayoffGameRow(match, game, gameIndex));
    });

    const teamB = document.createElement("div");
    teamB.className = "playoff-team";
    teamB.innerHTML = playoffTeamMarkup(match, "B");

    body.append(teamA, scores, teamB);
    card.append(heading, body);
    playoffBracket.append(card);
  });

  fitPlayoffTeamNames();
}

function fitPlayoffTeamNames() {
  document.querySelectorAll(".playoff-team-name").forEach((cell) => {
    if (!cell.clientWidth) return;

    cell.style.fontSize = "";
    let size = parseFloat(window.getComputedStyle(cell).fontSize);
    const minSize = 12;

    while (cell.scrollWidth > cell.clientWidth && size > minSize) {
      size -= 1;
      cell.style.fontSize = `${size}px`;
    }
  });
}

function renderPlayoffGameRow(match, game, gameIndex) {
  const row = document.createElement("div");
  row.className = "game-row playoff-game-row";

  const scoreA = Number(game.a);
  const scoreB = Number(game.b);
  const complete = game.a !== "" && game.b !== "";
  const aWon = complete && scoreA > scoreB;
  const bWon = complete && scoreB > scoreA;

  const inputA = playoffScoreInput(match, gameIndex, "a", game.a);
  if (aWon) inputA.classList.add("winner");

  const separator = document.createElement("div");
  separator.className = "score-separator";
  separator.textContent = "-";

  const inputB = playoffScoreInput(match, gameIndex, "b", game.b);
  if (bWon) inputB.classList.add("winner");

  row.append(inputA, separator, inputB);
  return row;
}

function playoffScoreInput(match, gameIndex, side, value) {
  const input = scoreInput(match.id, gameIndex, side, value);
  const activePlayoffMatch = Boolean(state.playoff) && match.teamA && match.teamB;
  input.disabled = !activePlayoffMatch;
  if (activePlayoffMatch) {
    input.addEventListener("input", () => updatePlayoffScore(match.id, gameIndex, side, input.value));
  }
  return input;
}

function playoffTeamName(match, side) {
  const explicit = side === "A" ? match.teamAName : match.teamBName;
  const id = side === "A" ? match.teamA : match.teamB;
  const placeholder = side === "A" ? match.placeholderA : match.placeholderB;
  if (id) return teamName(id);
  if (explicit) return explicit;
  return placeholder || "TBD";
}

function playoffTeamMarkup(match, side) {
  const seed = side === "A" ? match.seedA : match.seedB;
  const seedLabel = side === "A" ? match.seedLabelA : match.seedLabelB;
  const name = playoffTeamName(match, side);
  const displaySeedLabel = playoffSeedLabel(seed, seedLabel);
  return `
    <span class="playoff-seed">${escapeHtml(displaySeedLabel)}</span>
    <span class="playoff-team-name">${escapeHtml(name)}</span>
  `;
}

function renderGameRow(match, game, gameIndex) {
  const row = document.createElement("div");
  row.className = "game-row";

  const scoreA = Number(game.a);
  const scoreB = Number(game.b);
  const complete = game.a !== "" && game.b !== "";
  const aWon = complete && scoreA > scoreB;
  const bWon = complete && scoreB > scoreA;

  const inputA = scoreInput(match.id, gameIndex, "a", game.a);
  inputA.addEventListener("input", () => updateScore(match.id, gameIndex, "a", inputA.value));
  if (aWon) inputA.classList.add("winner");

  const separator = document.createElement("div");
  separator.className = "score-separator";
  separator.textContent = "-";

  const inputB = scoreInput(match.id, gameIndex, "b", game.b);
  inputB.addEventListener("input", () => updateScore(match.id, gameIndex, "b", inputB.value));
  if (bWon) inputB.classList.add("winner");

  row.append(inputA, separator, inputB);
  return row;
}

function scoreInput(matchId, gameIndex, side, value) {
  const input = document.createElement("input");
  input.className = "score-input";
  input.type = "number";
  input.min = "0";
  input.inputMode = "numeric";
  input.value = value;
  input.ariaLabel = `Game ${gameIndex + 1} score`;
  return input;
}

function makeMoveButton(label, text, onClick) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.ariaLabel = label;
  button.addEventListener("click", onClick);
  return button;
}

function calculateStandings() {
  const poolsByTeam = new Map(
    splitTeamIdsIntoPools(state.teams.map((team) => team.id)).flatMap((pool) =>
      pool.teamIds.map((teamId) => [teamId, pool.label])
    )
  );
  const standings = state.teams.map((team, seed) => ({
    id: team.id,
    seed,
    name: team.name.trim() || `Team ${seed + 1}`,
    pool: isPoolsMode() ? poolsByTeam.get(team.id) || null : null,
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    diff: 0,
  }));

  const byId = new Map(standings.map((team) => [team.id, team]));

  state.matches.forEach((match) => {
    match.games.forEach((game) => {
      if (game.a === "" || game.b === "") return;
      const scoreA = Number(game.a);
      const scoreB = Number(game.b);
      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return;

      const teamA = byId.get(match.teamA);
      const teamB = byId.get(match.teamB);
      teamA.pointsFor += scoreA;
      teamA.pointsAgainst += scoreB;
      teamB.pointsFor += scoreB;
      teamB.pointsAgainst += scoreA;

      if (scoreA > scoreB) {
        teamA.wins += 1;
        teamB.losses += 1;
      } else {
        teamB.wins += 1;
        teamA.losses += 1;
      }
    });
  });

  standings.forEach((team) => {
    team.diff = team.pointsFor - team.pointsAgainst;
  });

  return standings.sort(compareStandings);
}

function compareStandings(a, b) {
  if (b.wins !== a.wins) return b.wins - a.wins;
  if (b.diff !== a.diff) return b.diff - a.diff;
  if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
  return a.seed - b.seed;
}

function calculatePoolStandings(standings) {
  return splitTeamIdsIntoPools(state.teams.map((team) => team.id)).map((pool) => ({
    ...pool,
    teams: standings
      .filter((team) => pool.teamIds.includes(team.id))
      .sort(compareStandings),
  }));
}

function appendStandingRow(body, team, rank) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${rank}</td>
    <td class="standings-team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</td>
    <td>${team.wins}</td>
    <td>${team.losses}</td>
    <td>${team.pointsFor}</td>
    <td>${team.pointsAgainst}</td>
    <td class="${team.diff > 0 ? "diff-positive" : team.diff < 0 ? "diff-negative" : ""}">
      ${team.diff > 0 ? "+" : ""}${team.diff}
    </td>
  `;
  body.append(row);
}

function appendStandingSpacerRow(body) {
  const row = document.createElement("tr");
  row.className = "standings-spacer-row";
  row.setAttribute("aria-hidden", "true");
  row.innerHTML = '<td colspan="7"></td>';
  body.append(row);
}

function renderStandings() {
  if (isPlayoffWindow()) {
    standingsPanel.classList.remove("compact-standings", "pool-standings");
    standingsTitle.textContent = "Playoffs";
    standingsBody.innerHTML = "";
    return;
  }

  if (isPoolsMode()) {
    renderPoolStandings();
    return;
  }

  const standings = calculateStandings();
  const playoffMatches = (state.playoff?.matches || defaultPlayoffMatches()).filter(
    (match) => !match.hidden
  );
  standingsPanel.classList.toggle(
    "compact-standings",
    standings.length >= 6 && playoffMatches.length > 2
  );
  standingsPanel.classList.toggle("pool-standings", isPoolsMode());
  standingsTitle.textContent = isPoolsMode() ? "Pool Standings" : "Standings";
  standingsBody.innerHTML = "";

  standings.forEach((team, index) => appendStandingRow(standingsBody, team, index + 1));
  fitStandingsTeamNames();
}

function renderPoolStandings() {
  const pools = calculatePoolStandings(calculateStandings());
  poolTvViews.forEach((view, index) => {
    const pool = pools[index];
    view.standingsTitle.textContent = `${pool.label} Standings`;
    view.standingsBody.innerHTML = "";
    pool.teams.forEach((team, teamIndex) => {
      appendStandingRow(view.standingsBody, team, teamIndex + 1);
    });
    for (let slot = pool.teams.length; slot < 5; slot += 1) {
      appendStandingSpacerRow(view.standingsBody);
    }
  });

  fitStandingsTeamNames();
}

function fitStandingsTeamNames() {
  document.querySelectorAll(".standings-team-name").forEach((cell) => {
    cell.style.fontSize = "";
    let size = parseFloat(window.getComputedStyle(cell).fontSize);
    const minSize = 18;

    while (cell.scrollWidth > cell.clientWidth && size > minSize) {
      size -= 1;
      cell.style.fontSize = `${size}px`;
    }
  });
}

function syncMatchesPerTeamInput() {
  const teamCount = currentTeamCount();
  const { minimum, maximum } = matchesPerTeamBounds(teamCount, isPoolsMode());
  matchesPerTeamInput.min = String(minimum);
  matchesPerTeamInput.max = String(maximum);
  matchesPerTeamInput.step = String(minimum === 2 ? 2 : 1);
}

function syncTeamCountInput() {
  const poolsMode = isPoolsMode();
  teamCountInput.min = String(poolsMode ? POOLS_MIN_TEAM_COUNT : TEAM_COUNT_MIN);
  teamCountInput.step = String(poolsMode ? 2 : 1);
  teamCountInput.setCustomValidity(
    poolConfigurationIsValid() ? "" : "Pools mode requires an even number of at least 4 teams."
  );
}

function syncPlayoffTeamCountInput() {
  playoffTeamCountInput.min = String(isPoolsMode() ? POOLS_PLAYOFF_TEAM_COUNT : PLAYOFF_TEAM_MIN);
  playoffTeamCountInput.max = String(
    isPoolsMode() ? POOLS_PLAYOFF_TEAM_COUNT : currentTeamCount()
  );
  playoffTeamCountInput.step = "1";
  playoffTeamCountInput.disabled = isPoolsMode();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  const screen = window.location.hash === "#setup" || !state.matches.length ? "setup" : "tv";
  tournamentNameInput.value = state.tournamentName;
  tvTournamentName.textContent = state.tournamentName.trim() || "Round Robin Tournament";
  poolsModeInput.checked = isPoolsMode();
  teamCountInput.value = String(currentTeamCount());
  syncTeamCountInput();
  gamesPerMatchInput.value = String(currentGamesPerMatch());
  syncMatchesPerTeamInput();
  matchesPerTeamInput.value = String(currentMatchesPerTeam());
  syncPlayoffTeamCountInput();
  playoffTeamCountInput.value = String(currentPlayoffTeamCount());
  setupView.hidden = screen !== "setup";
  tvView.hidden = screen !== "tv";
  fitTournamentName();
  generateBtn.disabled = !canGenerateTournament();
  viewTvBtn.disabled = state.matches.length === 0;
  clearScoresBtn.disabled = state.matches.length === 0;
  generatePlayoffBtn.disabled = state.matches.length === 0 || !canGenerateTournament();
  generatePlayoffBtn.textContent = "Generate Playoff";
  fullScreenBtn.textContent = document.fullscreenElement ? "Exit Full Screen" : "Full Screen";
  const poolsMode = isPoolsMode();
  const playoffWindow = isPlayoffWindow();
  const showPoolBoard = poolsMode && !playoffWindow;
  poolTvBoard.hidden = !showPoolBoard;
  globalMatchPanel.hidden = showPoolBoard || playoffWindow;
  standingsPanel.hidden = showPoolBoard;
  standingsTable.hidden = playoffWindow;
  tvBoard.classList.toggle("pool-mode", showPoolBoard);
  tvBoard.classList.toggle("playoff-mode", playoffWindow);
  renderMatches();
  renderStandings();
  renderPlayoff();
}

async function toggleFullScreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    fullScreenBtn.textContent = "Full Screen";
  }
}

tournamentNameInput.addEventListener("input", () => {
  state.tournamentName = tournamentNameInput.value;
  saveState();
  render();
});

teamCountInput.addEventListener("change", () => {
  setTeamCount(teamCountInput.value);
});

teamCountInput.addEventListener("input", () => {
  if (teamCountInput.value === "") return;
  teamCountInput.value = String(clampTeamCount(teamCountInput.value));
});

gamesPerMatchInput.addEventListener("change", () => {
  setGamesPerMatch(gamesPerMatchInput.value);
});

gamesPerMatchInput.addEventListener("input", () => {
  if (gamesPerMatchInput.value === "") return;
  gamesPerMatchInput.value = String(clampGamesPerMatch(gamesPerMatchInput.value));
});

matchesPerTeamInput.addEventListener("change", () => {
  setMatchesPerTeam(matchesPerTeamInput.value);
});

matchesPerTeamInput.addEventListener("input", () => {
  if (matchesPerTeamInput.value === "") return;
  matchesPerTeamInput.value = String(
    clampMatchesPerTeam(matchesPerTeamInput.value, currentTeamCount(), isPoolsMode())
  );
});

playoffTeamCountInput.addEventListener("change", () => {
  setPlayoffTeamCount(playoffTeamCountInput.value);
});

playoffTeamCountInput.addEventListener("input", () => {
  if (playoffTeamCountInput.value === "") return;
  playoffTeamCountInput.value = String(
    clampPlayoffTeamCount(playoffTeamCountInput.value, currentTeamCount())
  );
});

poolsModeInput.addEventListener("change", () => {
  setPoolsMode(poolsModeInput.checked);
});

generateBtn.addEventListener("click", generateRoundRobin);
viewTvBtn.addEventListener("click", showTv);
clearScoresBtn.addEventListener("click", clearScores);
generatePlayoffBtn.addEventListener("click", generatePlayoff);
fullScreenBtn.addEventListener("click", toggleFullScreen);
backToSetupBtn.addEventListener("click", showSetup);
window.addEventListener("hashchange", render);
window.addEventListener("resize", fitAllMatchLists);
window.addEventListener("resize", fitMatchTeamNames);
window.addEventListener("resize", fitPlayoffTeamNames);
window.addEventListener("resize", fitStandingsTeamNames);
window.addEventListener("resize", fitTournamentName);
document.addEventListener("fullscreenchange", render);

window.addEventListener("pagehide", () => {
  writeLocalState();
  if (serverSaveTimer) clearTimeout(serverSaveTimer);
  if (serverStateAvailable === true && serverSavePending) flushServerSave(true);
});

courtPicker.querySelectorAll("[data-court]").forEach((button) => {
  button.addEventListener("click", () => chooseCourt(button.dataset.court));
});

courtPicker.addEventListener("click", (event) => {
  if (event.target === courtPicker) courtPicker.close();
});

renderTeamInputs();
render();
hydrateServerState();

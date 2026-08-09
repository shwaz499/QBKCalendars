const STATE_KEY = "roundRobinTournament:v4";
const LEGACY_STATE_KEY = "roundRobinTournament:v1";
const TEAM_COUNT_MIN = 3;
const TEAM_COUNT_MAX = 8;
const GAMES_PER_MATCH_MIN = 1;
const GAMES_PER_MATCH_MAX = 3;

const setupView = document.querySelector("#setupView");
const tvView = document.querySelector("#tvView");
const tournamentNameInput = document.querySelector("#tournamentNameInput");
const teamCountInput = document.querySelector("#teamCountInput");
const gamesPerMatchInput = document.querySelector("#gamesPerMatchInput");
const setupStatus = document.querySelector("#setupStatus");
const teamGrid = document.querySelector("#teamGrid");
const generateBtn = document.querySelector("#generateBtn");
const viewTvBtn = document.querySelector("#viewTvBtn");
const clearScoresBtn = document.querySelector("#clearScoresBtn");
const generatePlayoffBtn = document.querySelector("#generatePlayoffBtn");
const fullScreenBtn = document.querySelector("#fullScreenBtn");
const backToSetupBtn = document.querySelector("#backToSetupBtn");
const matchTitle = document.querySelector("#matchTitle");
const tvBoard = document.querySelector(".tv-board");
const matchList = document.querySelector("#matchList");
const playoffBracket = document.querySelector("#playoffBracket");
const emptyMatches = document.querySelector("#emptyMatches");
const standingsBody = document.querySelector("#standingsBody");
const standingsPanel = document.querySelector(".standings-panel");
const tvTournamentName = document.querySelector("#tvTournamentName");

let state = loadState();
let draggedMatchId = null;

function loadState() {
  const saved = readStoredState(STATE_KEY) || readStoredState(LEGACY_STATE_KEY);

  if (saved && Array.isArray(saved.teams) && Array.isArray(saved.matches)) {
    const gamesPerMatch = clampGamesPerMatch(saved.gamesPerMatch);
    return {
      tournamentName: String(saved.tournamentName || "Round Robin Tournament"),
      teams: normalizeTeams(saved.teams),
      gamesPerMatch,
      matches: normalizeMatches(saved.matches, gamesPerMatch),
      playoff: normalizePlayoff(saved.playoff),
    };
  }

  return {
    tournamentName: "Round Robin Tournament",
    teams: buildTeams(5),
    gamesPerMatch: 2,
    matches: [],
    playoff: null,
  };
}

function readStoredState(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    localStorage.removeItem(key);
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

function normalizeTeams(teams) {
  return buildTeams(teams.length || 5, teams);
}

function normalizeMatches(matches, gameCount = 2) {
  return matches
    .filter((match) => match?.teamA && match?.teamB)
    .map((match) => normalizeMatch(match, gameCount));
}

function normalizePlayoff(playoff) {
  if (!playoff || !Array.isArray(playoff.matches)) return null;
  const playoffGameCount = 3;
  const matches = playoff.matches.map((match, index) => ({
    id: match.id || `playoff-${index + 1}`,
    label: String(match.label || (index === 0 ? "Semifinal" : "Final")),
    seedA: match.seedA ?? (index === 0 ? 2 : 1),
    seedB: match.seedB ?? (index === 0 ? 3 : null),
    teamA: match.teamA || null,
    teamB: match.teamB || null,
    teamAName: String(match.teamAName || ""),
    teamBName: String(match.teamBName || ""),
    placeholderA: String(match.placeholderA || "Seed"),
    placeholderB: String(match.placeholderB || (index === 0 ? "Seed" : "Winner of #2 vs #3")),
    court: String(match.court || (index === 0 ? "Middle Court" : "Right Court")),
    games: Array.from({ length: playoffGameCount }, (_, gameIndex) => ({
      a: cleanScore(match.games?.[gameIndex]?.a ?? ""),
      b: cleanScore(match.games?.[gameIndex]?.b ?? ""),
    })),
  }));

  if (!matches.length) return null;

  const semifinal = matches.find((match) => match.id === "playoff-semifinal");
  const final = matches.find((match) => match.id === "playoff-final");

  if (!semifinal) {
    matches.unshift({
      id: "playoff-semifinal",
      label: "Semifinal",
      seedA: 2,
      seedB: 3,
      teamA: null,
      teamB: null,
      teamAName: "",
      teamBName: "",
      placeholderA: "Seed",
      placeholderB: "Seed",
      court: "Middle Court",
      games: Array.from({ length: playoffGameCount }, () => ({ a: "", b: "" })),
    });
  }

  if (final) {
    final.label = "Final";
    final.seedA = 1;
    final.seedB = null;
    final.court = final.court || "Right Court";
    final.placeholderB = "Winner of #2 vs #3";
    if (!semifinal) {
      final.teamB = null;
      final.teamBName = "";
      final.games = Array.from({ length: playoffGameCount }, () => ({ a: "", b: "" }));
    }
  } else {
    matches.push({
      id: "playoff-final",
      label: "Final",
      seedA: 1,
      seedB: null,
      teamA: null,
      teamB: null,
      teamAName: "",
      teamBName: "",
      placeholderA: "Seed",
      placeholderB: "Winner of #2 vs #3",
      court: "Right Court",
      games: Array.from({ length: playoffGameCount }, () => ({ a: "", b: "" })),
    });
  }

  return { matches };
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
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

function buildGames(count, existingGames = []) {
  const safeCount = clampGamesPerMatch(count);
  return Array.from({ length: safeCount }, (_, gameIndex) => ({
    a: cleanScore(existingGames[gameIndex]?.a ?? ""),
    b: cleanScore(existingGames[gameIndex]?.b ?? ""),
  }));
}

function normalizeMatch(match, gameCount = currentGamesPerMatch()) {
  return {
    id: match.id || `${match.teamA}-${match.teamB}`,
    teamA: match.teamA,
    teamB: match.teamB,
    round: Number(match.round) || 1,
    games: buildGames(gameCount, match.games),
  };
}

function currentTeamCount() {
  return clampTeamCount(state.teams.length);
}

function currentGamesPerMatch() {
  return clampGamesPerMatch(state.gamesPerMatch);
}

function teamName(teamId) {
  return state.teams.find((team) => team.id === teamId)?.name.trim() || "Unnamed";
}

function allTeamNamesValid() {
  const names = state.teams.map((team) => team.name.trim().toLowerCase());
  return names.every(Boolean) && new Set(names).size === names.length;
}

function renderTeamInputs() {
  teamGrid.innerHTML = "";
  teamGrid.style.gridTemplateColumns = `repeat(${Math.min(currentTeamCount(), 4)}, minmax(140px, 1fr))`;

  state.teams.forEach((team, index) => {
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
    teamGrid.append(field);
  });
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
  state.matches = state.matches.map((match) => normalizeMatch(match, count));
  saveState();
  render();
}

function generateRoundRobin() {
  if (!allTeamNamesValid()) return;

  if (state.matches.some((match) => match.games.some((game) => game.a || game.b))) {
    const keepGoing = window.confirm(
      "Generating a new order will clear the current match scores. Continue?"
    );
    if (!keepGoing) return;
  }

  const ids = state.teams.map((team) => team.id);
  const slots = ids.length % 2 === 0 ? [...ids] : [...ids, "bye"];
  const rounds = [];

  for (let round = 1; round < slots.length; round += 1) {
    const matches = [];
    for (let index = 0; index < slots.length / 2; index += 1) {
      const teamA = slots[index];
      const teamB = slots[slots.length - 1 - index];
      if (teamA !== "bye" && teamB !== "bye") {
        matches.push({
          id: `match-${teamA}-${teamB}`,
          teamA,
          teamB,
          round,
          games: buildGames(currentGamesPerMatch()),
        });
      }
    }

    rounds.push(matches);
    slots.splice(1, 0, slots.pop());
  }

  state.matches = rounds.flat();
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
  updateFinalParticipantFromSemifinal();
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
    updateFinalParticipantFromSemifinal();
  }
  saveState();
  render();
}

function renderMatches() {
  matchList.innerHTML = "";
  matchList.hidden = state.matches.length === 0;
  emptyMatches.hidden = state.matches.length > 0;
  matchTitle.textContent = "Matchups";

  state.matches.forEach((match, index) => {
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
      const fromIndex = state.matches.findIndex((item) => item.id === fromId);
      moveMatch(fromIndex, index);
    });

    const number = document.createElement("div");
    number.className = "match-number";

    const matchOrdinal = document.createElement("span");
    matchOrdinal.className = "match-ordinal";
    matchOrdinal.textContent = String(index + 1);

    const court = document.createElement("span");
    court.className = "match-court";
    court.textContent = index % 2 === 0 ? "Middle Court" : "Right Court";

    number.append(matchOrdinal, court);

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
      makeMoveButton("Move up", "^", () => moveMatch(index, index - 1)),
      makeMoveButton("Move down", "v", () => moveMatch(index, index + 1))
    );

    card.append(number, main, controls);
    matchList.append(card);
  });

  fitMatchTeamNames();
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

function generatePlayoff() {
  const standings = calculateStandings();
  if (standings.length < 3 || standings.slice(0, 3).some((team) => !team.name.trim())) return;

  const hasExistingScores = state.playoff?.matches?.some((match) =>
    match.games.some((game) => game.a !== "" || game.b !== "")
  );

  if (hasExistingScores) {
    const keepGoing = window.confirm(
      "Generating the playoff again will replace the seeded teams and clear playoff scores. Continue?"
    );
    if (!keepGoing) return;
  }

  const [seedOne, seedTwo, seedThree] = standings;
  state.playoff = {
    matches: [
      {
        id: "playoff-semifinal",
        label: "Semifinal",
        seedA: 2,
        seedB: 3,
        court: "Middle Court",
        teamA: seedTwo.id,
        teamB: seedThree.id,
        teamAName: seedTwo.name,
        teamBName: seedThree.name,
        games: [
          { a: "", b: "" },
          { a: "", b: "" },
          { a: "", b: "" },
        ],
      },
      {
        id: "playoff-final",
        label: "Final",
        seedA: 1,
        seedB: null,
        court: "Right Court",
        teamA: seedOne.id,
        teamB: null,
        teamAName: seedOne.name,
        teamBName: "",
        placeholderB: "Winner of #2 vs #3",
        games: [
          { a: "", b: "" },
          { a: "", b: "" },
          { a: "", b: "" },
        ],
      },
    ],
  };

  saveState();
  render();
}

function defaultPlayoffMatches() {
  return [
    {
      id: "playoff-semifinal",
      label: "Semifinal",
      seedA: 2,
      seedB: 3,
      teamA: null,
      teamB: null,
      teamAName: "",
      teamBName: "",
      placeholderA: "Seed",
      placeholderB: "Seed",
      court: "Middle Court",
      games: [
        { a: "", b: "" },
        { a: "", b: "" },
        { a: "", b: "" },
      ],
    },
    {
      id: "playoff-final",
      label: "Final",
      seedA: 1,
      seedB: null,
      teamA: null,
      teamB: null,
      teamAName: "",
      teamBName: "",
      placeholderA: "Seed",
      placeholderB: "Winner of #2 vs #3",
      court: "Right Court",
      games: [
        { a: "", b: "" },
        { a: "", b: "" },
        { a: "", b: "" },
      ],
    },
  ];
}

function playoffMatchWinner(match) {
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

  if (winsA >= 2) return match.teamA;
  if (winsB >= 2) return match.teamB;
  return null;
}

function updateFinalParticipantFromSemifinal() {
  if (!state.playoff) return;
  const semifinal = state.playoff.matches.find((match) => match.id === "playoff-semifinal");
  const final = state.playoff.matches.find((match) => match.id === "playoff-final");
  if (!semifinal || !final) return;

  const winnerId = playoffMatchWinner(semifinal);
  if (final.teamB === winnerId) return;

  final.teamB = winnerId;
  final.teamBName = winnerId ? teamName(winnerId) : "";
  final.seedB = null;
  final.games = final.games.map(() => ({ a: "", b: "" }));
}

function renderPlayoff() {
  updateFinalParticipantFromSemifinal();
  const playoffMatches = state.playoff?.matches || defaultPlayoffMatches();
  playoffBracket.hidden = false;
  playoffBracket.innerHTML = "";

  playoffMatches.forEach((match) => {
    const card = document.createElement("article");
    card.className = `playoff-card ${match.label.toLowerCase()}`;

    const heading = document.createElement("div");
    heading.className = "playoff-heading";

    const headingLabel = document.createElement("span");
    headingLabel.textContent = match.label;

    const headingCourt = document.createElement("span");
    headingCourt.className = "playoff-court";
    headingCourt.textContent = match.court;

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
  const name = playoffTeamName(match, side);
  const seedLabel = seed ? `#${seed}` : "";
  return `
    <span class="playoff-seed">${escapeHtml(seedLabel)}</span>
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
  const standings = state.teams.map((team, seed) => ({
    id: team.id,
    seed,
    name: team.name.trim() || `Team ${seed + 1}`,
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

  return standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.diff !== a.diff) return b.diff - a.diff;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.seed - b.seed;
  });
}

function renderStandings() {
  const standings = calculateStandings();
  standingsBody.innerHTML = "";

  standings.forEach((team, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="standings-team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</td>
      <td>${team.wins}</td>
      <td>${team.losses}</td>
      <td>${team.pointsFor}</td>
      <td>${team.pointsAgainst}</td>
      <td class="${team.diff > 0 ? "diff-positive" : team.diff < 0 ? "diff-negative" : ""}">
        ${team.diff > 0 ? "+" : ""}${team.diff}
      </td>
    `;
    standingsBody.append(row);
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

function renderSetupStatus() {
  const names = state.teams.map((team) => team.name.trim()).filter(Boolean);
  const duplicateCount = names.length - new Set(names.map((name) => name.toLowerCase())).size;
  const remaining = currentTeamCount() - names.length;

  if (remaining > 0) {
    setupStatus.textContent = `Enter ${remaining} more team name${remaining === 1 ? "" : "s"}.`;
  } else if (duplicateCount > 0) {
    setupStatus.textContent = "Team names must be unique.";
  } else {
    setupStatus.textContent = "Ready to generate the TV page.";
  }
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
  const screen = window.location.hash === "#tv" && state.matches.length ? "tv" : "setup";
  tournamentNameInput.value = state.tournamentName;
  tvTournamentName.textContent = state.tournamentName.trim() || "Round Robin Tournament";
  teamCountInput.value = String(currentTeamCount());
  gamesPerMatchInput.value = String(currentGamesPerMatch());
  setupView.hidden = screen !== "setup";
  tvView.hidden = screen !== "tv";
  generateBtn.disabled = !allTeamNamesValid();
  viewTvBtn.disabled = state.matches.length === 0;
  clearScoresBtn.disabled = state.matches.length === 0;
  generatePlayoffBtn.disabled = state.matches.length === 0;
  generatePlayoffBtn.textContent = "Generate Playoff";
  fullScreenBtn.textContent = document.fullscreenElement ? "Exit Full Screen" : "Full Screen";
  standingsPanel.hidden = false;
  tvBoard.classList.remove("playoff-mode");
  renderSetupStatus();
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

generateBtn.addEventListener("click", generateRoundRobin);
viewTvBtn.addEventListener("click", showTv);
clearScoresBtn.addEventListener("click", clearScores);
generatePlayoffBtn.addEventListener("click", generatePlayoff);
fullScreenBtn.addEventListener("click", toggleFullScreen);
backToSetupBtn.addEventListener("click", showSetup);
window.addEventListener("hashchange", render);
window.addEventListener("resize", fitMatchTeamNames);
window.addEventListener("resize", fitPlayoffTeamNames);
window.addEventListener("resize", fitStandingsTeamNames);
document.addEventListener("fullscreenchange", render);

renderTeamInputs();
render();

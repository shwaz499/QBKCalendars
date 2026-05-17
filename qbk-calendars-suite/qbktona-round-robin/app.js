const STATE_KEY = "roundRobinTournament:v2";
const LEGACY_STATE_KEY = "roundRobinTournament:v1";

const setupView = document.querySelector("#setupView");
const tvView = document.querySelector("#tvView");
const tournamentNameInput = document.querySelector("#tournamentNameInput");
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
const matchSummary = document.querySelector("#matchSummary");
const gamesSummary = document.querySelector("#gamesSummary");

const defaultTeams = Array.from({ length: 5 }, (_, index) => ({
  id: `team-${index + 1}`,
  name: "",
}));

let state = loadState();
let draggedMatchId = null;

function loadState() {
  const saved = readStoredState(STATE_KEY) || readStoredState(LEGACY_STATE_KEY);

  if (saved && Array.isArray(saved.teams) && Array.isArray(saved.matches)) {
    return {
      tournamentName: String(saved.tournamentName || "Round Robin Tournament"),
      teams: normalizeTeams(saved.teams),
      matches: normalizeMatches(saved.matches),
      playoff: normalizePlayoff(saved.playoff),
    };
  }

  return {
    tournamentName: "Round Robin Tournament",
    teams: defaultTeams,
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

function normalizeTeams(teams) {
  return defaultTeams.map((team, index) => ({
    id: team.id,
    name: String(teams[index]?.name || ""),
  }));
}

function normalizeMatches(matches) {
  return matches
    .filter((match) => match?.teamA && match?.teamB)
    .map((match) => ({
      id: match.id || `${match.teamA}-${match.teamB}`,
      teamA: match.teamA,
      teamB: match.teamB,
      round: Number(match.round) || 1,
      games: [0, 1].map((gameIndex) => ({
        a: cleanScore(match.games?.[gameIndex]?.a ?? ""),
        b: cleanScore(match.games?.[gameIndex]?.b ?? ""),
      })),
    }));
}

function normalizePlayoff(playoff) {
  if (!playoff || !Array.isArray(playoff.matches)) return null;
  const playoffGameCount = 3;
  const matches = playoff.matches.map((match, index) => ({
    id: match.id || `playoff-${index + 1}`,
    label: String(match.label || (index === 0 ? "Semifinal" : "Final")),
    teamA: match.teamA || null,
    teamB: match.teamB || null,
    teamAName: String(match.teamAName || ""),
    teamBName: String(match.teamBName || ""),
    placeholderA: String(match.placeholderA || ""),
    placeholderB: String(match.placeholderB || ""),
    court: String(match.court || (index === 0 ? "Middle Court" : "Right Court")),
    games: Array.from({ length: playoffGameCount }, (_, gameIndex) => ({
      a: cleanScore(match.games?.[gameIndex]?.a ?? ""),
      b: cleanScore(match.games?.[gameIndex]?.b ?? ""),
    })),
  }));

  return matches.length ? { matches } : null;
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function cleanScore(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : "";
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

function generateRoundRobin() {
  if (!allTeamNamesValid()) return;

  if (state.matches.some((match) => match.games.some((game) => game.a || game.b))) {
    const keepGoing = window.confirm(
      "Generating a new order will clear the current match scores. Continue?"
    );
    if (!keepGoing) return;
  }

  const ids = state.teams.map((team) => team.id);
  const slots = [...ids, "bye"];
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
          games: [
            { a: "", b: "" },
            { a: "", b: "" },
          ],
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
  playoffBracket.hidden = true;
  matchList.hidden = state.matches.length === 0 || Boolean(state.playoff);
  emptyMatches.hidden = state.matches.length > 0 || Boolean(state.playoff);
  matchSummary.textContent = `${state.matches.length} matches`;
  matchTitle.textContent = "Matchups";

  if (state.playoff) {
    renderPlayoff();
    return;
  }

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
    court.className = "court-label";
    court.textContent = (index + 1) % 2 === 1 ? "Middle\nCourt" : "Right\nCourt";

    number.append(matchOrdinal, court);

    const main = document.createElement("div");
    main.className = "match-main";

    const teamA = document.createElement("div");
    teamA.className = "match-side";
    teamA.textContent = teamName(match.teamA);

    const games = document.createElement("div");
    games.className = "games";
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
}

function generatePlayoff() {
  const standings = calculateStandings();
  if (standings.length < 3 || standings.slice(0, 3).some((team) => !team.name.trim())) return;

  const [seedOne, seedTwo, seedThree] = standings;
  state.playoff = {
    matches: [
      {
        id: "playoff-semifinal",
        label: "Semifinal",
        teamA: seedTwo.id,
        teamB: seedThree.id,
        teamAName: seedTwo.name,
        teamBName: seedThree.name,
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
        teamA: seedOne.id,
        teamB: null,
        teamAName: seedOne.name,
        teamBName: "",
        placeholderB: "Winner of 2 vs 3",
        court: "Right Court",
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

function togglePlayoff() {
  if (state.playoff) {
    state.playoff = null;
    saveState();
    render();
    return;
  }

  generatePlayoff();
}

function renderPlayoff() {
  if (!state.playoff) return;
  updateFinalParticipantFromSemifinal();
  matchList.hidden = true;
  emptyMatches.hidden = true;
  playoffBracket.hidden = false;
  playoffBracket.innerHTML = "";
  matchSummary.textContent = "Playoffs";
  matchTitle.textContent = "Playoff Bracket";

  state.playoff.matches.forEach((match, index) => {
    const card = document.createElement("article");
    card.className = `playoff-card ${index === 1 ? "final" : ""}`;

    const heading = document.createElement("div");
    heading.className = "playoff-heading";
    heading.innerHTML = `
      <span>${escapeHtml(match.label)}</span>
      <span>${escapeHtml(match.court)}</span>
    `;

    const body = document.createElement("div");
    body.className = "playoff-body";

    const teamA = document.createElement("div");
    teamA.className = "playoff-team";
    teamA.textContent = playoffTeamName(match, "A");

    const scores = document.createElement("div");
    scores.className = "playoff-scores";
    match.games.forEach((game, gameIndex) => {
      scores.append(renderPlayoffGameRow(match, game, gameIndex));
    });

    const teamB = document.createElement("div");
    teamB.className = "playoff-team";
    teamB.textContent = playoffTeamName(match, "B");

    body.append(teamA, scores, teamB);
    card.append(heading, body);
    playoffBracket.append(card);
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

  const inputA = playoffScoreInput(match.id, gameIndex, "a", game.a);
  if (aWon) inputA.classList.add("winner");

  const separator = document.createElement("div");
  separator.className = "score-separator";
  separator.textContent = "-";

  const inputB = playoffScoreInput(match.id, gameIndex, "b", game.b);
  if (bWon) inputB.classList.add("winner");

  row.append(inputA, separator, inputB);
  return row;
}

function playoffScoreInput(matchId, gameIndex, side, value) {
  const input = scoreInput(matchId, gameIndex, side, value);
  input.addEventListener("input", () => updatePlayoffScore(matchId, gameIndex, side, input.value));
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

function updateFinalParticipantFromSemifinal() {
  if (!state.playoff?.matches?.length) return;
  const semifinal = state.playoff.matches[0];
  const final = state.playoff.matches[1];
  if (!semifinal || !final) return;

  const winner = playoffMatchWinner(semifinal);
  if (!winner) {
    final.teamB = null;
    final.teamBName = "";
    final.placeholderB = "Winner of 2 vs 3";
    return;
  }

  final.teamB = winner.id;
  final.teamBName = winner.name;
  final.placeholderB = "";
}

function playoffMatchWinner(match) {
  let aWins = 0;
  let bWins = 0;

  match.games.forEach((game) => {
    if (game.a === "" || game.b === "") return;
    const scoreA = Number(game.a);
    const scoreB = Number(game.b);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) return;
    if (scoreA > scoreB) aWins += 1;
    if (scoreB > scoreA) bWins += 1;
  });

  if (aWins < 2 && bWins < 2) return null;
  const winnerIsA = aWins > bWins;
  const winnerId = winnerIsA ? match.teamA : match.teamB;
  return {
    id: winnerId,
    name: winnerId ? teamName(winnerId) : winnerIsA ? match.teamAName : match.teamBName,
  };
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
  const completeGames = standings.reduce((total, team) => total + team.wins, 0);
  gamesSummary.textContent = `${completeGames} games`;
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

  if (names.length < 5) {
    setupStatus.textContent = `Enter ${5 - names.length} more team name${5 - names.length === 1 ? "" : "s"}.`;
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
  setupView.hidden = screen !== "setup";
  tvView.hidden = screen !== "tv";
  generateBtn.disabled = !allTeamNamesValid();
  viewTvBtn.disabled = state.matches.length === 0;
  clearScoresBtn.disabled = state.matches.length === 0;
  generatePlayoffBtn.disabled = state.matches.length === 0;
  generatePlayoffBtn.textContent = state.playoff ? "Show Matchups" : "Generate Playoff";
  fullScreenBtn.textContent = document.fullscreenElement ? "Exit Full Screen" : "Full Screen";
  standingsPanel.hidden = Boolean(state.playoff);
  tvBoard.classList.toggle("playoff-mode", Boolean(state.playoff));
  renderSetupStatus();
  renderMatches();
  renderStandings();
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

generateBtn.addEventListener("click", generateRoundRobin);
viewTvBtn.addEventListener("click", showTv);
clearScoresBtn.addEventListener("click", clearScores);
generatePlayoffBtn.addEventListener("click", togglePlayoff);
fullScreenBtn.addEventListener("click", toggleFullScreen);
backToSetupBtn.addEventListener("click", showSetup);
window.addEventListener("hashchange", render);
window.addEventListener("resize", fitStandingsTeamNames);
document.addEventListener("fullscreenchange", render);

renderTeamInputs();
render();

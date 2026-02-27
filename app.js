(() => {
  const els = {
    teamCount: document.getElementById("team-count"),
    weekCount: document.getElementById("week-count"),
    timeStart: document.getElementById("time-start"),
    timeEnd: document.getElementById("time-end"),
    courtHours: document.getElementById("court-hours"),
    teamsWrap: document.getElementById("teams-wrap"),
    generate: document.getElementById("generate"),
    regenerateUnlocked: document.getElementById("regenerate-unlocked"),
    validate: document.getElementById("validate"),
    addGame: document.getElementById("add-game"),
    download: document.getElementById("download"),
    scheduleBody: document.getElementById("schedule-body"),
    error: document.getElementById("error"),
  };

  let currentTimes = [];
  let scheduleRows = [];
  let lockedWeeks = new Set();

  function setError(msg) {
    els.error.textContent = msg || "";
  }

  function parseTimeToMinutes(t) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(t || ""));
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function minutesToTime(total) {
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  function buildHourlyTimes(start, end) {
    const startMin = parseTimeToMinutes(start);
    const endMin = parseTimeToMinutes(end);
    if (startMin === null || endMin === null) throw new Error("Invalid time range.");
    if (endMin <= startMin) throw new Error("Time range end must be after start.");
    if ((endMin - startMin) < 60) throw new Error("Time range must cover at least one 1-hour slot.");

    const times = [];
    for (let m = startMin; m + 60 <= endMin; m += 60) {
      times.push(minutesToTime(m));
    }
    return times;
  }

  function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function keyPair(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function pickRandomMin(items, scorer) {
    let best = Infinity;
    let candidates = [];
    for (const item of items) {
      const score = scorer(item);
      if (score < best) {
        best = score;
        candidates = [item];
      } else if (score === best) {
        candidates.push(item);
      }
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function roundRobin(teams) {
    const list = [...teams];
    if (list.length % 2 === 1) {
      list.push("BYE");
    }
    const n = list.length;
    const rounds = [];

    for (let r = 0; r < n - 1; r += 1) {
      const pairs = [];
      for (let i = 0; i < n / 2; i += 1) {
        const a = list[i];
        const b = list[n - 1 - i];
        if (a === "BYE" || b === "BYE") continue;
        pairs.push([a, b]);
      }
      rounds.push(pairs);
      const rotated = [list[0], list[n - 1], ...list.slice(1, n - 1)];
      for (let i = 0; i < n; i += 1) list[i] = rotated[i];
    }

    return rounds;
  }

  function pairRemainingTeams(teams, matchupCounts) {
    const list = [...teams];

    function backtrack(pool) {
      if (!pool.length) return [];
      const [first, ...rest] = pool;
      const ranked = shuffle(rest).sort((a, b) => {
        const diff = (matchupCounts.get(keyPair(first, a)) || 0) - (matchupCounts.get(keyPair(first, b)) || 0);
        return diff;
      });

      for (const partner of ranked) {
        const remaining = rest.filter((t) => t !== partner);
        const tail = backtrack(remaining);
        if (tail) return [[first, partner], ...tail];
      }
      return null;
    }

    return backtrack(list) || [];
  }

  function pickDoubleheaderTeam(teams, dhCounts) {
    return pickRandomMin(teams, (t) => dhCounts.get(t) || 0);
  }

  function pickTwoOpponents(doubleTeam, others, matchupCounts) {
    const ranked = shuffle(others).sort((a, b) => {
      const da = matchupCounts.get(keyPair(doubleTeam, a)) || 0;
      const db = matchupCounts.get(keyPair(doubleTeam, b)) || 0;
      return da - db;
    });
    if (ranked.length < 2) throw new Error("Not enough opponents to create a doubleheader.");
    return [ranked[0], ranked[1]];
  }

  function courtOptionsForTime(time, courtMap) {
    const count = Number(courtMap[time] || 0);
    const options = [];
    for (let i = 1; i <= count; i += 1) options.push(i);
    return options;
  }

  function assignWeekSlots(week, matches, times, courtMap, teamUnavail, doubleheaderTeam) {
    const usage = {};
    const teamAtTime = new Map();
    const teamWeekGames = new Map();
    const placed = [];

    for (const t of matches.flat()) {
      if (!teamAtTime.has(t)) teamAtTime.set(t, new Set());
      if (!teamWeekGames.has(t)) teamWeekGames.set(t, 0);
    }

    for (const time of times) usage[time] = 0;

    function canPlace(match, time) {
      const [a, b] = match;
      if (usage[time] >= Number(courtMap[time] || 0)) return false;
      if ((teamUnavail.get(a) || new Set()).has(time)) return false;
      if ((teamUnavail.get(b) || new Set()).has(time)) return false;
      if (teamAtTime.get(a).has(time) || teamAtTime.get(b).has(time)) return false;
      return true;
    }

    function commit(match, time) {
      const [a, b] = match;
      usage[time] += 1;
      const court = usage[time];
      teamAtTime.get(a).add(time);
      teamAtTime.get(b).add(time);
      teamWeekGames.set(a, (teamWeekGames.get(a) || 0) + 1);
      teamWeekGames.set(b, (teamWeekGames.get(b) || 0) + 1);
      placed.push({ week, time, court, home: a, away: b });
    }

    const remaining = [...matches];

    if (doubleheaderTeam) {
      const dhGames = remaining.filter((m) => m[0] === doubleheaderTeam || m[1] === doubleheaderTeam);
      if (dhGames.length !== 2) throw new Error("Doubleheader team must have exactly two games.");

      let assigned = false;
      for (let i = 0; i < times.length - 1 && !assigned; i += 1) {
        const t1 = times[i];
        const t2 = times[i + 1];

        const [g1, g2] = dhGames;
        const orders = [[g1, g2], [g2, g1]];
        for (const [first, second] of orders) {
          if (canPlace(first, t1) && canPlace(second, t2)) {
            commit(first, t1);
            commit(second, t2);
            remaining.splice(remaining.indexOf(first), 1);
            remaining.splice(remaining.indexOf(second), 1);
            assigned = true;
            break;
          }
        }
      }

      if (!assigned) {
        throw new Error(`Week ${week}: unable to place back-to-back doubleheader for ${doubleheaderTeam}.`);
      }
    }

    const orderedRemaining = shuffle(remaining).sort((a, b) => {
      const aFlex = times.filter((t) => canPlace(a, t)).length;
      const bFlex = times.filter((t) => canPlace(b, t)).length;
      return aFlex - bFlex;
    });

    for (const match of orderedRemaining) {
      let done = false;
      for (const time of times) {
        if (canPlace(match, time)) {
          commit(match, time);
          done = true;
          break;
        }
      }
      if (!done) throw new Error(`Week ${week}: unable to place ${match[0]} vs ${match[1]}.`);
    }

    return placed;
  }

  function generateWeeklyMatchesEven(weekIndex, teams, rounds) {
    const round = rounds[weekIndex % rounds.length];
    return round.map(([a, b]) => [a, b]);
  }

  function generateWeeklyMatchesOdd(teams, matchupCounts, dhCounts) {
    const doubleTeam = pickDoubleheaderTeam(teams, dhCounts);
    const others = teams.filter((t) => t !== doubleTeam);
    const [o1, o2] = pickTwoOpponents(doubleTeam, others, matchupCounts);
    const remainingTeams = others.filter((t) => t !== o1 && t !== o2);
    const remainingPairs = pairRemainingTeams(remainingTeams, matchupCounts);
    const matches = [[doubleTeam, o1], [doubleTeam, o2], ...remainingPairs];
    return { matches, doubleTeam };
  }

  function updateStats(matches, matchupCounts, dhCounts, doubleTeam) {
    for (const [a, b] of matches) {
      const k = keyPair(a, b);
      matchupCounts.set(k, (matchupCounts.get(k) || 0) + 1);
    }
    if (doubleTeam) {
      dhCounts.set(doubleTeam, (dhCounts.get(doubleTeam) || 0) + 1);
    }
  }

  function validateCoreInput(cfg) {
    if (cfg.teams.length < 2) throw new Error("Need at least 2 teams.");
    if (new Set(cfg.teams).size !== cfg.teams.length) throw new Error("Team names must be unique.");
    if (cfg.weekCount < 1) throw new Error("Weeks must be at least 1.");
    if (!cfg.times.length) throw new Error("No valid hourly match slots from time range.");

    const totalCourts = cfg.times.reduce((sum, t) => sum + Number(cfg.courtMap[t] || 0), 0);
    if (totalCourts < 1) throw new Error("At least one court is required in the weekly hour settings.");

    const matchesNeededPerWeek = requiredGamesPerWeek(cfg.teams.length);
    if (totalCourts < matchesNeededPerWeek) {
      throw new Error(
        `Weekly capacity too low. Need at least ${matchesNeededPerWeek} game slots per week (currently ${totalCourts}).`
      );
    }

    if (cfg.teams.length % 2 === 1 && cfg.times.length < 2) {
      throw new Error("Odd team counts require at least two consecutive hourly slots for back-to-back doubleheaders.");
    }
  }

  function requiredGamesPerWeek(teamCount) {
    return teamCount % 2 === 0 ? teamCount / 2 : (teamCount + 1) / 2;
  }

  function generateSchedule(cfg, options = {}) {
    validateCoreInput(cfg);

    const lockedRows = options.lockedRows || [];
    const lockedByWeek = new Map();
    for (const row of lockedRows) {
      if (!lockedByWeek.has(row.week)) lockedByWeek.set(row.week, []);
      lockedByWeek.get(row.week).push({ week: row.week, time: row.time, court: row.court, home: row.home, away: row.away });
    }

    const matchupCounts = new Map();
    const dhCounts = new Map(cfg.teams.map((t) => [t, 0]));
    const allRows = [];

    const evenMode = cfg.teams.length % 2 === 0;
    const rounds = evenMode ? roundRobin(cfg.teams) : null;

    for (let week = 1; week <= cfg.weekCount; week += 1) {
      let matches;
      let doubleTeam = null;

      if (lockedByWeek.has(week)) {
        const fixedGames = lockedByWeek.get(week);
        allRows.push(...fixedGames);
        const fixedMatches = fixedGames.map((g) => [g.home, g.away]);
        let fixedDoubleTeam = null;
        if (!evenMode) {
          const teamGames = new Map();
          for (const g of fixedGames) {
            teamGames.set(g.home, (teamGames.get(g.home) || 0) + 1);
            teamGames.set(g.away, (teamGames.get(g.away) || 0) + 1);
          }
          const doubles = [...teamGames.entries()].filter(([, c]) => c === 2);
          fixedDoubleTeam = doubles.length ? doubles[0][0] : null;
        }
        updateStats(fixedMatches, matchupCounts, dhCounts, fixedDoubleTeam);
        continue;
      }

      if (evenMode) {
        matches = generateWeeklyMatchesEven(week - 1, cfg.teams, rounds);
      } else {
        let success = false;
        let lastError = null;
        for (let attempt = 0; attempt < 60 && !success; attempt += 1) {
          try {
            const result = generateWeeklyMatchesOdd(cfg.teams, matchupCounts, dhCounts);
            const placed = assignWeekSlots(week, result.matches, cfg.times, cfg.courtMap, cfg.teamUnavail, result.doubleTeam);
            matches = result.matches;
            doubleTeam = result.doubleTeam;
            allRows.push(...placed);
            success = true;
          } catch (err) {
            lastError = err;
          }
        }
        if (!success) {
          const message = lastError instanceof Error ? lastError.message : "Unable to schedule odd-team week.";
          throw new Error(`Week ${week} failed: ${message}`);
        }
      }

      if (evenMode) {
        const placed = assignWeekSlots(week, matches, cfg.times, cfg.courtMap, cfg.teamUnavail, null);
        allRows.push(...placed);
      }

      updateStats(matches, matchupCounts, dhCounts, doubleTeam);
    }

    allRows.sort((a, b) => {
      const wk = a.week - b.week;
      if (wk !== 0) return wk;
      const tk = a.time.localeCompare(b.time);
      if (tk !== 0) return tk;
      return a.court - b.court;
    });

    return allRows;
  }

  function gatherConfigFromUi() {
    const teamCount = Number(els.teamCount.value || 0);
    const weekCount = Number(els.weekCount.value || 0);
    if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error("Amount of teams must be at least 2.");
    if (!Number.isInteger(weekCount) || weekCount < 1) throw new Error("Amount of game weeks must be at least 1.");

    const times = buildHourlyTimes(els.timeStart.value, els.timeEnd.value);
    const courtMap = {};
    for (const t of times) {
      const input = els.courtHours.querySelector(`[data-court-time="${t}"]`);
      const n = Number(input?.value || 0);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Court count for ${t} must be 0 or more.`);
      courtMap[t] = n;
    }

    const rows = [...els.teamsWrap.querySelectorAll("[data-team-row]")];
    const teams = [];
    const teamUnavail = new Map();
    for (const row of rows) {
      const name = row.querySelector("[data-team-name]").value.trim();
      if (!name) throw new Error("Every team must have a name.");
      teams.push(name);

      const blocked = new Set();
      for (const check of row.querySelectorAll("[data-block-time]")) {
        if (check.checked) blocked.add(check.value);
      }
      teamUnavail.set(name, blocked);
    }

    return { teamCount, weekCount, times, courtMap, teams, teamUnavail };
  }

  function renderScheduleTable() {
    els.scheduleBody.innerHTML = "";
    if (!scheduleRows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="7" class="empty">No schedule generated yet.</td>';
      els.scheduleBody.appendChild(tr);
      return;
    }

    const cfg = gatherConfigFromUi();
    const teamOptions = cfg.teams.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");

    for (const row of scheduleRows) {
      const tr = document.createElement("tr");
      tr.dataset.id = row.id;

      tr.innerHTML = `
        <td><input type="number" min="1" value="${row.week}" data-field="week" /></td>
        <td><input type="checkbox" data-field="lock-week" ${lockedWeeks.has(row.week) ? "checked" : ""} /></td>
        <td>${buildTimeSelect(row.time, cfg.times, "time")}</td>
        <td>${buildCourtSelect(row.time, row.court, cfg.courtMap)}</td>
        <td><select data-field="home">${teamOptions}</select></td>
        <td><select data-field="away">${teamOptions}</select></td>
        <td><button class="row-remove" type="button" data-remove-row="${row.id}">Remove</button></td>
      `;

      tr.querySelector('[data-field="home"]').value = row.home;
      tr.querySelector('[data-field="away"]').value = row.away;
      els.scheduleBody.appendChild(tr);
    }
  }

  function buildTimeSelect(selected, times, field) {
    const options = times
      .map((t) => `<option value="${t}" ${t === selected ? "selected" : ""}>${t}</option>`)
      .join("");
    return `<select data-field="${field}">${options}</select>`;
  }

  function buildCourtSelect(time, selectedCourt, courtMap) {
    const options = courtOptionsForTime(time, courtMap)
      .map((n) => `<option value="${n}" ${Number(n) === Number(selectedCourt) ? "selected" : ""}>${n}</option>`)
      .join("");
    return `<select data-field="court">${options || '<option value="">-</option>'}</select>`;
  }

  function syncRowsFromTable() {
    const rows = [...els.scheduleBody.querySelectorAll("tr[data-id]")];
    for (const tr of rows) {
      const id = Number(tr.dataset.id);
      const row = scheduleRows.find((r) => r.id === id);
      if (!row) continue;

      row.week = Number(tr.querySelector('[data-field="week"]').value || 0);
      row.time = tr.querySelector('[data-field="time"]').value;
      row.court = Number(tr.querySelector('[data-field="court"]').value || 0);
      row.home = tr.querySelector('[data-field="home"]').value;
      row.away = tr.querySelector('[data-field="away"]').value;
    }
  }

  function collectLockedRows() {
    return scheduleRows
      .filter((row) => lockedWeeks.has(row.week))
      .map((row) => ({ week: row.week, time: row.time, court: row.court, home: row.home, away: row.away }));
  }

  function validateEditedSchedule(cfg, rows, options = {}) {
    if (!rows.length) throw new Error("No games to validate.");
    const requireAllWeeks = options.requireAllWeeks ?? true;

    const byWeek = new Map();
    for (const row of rows) {
      if (!Number.isInteger(row.week) || row.week < 1 || row.week > cfg.weekCount) {
        throw new Error(`Invalid week value found: ${row.week}`);
      }
      if (!cfg.times.includes(row.time)) {
        throw new Error(`Invalid time '${row.time}' in week ${row.week}.`);
      }
      const courtMax = Number(cfg.courtMap[row.time] || 0);
      if (!Number.isInteger(row.court) || row.court < 1 || row.court > courtMax) {
        throw new Error(`Invalid court '${row.court}' for ${row.time} in week ${row.week}.`);
      }
      if (!cfg.teams.includes(row.home) || !cfg.teams.includes(row.away)) {
        throw new Error(`Unknown team in week ${row.week}.`);
      }
      if (row.home === row.away) {
        throw new Error(`A team cannot play itself in week ${row.week}.`);
      }

      const blockedHome = cfg.teamUnavail.get(row.home) || new Set();
      const blockedAway = cfg.teamUnavail.get(row.away) || new Set();
      if (blockedHome.has(row.time) || blockedAway.has(row.time)) {
        throw new Error(`Restriction violation: ${row.home} or ${row.away} blocked at ${row.time} (week ${row.week}).`);
      }

      if (!byWeek.has(row.week)) byWeek.set(row.week, []);
      byWeek.get(row.week).push(row);
    }

    for (const [week, list] of byWeek.entries()) {
      const usedCourtTime = new Set();
      const teamTime = new Set();
      const teamGames = new Map();

      for (const game of list) {
        const ct = `${game.time}|${game.court}`;
        if (usedCourtTime.has(ct)) {
          throw new Error(`Court conflict in week ${week}: court ${game.court} at ${game.time}.`);
        }
        usedCourtTime.add(ct);

        for (const t of [game.home, game.away]) {
          const tt = `${t}|${game.time}`;
          if (teamTime.has(tt)) {
            throw new Error(`Team time conflict in week ${week}: ${t} has multiple games at ${game.time}.`);
          }
          teamTime.add(tt);
          teamGames.set(t, (teamGames.get(t) || 0) + 1);
        }
      }

      const expectedGames = requiredGamesPerWeek(cfg.teams.length);
      if (list.length !== expectedGames) {
        throw new Error(`Week ${week}: expected ${expectedGames} games, found ${list.length}.`);
      }

      const oddTeams = cfg.teams.length % 2 === 1;
      if (oddTeams) {
        const doubles = [...teamGames.entries()].filter(([, c]) => c === 2);
        if (doubles.length !== 1) {
          throw new Error(`Week ${week}: odd-team format requires exactly one doubleheader team.`);
        }
        const dhTeam = doubles[0][0];
        const dhTimes = list
          .filter((g) => g.home === dhTeam || g.away === dhTeam)
          .map((g) => g.time)
          .sort();
        const i1 = cfg.times.indexOf(dhTimes[0]);
        const i2 = cfg.times.indexOf(dhTimes[1]);
        if (i2 - i1 !== 1) {
          throw new Error(`Week ${week}: ${dhTeam} doubleheader must be back-to-back.`);
        }
      }
    }

    if (requireAllWeeks) {
      for (let week = 1; week <= cfg.weekCount; week += 1) {
        if (!byWeek.has(week)) {
          throw new Error(`Week ${week}: no games scheduled.`);
        }
      }
    }

    return true;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function csvCell(s) {
    const raw = String(s ?? "");
    if (!/[",\n]/.test(raw)) return raw;
    return `"${raw.replaceAll('"', '""')}"`;
  }

  function downloadCsv(cfg, rows) {
    const sorted = [...rows].sort((a, b) => {
      const wk = a.week - b.week;
      if (wk !== 0) return wk;
      const tk = a.time.localeCompare(b.time);
      if (tk !== 0) return tk;
      return a.court - b.court;
    });

    const lines = ["week,time,court,home_team,away_team"];
    for (const r of sorted) {
      lines.push([r.week, r.time, r.court, r.home, r.away].map(csvCell).join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "weekly_schedule.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function updateCourtHourRows() {
    const oldValues = {};
    for (const input of els.courtHours.querySelectorAll("[data-court-time]")) {
      oldValues[input.dataset.courtTime] = input.value;
    }

    const times = buildHourlyTimes(els.timeStart.value, els.timeEnd.value);
    currentTimes = times;
    els.courtHours.innerHTML = "";

    for (const t of times) {
      const row = document.createElement("div");
      row.className = "hour-row";
      row.innerHTML = `
        <label>
          Hour Slot
          <input type="text" value="${t}" readonly />
        </label>
        <label>
          Number of Courts Available
          <input type="number" min="0" value="${oldValues[t] ?? 2}" data-court-time="${t}" />
        </label>
      `;
      els.courtHours.appendChild(row);
    }

    updateTeamRows(true);
    if (scheduleRows.length) renderScheduleTable();
  }

  function updateTeamRows(preserveNames) {
    const existing = [...els.teamsWrap.querySelectorAll("[data-team-row]")].map((row) => {
      const name = row.querySelector("[data-team-name]").value.trim();
      const blocked = [...row.querySelectorAll("[data-block-time]")].filter((c) => c.checked).map((c) => c.value);
      return { name, blocked };
    });

    const count = Number(els.teamCount.value || 0);
    els.teamsWrap.innerHTML = "";

    for (let i = 0; i < count; i += 1) {
      const seed = existing[i] || {};
      const row = document.createElement("div");
      row.className = "team-row";
      row.dataset.teamRow = String(i);

      const defaultName = preserveNames ? (seed.name || `Team ${i + 1}`) : `Team ${i + 1}`;
      row.innerHTML = `
        <label>
          Team Name
          <input data-team-name type="text" value="${escapeHtml(defaultName)}" />
        </label>
        <div>
          <div class="muted">Unavailable Times</div>
          <div class="unavailable-list" data-unavailable></div>
        </div>
      `;

      const blockedSet = new Set(seed.blocked || []);
      const wrap = row.querySelector("[data-unavailable]");
      for (const t of currentTimes) {
        const id = `team-${i}-time-${t.replace(':', '')}`;
        const label = document.createElement("label");
        label.className = "check";
        label.setAttribute("for", id);
        label.innerHTML = `
          <input id="${id}" data-block-time type="checkbox" value="${t}" ${blockedSet.has(t) ? "checked" : ""} />
          ${t}
        `;
        wrap.appendChild(label);
      }

      els.teamsWrap.appendChild(row);
    }
  }

  function nextRowId() {
    return scheduleRows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  }

  function onGenerate() {
    setError("");
    try {
      const cfg = gatherConfigFromUi();
      const generated = generateSchedule(cfg);
      scheduleRows = generated.map((g, i) => ({ id: i + 1, ...g }));
      lockedWeeks = new Set();
      renderScheduleTable();
      els.download.disabled = scheduleRows.length === 0;
    } catch (err) {
      scheduleRows = [];
      renderScheduleTable();
      els.download.disabled = true;
      setError(err instanceof Error ? err.message : "Failed to generate schedule.");
    }
  }

  function onRegenerateUnlocked() {
    setError("");
    try {
      const cfg = gatherConfigFromUi();
      if (!scheduleRows.length) {
        throw new Error("Generate a schedule first, then lock weeks and regenerate.");
      }
      syncRowsFromTable();
      const lockedRows = collectLockedRows();
      if (!lockedRows.length) {
        throw new Error("No locked weeks selected. Check Lock Week in any week, then retry.");
      }

      validateEditedSchedule(cfg, lockedRows, { requireAllWeeks: false });
      const regenerated = generateSchedule(cfg, { lockedRows });
      scheduleRows = regenerated.map((g, i) => ({ id: i + 1, ...g }));
      renderScheduleTable();
      els.download.disabled = scheduleRows.length === 0;
      setError("Unlocked weeks regenerated. Locked weeks were preserved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regeneration failed.");
    }
  }

  function onValidate() {
    setError("");
    try {
      const cfg = gatherConfigFromUi();
      syncRowsFromTable();
      validateEditedSchedule(cfg, scheduleRows);
      setError("Schedule validation passed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed.");
    }
  }

  function onDownload() {
    setError("");
    try {
      const cfg = gatherConfigFromUi();
      syncRowsFromTable();
      validateEditedSchedule(cfg, scheduleRows);
      downloadCsv(cfg, scheduleRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    }
  }

  function onAddGameRow() {
    try {
      const cfg = gatherConfigFromUi();
      const id = nextRowId();
      const defaultTime = cfg.times[0];
      scheduleRows.push({ id, week: 1, time: defaultTime, court: 1, home: cfg.teams[0], away: cfg.teams[1] || cfg.teams[0] });
      renderScheduleTable();
      els.download.disabled = scheduleRows.length === 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add row.");
    }
  }

  function onScheduleTableChange(e) {
    const sel = e.target;
    if (!(sel instanceof HTMLElement)) return;
    const tr = sel.closest("tr[data-id]");
    if (!tr) return;

    if (sel.matches('[data-field="lock-week"]')) {
      syncRowsFromTable();
      const weekValue = Number(tr.querySelector('[data-field="week"]').value || 0);
      if (weekValue >= 1) {
        if (sel.checked) lockedWeeks.add(weekValue);
        else lockedWeeks.delete(weekValue);
      }
      renderScheduleTable();
      return;
    }

    if (sel.matches('[data-field="time"]')) {
      const cfg = gatherConfigFromUi();
      const courtSelect = tr.querySelector('[data-field="court"]');
      if (courtSelect) {
        const chosenTime = sel.value;
        courtSelect.outerHTML = buildCourtSelect(chosenTime, 1, cfg.courtMap);
      }
      return;
    }

    if (sel.matches('[data-field="week"]')) {
      syncRowsFromTable();
      renderScheduleTable();
    }
  }

  function onScheduleTableClick(e) {
    const btn = e.target.closest("button[data-remove-row]");
    if (!btn) return;
    const id = Number(btn.dataset.removeRow);
    scheduleRows = scheduleRows.filter((r) => r.id !== id);
    renderScheduleTable();
    els.download.disabled = scheduleRows.length === 0;
  }

  function initialize() {
    updateCourtHourRows();

    els.teamCount.addEventListener("change", () => updateTeamRows(true));
    els.timeStart.addEventListener("change", updateCourtHourRows);
    els.timeEnd.addEventListener("change", updateCourtHourRows);

    els.generate.addEventListener("click", onGenerate);
    els.regenerateUnlocked.addEventListener("click", onRegenerateUnlocked);
    els.validate.addEventListener("click", onValidate);
    els.download.addEventListener("click", onDownload);
    els.addGame.addEventListener("click", onAddGameRow);

    els.scheduleBody.addEventListener("change", onScheduleTableChange);
    els.scheduleBody.addEventListener("click", onScheduleTableClick);
  }

  initialize();
})();

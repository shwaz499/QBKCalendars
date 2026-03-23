(() => {
  const LEAGUES = [
    {
      day: "Monday",
      format: "4x4",
      title: "Monday Night Intermediate 4x4 Coed League",
      leagueStarts: "May 11, 2026",
      teamPrice: "$1390/team",
      teamNote: "Unlimited roster. $100 off if signed up by April 19th.",
      freeAgentPrice: "$200/player",
      freeAgentNote: "Placed onto a team. Expect roughly 7 players per team.",
      startTimes: "6:00 PM and later",
      season: "8 weeks",
      schedule: "7 weeks regular play + 1 week playoffs",
      playoffDate: "July 6, 2026",
      playoffNote: "Top 6 teams in each division guaranteed playoffs.",
      notes: ["No leagues 5/25 for Memorial Day."],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/359?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9027"
    },
    {
      day: "Tuesday",
      format: "6x6",
      title: "Tuesday Night All Abilities 6x6 Coed Rec League",
      leagueStarts: "May 12, 2026",
      teamPrice: "$1590/team",
      teamNote: "Unlimited roster. $100 off if signed up by April 19th.",
      freeAgentPrice: "$160/player",
      freeAgentNote: "Placed onto a team. Expect roughly 11 players per team.",
      startTimes: "6:00 PM and later",
      season: "8 weeks",
      schedule: "7 weeks regular play + 1 week playoffs",
      playoffDate: "June 30, 2026",
      playoffNote: "Top 6 teams in each division guaranteed playoffs.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/358?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9026"
    },
    {
      day: "Wednesday",
      format: "4x4",
      title: "Wednesday Night Intermediate 4x4 Coed League",
      leagueStarts: "May 13, 2026",
      teamPrice: "$1390/team",
      teamNote: "Unlimited roster. $100 off if signed up by April 19th.",
      freeAgentPrice: "$200/player",
      freeAgentNote: "Placed onto a team. Expect roughly 7 players per team.",
      startTimes: "6:00 PM and later",
      season: "8 weeks",
      schedule: "7 weeks regular play + 1 week playoffs",
      playoffDate: "July 1, 2026",
      playoffNote: "Top 6 teams in each division guaranteed playoffs.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/362?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9030"
    },
    {
      day: "Thursday",
      format: "4x4",
      title: "Thursday Night Intermediate 4x4 Coed League",
      leagueStarts: "May 21, 2026",
      teamPrice: "$1390/team",
      teamNote: "Unlimited roster. $100 off if signed up by April 19th.",
      freeAgentPrice: "$200/player",
      freeAgentNote: "Placed onto a team. Expect roughly 7 players per team.",
      startTimes: "6:00 PM and later",
      season: "8 weeks",
      schedule: "7 weeks regular play + 1 week playoffs",
      playoffDate: "July 9, 2026",
      playoffNote: "Top 6 teams in each division guaranteed playoffs.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/361?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9029"
    },
    {
      day: "Thursday",
      format: "6x6",
      title: "Thursday Night All Abilities 6x6 Coed Rec League",
      leagueStarts: "May 21, 2026",
      teamPrice: "$1590/team",
      teamNote: "Unlimited roster. $100 off if signed up by April 19th.",
      freeAgentPrice: "$160/player",
      freeAgentNote: "Placed onto a team. Expect roughly 10 players per team.",
      startTimes: "6:00 PM and later",
      season: "8 weeks",
      schedule: "7 weeks regular play + 1 week playoffs",
      playoffDate: "July 9, 2026",
      playoffNote: "Top 6 teams in each division guaranteed playoffs.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/360?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9028"
    }
  ];

  const gridEl = document.getElementById("league-grid");
  if (!gridEl) return;

  function buildCard(league) {
    const notesHtml = league.notes.length
      ? `<div class="league-note">${league.notes.join("<br />")}</div>`
      : "";

    return `
      <article class="league-card">
        <div class="league-top">
          <h2 class="league-title">${league.title}</h2>
          <div class="league-meta"><strong>League starts:</strong> ${league.leagueStarts}</div>
        </div>

        <ul class="league-facts">
          <li><strong>${league.teamPrice}</strong> — ${league.teamNote.replace("$100 off if signed up by April 19th.", `<span class="discount-highlight">$100 off if signed up by April 19th.</span>`)}</li>
          <li><strong>${league.freeAgentPrice}</strong> — ${league.freeAgentNote}</li>
          <li><strong>Start times:</strong> ${league.startTimes}</li>
          <li><strong>Season:</strong> ${league.season}</li>
          <li><strong>Format:</strong> ${league.schedule}</li>
          <li><strong>Playoffs:</strong> ${league.playoffDate} — ${league.playoffNote}</li>
        </ul>

        ${notesHtml}

        <div class="league-actions">
          <a class="cta cta-primary" href="${league.signUpUrl}" target="_blank" rel="noreferrer">Team Sign Up</a>
          <a class="cta cta-secondary" href="${league.freeAgentUrl}" target="_blank" rel="noreferrer">Free Agent Sign Up</a>
        </div>
      </article>
    `;
  }

  gridEl.innerHTML = LEAGUES.map(buildCard).join("");
})();

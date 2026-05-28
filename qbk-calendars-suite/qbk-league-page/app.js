(() => {
  const TRACK_CLICK_URL = "/api/track-league-click";
  const params = new URLSearchParams(window.location.search);
  const analyticsSiteId = params.get("site") || "";
  function isLocalAnalyticsSource() {
    const host = (window.location.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }
  const LEAGUES = [
    {
      day: "Monday",
      format: "4v4",
      title: "Monday Intermediate Coed 4x4",
      leagueStarts: "July 13, 2026",
      teamPrice: "$1,095/team",
      teamNote: "Unlimited roster. $100 off if signed up by June 21st, 2026.",
      freeAgentPrice: "$150/player",
      freeAgentNote: "Placed onto a team. Expect roughly 7 players per team.",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "August 17, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/379?facility_ids=1&registrantType=manager",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9495"
    },
    {
      day: "Tuesday",
      format: "6v6",
      title: "Tuesday All Abilities Coed 6x6",
      leagueStarts: "July 14, 2026",
      teamPrice: "$1,195/team",
      teamNote: "Unlimited roster. $100 off if signed up by June 21st, 2026.",
      freeAgentPrice: "$120/player",
      freeAgentNote: "Placed onto a team. Expect roughly 11 players per team.",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "August 18, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/378?facility_ids=1&registrantType=manager",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9494"
    },
    {
      day: "Wednesday",
      format: "4v4",
      title: "Wednesday Intermediate Coed 4x4",
      leagueStarts: "July 15, 2026",
      teamPrice: "$1,095/team",
      teamNote: "Unlimited roster. $100 off if signed up by June 21st, 2026.",
      freeAgentPrice: "$150/player",
      freeAgentNote: "Placed onto a team. Expect roughly 7 players per team.",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "August 19, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/381?facility_ids=1&registrantType=manager",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9497"
    },
    {
      day: "Thursday",
      format: "6v6",
      title: "Thursday All Abilities Coed 6x6",
      leagueStarts: "July 16, 2026",
      teamPrice: "$1,195/team",
      teamNote: "Unlimited roster. $100 off if signed up by June 21st, 2026.",
      freeAgentPrice: "$120/player",
      freeAgentNote: "Placed onto a team. Expect roughly 10 players per team.",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "August 20, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/activity-finder/programs/1/levels/380?&&registrantType=manager",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9496"
    }
  ];

  const gridEl = document.getElementById("league-grid");
  if (!gridEl) return;

  function trackClick(payload) {
    if (isLocalAnalyticsSource()) return;
    const body = JSON.stringify({
      calendar: "league-page",
      action: "click",
      page_path: window.location.pathname,
      view_mode: window.innerWidth <= 720 ? "mobile" : "desktop",
      referrer: document.referrer || "",
      source_host: window.location.hostname || "",
      site_id: analyticsSiteId,
      ...payload,
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(TRACK_CLICK_URL, blob)) {
        return;
      }
    }

    fetch(TRACK_CLICK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  function trackTarget(node) {
    if (!node) return;
    const now = Date.now();
    const lastSent = Number(node.dataset.analyticsTrackedAt || 0);
    if (now - lastSent < 1500) return;
    node.dataset.analyticsTrackedAt = String(now);
    trackClick({
      button_type: node.dataset.analyticsType || "league_cta",
      button_label: node.dataset.buttonLabel || node.textContent.trim(),
      destination_url: node.dataset.destinationUrl || "",
      category: node.dataset.category || "league-page",
    });
  }

  function buildCard(league) {
    const notesHtml = league.notes.length
      ? `<div class="league-note">${league.notes.join("<br />")}</div>`
      : "";
    const teamNoteHtml = league.teamNote.replace(
      "$100 off if signed up by June 21st, 2026.",
      `<span class="discount-highlight">$100 off if signed up by June 21st, 2026.</span>`
    );

    return `
      <article class="league-card">
        <div class="league-top">
          <h2 class="league-title">${league.title}</h2>
          <div class="league-meta"><strong>League starts:</strong> ${league.leagueStarts}</div>
        </div>

        <ul class="league-facts">
          <li><strong>${league.teamPrice}</strong> — ${teamNoteHtml}</li>
          <li><strong>${league.freeAgentPrice}</strong> — ${league.freeAgentNote}</li>
          <li><strong>Start times:</strong> ${league.startTimes}</li>
          <li><strong>Season:</strong> ${league.season}</li>
          <li><strong>Format:</strong> ${league.schedule}</li>
          <li><strong>Playoffs:</strong> ${league.playoffDate} — ${league.playoffNote}</li>
        </ul>

        ${notesHtml}

        <div class="league-actions">
          <a
            class="cta cta-primary"
            href="${league.signUpUrl}"
            target="_blank"
            rel="noreferrer"
            data-analytics-type="team_signup"
            data-button-label="${league.title} — Team Sign Up"
            data-destination-url="${league.signUpUrl}"
            data-category="${league.title}"
          >Team Sign Up</a>
          <a
            class="cta cta-secondary"
            href="${league.freeAgentUrl}"
            target="_blank"
            rel="noreferrer"
            data-analytics-type="free_agent_signup"
            data-button-label="${league.title} — Free Agent Sign Up"
            data-destination-url="${league.freeAgentUrl}"
            data-category="${league.title}"
          >Free Agent Sign Up</a>
        </div>
      </article>
    `;
  }

  gridEl.innerHTML = LEAGUES.map(buildCard).join("");

  const analyticsNodes = gridEl.querySelectorAll("[data-analytics-type]");
  analyticsNodes.forEach((node) => {
    node.addEventListener("pointerdown", () => {
      trackTarget(node);
    }, { passive: true });

    node.addEventListener("click", () => {
      trackTarget(node);
    });

    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        trackTarget(node);
      }
    });
  });
})();

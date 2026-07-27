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
      format: "4x4",
      title: "Monday Intermediate League",
      leagueStarts: "September 14, 2026",
      teamPrice: "$1,095.00/team",
      freeAgentPrice: "$150/player",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "October 26, 2026",
      playoffNote: "Playoff night.",
      notes: ["No games October 12, 2026 for Columbus/Indigenous Peoples' Day."],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/qbksports/programs/level/384?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9746"
    },
    {
      day: "Tuesday",
      format: "6x6",
      title: "Tuesday All-Abilities Rec League",
      leagueStarts: "September 8, 2026",
      teamPrice: "$1,195/team",
      freeAgentPrice: "$120/player",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "October 13, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/qbksports/programs/level/383?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9745"
    },
    {
      day: "Wednesday",
      format: "4x4",
      title: "Wednesday Intermediate League",
      leagueStarts: "September 9, 2026",
      teamPrice: "$1,095.00/team",
      freeAgentPrice: "$150/player",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "October 14, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/qbksports/programs/level/386?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9748"
    },
    {
      day: "Thursday",
      format: "6x6",
      title: "Thursday All-Abilities Rec League",
      leagueStarts: "September 10, 2026",
      teamPrice: "$1,195/team",
      freeAgentPrice: "$120/player",
      startTimes: "6:00 PM and later",
      season: "6 weeks",
      schedule: "5 weeks regular play + 1 week playoffs",
      playoffDate: "October 15, 2026",
      playoffNote: "Playoff night.",
      notes: [],
      signUpUrl: "https://apps.daysmartrecreation.com/dash/x/qbksports/programs/level/385?facility_ids=1",
      freeAgentUrl: "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/teams/9747"
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
    const titleRest = league.title.startsWith(`${league.day} `)
      ? league.title.slice(league.day.length + 1)
      : league.title;
    const notesHtml = league.notes.length
      ? `<div class="league-note"><span>Schedule note</span><strong>${league.notes.join("<br />")}</strong></div>`
      : "";
    return `
      <article class="league-card" data-day="${league.day.toLowerCase()}">
        <header class="league-top">
          <div class="league-labels">
            <span class="format-label">${league.format} Coed</span>
          </div>
          <h2 class="league-title">
            <span class="title-day">${league.day}</span>
            <span class="title-rest">${titleRest}</span>
          </h2>
          <p class="start-time">Games start ${league.startTimes}. 6-week season.</p>
        </header>

        <div class="season-path${league.notes.length ? " has-note" : ""}" aria-label="${league.day} league season dates">
          <div class="date-block">
            <span>Starts</span>
            <strong>${league.leagueStarts}</strong>
          </div>
          <div class="path-line" aria-hidden="true">
            <span></span>
          </div>
          <div class="date-block date-block-end">
            <span>Playoffs</span>
            <strong>${league.playoffDate}</strong>
          </div>
          ${notesHtml}
        </div>

        <div class="registration-options">
          <div class="registration-option">
            <div class="option-label">Bring a team</div>
            <div class="option-price">${league.teamPrice}</div>
            <div class="discount-highlight">Save $100 by August 16</div>
          </div>
          <div class="registration-option">
            <div class="option-label">Join as a free agent</div>
            <div class="option-price">${league.freeAgentPrice}</div>
          </div>
        </div>

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
          ><span>Register a Team</span><span class="cta-arrow" aria-hidden="true">-&gt;</span></a>
          <a
            class="cta cta-secondary"
            href="${league.freeAgentUrl}"
            target="_blank"
            rel="noreferrer"
            data-analytics-type="free_agent_signup"
            data-button-label="${league.title} — Free Agent Sign Up"
            data-destination-url="${league.freeAgentUrl}"
            data-category="${league.title}"
          ><span>Join as a Free Agent</span><span class="cta-arrow" aria-hidden="true">-&gt;</span></a>
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

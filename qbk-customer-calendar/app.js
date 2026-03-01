(() => {
  const params = new URLSearchParams(window.location.search);
  const embedMode = params.get("embed") === "1" || document.body.dataset.embed === "1";
  if (embedMode) {
    document.body.classList.add("embed-mode");
  }

  const LIVE_FEED_BASE = "/api/events";
  const RENT_URL = "https://www.catchcorner.com/qbksports";
  const SLOT_MINUTES = 30;
  const SLOT_HEIGHT = 28;
  const DAY_START_MIN = 6 * 60;
  const SLOT_COUNT = 38; // 6:00 AM -> 1:00 AM in 30-minute slots
  const DAY_END_MIN = DAY_START_MIN + (SLOT_COUNT * SLOT_MINUTES);
  const RENT_START_MIN = 9 * 60;
  const RENT_END_MIN = 24 * 60;
  const COURTS = [
    { key: "left", label: "Left Court" },
    { key: "middle", label: "Middle Court" },
    { key: "right", label: "Right Court" },
  ];
  const els = {
    date: document.getElementById("event-date"),
    prevDay: document.getElementById("prev-day"),
    nextDay: document.getElementById("next-day"),
    todayDay: document.getElementById("today-day"),
    dayGrid: document.getElementById("day-grid"),
    dayViewTitle: document.getElementById("day-view-title"),
    timeTrack: document.getElementById("time-track"),
    courtLeft: document.getElementById("court-left"),
    courtMiddle: document.getElementById("court-middle"),
    courtRight: document.getElementById("court-right"),
    vacancyOverlay: document.getElementById("vacancy-overlay"),
    eventsOverlay: document.getElementById("events-overlay"),
  };

  function formatShortDate(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTimeRange(startISO, endISO) {
    const start = new Date(startISO);
    const end = new Date(endISO);
    const opts = { hour: "numeric", minute: "2-digit" };
    return `${start.toLocaleTimeString([], opts)} - ${end.toLocaleTimeString([], opts)}`;
  }

  function normalizeEvent(raw) {
    let title = String(raw.title || raw.name || "Untitled Event");
    const start = raw.start_time || raw.start || raw.startAt;
    const end = raw.end_time || raw.end || raw.endAt;
    if (!start || !end) return null;

    let category = raw.category ? String(raw.category) : null;
    let bookingUrl = raw.booking_url || raw.bookingUrl
      ? String(raw.booking_url || raw.bookingUrl)
      : "#";
    let forceClickable = false;

    const lowerTitle = title.toLowerCase();

    const is2sEvent = /\b2s\b/.test(lowerTitle);
    const isMatchPlay = /match[\s-]*play/.test(lowerTitle);
    const isKingOfCourt = /king[\s-]*of[\s-]*the[\s-]*court/.test(lowerTitle);
    const isAdvanced = /\badvanced\b/.test(lowerTitle);
    const isIntermediate = /\bintermediate\b/.test(lowerTitle);
    if (is2sEvent && (isMatchPlay || isKingOfCourt) && (isAdvanced || isIntermediate)) {
      const level = isAdvanced ? "Advanced" : "Intermediate";
      const format = isMatchPlay ? "Match Play" : "King of the Court";
      title = `${level} 2s - ${format}`;
    }

    if (/free[\s-]*trial[\s-]*class/.test(lowerTitle)) {
      title = "Free Trial Class";
    }

    if (lowerTitle.includes("beach lions")) {
      title = title
        .replace(/\s*[-–—]?\s*\b(winter|spring|summer|fall)\b\s*[-–—]?\s*/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    const categoryLower = String(category || "").toLowerCase();
    const isLeagueOrGame = categoryLower.includes("league")
      || categoryLower.includes("game")
      || lowerTitle.includes("league");
    if (isLeagueOrGame) {
      bookingUrl = "https://qbksports.com/leagues";
      forceClickable = true;
      const seasonMatch = lowerTitle.match(/\b(winter|spring|summer|fall)\b/);
      const formatMatch = lowerTitle.match(/\b(4x4|6x6)\b/);
      if (seasonMatch && formatMatch) {
        const season = seasonMatch[1].charAt(0).toUpperCase() + seasonMatch[1].slice(1);
        title = `${season} ${formatMatch[1]} League`;
      }
    }

    if (lowerTitle.includes("junior classes")) {
      title = title.replace(/\bCubs\b(?!\s*\(6-9 y\/o\))/i, "Cubs (6-9 y/o)");
      if (lowerTitle.includes("cubs") || lowerTitle.includes("seals")) {
        bookingUrl = "https://qbksports.com/youth";
      } else if (lowerTitle.includes("beach lions")) {
        bookingUrl = "https://qbksports.com/beachlions";
      }
    }

    const isTeenDropIn = /\bteens?\b/.test(lowerTitle) && /drop[\s-]*in/.test(lowerTitle);
    if (isTeenDropIn) {
      title = "Teen Drop in";
    }

    const isTeenGlowParty = /\bteens?\b/.test(lowerTitle)
      && /glow[\s-]*in[\s-]*the[\s-]*dark[\s-]*party/.test(lowerTitle);
    if (isTeenGlowParty) {
      title = "Teen Glow In The Dark Party";
    }

    const isProDropIn = /pro[\s-]*drop[\s-]*in/.test(lowerTitle);
    if (isProDropIn) {
      title = "Private Rental";
      category = "Rental";
      bookingUrl = "#";
      forceClickable = false;
    }

    const clickable = (forceClickable || raw.clickable !== false) && bookingUrl && bookingUrl !== "#";

    return {
      id: String(raw.id || raw.event_id || `${title}-${start}`),
      title,
      category,
      location: raw.location ? String(raw.location) : null,
      subResource: raw.sub_resource ? String(raw.sub_resource) : null,
      courtKey: raw.court_key ? String(raw.court_key) : null,
      start,
      end,
      bookingUrl,
      clickable,
    };
  }

  function getDayEvents(events, selectedDate) {
    const startOfDay = new Date(`${selectedDate}T00:00:00`);
    const endOfDay = new Date(`${selectedDate}T23:59:59.999`);

    return events
      .map(normalizeEvent)
      .filter(Boolean)
      .filter((event) => {
        const start = new Date(event.start);
        return start >= startOfDay && start <= endOfDay;
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function hourOrderFromDate(rawDate) {
    const hour = rawDate.getHours();
    const minute = rawDate.getMinutes();
    let totalMinutes = (hour * 60) + minute;
    if (totalMinutes < DAY_START_MIN) totalMinutes += 24 * 60;
    return totalMinutes / 60;
  }

  function formatHourLabel(hourOrder) {
    const hour24 = hourOrder % 24;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:00 ${suffix}`;
  }

  function formatSlotLabel(hourValue) {
    const baseHour = Math.floor(hourValue);
    const minutes = Math.round((hourValue - baseHour) * 60);
    const hour24 = baseHour % 24;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const mm = minutes === 30 ? "30" : "00";
    return `${hour12}:${mm} ${suffix}`;
  }

  function courtsForLocation(location) {
    const text = String(location || "").toLowerCase();
    if (!text) return ["left"];
    if (text.includes("all court")) return COURTS.map((court) => court.key);
    if (text.includes("left")) return ["left"];
    if (text.includes("middle")) return ["middle"];
    if (text.includes("right")) return ["right"];
    return ["left"];
  }

  function renderDayView(events, selectedDate) {
    els.dayViewTitle.textContent = `Court Day View for ${formatShortDate(selectedDate)}`;
    const trackHeight = SLOT_COUNT * SLOT_HEIGHT;
    const firstHead = els.dayGrid.querySelector(".day-head");
    const headHeight = firstHead ? firstHead.getBoundingClientRect().height : 32;
    els.dayGrid.style.setProperty("--head-height", `${headHeight}px`);
    const courtEls = {
      left: els.courtLeft,
      middle: els.courtMiddle,
      right: els.courtRight,
    };

    els.timeTrack.innerHTML = "";
    els.timeTrack.style.height = `${trackHeight}px`;
    for (const court of COURTS) {
      courtEls[court.key].innerHTML = "";
      courtEls[court.key].style.height = `${trackHeight}px`;
    }
    els.eventsOverlay.innerHTML = "";
    els.eventsOverlay.style.height = `${trackHeight}px`;
    els.vacancyOverlay.innerHTML = "";
    els.vacancyOverlay.style.height = `${trackHeight}px`;

    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const order = (DAY_START_MIN + (i * SLOT_MINUTES)) / 60;
      const slot = document.createElement("div");
      slot.className = "time-slot";

      const label = document.createElement("span");
      label.className = "time-label";
      label.textContent = i % 2 === 0 ? formatSlotLabel(order) : "";
      slot.appendChild(label);
      els.timeTrack.appendChild(slot);

      for (const court of COURTS) {
        const courtSlot = document.createElement("div");
        courtSlot.className = "court-slot";
        courtEls[court.key].appendChild(courtSlot);
      }
    }

    // Safety trim: never allow more than the configured visible slot count.
    while (els.timeTrack.children.length > SLOT_COUNT) {
      els.timeTrack.removeChild(els.timeTrack.lastElementChild);
    }
    for (const court of COURTS) {
      while (courtEls[court.key].children.length > SLOT_COUNT) {
        courtEls[court.key].removeChild(courtEls[court.key].lastElementChild);
      }
    }

    const grouped = new Map();
    const occupied = COURTS.map(() => Array.from({ length: SLOT_COUNT }, () => false));
    for (const event of events) {
      const eventCourts = event.courtKey
        ? (event.courtKey === "all" ? COURTS.map((court) => court.key) : [event.courtKey])
        : courtsForLocation(event.subResource || event.location);
      const key = [event.title, event.start, event.end, event.bookingUrl || "", event.clickable ? "1" : "0"].join("|");
      const existing = grouped.get(key);
      if (existing) {
        for (const courtKey of eventCourts) existing.courts.add(courtKey);
      } else {
        grouped.set(key, { event, courts: new Set(eventCourts) });
      }
    }

    for (const groupedEvent of grouped.values()) {
      const event = groupedEvent.event;
      const startDate = new Date(event.start);
      const endDate = new Date(event.end);
      const startOrderRaw = hourOrderFromDate(startDate);
      const endOrderRaw = hourOrderFromDate(endDate);
      const startOrder = Math.max(DAY_START_MIN / 60, Math.min(DAY_END_MIN / 60, startOrderRaw));
      const minEndOrder = startOrder + (SLOT_MINUTES / 60);
      const endOrder = Math.max(minEndOrder, Math.min(DAY_END_MIN / 60, endOrderRaw));
      if (endOrder <= DAY_START_MIN / 60 || startOrder >= DAY_END_MIN / 60) continue;

      const startOffset = ((startOrder * 60) - DAY_START_MIN) / SLOT_MINUTES;
      const endOffset = ((endOrder * 60) - DAY_START_MIN) / SLOT_MINUTES;
      const top = startOffset * SLOT_HEIGHT;
      const height = Math.max(22, (endOffset - startOffset) * SLOT_HEIGHT - 4);

      const courtIndexes = Array.from(groupedEvent.courts)
        .map((courtKey) => COURTS.findIndex((court) => court.key === courtKey))
        .filter((idx) => idx >= 0)
        .sort((a, b) => a - b);
      const startCol = courtIndexes.length ? courtIndexes[0] : 0;
      const endCol = courtIndexes.length ? courtIndexes[courtIndexes.length - 1] : 0;
      const leftPct = (startCol / COURTS.length) * 100;
      const widthPct = ((endCol - startCol + 1) / COURTS.length) * 100;
      const startSlot = Math.max(0, Math.floor(startOffset));
      const endSlot = Math.min(SLOT_COUNT, Math.ceil(endOffset));
      for (let col = startCol; col <= endCol; col += 1) {
        for (let slot = startSlot; slot < endSlot; slot += 1) {
          occupied[col][slot] = true;
        }
      }

      const card = document.createElement(event.clickable ? "a" : "div");
      card.className = "day-event";
      const categoryText = String(event.category || "").toLowerCase();
      const titleText = String(event.title || "").toLowerCase();
      const isAdultClass = titleText.includes("adult") && titleText.includes("class");
      const isFreeTrialClass = titleText.includes("free trial class");
      const isTeenDropIn = titleText === "teen drop in"
        || (/\bteens?\b/.test(titleText) && /drop[\s-]*in/.test(titleText));
      const isTeenGlowParty = /glow[\s-]*in[\s-]*the[\s-]*dark[\s-]*party/.test(titleText);
      if (categoryText.includes("league") || categoryText.includes("game")) {
        card.classList.add("day-event-league");
      }
      if (
        !isAdultClass
        && !isFreeTrialClass
        && !isTeenDropIn
        && (categoryText.includes("drop-in") || categoryText.includes("drop in"))
      ) {
        card.classList.add("day-event-dropin");
      }
      if (isTeenDropIn || isTeenGlowParty) {
        card.classList.add("day-event-teen");
      }
      if (titleText.includes("junior classes")) {
        card.classList.add("day-event-junior");
      }
      if (event.clickable) {
        card.href = event.bookingUrl;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
      } else {
        card.classList.add("day-event-static");
      }
      card.style.top = `${top + 2}px`;
      card.style.height = `${height}px`;
      card.style.left = `calc(${leftPct}% + 5px)`;
      card.style.width = `calc(${widthPct}% - 10px)`;

      const title = document.createElement("span");
      title.className = "day-event-title";
      title.textContent = event.title;

      const time = document.createElement("span");
      time.className = "day-event-time";
      time.textContent = formatTimeRange(event.start, event.end);

      card.appendChild(title);
      card.appendChild(time);
      els.eventsOverlay.appendChild(card);
    }

    for (let col = 0; col < COURTS.length; col += 1) {
      const rentStartSlot = Math.max(
        0,
        Math.floor((RENT_START_MIN - DAY_START_MIN) / SLOT_MINUTES),
      );
      const rentEndSlot = Math.min(
        SLOT_COUNT,
        Math.ceil((RENT_END_MIN - DAY_START_MIN) / SLOT_MINUTES),
      );

      let slot = 0;
      while (slot < SLOT_COUNT) {
        const slotOutsideRentWindow = slot < rentStartSlot || slot >= rentEndSlot;
        if (occupied[col][slot] || slotOutsideRentWindow) {
          slot += 1;
          continue;
        }

        const start = slot;
        while (
          slot < SLOT_COUNT
          && slot >= rentStartSlot
          && slot < rentEndSlot
          && !occupied[col][slot]
        ) {
          slot += 1;
        }
        const end = slot;
        const runLength = end - start;
        if (runLength < 2) continue; // only show 1 hour+ windows

        const leftPct = (col / COURTS.length) * 100;
        const widthPct = (1 / COURTS.length) * 100;
        const top = start * SLOT_HEIGHT;
        const height = (runLength * SLOT_HEIGHT) - 2;

        const rent = document.createElement("a");
        rent.className = "rent-slot";
        rent.href = RENT_URL;
        rent.target = "_blank";
        rent.rel = "noopener noreferrer";
        rent.style.left = `calc(${leftPct}% + 5px)`;
        rent.style.width = `calc(${widthPct}% - 10px)`;
        rent.style.top = `${top + 1}px`;
        rent.style.height = `${height}px`;
        rent.textContent = "Rent Court";
        els.vacancyOverlay.appendChild(rent);
      }
    }
  }

  function fetchEventsFrom(url) {
    return fetch(url, { cache: "no-store" }).then((response) => {
      if (!response.ok) {
        return response.text().then((body) => {
          throw new Error(`Feed request failed (${response.status}): ${body.slice(0, 120)}`);
        });
      }
      return response.json();
    }).then((data) => {
      if (!Array.isArray(data)) {
        throw new Error("Event feed must be a JSON array.");
      }
      return data;
    });
  }

  function getLiveFeedUrl(selectedDate) {
    return `${LIVE_FEED_BASE}?date=${encodeURIComponent(selectedDate)}`;
  }

  function loadAndRender() {
    const selectedDate = els.date.value;
    if (!selectedDate) return Promise.resolve();

    return fetchEventsFrom(getLiveFeedUrl(selectedDate))
      .then((raw) => {
        const events = getDayEvents(raw, selectedDate);
        renderDayView(events, selectedDate);
      })
      .catch((error) => {
        renderDayView([], selectedDate);
        if (error) console.error(error);
      });
  }

  function getTodayISO() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function shiftDateBy(days) {
    const base = els.date.value ? new Date(`${els.date.value}T00:00:00`) : new Date();
    base.setDate(base.getDate() + days);
    const yyyy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, "0");
    const dd = String(base.getDate()).padStart(2, "0");
    els.date.value = `${yyyy}-${mm}-${dd}`;
    loadAndRender();
  }

  function init() {
    els.date.value = getTodayISO();
    els.date.addEventListener("change", function () { loadAndRender(); });
    if (els.prevDay) {
      els.prevDay.addEventListener("click", function () { shiftDateBy(-1); });
    }
    if (els.nextDay) {
      els.nextDay.addEventListener("click", function () { shiftDateBy(1); });
    }
    if (els.todayDay) {
      els.todayDay.addEventListener("click", function () {
        els.date.value = getTodayISO();
        loadAndRender();
      });
    }
    loadAndRender();
  }

  init();
})();

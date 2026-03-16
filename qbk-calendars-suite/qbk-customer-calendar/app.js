(() => {
  const params = new URLSearchParams(window.location.search);
  const embedMode = params.get("embed") === "1" || document.body.dataset.embed === "1";
  const forceMobileMode = params.get("mobile") === "1" || document.body.dataset.forceMobile === "1";
  if (embedMode) {
    document.body.classList.add("embed-mode");
  }
  if (forceMobileMode) {
    document.body.classList.add("force-mobile-mode");
  }

  const LIVE_FEED_BASE = "/api/events";
  const RENT_URL = "https://www.catchcorner.com/qbksports";
  const CLIENT_EVENTS_CACHE_MS = 120000;
  const MOBILE_LAYOUT_QUERY = "(max-width: 900px), (max-device-width: 900px), (hover: none) and (pointer: coarse)";
  const SLOT_MINUTES = 30;
  const DEFAULT_SLOT_HEIGHT = 28;
  const DAY_START_MIN = 6 * 60;
  const SLOT_COUNT = 38; // 6:00 AM -> 1:00 AM in 30-minute slots
  const DAY_END_MIN = DAY_START_MIN + (SLOT_COUNT * SLOT_MINUTES);
  const RENT_START_MIN = 9 * 60;
  const RENT_END_MIN = 24 * 60;
  const RENT_PEAK_START_MIN = 16 * 60;
  const RENT_PEAK_END_MIN = 22 * 60;
  const RENT_TIER_OFF_PEAK = "offpeak";
  const RENT_TIER_PEAK = "peak";
  const COURTS = [
    { key: "left", label: "Left Court" },
    { key: "middle", label: "Middle Court" },
    { key: "right", label: "Right Court" },
  ];
  const FILTER_KEYS = [
    "adultClasses",
    "availableRentals",
    "leagues",
    "privateEventsRentals",
    "youthClasses",
    "adultDropIns",
    "teenDropIns",
  ];
  const filterState = Object.fromEntries(FILTER_KEYS.map((key) => [key, true]));
  const els = {
    date: document.getElementById("event-date"),
    prevDay: document.getElementById("prev-day"),
    nextDay: document.getElementById("next-day"),
    todayDay: document.getElementById("today-day"),
    clearFilters: document.getElementById("clear-filters"),
    mobileFilterToggle: document.getElementById("mobile-filter-toggle"),
    filterMenu: document.getElementById("filter-menu"),
    dayGrid: document.getElementById("day-grid"),
    dayViewTitle: document.getElementById("day-view-title"),
    timeTrack: document.getElementById("time-track"),
    courtLeft: document.getElementById("court-left"),
    courtMiddle: document.getElementById("court-middle"),
    courtRight: document.getElementById("court-right"),
    vacancyOverlay: document.getElementById("vacancy-overlay"),
    eventsOverlay: document.getElementById("events-overlay"),
    mobileDayView: document.getElementById("mobile-day-view"),
    mobileCourtTabs: document.getElementById("mobile-court-tabs"),
    mobileEventsList: document.getElementById("mobile-events-list"),
  };
  const filterBarEl = document.querySelector(".filter-bar");
  let mobileCourtKey = "left";
  let lastDayEvents = [];
  let lastSelectedDate = "";
  let lastIsMobile = null;
  let mobileFiltersOpen = false;
  const clientEventsCache = new Map();
  const clientEventsInflight = new Map();

  function applyEventFilters() {
    const items = document.querySelectorAll("[data-filter-category]");
    items.forEach((node) => {
      const key = node.dataset.filterCategory;
      const visible = !!filterState[key];
      node.style.display = visible ? "" : "none";
    });
  }

  function updateFilterChipState() {
    if (!els.filterMenu) return;
    const chips = els.filterMenu.querySelectorAll(".filter-chip[data-filter-key]");
    chips.forEach((chip) => {
      const key = chip.dataset.filterKey;
      const selected = !!filterState[key];
      chip.classList.toggle("is-active", selected);
      chip.classList.toggle("is-inactive", !selected);
      chip.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function clearAllFilters() {
    FILTER_KEYS.forEach((key) => {
      filterState[key] = false;
    });
    updateFilterChipState();
    applyEventFilters();
  }

  function setupFilterControls() {
    if (els.filterMenu) {
      els.filterMenu.addEventListener("click", (event) => {
        const target = event.target.closest(".filter-chip[data-filter-key]");
        if (!target) return;
        const key = target.dataset.filterKey;
        if (!Object.prototype.hasOwnProperty.call(filterState, key)) return;
        filterState[key] = !filterState[key];
        updateFilterChipState();
        applyEventFilters();
      });
    }

    if (els.clearFilters) {
      els.clearFilters.addEventListener("click", () => {
        clearAllFilters();
      });
    }

    updateFilterChipState();
  }

  function syncMobileFilterDropdown() {
    if (!filterBarEl || !els.mobileFilterToggle) return;
    const mobile = isMobileLayout();
    if (!mobile) {
      filterBarEl.classList.add("mobile-filters-open");
      els.mobileFilterToggle.setAttribute("aria-expanded", "true");
      els.mobileFilterToggle.textContent = "Filters ▴";
      return;
    }
    filterBarEl.classList.toggle("mobile-filters-open", mobileFiltersOpen);
    els.mobileFilterToggle.setAttribute("aria-expanded", mobileFiltersOpen ? "true" : "false");
    els.mobileFilterToggle.textContent = mobileFiltersOpen ? "Filters ▴" : "Filters ▾";
  }

  function isMobileLayout() {
    return forceMobileMode || window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  }

  function getEventCourts(event) {
    return event.courtKey
      ? (event.courtKey === "all" ? COURTS.map((court) => court.key) : [event.courtKey])
      : courtsForLocation(event.subResource || event.location);
  }

  function getEventClassification(event) {
    const categoryText = String(event.category || "").toLowerCase();
    const titleText = String(event.title || "").toLowerCase();
    const isAdultClass = titleText.includes("adult") && titleText.includes("class");
    const isFreeTrialClass = titleText.includes("free trial class");
    const isTeenDropIn = titleText === "teen drop in"
      || (/\bteens?\b/.test(titleText) && /drop[\s-]*in/.test(titleText));
    const isTeenGlowParty = /glow[\s-]*in[\s-]*the[\s-]*dark[\s-]*party/.test(titleText);
    const isLeagueOrGame = categoryText.includes("league") || categoryText.includes("game");
    const isYouthClass = titleText.includes("junior classes")
      || titleText.includes("cubs")
      || titleText.includes("seals")
      || titleText.includes("beach lions");
    const isAdultDropIn = !isTeenDropIn
      && !isTeenGlowParty
      && (categoryText.includes("drop-in") || categoryText.includes("drop in"));
    const isPrivateEventOrRental = titleText.includes("private event")
      || titleText.includes("private rental")
      || (!event.clickable && (categoryText.includes("rental") || categoryText.includes("block")));

    let filterCategory = "privateEventsRentals";
    if (isTeenDropIn || isTeenGlowParty) {
      filterCategory = "teenDropIns";
    } else if (isYouthClass) {
      filterCategory = "youthClasses";
    } else if (isAdultDropIn) {
      filterCategory = "adultDropIns";
    } else if (isLeagueOrGame) {
      filterCategory = "leagues";
    } else if (isPrivateEventOrRental) {
      filterCategory = "privateEventsRentals";
    } else if (isAdultClass || isFreeTrialClass || event.clickable) {
      filterCategory = "adultClasses";
    }

    const classes = [];
    if (isLeagueOrGame) classes.push("day-event-league");
    if (!isAdultClass && !isFreeTrialClass && !isTeenDropIn && !isTeenGlowParty && isAdultDropIn) {
      classes.push("day-event-dropin");
    }
    if (isTeenDropIn || isTeenGlowParty) classes.push("day-event-teen");
    if (titleText.includes("junior classes")) classes.push("day-event-junior");
    if (!event.clickable) classes.push("day-event-static");

    return { classes, filterCategory };
  }

  function applyClassification(node, event) {
    const classification = getEventClassification(event);
    classification.classes.forEach((cls) => node.classList.add(cls));
    node.dataset.filterCategory = classification.filterCategory;
  }

  function updateMobileCourtTabs() {
    if (!els.mobileCourtTabs) return;
    const tabs = els.mobileCourtTabs.querySelectorAll(".mobile-court-tab[data-court-key]");
    tabs.forEach((tab) => {
      const active = tab.dataset.courtKey === mobileCourtKey;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function buildGroupedEvents(events) {
    const grouped = new Map();
    for (const event of events) {
      const eventCourts = getEventCourts(event);
      const key = [event.title, event.start, event.end, event.bookingUrl || "", event.clickable ? "1" : "0"].join("|");
      const existing = grouped.get(key);
      if (existing) {
        for (const courtKey of eventCourts) existing.courts.add(courtKey);
      } else {
        grouped.set(key, { event, courts: new Set(eventCourts) });
      }
    }
    return Array.from(grouped.values())
      .sort((a, b) => new Date(a.event.start) - new Date(b.event.start));
  }

  function formatShortDate(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatClockTime(date, compact, withSuffix = true) {
    const hour24 = date.getHours();
    const minute = date.getMinutes();
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    if (compact && minute === 0) {
      return withSuffix ? `${hour12} ${suffix}` : `${hour12}`;
    }
    const mm = String(minute).padStart(2, "0");
    return withSuffix ? `${hour12}:${mm} ${suffix}` : `${hour12}:${mm}`;
  }

  function formatTimeRange(startISO, endISO, options = {}) {
    const { compact = false } = options;
    const start = new Date(startISO);
    const end = new Date(endISO);
    const startSuffix = start.getHours() >= 12 ? "PM" : "AM";
    const endSuffix = end.getHours() >= 12 ? "PM" : "AM";
    if (compact && startSuffix === endSuffix) {
      return `${formatClockTime(start, compact, false)} - ${formatClockTime(end, compact, true)}`;
    }
    return `${formatClockTime(start, compact)} - ${formatClockTime(end, compact)}`;
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

  function isLeagueEvent(event) {
    const categoryText = String(event.category || "").toLowerCase();
    const titleText = String(event.title || "").toLowerCase();
    return categoryText.includes("league")
      || categoryText.includes("game")
      || titleText.includes("league");
  }

  function isGenericLeagueTitle(title) {
    const text = String(title || "").toLowerCase().trim();
    return /\bleague[\s-]*match\b/.test(text) || text === "league";
  }

  function getEventWindowHours(event) {
    const startHours = hourOrderFromDate(new Date(event.start));
    const endHours = hourOrderFromDate(new Date(event.end));
    const minDurationHours = SLOT_MINUTES / 60;
    return {
      start: startHours,
      end: Math.max(startHours + minDurationHours, endHours),
    };
  }

  function resolveLeagueMatchTitles(events) {
    const leagueEvents = events.filter((event) => isLeagueEvent(event));
    const namedLeagues = leagueEvents.filter((event) => !isGenericLeagueTitle(event.title));
    if (!namedLeagues.length) return events;

    for (const event of leagueEvents) {
      if (!isGenericLeagueTitle(event.title)) continue;
      const currentWindow = getEventWindowHours(event);
      let bestMatch = null;
      let bestDelta = Number.POSITIVE_INFINITY;

      for (const candidate of namedLeagues) {
        if (candidate === event) continue;
        const candidateWindow = getEventWindowHours(candidate);
        const overlaps = currentWindow.start < candidateWindow.end
          && candidateWindow.start < currentWindow.end;
        if (!overlaps) continue;

        const delta = Math.abs(currentWindow.start - candidateWindow.start);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestMatch = candidate;
        }
      }

      if (bestMatch) {
        event.title = bestMatch.title;
      } else {
        event.title = namedLeagues[0].title;
      }
    }

    return events;
  }

  function getDayEvents(events, selectedDate) {
    const startOfDay = new Date(`${selectedDate}T00:00:00`);
    const endOfDay = new Date(`${selectedDate}T23:59:59.999`);

    const dayEvents = events
      .map(normalizeEvent)
      .filter(Boolean)
      .filter((event) => {
        const start = new Date(event.start);
        return start >= startOfDay && start <= endOfDay;
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    return resolveLeagueMatchTitles(dayEvents);
  }

  function hourOrderFromDate(rawDate) {
    const hour = rawDate.getHours();
    const minute = rawDate.getMinutes();
    let totalMinutes = (hour * 60) + minute;
    if (totalMinutes < DAY_START_MIN) totalMinutes += 24 * 60;
    return totalMinutes / 60;
  }

  function isWeekendDate(selectedDate) {
    const date = new Date(`${selectedDate}T00:00:00`);
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  function getRentalTierForSlot(slot, weekend) {
    if (weekend) return RENT_TIER_PEAK;
    const slotStartMin = DAY_START_MIN + (slot * SLOT_MINUTES);
    return slotStartMin >= RENT_PEAK_START_MIN && slotStartMin < RENT_PEAK_END_MIN
      ? RENT_TIER_PEAK
      : RENT_TIER_OFF_PEAK;
  }

  function splitRentalRunByTier(startSlot, endSlot, weekend) {
    if (weekend) {
      return [{ start: startSlot, end: endSlot, tier: RENT_TIER_PEAK }];
    }

    const segments = [];
    let cursor = startSlot;
    while (cursor < endSlot) {
      const tier = getRentalTierForSlot(cursor, weekend);
      let next = cursor + 1;
      while (next < endSlot && getRentalTierForSlot(next, weekend) === tier) {
        next += 1;
      }
      segments.push({ start: cursor, end: next, tier });
      cursor = next;
    }
    return segments;
  }

  function formatHourLabel(hourOrder) {
    const hour24 = hourOrder % 24;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:00 ${suffix}`;
  }

  function formatSlotLabel(hourValue, compact = false) {
    const baseHour = Math.floor(hourValue);
    const minutes = Math.round((hourValue - baseHour) * 60);
    const hour24 = baseHour % 24;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    if (compact && minutes === 0) {
      return `${hour12} ${suffix}`;
    }
    const mm = minutes === 30 ? "30" : "00";
    return `${hour12}:${mm} ${suffix}`;
  }

  function getSlotHeightPx() {
    const source = els.dayGrid || document.body;
    const raw = window.getComputedStyle(source).getPropertyValue("--slot-height").trim();
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return DEFAULT_SLOT_HEIGHT;
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

  function renderDayViewMobile(events, selectedDate) {
    els.dayViewTitle.textContent = `Court Day View for ${formatShortDate(selectedDate)}`;
    if (!els.mobileEventsList) return;

    updateMobileCourtTabs();
    els.mobileEventsList.innerHTML = "";

    const groupedEvents = buildGroupedEvents(events);
    const courtIndex = COURTS.findIndex((court) => court.key === mobileCourtKey);
    const weekend = isWeekendDate(selectedDate);
    const occupied = Array.from({ length: SLOT_COUNT }, () => false);
    const timelineItems = [];
    const renderedLeagueRanges = [];

    for (const groupedEvent of groupedEvents) {
      const event = groupedEvent.event;
      if (!groupedEvent.courts.has(mobileCourtKey)) continue;

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
      if (isLeagueEvent(event)) {
        const overlapsLeague = renderedLeagueRanges.some((range) => startOffset < range.end && range.start < endOffset);
        if (overlapsLeague) continue;
        renderedLeagueRanges.push({ start: startOffset, end: endOffset });
      }

      const startSlot = Math.max(0, Math.floor(startOffset));
      const endSlot = Math.min(SLOT_COUNT, Math.ceil(endOffset));
      for (let slot = startSlot; slot < endSlot; slot += 1) {
        occupied[slot] = true;
      }

      timelineItems.push({
        type: "event",
        event,
        startOrder,
      });
    }

    const rentStartSlot = Math.max(0, Math.floor((RENT_START_MIN - DAY_START_MIN) / SLOT_MINUTES));
    const rentEndSlot = Math.min(SLOT_COUNT, Math.ceil((RENT_END_MIN - DAY_START_MIN) / SLOT_MINUTES));
    let slot = 0;
    while (slot < SLOT_COUNT) {
      const outsideRent = slot < rentStartSlot || slot >= rentEndSlot;
      if (occupied[slot] || outsideRent) {
        slot += 1;
        continue;
      }
      const start = slot;
      while (slot < SLOT_COUNT && slot >= rentStartSlot && slot < rentEndSlot && !occupied[slot]) {
        slot += 1;
      }
      const end = slot;
      const runLength = end - start;
      if (runLength < 2) continue;
      const tierRuns = splitRentalRunByTier(start, end, weekend);
      for (const tierRun of tierRuns) {
        const tierLength = tierRun.end - tierRun.start;
        if (tierLength < 2) continue;
        const startMin = DAY_START_MIN + (tierRun.start * SLOT_MINUTES);
        const endMin = DAY_START_MIN + (tierRun.end * SLOT_MINUTES);
        const baseDate = new Date(`${selectedDate}T00:00:00`);
        const rentStart = new Date(baseDate);
        rentStart.setHours(0, startMin, 0, 0);
        const rentEnd = new Date(baseDate);
        rentEnd.setHours(0, endMin, 0, 0);

        timelineItems.push({
          type: "rent",
          tier: tierRun.tier,
          startOrder: startMin / 60,
          startISO: rentStart.toISOString(),
          endISO: rentEnd.toISOString(),
        });
      }
    }

    timelineItems.sort((a, b) => a.startOrder - b.startOrder);
    for (const item of timelineItems) {
      if (item.type === "rent") {
        const rent = document.createElement("a");
        rent.className = `mobile-item mobile-rent-slot mobile-rent-slot--${item.tier || RENT_TIER_OFF_PEAK}`;
        rent.href = RENT_URL;
        rent.target = "_blank";
        rent.rel = "noopener noreferrer";
        rent.dataset.filterCategory = "availableRentals";

        const title = document.createElement("span");
        title.className = "mobile-item-title";
        title.textContent = "Court Rental Available";
        const time = document.createElement("span");
        time.className = "mobile-item-time";
        time.textContent = formatTimeRange(item.startISO, item.endISO, { compact: true });
        rent.appendChild(title);
        rent.appendChild(time);
        els.mobileEventsList.appendChild(rent);
        continue;
      }

      const event = item.event;
      const card = document.createElement(event.clickable ? "a" : "div");
      card.className = "mobile-item";
      applyClassification(card, event);
      if (event.clickable) {
        card.href = event.bookingUrl;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
      }

      const title = document.createElement("span");
      title.className = "mobile-item-title";
      title.textContent = event.title;
      const time = document.createElement("span");
      time.className = "mobile-item-time";
      time.textContent = formatTimeRange(event.start, event.end, { compact: true });
      card.appendChild(title);
      card.appendChild(time);
      els.mobileEventsList.appendChild(card);
    }

    if (!els.mobileEventsList.children.length) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty";
      const courtLabel = COURTS[courtIndex]?.label || "Selected Court";
      empty.textContent = `No events for ${courtLabel}.`;
      els.mobileEventsList.appendChild(empty);
    }

    applyEventFilters();
  }

  function renderDayView(events, selectedDate) {
    lastDayEvents = events;
    lastSelectedDate = selectedDate;

    els.dayViewTitle.textContent = `Court Day View for ${formatShortDate(selectedDate)}`;
    const slotHeight = getSlotHeightPx();
    const useCompactTimes = isMobileLayout();
    const trackHeight = SLOT_COUNT * slotHeight;
    els.dayGrid.style.setProperty("--visible-slot-count", String(SLOT_COUNT));
    els.dayGrid.style.setProperty("--visible-track-height", `${trackHeight}px`);
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
      label.textContent = i % 2 === 0 ? formatSlotLabel(order, useCompactTimes) : "";
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

    const groupedEvents = buildGroupedEvents(events);
    const weekend = isWeekendDate(selectedDate);
    const occupied = COURTS.map(() => Array.from({ length: SLOT_COUNT }, () => false));
    const renderedLeagueBlocks = [];
    for (const groupedEvent of groupedEvents) {
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
      const top = startOffset * slotHeight;
      const height = Math.max(22, (endOffset - startOffset) * slotHeight - 4);

      const courtIndexes = Array.from(groupedEvent.courts)
        .map((courtKey) => COURTS.findIndex((court) => court.key === courtKey))
        .filter((idx) => idx >= 0)
        .sort((a, b) => a - b);
      const startCol = courtIndexes.length ? courtIndexes[0] : 0;
      const endCol = courtIndexes.length ? courtIndexes[courtIndexes.length - 1] : 0;
      const leftPct = (startCol / COURTS.length) * 100;
      const widthPct = ((endCol - startCol + 1) / COURTS.length) * 100;
      if (isLeagueEvent(event)) {
        const overlapsExistingLeague = renderedLeagueBlocks.some((block) => {
          const timeOverlap = startOffset < block.endOffset && block.startOffset < endOffset;
          const courtOverlap = startCol <= block.endCol && block.startCol <= endCol;
          return timeOverlap && courtOverlap;
        });
        if (overlapsExistingLeague) {
          continue;
        }
        renderedLeagueBlocks.push({
          startOffset,
          endOffset,
          startCol,
          endCol,
        });
      }
      const startSlot = Math.max(0, Math.floor(startOffset));
      const endSlot = Math.min(SLOT_COUNT, Math.ceil(endOffset));
      for (let col = startCol; col <= endCol; col += 1) {
        for (let slot = startSlot; slot < endSlot; slot += 1) {
          occupied[col][slot] = true;
        }
      }

      const card = document.createElement(event.clickable ? "a" : "div");
      card.className = "day-event";
      applyClassification(card, event);
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
      time.textContent = formatTimeRange(event.start, event.end, { compact: useCompactTimes });

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
        const tierRuns = splitRentalRunByTier(start, end, weekend);
        for (const tierRun of tierRuns) {
          const tierLength = tierRun.end - tierRun.start;
          if (tierLength < 2) continue; // only show 1 hour+ windows

          const leftPct = (col / COURTS.length) * 100;
          const widthPct = (1 / COURTS.length) * 100;
          const top = tierRun.start * slotHeight;
          const height = (tierLength * slotHeight) - 2;

          const rent = document.createElement("a");
          rent.className = `rent-slot rent-slot--${tierRun.tier}`;
          rent.href = RENT_URL;
          rent.target = "_blank";
          rent.rel = "noopener noreferrer";
          rent.style.left = `calc(${leftPct}% + 5px)`;
          rent.style.width = `calc(${widthPct}% - 10px)`;
          rent.style.top = `${top + 1}px`;
          rent.style.height = `${height}px`;
          rent.textContent = "Court Rental Available";
          rent.dataset.filterCategory = "availableRentals";
          els.vacancyOverlay.appendChild(rent);
        }
      }
    }

    applyEventFilters();
  }

  function fetchEventsFrom(url) {
    const now = Date.now();
    const cached = clientEventsCache.get(url);
    if (cached && now - cached.ts < CLIENT_EVENTS_CACHE_MS) {
      return Promise.resolve(cached.data);
    }

    const inflight = clientEventsInflight.get(url);
    if (inflight) {
      return inflight;
    }

    const request = fetch(url).then((response) => {
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
      clientEventsCache.set(url, { ts: Date.now(), data });
      return data;
    }).finally(() => {
      clientEventsInflight.delete(url);
    });
    clientEventsInflight.set(url, request);
    return request;
  }

  function getLiveFeedUrl(selectedDate) {
    return `${LIVE_FEED_BASE}?date=${encodeURIComponent(selectedDate)}`;
  }

  function shiftISODate(isoDate, days) {
    const base = new Date(`${isoDate}T00:00:00`);
    base.setDate(base.getDate() + days);
    const yyyy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, "0");
    const dd = String(base.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function prefetchAdjacentDates(selectedDate) {
    const prev = shiftISODate(selectedDate, -1);
    const next = shiftISODate(selectedDate, 1);
    fetchEventsFrom(getLiveFeedUrl(prev)).catch(() => {});
    fetchEventsFrom(getLiveFeedUrl(next)).catch(() => {});
  }

  function loadAndRender() {
    const selectedDate = els.date.value;
    if (!selectedDate) return Promise.resolve();

    return fetchEventsFrom(getLiveFeedUrl(selectedDate))
      .then((raw) => {
        const events = getDayEvents(raw, selectedDate);
        renderDayView(events, selectedDate);
        setTimeout(() => prefetchAdjacentDates(selectedDate), 0);
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
    setupFilterControls();
    syncMobileFilterDropdown();
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
    if (els.mobileFilterToggle) {
      els.mobileFilterToggle.addEventListener("click", function () {
        mobileFiltersOpen = !mobileFiltersOpen;
        syncMobileFilterDropdown();
      });
    }
    if (els.mobileCourtTabs) {
      els.mobileCourtTabs.addEventListener("click", (event) => {
        const target = event.target.closest(".mobile-court-tab[data-court-key]");
        if (!target) return;
        mobileCourtKey = target.dataset.courtKey || "left";
        updateMobileCourtTabs();
        if (lastSelectedDate) {
          renderDayView(lastDayEvents, lastSelectedDate);
        }
      });
    }
    lastIsMobile = isMobileLayout();
    window.addEventListener("resize", () => {
      const currentIsMobile = isMobileLayout();
      if (currentIsMobile === lastIsMobile) return;
      lastIsMobile = currentIsMobile;
      if (!currentIsMobile) {
        mobileFiltersOpen = true;
      }
      syncMobileFilterDropdown();
      if (lastSelectedDate) {
        renderDayView(lastDayEvents, lastSelectedDate);
      }
    });
    loadAndRender();
  }

  init();
})();

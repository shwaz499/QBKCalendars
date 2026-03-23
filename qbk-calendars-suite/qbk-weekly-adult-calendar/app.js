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
  const MOBILE_LAYOUT_QUERY = "(max-width: 900px), (max-device-width: 900px), (hover: none) and (pointer: coarse)";
  const SLOT_MINUTES = 30;
  const SLOT_HEIGHT = 28;
  const DAY_START_MIN = 8 * 60;
  const SLOT_COUNT = 28; // 8:00 AM -> 10:00 PM
  const DAY_END_MIN = DAY_START_MIN + (SLOT_COUNT * SLOT_MINUTES);

  const DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const FILTER_KEYS = [
    "freeTrial",
    "intro",
    "levelI",
    "levelII",
    "levelIII",
    "levelIV",
    "sundaySkills",
    "popUpClinics",
  ];
  const filterState = Object.fromEntries(FILTER_KEYS.map((key) => [key, true]));
  const ADULT_CLINIC_TERMS = [
    "beachmode",
    "sandy hands",
    "beach bombers",
    "beach bomberts",
    "serve / serve receive",
    "serve/serve receive",
    "serve receive",
    "shots shop",
  ];
  const currentWeek = {
    rawEvents: [],
    weekStartISO: null,
  };

  const els = {
    date: document.getElementById("week-date"),
    prevWeek: document.getElementById("prev-week"),
    nextWeek: document.getElementById("next-week"),
    todayWeek: document.getElementById("today-week"),
    clearFilters: document.getElementById("clear-filters"),
    mobileFilterToggle: document.getElementById("mobile-filter-toggle"),
    filterMenu: document.getElementById("filter-menu"),
    weekGrid: document.getElementById("week-grid"),
    weekViewTitle: document.getElementById("week-view-title"),
    timeTrack: document.getElementById("time-track"),
    dayTracks: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-track-${idx}`)),
    dayHeads: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-head-${idx}`)),
    eventsOverlay: document.getElementById("events-overlay"),
    mobileWeekView: document.getElementById("mobile-week-view"),
    mobileWeekColumns: document.getElementById("mobile-week-columns"),
  };
  const filterBarEl = document.querySelector(".filter-bar");
  let resizeTimer = null;
  let lastIsMobile = null;
  let mobileFiltersOpen = false;

  function computePageHeight() {
    const body = document.body;
    const html = document.documentElement;
    return Math.ceil(
      Math.max(
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        html ? html.clientHeight : 0,
        html ? html.scrollHeight : 0,
        html ? html.offsetHeight : 0,
      ),
    );
  }

  function postEmbedHeight() {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage(
      {
        type: "qbk:embed-height",
        view: "adult-classes-week",
        height: computePageHeight(),
      },
      "*",
    );
  }

  function schedulePostEmbedHeight() {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(postEmbedHeight, 40);
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
    if (currentWeek.weekStartISO) {
      renderEvents(currentWeek.rawEvents, currentWeek.weekStartISO);
    }
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
        if (currentWeek.weekStartISO) {
          renderEvents(currentWeek.rawEvents, currentWeek.weekStartISO);
        }
      });
    }

    if (els.clearFilters) {
      els.clearFilters.addEventListener("click", clearAllFilters);
    }

    updateFilterChipState();
  }

  function isMobileLayout() {
    return forceMobileMode || window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  }

  function syncMobileFilterDropdown() {
    if (!filterBarEl || !els.mobileFilterToggle) return;
    filterBarEl.classList.toggle("mobile-filters-open", mobileFiltersOpen);
    els.mobileFilterToggle.setAttribute("aria-expanded", mobileFiltersOpen ? "true" : "false");
    els.mobileFilterToggle.textContent = mobileFiltersOpen ? "Filters ▴" : "Filters ▾";
  }

  function getTodayISO() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function toISODate(dateObj) {
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const dd = String(dateObj.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function getMondayISO(dateString) {
    const base = new Date(`${dateString}T00:00:00`);
    const weekday = base.getDay();
    const diffToMonday = (weekday + 6) % 7;
    base.setDate(base.getDate() - diffToMonday);
    return toISODate(base);
  }

  function shiftWeekBy(weeks) {
    const monday = new Date(`${getMondayISO(els.date.value || getTodayISO())}T00:00:00`);
    monday.setDate(monday.getDate() + (weeks * 7));
    els.date.value = toISODate(monday);
    loadAndRender();
  }

  function formatSlotLabel(index) {
    const totalMinutes = DAY_START_MIN + (index * SLOT_MINUTES);
    const hour24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
  }

  function formatTimeRange(startISO, endISO) {
    const start = new Date(startISO);
    const end = new Date(endISO);

    function timeParts(d) {
      const h24 = d.getHours();
      const m = d.getMinutes();
      const suffix = h24 >= 12 ? "PM" : "AM";
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      const clock = m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, "0")}`;
      return { clock, suffix };
    }

    const s = timeParts(start);
    const e = timeParts(end);

    if (s.suffix === e.suffix) {
      return `${s.clock}\u00A0-\u00A0${e.clock}\u00A0${e.suffix}`;
    }
    return `${s.clock}\u00A0${s.suffix}\u00A0-\u00A0${e.clock}\u00A0${e.suffix}`;
  }

  function formatTimeRangeCompact(startISO, endISO) {
    const start = new Date(startISO);
    const end = new Date(endISO);

    function timeParts(d) {
      const h24 = d.getHours();
      const m = d.getMinutes();
      const suffix = h24 >= 12 ? "PM" : "AM";
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      const clock = m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, "0")}`;
      return { clock, suffix };
    }

    const s = timeParts(start);
    const e = timeParts(end);
    if (s.suffix === e.suffix) {
      return `${s.clock}-${e.clock}${e.suffix}`;
    }
    return `${s.clock}${s.suffix}-${e.clock}${e.suffix}`;
  }

  function formatWeekTitle(weekStartISO) {
    const start = new Date(`${weekStartISO}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);

    const startText = start.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const endText = end.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `Adult Classes Week View (${startText} - ${endText})`;
  }

  function setDayHeaders(weekStartISO) {
    const start = new Date(`${weekStartISO}T00:00:00`);
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const label = d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "numeric",
        day: "numeric",
      });
      els.dayHeads[i].textContent = label;
    }
  }

  function buildGridSkeleton() {
    const trackHeight = SLOT_COUNT * SLOT_HEIGHT;
    const firstHead = els.weekGrid.querySelector(".week-head");
    const headHeight = firstHead ? firstHead.getBoundingClientRect().height : 32;
    els.weekGrid.style.setProperty("--head-height", `${headHeight}px`);

    els.timeTrack.innerHTML = "";
    els.timeTrack.style.height = `${trackHeight}px`;
    for (let i = 0; i < 7; i += 1) {
      els.dayTracks[i].innerHTML = "";
      els.dayTracks[i].style.height = `${trackHeight}px`;
    }
    els.eventsOverlay.innerHTML = "";
    els.eventsOverlay.style.height = `${trackHeight}px`;

    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const timeSlot = document.createElement("div");
      timeSlot.className = "time-slot";
      const label = document.createElement("span");
      label.className = "time-label";
      label.textContent = i % 2 === 0 ? formatSlotLabel(i) : "";
      timeSlot.appendChild(label);
      els.timeTrack.appendChild(timeSlot);

      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const daySlot = document.createElement("div");
        daySlot.className = "day-slot";
        els.dayTracks[dayIndex].appendChild(daySlot);
      }
    }
  }

  function getDayIndex(startISO, weekStartISO) {
    const start = new Date(startISO);
    const weekStart = new Date(`${weekStartISO}T00:00:00`);
    const eventDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const diffMs = eventDay.getTime() - weekStart.getTime();
    return Math.floor(diffMs / (24 * 60 * 60 * 1000));
  }

  function getMinuteOrder(isoString) {
    const d = new Date(isoString);
    let totalMinutes = (d.getHours() * 60) + d.getMinutes();
    if (totalMinutes < DAY_START_MIN) totalMinutes += (24 * 60);
    return totalMinutes;
  }

  function normalizeAdultEvent(raw, weekStartISO) {
    const sourceTitle = String(raw.title || "").trim();
    const lower = sourceTitle.toLowerCase();
    const hasAdult = lower.includes("adult");
    const isSundaySkills = /sunday[\s-]*skills/.test(lower);
    const isFreeTrialClass = /free[\s-]*trial[\s-]*class/.test(lower);
    const isAdultClass = hasAdult && lower.includes("class");
    const isAdultCampOrClinic = hasAdult && (lower.includes("camp") || lower.includes("clinic"));
    const isKnownAdultProgram = ADULT_CLINIC_TERMS.some((term) => lower.includes(term));
    const include = isSundaySkills || isFreeTrialClass || isAdultClass || isAdultCampOrClinic || isKnownAdultProgram;
    if (!include) return null;
    const filterCategories = new Set();

    let title = sourceTitle.replace(/\badult\b/gi, "").replace(/\s{2,}/g, " ").trim();
    if (isSundaySkills) {
      title = "Sunday Skills";
      filterCategories.add("sundaySkills");
    }
    if (isFreeTrialClass) {
      title = "Free Trial Class";
      filterCategories.add("freeTrial");
    }
    title = title.replace(/\bclass\b/gi, "").replace(/\s{2,}/g, " ").trim();

    if (isAdultClass && !isSundaySkills && !isFreeTrialClass) {
      const levelPattern = /level\s*([iv0-9]+(?:\s*\/\s*[iv0-9]+)*)/gi;
      let hasLevelMatch = false;
      let match;
      while ((match = levelPattern.exec(lower)) !== null) {
        const parts = String(match[1] || "")
          .split("/")
          .map((part) => part.trim().toUpperCase())
          .filter(Boolean);
        for (const part of parts) {
          hasLevelMatch = true;
          if (part === "I" || part === "1") filterCategories.add("levelI");
          if (part === "II" || part === "2") filterCategories.add("levelII");
          if (part === "III" || part === "3") filterCategories.add("levelIII");
          if (part === "IV" || part === "4") filterCategories.add("levelIV");
        }
      }
      if (/\bintro\b/.test(lower)) {
        filterCategories.add("intro");
      }
      if (!hasLevelMatch && !filterCategories.has("intro")) {
        filterCategories.add("popUpClinics");
      }
    }

    if (isAdultCampOrClinic || isKnownAdultProgram) {
      filterCategories.add("popUpClinics");
    }
    if (!filterCategories.size) {
      filterCategories.add("popUpClinics");
    }

    const start = raw.start_time || raw.start;
    const end = raw.end_time || raw.end;
    if (!start || !end) return null;

    const dayIndex = raw.week_day_index != null
      ? Number(raw.week_day_index)
      : getDayIndex(start, weekStartISO);
    if (dayIndex < 0 || dayIndex > 6) return null;

    const bookingUrl = raw.booking_url || raw.bookingUrl;
    if (!bookingUrl || bookingUrl === "#") return null;

    return {
      id: String(raw.id || `${title}-${start}`),
      title,
      start,
      end,
      bookingUrl: String(bookingUrl),
      dayIndex,
      filterCategories: Array.from(filterCategories),
    };
  }

  function getFilteredEvents(rawEvents, weekStartISO) {
    return rawEvents
      .map((raw) => normalizeAdultEvent(raw, weekStartISO))
      .filter(Boolean)
      .filter((event) => {
        const categories = Array.isArray(event.filterCategories) ? event.filterCategories : [];
        return categories.some((category) => !!filterState[category]);
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function assignDayLanes(events) {
    const byDay = Array.from({ length: 7 }, () => []);
    for (const event of events) {
      byDay[event.dayIndex].push(event);
    }

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayEvents = byDay[dayIndex].sort((a, b) => new Date(a.start) - new Date(b.start));
      let groupId = -1;
      let groupMaxEnd = Number.NEGATIVE_INFINITY;
      const groupSizes = new Map();
      const laneEndTimes = [];

      for (const event of dayEvents) {
        const startMin = getMinuteOrder(event.start);
        const endMin = getMinuteOrder(event.end);

        if (startMin >= groupMaxEnd) {
          groupId += 1;
          groupMaxEnd = endMin;
          laneEndTimes.length = 0;
        } else {
          groupMaxEnd = Math.max(groupMaxEnd, endMin);
        }

        let lane = laneEndTimes.findIndex((laneEnd) => laneEnd <= startMin);
        if (lane === -1) {
          lane = laneEndTimes.length;
          laneEndTimes.push(endMin);
        } else {
          laneEndTimes[lane] = endMin;
        }

        event.lane = lane;
        event.groupId = groupId;
        const currentSize = groupSizes.get(groupId) || 1;
        groupSizes.set(groupId, Math.max(currentSize, laneEndTimes.length));
      }

      for (const event of dayEvents) {
        event.groupSize = groupSizes.get(event.groupId) || 1;
      }
    }

    return events;
  }

  function fitCardText(card) {
    const title = card.querySelector(".week-event-title");
    const time = card.querySelector(".week-event-time");
    if (!title || !time) return;

    const cardTiers = ["", "week-event-fit-sm", "week-event-fit-xs", "week-event-fit-xxs", "week-event-fit-micro"];
    const titleTiers = ["", "week-event-title-fit-sm", "week-event-title-fit-xs", "week-event-title-fit-xxs", "week-event-title-fit-micro"];
    const timeTiers = ["", "week-event-time-fit-sm", "week-event-time-fit-xs", "week-event-time-fit-xxs", "week-event-time-fit-micro"];

    let cardIdx = 0;
    let titleIdx = 0;
    let timeIdx = 0;

    const removeClasses = (el, classes) => {
      for (const cls of classes) {
        if (cls) el.classList.remove(cls);
      }
    };
    const applyClassAt = (el, classes, idx) => {
      removeClasses(el, classes);
      const cls = classes[idx];
      if (cls) el.classList.add(cls);
    };
    const isWidthOverflowing = (el) => el.scrollWidth > el.clientWidth + 0.5;
    const isHeightOverflowing = (el) => el.scrollHeight > el.clientHeight + 0.5;

    for (let i = 0; i < 24; i += 1) {
      applyClassAt(card, cardTiers, cardIdx);
      applyClassAt(title, titleTiers, titleIdx);
      applyClassAt(time, timeTiers, timeIdx);

      const titleOverflow = isWidthOverflowing(title);
      const timeOverflow = isWidthOverflowing(time);
      const cardOverflow = isHeightOverflowing(card);
      if (!titleOverflow && !timeOverflow && !cardOverflow) break;

      let changed = false;
      if (titleOverflow && titleIdx < titleTiers.length - 1) {
        titleIdx += 1;
        changed = true;
      }
      if (timeOverflow && timeIdx < timeTiers.length - 1) {
        timeIdx += 1;
        changed = true;
      }
      if (!changed && cardOverflow && cardIdx < cardTiers.length - 1) {
        cardIdx += 1;
        changed = true;
      }
      if (!changed) {
        if (titleIdx < titleTiers.length - 1) {
          titleIdx += 1;
          changed = true;
        } else if (timeIdx < timeTiers.length - 1) {
          timeIdx += 1;
          changed = true;
        } else if (cardIdx < cardTiers.length - 1) {
          cardIdx += 1;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  function fitAllVisibleCards() {
    const cards = els.eventsOverlay.querySelectorAll(".week-event");
    cards.forEach((card) => fitCardText(card));
  }

  function applyDayColumnLayout(events) {
    const hasEvents = Array.from({ length: 7 }, () => false);
    const hasTripleOverlap = Array.from({ length: 7 }, () => false);
    for (const event of events) {
      if (event.dayIndex >= 0 && event.dayIndex < 7) {
        hasEvents[event.dayIndex] = true;
        if ((Number(event.groupSize) || 1) >= 3) {
          hasTripleOverlap[event.dayIndex] = true;
        }
      }
    }

    const weights = hasEvents.map((active, idx) => {
      if (!active) return 0.5;
      return hasTripleOverlap[idx] ? 1.5 : 1;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    const widthsPct = weights.map((value) => (value / totalWeight) * 100);
    const leftsPct = [];
    let running = 0;
    for (const width of widthsPct) {
      leftsPct.push(running);
      running += width;
    }

    const timeColPx = isMobileLayout() ? 44 : 92;
    els.weekGrid.style.setProperty("--time-col-width", `${timeColPx}px`);
    els.weekGrid.style.gridTemplateColumns = `${timeColPx}px ${weights.map((w) => `${w}fr`).join(" ")}`;
    return { widthsPct, leftsPct };
  }

  function renderMobileWeek(events, weekStartISO) {
    if (!els.mobileWeekColumns) return;
    const byDay = Array.from({ length: 7 }, () => []);
    for (const event of events) {
      byDay[event.dayIndex].push(event);
    }
    for (let i = 0; i < 7; i += 1) {
      byDay[i].sort((a, b) => new Date(a.start) - new Date(b.start));
    }

    els.mobileWeekColumns.innerHTML = "";
    for (let i = 0; i < 7; i += 1) {
      const dayDate = new Date(`${weekStartISO}T00:00:00`);
      dayDate.setDate(dayDate.getDate() + i);
      const dayCol = document.createElement("div");
      dayCol.className = "mobile-week-day-col";

      const dayHead = document.createElement("div");
      dayHead.className = "mobile-week-day-head";
      dayHead.textContent = dayDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "numeric",
        day: "numeric",
      });
      dayCol.appendChild(dayHead);

      const dayList = document.createElement("div");
      dayList.className = "mobile-week-day-list";
      const dayEvents = byDay[i];
      if (!dayEvents.length) {
        const empty = document.createElement("div");
        empty.className = "mobile-week-day-empty";
        empty.textContent = "\u2014";
        dayList.appendChild(empty);
      } else {
        for (const event of dayEvents) {
          const card = document.createElement("a");
          card.className = "mobile-week-event";
          card.href = event.bookingUrl;
          card.target = "_blank";
          card.rel = "noopener noreferrer";

          const title = document.createElement("span");
          title.className = "mobile-week-event-title";
          title.textContent = event.title;

          const time = document.createElement("span");
          time.className = "mobile-week-event-time";
          time.textContent = formatTimeRangeCompact(event.start, event.end);

          card.appendChild(title);
          card.appendChild(time);
          dayList.appendChild(card);
        }
      }
      dayCol.appendChild(dayList);
      els.mobileWeekColumns.appendChild(dayCol);
    }
  }

  function renderEvents(rawEvents, weekStartISO) {
    currentWeek.rawEvents = Array.isArray(rawEvents) ? rawEvents : [];
    currentWeek.weekStartISO = weekStartISO;
    buildGridSkeleton();
    setDayHeaders(weekStartISO);
    if (els.weekViewTitle) {
      els.weekViewTitle.textContent = formatWeekTitle(weekStartISO);
    }

    const events = getFilteredEvents(rawEvents, weekStartISO);
    assignDayLanes(events);
    renderMobileWeek(events, weekStartISO);
    const dayLayout = applyDayColumnLayout(events);

    for (const event of events) {
      const startMin = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, getMinuteOrder(event.start)));
      const endMin = Math.max(startMin + SLOT_MINUTES, Math.min(DAY_END_MIN, getMinuteOrder(event.end)));
      if (endMin <= DAY_START_MIN || startMin >= DAY_END_MIN) continue;

      const startOffset = (startMin - DAY_START_MIN) / SLOT_MINUTES;
      const endOffset = (endMin - DAY_START_MIN) / SLOT_MINUTES;
      const top = (startOffset * SLOT_HEIGHT) + 2;
      const height = Math.max(22, ((endOffset - startOffset) * SLOT_HEIGHT) - 4);

      const lane = event.lane || 0;
      const groupSize = Math.max(1, Number(event.groupSize) || 1);
      const dayWidthPct = dayLayout.widthsPct[event.dayIndex] || (100 / 7);
      const dayLeftPct = dayLayout.leftsPct[event.dayIndex] || 0;
      const laneWidthPct = dayWidthPct / groupSize;
      const leftPct = dayLeftPct + (lane * laneWidthPct);
      const widthPct = laneWidthPct;
      const insetPx = groupSize > 1 ? 3 : 5;

      const card = document.createElement("a");
      card.className = "week-event";
      if (String(event.title || "").toLowerCase().includes("beachmode fitness")) {
        card.classList.add("week-event-beachmode");
      }
      card.href = event.bookingUrl;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.style.left = `calc(${leftPct}% + ${insetPx}px)`;
      card.style.width = `calc(${widthPct}% - ${insetPx * 2}px)`;
      card.style.top = `${top}px`;
      card.style.height = `${height}px`;

      const title = document.createElement("span");
      title.className = "week-event-title";
      title.textContent = event.title;

      const time = document.createElement("span");
      time.className = "week-event-time";
      time.textContent = formatTimeRange(event.start, event.end);

      card.appendChild(title);
      card.appendChild(time);
      els.eventsOverlay.appendChild(card);
      fitCardText(card);
    }

    requestAnimationFrame(() => {
      fitAllVisibleCards();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          fitAllVisibleCards();
          schedulePostEmbedHeight();
        });
      }
      schedulePostEmbedHeight();
    });
  }

  function fetchDayEvents(selectedDate) {
    const url = `${LIVE_FEED_BASE}?date=${encodeURIComponent(selectedDate)}`;
    return fetch(url, { cache: "no-store" }).then((response) => {
      if (!response.ok) {
        return response.text().then((body) => {
          throw new Error(`Feed request failed (${response.status}): ${body.slice(0, 120)}`);
        });
      }
      return response.json();
    }).then((payload) => {
      if (!Array.isArray(payload)) {
        throw new Error("Daily feed response must be a JSON array.");
      }
      return payload;
    });
  }

  function fetchWeekEvents(mondayISO) {
    const monday = new Date(`${mondayISO}T00:00:00`);
    const days = Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + idx);
      return { idx, iso: toISODate(d) };
    });

    return Promise.allSettled(days.map((day) => {
      return fetchDayEvents(day.iso).then((rows) => {
        return rows.map((row) => ({
          ...row,
          week_day_index: day.idx,
        }));
      });
    })).then((results) => {
      const weeklyRows = [];
      results.forEach((result, idx) => {
        if (result.status === "fulfilled") {
          weeklyRows.push(result.value);
          return;
        }
        console.error(`Weekly feed request failed for ${days[idx].iso}`, result.reason);
      });
      return {
      week_start: mondayISO,
      events: weeklyRows.flat(),
      };
    });
  }

  function loadAndRender() {
    const selectedDate = els.date.value || getTodayISO();
    const mondayISO = getMondayISO(selectedDate);
    return fetchWeekEvents(mondayISO)
      .then((payload) => {
        renderEvents(payload.events, payload.week_start);
      })
      .catch((error) => {
        renderEvents([], mondayISO);
        if (error) console.error(error);
      });
  }

  function init() {
    setupFilterControls();
    syncMobileFilterDropdown();
    els.date.value = getTodayISO();
    els.date.addEventListener("change", function () { loadAndRender(); });
    els.prevWeek.addEventListener("click", function () { shiftWeekBy(-1); });
    els.nextWeek.addEventListener("click", function () { shiftWeekBy(1); });
    els.todayWeek.addEventListener("click", function () {
      els.date.value = getTodayISO();
      loadAndRender();
    });
    if (els.mobileFilterToggle) {
      els.mobileFilterToggle.addEventListener("click", function () {
        mobileFiltersOpen = !mobileFiltersOpen;
        syncMobileFilterDropdown();
      });
    }
    lastIsMobile = isMobileLayout();
    window.addEventListener("resize", function () {
      const currentIsMobile = isMobileLayout();
      if (currentIsMobile !== lastIsMobile) {
        lastIsMobile = currentIsMobile;
      }
      syncMobileFilterDropdown();
      fitAllVisibleCards();
      if (currentIsMobile && currentWeek.weekStartISO) {
        renderEvents(currentWeek.rawEvents, currentWeek.weekStartISO);
      }
      schedulePostEmbedHeight();
    });
    const observer = new MutationObserver(schedulePostEmbedHeight);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    schedulePostEmbedHeight();
    loadAndRender();
  }

  init();
})();

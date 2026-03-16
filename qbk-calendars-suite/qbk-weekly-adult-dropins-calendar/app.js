(() => {
  const params = new URLSearchParams(window.location.search);
  const embedMode = params.get("embed") === "1" || document.body.dataset.embed === "1";
  const forceMobileMode = params.get("mobile") === "1" || document.body.dataset.forceMobile === "1";
  const hourlyParam = params.get("hourly");
  const forceHourlyMode = hourlyParam === "1";
  const forceHalfHourMode = hourlyParam === "0";
  if (embedMode) {
    document.body.classList.add("embed-mode");
  }
  if (forceMobileMode) {
    document.body.classList.add("force-mobile-mode");
  }

  const LIVE_FEED_BASE = "/api/events";
  const MOBILE_LAYOUT_QUERY = "(max-width: 900px), (max-device-width: 900px), (hover: none) and (pointer: coarse)";
  const DAY_START_MIN = 6 * 60;
  let hourlyCompactMode = false;
  let SLOT_MINUTES = 30;
  let SLOT_HEIGHT = 28;
  let SLOT_COUNT = 38; // 6:00 AM -> 1:00 AM
  let DAY_END_MIN = DAY_START_MIN + (SLOT_COUNT * SLOT_MINUTES);

  const DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const FILTER_KEYS = ["drop2sKing", "drop2sMatch", "drop4s"];
  const filterState = Object.fromEntries(FILTER_KEYS.map((key) => [key, true]));
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
    timeTrack: document.getElementById("time-track"),
    dayTracks: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-track-${idx}`)),
    dayHeads: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-head-${idx}`)),
    eventsOverlay: document.getElementById("events-overlay"),
    mobileWeekColumns: document.getElementById("mobile-week-columns"),
  };
  const filterBarEl = document.querySelector(".filter-bar");
  let lastIsMobile = null;
  let mobileFiltersOpen = false;

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

  function getTodayISO() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function isMobileLayout() {
    return forceMobileMode || window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
  }

  function applyTimeScaleMode() {
    const nextHourlyCompactMode = forceHourlyMode || (!forceHalfHourMode && !isMobileLayout());
    if (hourlyCompactMode === nextHourlyCompactMode) {
      return false;
    }
    hourlyCompactMode = nextHourlyCompactMode;
    SLOT_MINUTES = hourlyCompactMode ? 60 : 30;
    SLOT_HEIGHT = hourlyCompactMode ? 22 : 28;
    SLOT_COUNT = hourlyCompactMode ? 19 : 38;
    DAY_END_MIN = DAY_START_MIN + (SLOT_COUNT * SLOT_MINUTES);
    return true;
  }

  function syncMobileFilterDropdown() {
    if (!filterBarEl || !els.mobileFilterToggle) return;
    filterBarEl.classList.toggle("mobile-filters-open", mobileFiltersOpen);
    els.mobileFilterToggle.setAttribute("aria-expanded", mobileFiltersOpen ? "true" : "false");
    els.mobileFilterToggle.textContent = mobileFiltersOpen ? "Filters ▴" : "Filters ▾";
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
    if (minutes === 0) return `${hour12} ${suffix}`;
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
    return `Adult Drop-Ins Week View (${startText} - ${endText})`;
  }

  function toIntOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }

  function getCapacityText(raw) {
    const capacity = toIntOrNull(raw.register_capacity ?? raw.registerCapacity);
    let registered = toIntOrNull(raw.registered_count ?? raw.registeredCount);
    const remaining = toIntOrNull(
      raw.remaining_registration_slots ?? raw.remainingRegistrationSlots,
    );

    if ((registered === null || registered < 0) && capacity !== null && capacity >= 0 && remaining !== null) {
      registered = Math.max(0, capacity - remaining);
    }
    if (capacity === null || capacity <= 0) return "";
    if (registered === null || registered < 0) return "";
    return `${registered}/${capacity} spots`;
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
    document.documentElement.style.setProperty("--visible-slot-count", String(SLOT_COUNT));
    document.documentElement.style.setProperty("--slot-height", `${SLOT_HEIGHT}px`);
    document.documentElement.style.setProperty("--visible-track-height", `${trackHeight}px`);
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
      label.textContent = (hourlyCompactMode || i % 2 === 0) ? formatSlotLabel(i) : "";
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
    const isTeenDropIn = /teen[\s-]*drop[\s-]*in/.test(lower) || lower.includes("teen");
    if (isTeenDropIn) return null;

    const is4sDropIn = /\b4s\b/.test(lower) && /drop[\s-]*in/.test(lower);
    const is2s = /\b2s\b/.test(lower);
    const isAdvanced = /\badvanced\b/.test(lower);
    const isIntermediate = /\bintermediate\b/.test(lower);
    const isMatchPlay = /match[\s-]*play/.test(lower);
    const isKingOfCourt = /king[\s-]*of[\s-]*the[\s-]*court/.test(lower);

    let title = null;
    let filterCategory = null;
    if (is4sDropIn) {
      title = "4s Drop In";
      filterCategory = "drop4s";
    } else if (is2s && isAdvanced && isKingOfCourt) {
      title = "Advanced 2s - King of the Court";
      filterCategory = "drop2sKing";
    } else if (is2s && isIntermediate && isKingOfCourt) {
      title = "Intermediate 2s - King of the Court";
      filterCategory = "drop2sKing";
    } else if (is2s && isAdvanced && isMatchPlay) {
      title = "Advanced 2s - Match Play";
      filterCategory = "drop2sMatch";
    } else if (is2s && isIntermediate && isMatchPlay) {
      title = "Intermediate 2s - Match Play";
      filterCategory = "drop2sMatch";
    } else {
      return null;
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
      filterCategory,
      capacityText: getCapacityText(raw),
    };
  }

  function getFilteredEvents(rawEvents, weekStartISO) {
    return rawEvents
      .map((raw) => normalizeAdultEvent(raw, weekStartISO))
      .filter(Boolean)
      .filter((event) => !!filterState[event.filterCategory])
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
    const capacity = card.querySelector(".week-event-capacity");
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
      if (capacity) {
        applyClassAt(capacity, timeTiers, timeIdx);
      }

      const titleOverflow = isWidthOverflowing(title);
      const timeOverflow = isWidthOverflowing(time);
      const capacityOverflow = capacity ? isWidthOverflowing(capacity) : false;
      const cardOverflow = isHeightOverflowing(card);
      if (!titleOverflow && !timeOverflow && !capacityOverflow && !cardOverflow) break;

      let changed = false;
      if (titleOverflow && titleIdx < titleTiers.length - 1) {
        titleIdx += 1;
        changed = true;
      }
      if (timeOverflow && timeIdx < timeTiers.length - 1) {
        timeIdx += 1;
        changed = true;
      }
      if (capacityOverflow && timeIdx < timeTiers.length - 1) {
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

    els.weekGrid.style.gridTemplateColumns = `92px ${weights.map((w) => `${w}fr`).join(" ")}`;
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
          if (event.capacityText) {
            const capacity = document.createElement("span");
            capacity.className = "mobile-week-event-capacity";
            capacity.textContent = event.capacityText;
            card.appendChild(capacity);
          }
          dayList.appendChild(card);
        }
      }
      dayCol.appendChild(dayList);
      els.mobileWeekColumns.appendChild(dayCol);
    }
  }

  function renderEvents(rawEvents, weekStartISO) {
    applyTimeScaleMode();
    currentWeek.rawEvents = Array.isArray(rawEvents) ? rawEvents : [];
    currentWeek.weekStartISO = weekStartISO;
    buildGridSkeleton();
    setDayHeaders(weekStartISO);
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
      let displayTitle = event.title;
      if (groupSize >= 2) {
        displayTitle = displayTitle
          .replace(/\bAdvanced\b/g, "Adv.")
          .replace(/\bIntermediate\b/g, "Int.");
      }
      title.textContent = displayTitle;

      const time = document.createElement("span");
      time.className = "week-event-time";
      time.textContent = formatTimeRange(event.start, event.end);

      card.appendChild(title);
      card.appendChild(time);
      if (event.capacityText) {
        const capacity = document.createElement("span");
        capacity.className = "week-event-capacity";
        capacity.textContent = event.capacityText;
        card.appendChild(capacity);
      }
      els.eventsOverlay.appendChild(card);
      fitCardText(card);
    }

    requestAnimationFrame(() => {
      fitAllVisibleCards();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          fitAllVisibleCards();
        });
      }
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

    return Promise.all(days.map((day) => {
      return fetchDayEvents(day.iso).then((rows) => {
        return rows.map((row) => ({
          ...row,
          week_day_index: day.idx,
        }));
      });
    })).then((weeklyRows) => ({
      week_start: mondayISO,
      events: weeklyRows.flat(),
    }));
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
    applyTimeScaleMode();
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
      const timeScaleChanged = applyTimeScaleMode();
      if (currentIsMobile !== lastIsMobile || timeScaleChanged) {
        lastIsMobile = currentIsMobile;
        syncMobileFilterDropdown();
        if (currentWeek.weekStartISO) {
          renderEvents(currentWeek.rawEvents, currentWeek.weekStartISO);
          return;
        }
      }
      syncMobileFilterDropdown();
      fitAllVisibleCards();
    });
    loadAndRender();
  }

  init();
})();

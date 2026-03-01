(() => {
  const LIVE_FEED_BASE = "/api/events";
  const SLOT_MINUTES = 30;
  const SLOT_HEIGHT = 28;
  const DAY_START_MIN = 6 * 60;
  const SLOT_COUNT = 38; // 6:00 AM -> 1:00 AM
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

  const els = {
    date: document.getElementById("week-date"),
    prevWeek: document.getElementById("prev-week"),
    nextWeek: document.getElementById("next-week"),
    todayWeek: document.getElementById("today-week"),
    weekGrid: document.getElementById("week-grid"),
    weekViewTitle: document.getElementById("week-view-title"),
    timeTrack: document.getElementById("time-track"),
    dayTracks: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-track-${idx}`)),
    dayHeads: Array.from({ length: 7 }, (_, idx) => document.getElementById(`day-head-${idx}`)),
    eventsOverlay: document.getElementById("events-overlay"),
  };

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
    const isKnownAdultProgram = (
      lower.includes("beachmode")
      || lower.includes("sandy hands")
      || lower.includes("beach bombers")
      || lower.includes("beach bomberts")
    );
    const include = isSundaySkills || isFreeTrialClass || isAdultClass || isAdultCampOrClinic || isKnownAdultProgram;
    if (!include) return null;

    let title = sourceTitle.replace(/\badult\b/gi, "").replace(/\s{2,}/g, " ").trim();
    if (isSundaySkills) {
      title = "Sunday Skills";
    }
    if (isFreeTrialClass) {
      title = "Free Trial Class";
    }
    title = title.replace(/\bclass\b/gi, "").replace(/\s{2,}/g, " ").trim();

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
    };
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

    els.weekGrid.style.gridTemplateColumns = `92px ${weights.map((w) => `${w}fr`).join(" ")}`;
    return { widthsPct, leftsPct };
  }

  function renderEvents(rawEvents, weekStartISO) {
    buildGridSkeleton();
    setDayHeaders(weekStartISO);
    els.weekViewTitle.textContent = formatWeekTitle(weekStartISO);

    const events = rawEvents
      .map((raw) => normalizeAdultEvent(raw, weekStartISO))
      .filter(Boolean)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    assignDayLanes(events);
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
    els.date.value = getTodayISO();
    els.date.addEventListener("change", function () { loadAndRender(); });
    els.prevWeek.addEventListener("click", function () { shiftWeekBy(-1); });
    els.nextWeek.addEventListener("click", function () { shiftWeekBy(1); });
    els.todayWeek.addEventListener("click", function () {
      els.date.value = getTodayISO();
      loadAndRender();
    });
    window.addEventListener("resize", function () {
      fitAllVisibleCards();
    });
    loadAndRender();
  }

  init();
})();

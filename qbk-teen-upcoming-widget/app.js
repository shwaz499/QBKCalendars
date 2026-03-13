(() => {
  const API_URL = "/api/teen-upcoming?limit=5";

  const els = {
    status: document.getElementById("status"),
    list: document.getElementById("event-list"),
  };

  function formatDateLabel(isoString) {
    const value = new Date(isoString);
    return value.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function formatClockTime(dateObj, withSuffix = true) {
    const hour24 = dateObj.getHours();
    const minute = dateObj.getMinutes();
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const minuteText = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
    return withSuffix ? `${hour12}${minuteText} ${suffix}` : `${hour12}${minuteText}`;
  }

  function formatTimeRange(startISO, endISO) {
    const start = new Date(startISO);
    const end = new Date(endISO);
    const startSuffix = start.getHours() >= 12 ? "PM" : "AM";
    const endSuffix = end.getHours() >= 12 ? "PM" : "AM";
    if (startSuffix === endSuffix) {
      return `${formatClockTime(start, false)} - ${formatClockTime(end, true)}`;
    }
    return `${formatClockTime(start, true)} - ${formatClockTime(end, true)}`;
  }

  function renderEmpty(message) {
    els.status.textContent = "";
    els.list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = message;
    els.list.appendChild(empty);
  }

  function renderEvents(events) {
    els.list.innerHTML = "";
    if (!events.length) {
      renderEmpty("No upcoming teen drop-ins are available right now.");
      return;
    }

    els.status.textContent = "";
    for (const event of events) {
      const card = document.createElement("a");
      card.className = "event-item";
      card.href = event.booking_url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      const title = document.createElement("div");
      title.className = "event-title";
      title.textContent = event.title;

      const date = document.createElement("div");
      date.className = "event-date";
      date.textContent = formatDateLabel(event.start_time);

      const time = document.createElement("div");
      time.className = "event-time";
      time.textContent = formatTimeRange(event.start_time, event.end_time);

      const meta = document.createElement("div");
      meta.className = "event-meta";
      meta.appendChild(date);
      meta.appendChild(time);

      card.appendChild(title);
      card.appendChild(meta);

      els.list.appendChild(card);
    }
  }

  function loadUpcomingEvents() {
    els.status.textContent = "Loading upcoming sessions...";
    return fetch(API_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          return response.text().then((body) => {
            throw new Error(`Request failed (${response.status}): ${body.slice(0, 120)}`);
          });
        }
        return response.json();
      })
      .then((payload) => {
        if (!Array.isArray(payload)) {
          throw new Error("Upcoming teen events feed must be a JSON array.");
        }
        renderEvents(payload);
      })
      .catch((error) => {
        console.error(error);
        renderEmpty("Could not load upcoming teen drop-ins right now.");
      });
  }

  loadUpcomingEvents();
})();

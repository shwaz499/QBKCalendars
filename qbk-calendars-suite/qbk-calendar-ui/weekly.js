(() => {
  const query = window.matchMedia("(max-width: 900px), (hover: none) and (pointer: coarse)");
  const date = document.querySelector(".calendar-date");
  const nav = document.querySelector(".date-nav");
  const prev = document.getElementById("prev-week");
  const toggle = document.getElementById("mobile-filter-toggle");
  const filterBar = document.querySelector(".filter-bar");
  const range = document.getElementById("week-view-title");
  const rangeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const params = new URLSearchParams(location.search);
  const forceMobile = document.body.dataset.forceMobile === "1" || params.get("mobile") === "1";
  let compact = null;
  let open = false;

  function syncFilterLabel() {
    if (!toggle) return;
    const count = filterBar.querySelectorAll('[data-filter-key][aria-pressed="true"]').length;
    toggle.textContent = `Filters (${count}) ${open ? "\u25B4" : "\u25BE"}`;
  }

  function setOpen(next) {
    open = compact && next;
    if (!toggle) return;
    filterBar.classList.toggle("mobile-filters-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    syncFilterLabel();
  }

  function isCompact() {
    return forceMobile || query.matches;
  }

  function syncLayout() {
    const next = isCompact();
    if (compact === next) return;
    compact = next;
    document.body.classList.toggle("weekly-compact", compact);
    if (filterBar) {
      if (compact) nav.after(filterBar);
      else nav.before(filterBar);
    }
    setOpen(false);
  }

  window.qbkWeeklyCalendar = {
    isCompact,
    showWeek(mondayISO) {
      const monday = new Date(`${mondayISO}T00:00:00`);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const label = rangeFormat.formatRange(monday, sunday);
      if (range.textContent !== label) range.textContent = label;
    },
  };

  if (params.get("embed") === "1" || document.body.dataset.embed === "1") {
    document.body.classList.add("embed-mode");
  }
  if (forceMobile) {
    document.body.classList.add("force-mobile-mode");
  }
  prev.before(date);
  syncLayout();
  query.addEventListener("change", syncLayout);
  window.addEventListener("resize", syncLayout);

  if (!toggle) return;
  toggle.addEventListener("click", (event) => {
    setOpen(!open);
    if (open && event.detail === 0) filterBar.querySelector(".filter-chip").focus({ preventScroll: true });
  });
  document.addEventListener("click", (event) => {
    if (open && !toggle.contains(event.target) && !filterBar.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    toggle.focus({ preventScroll: true });
  });
  new MutationObserver(syncFilterLabel).observe(filterBar, {
    attributes: true,
    subtree: true,
    attributeFilter: ["aria-pressed"],
  });
})();

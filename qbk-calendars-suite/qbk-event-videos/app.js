const clips = (session, rows) => rows.map(([time, file]) => ({
  session,
  time,
  file,
  url: `https://pushitreplays.com/assets/videos/clips_overlay/${file}.mp4`,
  poster: `https://pushitreplays.com/assets/images/clips/${file}.jpg`,
}));

const events = {
  "27158": {
    // Daily Calendar classifies the underlying booking as a private event.
    title: "Private Event",
    calendarKind: "private_event",
    date: "Saturday, July 18, 2026",
    time: "12:00–2:00 PM",
    court: "Right Court",
    type: "Private Event",
    sessions: [
      { label: "12:00–1:00 PM", court: "Right Court", clips: clips("12:00–1:00 PM", [["12:59:12 PM", "db820f38ab90002d744c71ecdb3a221c"], ["12:56:25 PM", "ab9309eb6012464bf11b81d0a2290018"]]) },
      { label: "1:00–2:00 PM", court: "Right Court", clips: clips("1:00–2:00 PM", [
        ["1:01:35 PM", "2351c8fce37855a6921e9778af55c9f8"], ["1:05:27 PM", "1f4ae18d362a6da3671a4441543c70da"],
        ["1:13:31 PM", "444885b392e0cc4297b8a295b1b3bd20"], ["1:15:40 PM", "c77fe2e0d5a04ee64c8db31e74c7f694"],
        ["1:16:07 PM", "c51639150e1df2d697e78e4c5e623e8a"], ["1:18:04 PM", "5897c045a4ff6cead6b031181d89bb75"],
        ["1:21:54 PM", "27463321905d388cc8cce939192f8ae6"], ["1:23:22 PM", "09b345ee3da350ceee21db596237e907"],
        ["1:42:19 PM", "a6efe29ab6a6d1db9eb614a6d08564db"], ["1:47:00 PM", "e5fbaa3f3406955d40b408e0917a2dc3"],
        ["1:47:22 PM", "6ab5c7a0b60906df549262d97dfb6e8f"], ["1:48:16 PM", "dec077dc20837bca927c901abf172c23"],
        ["1:49:17 PM", "34eb573a6a313462bca4f4251ad03971"], ["1:50:12 PM", "4be25d5a1def9b3a105b7eb880f2cffe"],
        ["1:54:37 PM", "2414cd8d516583aeddb6ea813390cd92"], ["1:56:36 PM", "4a97375c698a0cd3593e87e041b73322"],
      ]) },
    ],
  },
  "27294": {
    // The Daily Calendar exposes this booking as "Private Rental"; never surface the raw customer name here.
    title: "Private Rental",
    calendarKind: "rental",
    date: "Monday, July 20, 2026",
    time: "10:00–11:00 PM",
    court: "Left Court",
    type: "Rental",
    sessions: [],
  },
};

const params = new URLSearchParams(window.location.search);
const eventId = params.get("eventId") || "27158";
const event = events[eventId] || events["27158"];
const allClips = event.sessions.flatMap((session) => session.clips.map((clip) => ({ ...clip, court: session.court || event.court })));
const courtGroups = Array.from(allClips.reduce((groups, clip) => {
  const court = clip.court || event.court || "Court";
  if (!groups.has(court)) groups.set(court, []);
  groups.get(court).push(clip);
  return groups;
}, new Map()), ([court, clips]) => ({ court, clips }));

// The Daily Calendar supplies the already-sanitized title/category in the link.
// Keep the fallback demo data, but always prefer those calendar values when present.
const calendarTitle = (params.get("title") || params.get("eventTitle") || "").trim();
const calendarCategory = (params.get("category") || "").trim();
const titleSource = calendarTitle || event.title;
const titleLower = titleSource.toLowerCase();
const categoryLower = calendarCategory.toLowerCase();
const isPrivateEvent = event.calendarKind === "private_event"
  || categoryLower.includes("private event")
  || /private\s+event|staff[\s-]*court|pro[\s-]*court/.test(titleLower);
const isPrivateRental = event.calendarKind === "rental"
  || categoryLower.includes("rental")
  || /private\s+rental|pro[\s-]*drop[\s-]*in/.test(titleLower);
const displayTitle = isPrivateEvent ? "Private Event" : isPrivateRental ? "Private Rental" : titleSource;
event.displayTitle = displayTitle;

document.title = `${displayTitle} · QBK Event Videos`;
document.getElementById("page-title").textContent = displayTitle;
document.getElementById("hero-event-meta").innerHTML = `
  <div class="hero-meta-item"><span class="hero-meta-label">Date</span><strong>${event.date}</strong></div>
  <div class="hero-meta-item"><span class="hero-meta-label">Time</span><strong>${event.time}</strong></div>
  <div class="hero-meta-item"><span class="hero-meta-label">Court</span><strong>${event.court}</strong></div>
`;
document.querySelectorAll("[data-event-link]").forEach((link) => {
  link.classList.toggle("active", link.dataset.eventLink === eventId);
});

const sessionList = document.getElementById("session-list");
const emptyState = document.getElementById("empty-state");
if (!allClips.length) {
  emptyState.hidden = false;
} else {
  sessionList.innerHTML = courtGroups.map((group) => `
    <section class="session" ${courtGroups.length > 1 ? `aria-labelledby="session-${group.court.replace(/[^a-z0-9]/gi, "-")}"` : `aria-label="${group.court} replays"`}>
      ${courtGroups.length > 1 ? `<div class="session-heading"><h3 id="session-${group.court.replace(/[^a-z0-9]/gi, "-")}">${group.court}</h3><span>${group.clips.length} ${group.clips.length === 1 ? "clip" : "clips"}</span></div>` : ""}
      <div class="clip-grid">
        ${group.clips.map((clip) => `
          <a class="clip" href="${clip.url}" data-clip-index="${allClips.indexOf(clip)}" aria-label="Play replay from ${clip.time}">
            <span class="clip-image">
              <img src="${clip.poster}" alt="Replay thumbnail from ${clip.time}" loading="lazy" onerror="this.style.display='none'" />
              <span class="play">▶</span>
            </span>
            <span class="clip-info"><span class="clip-time">${clip.time}</span></span>
          </a>
        `).join("")}
      </div>
    </section>
  `).join("");
}

const modal = document.getElementById("video-modal");
const modalVideo = document.getElementById("modal-video");
const modalTitle = document.getElementById("modal-title");
const modalTime = document.getElementById("modal-time");
const modalPosition = document.getElementById("modal-position");
const modalPrev = document.getElementById("modal-prev");
const modalNext = document.getElementById("modal-next");
let activeClipIndex = 0;

function updateModal() {
  const clip = allClips[activeClipIndex];
  if (!clip) return;
  modalVideo.src = clip.url;
  modalVideo.load();
  modalTitle.textContent = displayTitle;
  modalTime.textContent = `${clip.court} · ${clip.time}`;
  modalPosition.textContent = `${activeClipIndex + 1} / ${allClips.length}`;
  modalPrev.disabled = activeClipIndex === 0;
  modalNext.disabled = activeClipIndex === allClips.length - 1;
  modalVideo.play().catch(() => {});
}

function openModal(index) {
  activeClipIndex = Math.max(0, Math.min(index, allClips.length - 1));
  modal.hidden = false;
  document.body.classList.add("modal-open");
  updateModal();
}

function closeModal() {
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  modalVideo.load();
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

document.addEventListener("click", (event) => {
  const clip = event.target.closest(".clip");
  if (!clip) return;
  event.preventDefault();
  openModal(Number(clip.dataset.clipIndex));
});
document.querySelectorAll("[data-modal-close]").forEach((button) => button.addEventListener("click", closeModal));
modalPrev.addEventListener("click", () => {
  if (activeClipIndex > 0) openModal(activeClipIndex - 1);
});
modalNext.addEventListener("click", () => {
  if (activeClipIndex < allClips.length - 1) openModal(activeClipIndex + 1);
});
document.addEventListener("keydown", (event) => {
  if (modal.hidden) return;
  if (event.key === "Escape") closeModal();
  if (event.key === "ArrowLeft" && activeClipIndex > 0) openModal(activeClipIndex - 1);
  if (event.key === "ArrowRight" && activeClipIndex < allClips.length - 1) openModal(activeClipIndex + 1);
});

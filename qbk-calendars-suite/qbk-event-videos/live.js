const params = new URLSearchParams(window.location.search);
const isPlayoffPage = window.location.pathname.startsWith("/playoff-videos");
const eventId = params.get("eventId") || "";
const requestedClipId = params.get("clipId") || "";
const calendarTitle = (params.get("title") || params.get("eventTitle") || "").trim();
const calendarCategory = (params.get("category") || "").trim();
const emailSource = params.get("source") || "";
const fromReplayEmail = ["league_replay_email", "league_thank_you_email"].includes(emailSource) && params.get("preview") !== "1";
const trackingSession = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const playedClips = new Set();
function trackReplay(action, clipId = "") {
  if (!fromReplayEmail) return;
  fetch("/api/track-replay", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
    body: JSON.stringify({ action, eventId, source: emailSource, seasonId: params.get("seasonId") || "", leagueId: params.get("leagueId") || "", clipId: String(clipId), title: calendarTitle,
      date: params.get("date") || "", court: params.get("court") || "", session: trackingSession }) }).catch(() => {});
}
let currentClips = [];
let currentDisplayTitle = "Event Video";
let activeClipIndex = 0;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
}[char]));

function displayTitleFor(event) {
  const source = String(event.title || calendarTitle || calendarCategory || "Event Video").trim();
  const lower = source.toLowerCase();
  const category = String(event.category || calendarCategory || "").toLowerCase();
  if (event.calendarKind === "private_event" || category.includes("private event") || /private\s+event|staff[\s-]*court|pro[\s-]*court/.test(lower)) return "Private Event";
  if (event.calendarKind === "rental" || category.includes("rental") || /private\s+rental|pro[\s-]*drop[\s-]*in/.test(lower)) return "Private Rental";
  return source || "Event Video";
}

function renderEvent(payload) {
  const event = payload.event || {};
  currentDisplayTitle = displayTitleFor(event);
  currentClips = (payload.clips || []).map((clip) => ({ ...clip, court: clip.court || event.court || "Court" }));
  document.title = `${currentDisplayTitle} · QBK Event Videos`;
  document.getElementById("page-title").textContent = currentDisplayTitle;
  document.getElementById("hero-event-meta").innerHTML = `
    <div class="hero-meta-item"><span class="hero-meta-label">Date</span><strong>${escapeHtml(event.date || "—")}</strong></div>
    <div class="hero-meta-item"><span class="hero-meta-label">Time</span><strong>${escapeHtml(event.time || "—")}</strong></div>
    <div class="hero-meta-item"><span class="hero-meta-label">Court</span><strong>${escapeHtml(event.court || "Court")}</strong></div>`;

  const groups = Array.from(currentClips.reduce((map, clip) => {
    const court = isPlayoffPage ? (clip.match_title || clip.court || "Playoff games") : (clip.court || event.court || "Court");
    if (!map.has(court)) map.set(court, []);
    map.get(court).push(clip);
    return map;
  }, new Map()), ([court, clips]) => ({ court, clips }));
  const sessionList = document.getElementById("session-list");
  const emptyState = document.getElementById("empty-state");
  emptyState.hidden = currentClips.length > 0;
  sessionList.innerHTML = groups.map((group) => `
    <section class="session" ${groups.length > 1 ? `aria-labelledby="court-${group.court.replace(/[^a-z0-9]/gi, "-")}"` : `aria-label="${escapeHtml(group.court)} replays"`}>
      ${groups.length > 1 ? `<div class="session-heading"><h3 id="court-${group.court.replace(/[^a-z0-9]/gi, "-")}">${escapeHtml(group.court)}</h3><span>${group.clips.length} ${group.clips.length === 1 ? "clip" : "clips"}</span></div>` : ""}
      <div class="clip-grid">${group.clips.map((clip) => `
        <a class="clip" href="${escapeHtml(clip.url)}" data-clip-index="${currentClips.indexOf(clip)}" aria-label="Play replay from ${escapeHtml(clip.time)}">
          <span class="clip-image"><img src="${escapeHtml(clip.poster || "")}" alt="Replay thumbnail from ${escapeHtml(clip.time)}" loading="lazy" onerror="this.style.display='none'" /><span class="play">▶</span></span>
          <span class="clip-info"><span class="clip-time">${escapeHtml(clip.time || "—")}</span></span>
        </a>`).join("")}</div>
    </section>`).join("");
}

const modal = document.getElementById("video-modal");
const modalVideo = document.getElementById("modal-video");
const modalTitle = document.getElementById("modal-title");
const modalTime = document.getElementById("modal-time");
const modalPosition = document.getElementById("modal-position");
const modalPrev = document.getElementById("modal-prev");
const modalNext = document.getElementById("modal-next");
const modalDownload = document.getElementById("modal-download");

function updateModal() {
  const clip = currentClips[activeClipIndex];
  if (!clip) return;
  modalVideo.src = clip.url;
  modalVideo.load();
  modalTitle.textContent = currentDisplayTitle;
  modalTime.textContent = `${clip.court} · ${clip.time}`;
  modalPosition.textContent = `${activeClipIndex + 1} / ${currentClips.length}`;
  modalPrev.disabled = activeClipIndex === 0;
  modalNext.disabled = activeClipIndex === currentClips.length - 1;
  modalVideo.play().catch(() => {});
}

async function downloadCurrentClip() {
  const clip = currentClips[activeClipIndex];
  if (!clip) return;

  trackReplay("download_click", clip.id);
  try {
    const response = await fetch(clip.url);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${clip.file || "qbk-replay"}.mp4`;
    document.body.appendChild(anchor);
    anchor.click();
    trackReplay("download_ready", clip.id);
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    trackReplay("download_error", clip.id);
    console.error(error);
  }
}

function openModal(index) {
  if (!currentClips.length) return;
  activeClipIndex = Math.max(0, Math.min(index, currentClips.length - 1));
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
modalPrev.addEventListener("click", () => openModal(activeClipIndex - 1));
modalNext.addEventListener("click", () => openModal(activeClipIndex + 1));
modalDownload.addEventListener("click", downloadCurrentClip);
modalVideo.addEventListener("playing", () => {
  const clip = currentClips[activeClipIndex];
  if (!clip || playedClips.has(String(clip.id))) return;
  playedClips.add(String(clip.id));
  trackReplay("video_play", clip.id);
});
document.addEventListener("keydown", (event) => {
  if (modal.hidden) return;
  if (event.key === "Escape") closeModal();
  if (event.key === "ArrowLeft") openModal(activeClipIndex - 1);
  if (event.key === "ArrowRight") openModal(activeClipIndex + 1);
});

async function loadEvent() {
  if (!isPlayoffPage && !eventId) throw new Error("Missing eventId");
  const query = new URLSearchParams(isPlayoffPage ? {seasonId: params.get("seasonId") || "", leagueId: params.get("leagueId") || "", date: params.get("date") || ""} : { eventId });
  if (calendarTitle) query.set("title", calendarTitle);
  if (calendarCategory) query.set("category", calendarCategory);
  const response = await fetch(`/api/${isPlayoffPage ? "playoff-videos" : "event-videos"}?${query.toString()}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Event videos request failed (${response.status})`);
  renderEvent(await response.json());
  trackReplay("replay_visit", requestedClipId);
  if (requestedClipId) {
    const index = currentClips.findIndex((clip) => String(clip.id) === requestedClipId);
    if (index >= 0) openModal(index);
  }
}

loadEvent().catch((error) => {
  console.error(error);
  renderEvent({ event: { title: calendarTitle || "Event Video", category: calendarCategory, date: "", time: "", court: "Court" }, clips: [] });
});

const rows = document.getElementById("rows"), status = document.getElementById("status");
function cell(row, text) { const td = document.createElement("td"); td.textContent = text; row.appendChild(td); }
async function refresh() {
  status.textContent = "Loading…";
  try {
    const response = await fetch(`/api/replay-analytics?days=${document.getElementById("days").value}`, {cache:"no-store"});
    if (!response.ok) throw new Error("Reporting is temporarily unavailable.");
    const data = await response.json(); rows.replaceChildren();
    for (const match of data.matches) {
      const row = document.createElement("tr");
      cell(row, `${match.title || "Event " + match.event_id} · ${match.date} · ${match.court}`);
      cell(row, match.counts.replay_visit || 0); cell(row, match.sessions);
      for (const action of ["video_play","download_click","download_ready","download_error","signup_click","logo_click","instagram_click"]) cell(row, match.counts[action] || 0);
      rows.appendChild(row);
    }
    status.textContent = data.matches.length ? `Updated ${new Date().toLocaleTimeString()}` : "No tracked activity yet. Counts will appear after readers use new replay emails.";
    if (data.storage === "local_file") status.textContent += " Storage is local and may not survive deployment.";
  } catch(error) { status.textContent = error.message; }
}
document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("days").addEventListener("change", refresh);
refresh();

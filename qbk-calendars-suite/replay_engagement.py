"""Aggregate match replay and season thank-you activity without recipient data."""
from datetime import date
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REPLAY_ORIGIN = "https://qbk-calendars-suite.onrender.com"
REPLAY_TARGETS = {
    "logo": "https://www.qbksports.com/",
    "signup": "https://www.qbksports.com/volleyball-leagues",
    "instagram": "https://www.instagram.com/qbksports/",
}
REPLAY_ACTIONS = {"replay_click", "replay_visit", "video_play", "download_click",
                  "download_ready", "download_error", "logo_click", "signup_click", "instagram_click", "campaign_sent"}


def tracking_group(payload):
    source = str(payload.get("source") or "league_replay_email")
    if source == "league_thank_you_email":
        season = str(payload.get("seasonId") or "")
        league = str(payload.get("leagueId") or "")
        day = str(payload.get("date") or "")
        if not all(value.isascii() and value.isdigit() and len(value) <= 15 for value in (season, league)):
            raise ValueError("A thank-you campaign requires season and league IDs")
        if date.fromisoformat(day).isoformat() != day:
            raise ValueError("Invalid playoff date")
        return "league_thank_you", f"thank-you:{season}:{league}:{day}"
    if source != "league_replay_email":
        raise ValueError("Unknown replay email source")
    event_id = str(payload.get("eventId") or "")
    if not event_id.isascii() or not event_id.isdigit() or len(event_id) > 15:
        raise ValueError("Invalid match event")
    return "league_replay", event_id


def replay_destination(payload):
    target = str(payload.get("target") or "")
    if target == "signup" and payload.get("source") == "league_thank_you_email" and payload.get("directMonday4s") == "1":
        tracking_group(payload)
        return "https://apps.daysmartrecreation.com/dash/x/#/online/qbksports/programs/level/391?facility_ids=1"
    if target in REPLAY_TARGETS:
        return REPLAY_TARGETS[target]
    if target != "replays" or payload.get("source") != "league_thank_you_email":
        raise ValueError("Invalid link")
    tracking_group(payload)
    url = urlsplit(str(payload.get("destination") or ""))
    if (url.scheme != "https" or url.netloc != "qbk-calendars-suite.onrender.com"
            or url.path not in {"/playoff-videos/", "/event-videos/"}):
        raise ValueError("Replay links must use the hosted QBK video page")
    query = dict(parse_qsl(url.query, keep_blank_values=True))
    for key in ("source", "seasonId", "leagueId", "date", "title", "court"):
        query[key] = str(payload.get(key) or "")
    if str(payload.get("preview") or "") == "1":
        query["preview"] = "1"
    else:
        query.pop("preview", None)
    return urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), ""))


def aggregate_replays(events):
    groups = {}
    for event in events:
        key = str(event.get("category") or "")
        kind = "thank_you" if event.get("calendar") == "league_thank_you" else "match_replay"
        row = groups.setdefault((kind, key), {
            "event_id": key if kind == "match_replay" else "",
            "campaign_id": key if kind == "thank_you" else "",
            "email_type": kind, "title": "", "date": "", "court": "", "counts": {}, "sessions": set(),
        })
        for field, source in (("title", "button_label"), ("date", "selected_date"), ("court", "court")):
            if event.get(source):
                row[field] = event[source]
        action = event.get("action")
        row["counts"][action] = row["counts"].get(action, 0) + 1
        if event.get("view_mode"):
            row["sessions"].add(event["view_mode"])
    rows = list(groups.values())
    for row in rows:
        row["sessions"] = len(row["sessions"])
    return sorted(rows, key=lambda row: (row["date"], int(row["event_id"]) if row["event_id"].isdigit() else 0, row["campaign_id"]), reverse=True)

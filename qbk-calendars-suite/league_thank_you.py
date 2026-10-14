"""Build the reusable thank-you email with league-level engagement links.

This module renders HTML only; it does not schedule or send mail.
"""
from html import escape
from pathlib import Path
import re
from urllib.parse import urlencode, urlsplit

from replay_engagement import REPLAY_ORIGIN, REPLAY_TARGETS, replay_destination, tracking_group

TEMPLATE = Path(__file__).with_name("email_templates") / "league-thank-you.html"


def build(data, *, preview=False):
    values = {key: str(value or "").strip() for key, value in data.items()}
    for key in ("season_id", "league_id", "playoff_date_iso", "league_name", "season_name",
                "playoff_date", "champion_name", "champion_photo_url", "next_season_name", "playoff_replays_url"):
        value = values.get(key, "")
        if not value or "{{" in value or re.fullmatch(r"\[.*\]", value):
            raise ValueError(f"A confirmed {key} is required")
    context = {"source": "league_thank_you_email", "seasonId": values["season_id"],
               "leagueId": values["league_id"], "date": values["playoff_date_iso"],
               "title": f'{values["season_name"]} {values["league_name"]} playoffs', "court": "All playoff courts"}
    tracking_group(context)
    photo = urlsplit(values["champion_photo_url"])
    if values["champion_photo_url"] != "cid:champion-photo" and (photo.scheme != "https" or not photo.netloc or photo.username or photo.password):
        raise ValueError("The champion photo must use HTTPS or cid:champion-photo")
    logo = values.setdefault("logo_src", "cid:qbk-logo")
    logo_url = urlsplit(logo)
    if logo != "cid:qbk-logo" and (logo_url.scheme != "https" or not logo_url.netloc or logo_url.username or logo_url.password):
        raise ValueError("The logo must use HTTPS or cid:qbk-logo")
    destination = values["playoff_replays_url"]
    if preview:
        context["preview"] = "1"
    direct_replay = replay_destination({**context, "target": "replays", "destination": destination})

    def link(target):
        if preview:
            return direct_replay if target == "replays" else REPLAY_TARGETS[target]
        query = {**context, "target": target}
        if target == "replays":
            query["destination"] = destination
        return REPLAY_ORIGIN + "/replay-link?" + urlencode(query)

    values.update(logo_link=link("logo"), instagram_link=link("instagram"),
                  signup_url=link("signup"), playoff_replays_url=link("replays"))
    html = TEMPLATE.read_text()
    for marker, key in (("CAPTION", "champion_caption"), ("SEASON_DETAILS", "next_season_details"), ("DISCOUNT", "returning_team_discount")):
        if not values.get(key):
            html = re.sub(f"<!-- OPTIONAL_{marker}_START -->.*?<!-- OPTIONAL_{marker}_END -->", "", html, flags=re.S)

    def replace(match):
        key = match[1]
        if key not in values:
            raise ValueError(f"Missing template field {key}")
        return escape(values[key], quote=True)

    html = re.sub(r"\{\{(\w+)\}\}", replace, html)
    return {"subject": "Thanks for playing at QBK!", "html_content": html,
            "preheader": f'Congratulations to {values["champion_name"]}! Your playoff replays and next season.',
            "from_address": "QBK Sports <info@qbksports.com>", "reply_to": "info@qbksports.com",
            "preview_only": preview, "campaign_id": tracking_group(context)[1]}

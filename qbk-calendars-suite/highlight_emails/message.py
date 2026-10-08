from html import escape
from urllib.parse import urlencode, urlsplit
from .models import Match, NY, instant


def safe_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Email media must use public HTTPS URLs.")
    return escape(value, quote=True)


def replay_url(match: Match, clip: dict) -> str:
    safe_url(clip["video_url"])
    query = urlencode({"eventId": match.event_id, "clipId": str(clip["id"]),
                       "title": f"{match.home_team} vs {match.away_team}",
                       "category": "League", "source": "league_replay_email",
                       "date": match.day.isoformat(), "court": match.court.title() + " Court"})
    return safe_url(f"https://qbk-calendars-suite.onrender.com/event-videos/?{query}")


def tracked_link(match: Match, target: str) -> str:
    query = urlencode({"eventId": match.event_id, "target": target,
                       "title": f"{match.home_team} vs {match.away_team}",
                       "date": match.day.isoformat(), "court": match.court.title() + " Court"})
    return safe_url(f"https://qbk-calendars-suite.onrender.com/replay-link?{query}")


def build(match: Match, clips: list[dict], *, logo_url: str | None = None,
          preview_logo: bool = False) -> dict:
    if not clips:
        raise ValueError("A highlight email requires at least one clip.")
    if len({c["id"] for c in clips}) != len(clips):
        raise ValueError("Duplicate clip IDs in email.")
    start, end = match.start.astimezone(NY), match.end.astimezone(NY)
    short_date = f"{start:%b} {start.day}"
    count = len(clips)
    noun = "clip" if count == 1 else "clips"
    subject = f"Your QBK game replays 🏐 | {short_date}"
    preheader = f"{match.home_team} vs {match.away_team} — your Push It highlights are ready."
    metadata = f"{start:%A}, {short_date} · {start:%-I:%M %p}–{end:%-I:%M %p} · {match.court.title()} Court"
    if logo_url and preview_logo:
        raise ValueError("Choose a public logo URL or the local preview logo.")
    if preview_logo:
        logo_src = "qbk-logo.png"
    elif logo_url:
        logo_src = safe_url(logo_url)
    else:
        logo_src = None
    brand = (f'<img src="{logo_src}" width="55" alt="QBK Sports" '
             'style="display:block;width:55px;max-width:100%;height:auto;border:0;">'
             if logo_src else '<span style="font-size:15px;font-weight:bold;letter-spacing:2px;">QBK SPORTS</span>')
    brand = f'<a href="{tracked_link(match, "logo")}" target="_blank" style="text-decoration:none;color:inherit;">{brand}</a>'
    cards = []
    for number, clip in enumerate(clips[:3], 1):
        label = f"Clip {number} · {instant(clip['timestamp']).astimezone(NY):%-I:%M %p}"
        cards.append(f'''<tr><td style="padding:0 28px 24px;">
<a href="{replay_url(match, clip)}" style="color:#171714;text-decoration:none;">
<img src="{safe_url(clip['thumbnail_url'])}" width="584" alt="Watch {escape(label)}" style="display:block;width:100%;max-width:584px;height:auto;border:0;border-radius:10px;">
<span style="display:block;padding-top:10px;font-size:14px;font-weight:bold;">▶ Watch {escape(label)}</span></a></td></tr>''')
    remaining = ""
    if count > 3:
        links = "".join(f'<li style="padding:7px 0;"><a style="color:#514117;" href="{replay_url(match, c)}">Watch clip {n} · {instant(c["timestamp"]).astimezone(NY):%-I:%M %p}</a></li>'
                        for n, c in enumerate(clips[3:], 4))
        remaining = f'<tr><td style="padding:0 28px 24px;"><h2 style="font-size:20px;margin:0 0 8px;">Keep watching</h2><ul style="margin:0;padding-left:20px;">{links}</ul></td></tr>'
    html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(subject)}</title></head>
<body style="margin:0;background:#f5f2e9;font-family:Arial,Helvetica,sans-serif;color:#171714;">
<div style="display:none;font-size:1px;color:#f5f2e9;max-height:0;overflow:hidden;">{escape(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f2e9;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#fff;border-radius:14px;">
<tr><td style="padding:8px 28px;border-bottom:4px solid #d4b762;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="120" align="left" valign="middle">{brand}</td><td align="right" valign="middle" style="color:#756438;font-size:11px;font-weight:bold;letter-spacing:2px;">LEAGUE VIDEO REPLAYS</td></tr></table></td></tr>
<tr><td style="padding:28px;"><p style="margin:0 0 12px;font-size:12px;color:#776e58;">{escape(metadata)}</p>
<h1 style="margin:0 0 16px;font-size:32px;line-height:1.15;">{escape(match.home_team)} vs {escape(match.away_team)}</h1>
<p style="margin:0;font-size:16px;line-height:1.6;">{count} {noun} from your match:</p></td></tr>
{''.join(cards)}{remaining}
<tr><td style="padding:24px 28px;background:#fbf7e9;border-top:1px solid #e9dfc5;">
<h2 style="margin:0 0 10px;font-size:18px;line-height:1.3;">Share your best play for a shot at Play of the Week.</h2>
<p style="margin:0;font-size:16px;line-height:1.6;">Save your favorite moments, post your highlights, and tag <a href="{tracked_link(match, 'instagram')}" style="color:#514117;font-weight:bold;">@qbksports</a>.<br>Every week we'll select a Play of the Week. Winner gets a special QBK prize!</p></td></tr>
<tr><td style="padding:24px 28px 28px;border-top:1px solid #e9dfc5;">
<h2 style="margin:0 0 10px;font-size:20px;">Run it back next season</h2>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Ready for more sand time? Returning teams get <strong>$100 off</strong> their next league season. Choose your night and format, then sign up on the QBK league page.</p>
<a href="{tracked_link(match, 'signup')}" style="display:inline-block;padding:12px 16px;background:#171714;border-radius:6px;color:#fff;font-size:14px;font-weight:bold;text-decoration:none;">See leagues &amp; sign up</a></td></tr>
<tr><td style="padding:18px 28px;color:#776e58;font-size:12px;line-height:1.6;border-top:1px solid #e9dfc5;">You're receiving match highlights because you're registered on one of these teams.<br>Videos captured by Push It. <a href="mailto:info@qbksports.com?subject=Unsubscribe%20from%20League%20Replay%20List&amp;body=Please%20unsubscribe%20me%20from%20the%20League%20Replay%20List." style="color:#514117;">Unsubscribe from League Replays</a>.</td></tr>
</table></td></tr></table>[[trackingImage]]</body></html>'''
    return {"format_type": 5, "subject": subject, "preheader": preheader[:140], "html_content": html}

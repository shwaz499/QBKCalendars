# League thank-you emails and replay engagement

The reusable email template is `email_templates/league-thank-you.html`; `league_thank_you.build(data, preview=False)` renders it. It does not send or schedule mail. From is QBK Sports <info@qbksports.com>, Reply-To is info@qbksports.com. Attach the logo as `cid:qbk-logo` and the approved champion photo as `cid:champion-photo` when using those sources.

Required input fields: season_id, league_id, playoff_date_iso, league_name, season_name, playoff_date, champion_name, champion_photo_url, next_season_name, and playoff_replays_url. Optional fields: champion_caption, next_season_details, returning_team_discount, and logo_src. The renderer removes unused optional sections, escapes values, rejects blank/unresolved required inputs, and computes all tracked logo, signup, Instagram, and replay links. Missing winner/photo/details require operator confirmation; the renderer cannot determine the factual winner from standings.

Thank-you links carry source=league_thank_you_email plus the real DaySmart season and league IDs and an ISO playoff date. Their aggregate key is thank-you:SEASON:LEAGUE:YYYY-MM-DD. Match replay links retain source=league_replay_email and their numeric event IDs. Existing persisted events remain readable. No recipient identifier or open pixel is added.

The League Replay Engagement dashboard includes both email types, an email-type filter, and a replay-link-click column. Page visits, ephemeral browser sessions, clip plays, download clicks/readiness/errors, and signup/logo/Instagram clicks remain counted. Plays count once per clip per page load. Signup clicks are not completed registrations; browser automation and security scanners can affect counts. The persistent store stays on the existing Render disk.

The tracked replay redirect accepts only the QBK hosted /playoff-videos/ or /event-videos/ destination and propagates campaign context into the player. An explicit preview flag suppresses tracking on both the redirect and player; preview email output uses direct logo/signup/Instagram destinations. Local testing must use its own analytics data directory, never production data.

## Prepared playoff archives

/playoff-videos/?seasonId=112&leagueId=383&date=2026-10-13 loads the approved snapshot from qbk-playoff-videos/campaigns/112-383-2026-10-13.json through /api/playoff-videos. The existing player and DOWNLOAD button are reused, grouping clips by playoff game. Unprepared campaigns return 404; invalid identifiers return 400.

This first archive was prepared on October 14 from live DaySmart and a fresh Push It scan. It includes 16 unique clips from league 383, season 112, games 28403/28404/28405, all on Right Court, including the championship slot even though its teams were not populated. The winner Blowfish was supplied by Josh. Source membership, exact court, scheduled game windows plus five minutes, clip deduplication, and all three games were verified. No unrelated events or roster data appear in the public archive.

For each future archive, confirm the playoff date and league, fetch the complete live schedule, verify season/league membership including unpopulated championship slots, and aggregate only matching court/time clips. Populate the same public event/clips JSON shape and record source event IDs and preparation time. Refresh before delivery if new footage or schedule corrections change the archive. This snapshot is a prepared archive, not a continuously refreshed feed or automatic playoff detector.

## Delivery remains a separate action

Publish and verify the public replay page and analytics endpoints before a real email uses the generated links. Always send one email for each league-day/season thank-you, with To info@qbksports.com and every eligible player privately in Bcc. Do not split thank-you emails by team or player. This is Josh's standing instruction from October 14, 2026. Prepare recipients from every team in the season/league, including eliminated teams, deduplicate privately in Bcc, honor actual unsubscribe/suppression/bounce exclusions, and follow the user's DaySmart communication-flag preference. Require explicit send authorization, fresh recipient/link checks, durable campaign send intent, and exact Gmail Sent verification before recording delivery. Never resend after an ambiguous result without reconciliation. This change creates no recipient list, scheduled job, or live email send.

Validation: `QBK_PREWARM_ON_STARTUP=0 python3 -m unittest discover -v`. HTTP tests use an isolated real file store. Browser checks cover dashboard filters, campaign propagation, once-per-clip play callbacks, download callbacks, actual Tuesday clips, responsive email layouts, and preview exclusion.

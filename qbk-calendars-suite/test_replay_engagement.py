"""Exercise analytics through HTTP using an isolated real file store."""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlencode, urlsplit, parse_qs

os.environ["QBK_PREWARM_ON_STARTUP"] = "0"
import server


class ReplayEngagementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_store = server.REPLAY_ANALYTICS
        self.previous_campaign_dir = getattr(server, "PLAYOFF_CAMPAIGN_DIR", None)
        server.PLAYOFF_CAMPAIGN_DIR = Path(self.directory.name) / "campaigns"
        server.PLAYOFF_CAMPAIGN_DIR.mkdir()
        server.REPLAY_ANALYTICS = server.ClickAnalyticsStore(Path(self.directory.name) / "events.jsonl")
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.CalendarHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.context = {"source": "league_thank_you_email", "seasonId": "112", "leagueId": "42",
                        "date": "2026-10-14", "title": "Fall 2026 Wednesday 4s playoffs", "court": "All playoff courts"}

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        server.REPLAY_ANALYTICS = self.previous_store
        if self.previous_campaign_dir is None:
            del server.PLAYOFF_CAMPAIGN_DIR
        else:
            server.PLAYOFF_CAMPAIGN_DIR = self.previous_campaign_dir
        self.directory.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)
        connection.request(method, path, json.dumps(body) if body is not None else None,
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def track(self, **values):
        return self.request("POST", "/api/track-replay", {**self.context, **values})[0]

    def report(self):
        status, _, body = self.request("GET", "/api/replay-analytics?days=365")
        self.assertEqual(status, 200, body)
        return json.loads(body)["matches"]

    def test_thank_you_activity_is_grouped_separately_from_match_replays(self):
        self.assertEqual(self.track(action="replay_visit", session="browser-one"), 200)
        self.assertEqual(self.track(action="video_play", clipId="700", session="browser-one", eventId="28403"), 200)
        self.assertEqual(self.track(action="download_ready", clipId="700", session="browser-one"), 200)
        self.assertEqual(self.request("POST", "/api/track-replay", {"eventId": "28403", "action": "video_play"})[0], 200)
        rows = self.report()
        self.assertEqual(len(rows), 2)
        season = next(row for row in rows if row["email_type"] == "thank_you")
        self.assertEqual(season["campaign_id"], "thank-you:112:42:2026-10-14")
        self.assertEqual(season["counts"], {"replay_visit": 1, "video_play": 1, "download_ready": 1})
        self.assertEqual(season["sessions"], 1)
        match = next(row for row in rows if row["email_type"] == "match_replay")
        self.assertEqual(match["event_id"], "28403")
        self.assertEqual(match["counts"], {"video_play": 1})

    def test_different_seasons_leagues_and_playoff_dates_do_not_merge(self):
        for values in ({}, {"seasonId": "113"}, {"leagueId": "43"}, {"date": "2026-10-15"}):
            self.assertEqual(self.track(action="signup_click", **values), 200)
        self.assertEqual(len(self.report()), 4)

    def test_preview_activity_is_not_persisted(self):
        self.assertEqual(self.track(action="signup_click", preview="1"), 200)
        self.assertEqual(self.report(), [])

    def test_incomplete_or_unknown_campaign_context_is_rejected(self):
        for values in ({"seasonId": ""}, {"leagueId": ""}, {"date": "2026-02-30"}, {"source": "unknown"}):
            self.assertEqual(self.track(action="signup_click", **values), 400)
        self.assertEqual(self.report(), [])

    def test_email_replay_redirect_counts_click_and_preserves_campaign_context(self):
        query = urlencode({**self.context, "target": "replays", "destination": "https://qbk-calendars-suite.onrender.com/playoff-videos/?night=one"})
        status, headers, _ = self.request("GET", "/replay-link?" + query)
        self.assertEqual(status, 302)
        destination = urlsplit(headers["Location"])
        self.assertEqual(destination.path, "/playoff-videos/")
        params = parse_qs(destination.query)
        self.assertEqual(params["source"], ["league_thank_you_email"])
        self.assertEqual(params["leagueId"], ["42"])
        self.assertEqual(params["seasonId"], ["112"])
        self.assertEqual(params["night"], ["one"])
        self.assertEqual(self.report()[0]["counts"], {"replay_click": 1})

    def test_replay_redirect_rejects_external_destination_without_recording(self):
        for destination in ("https://example.com/playoff-videos/", "https://qbk-calendars-suite.onrender.com@evil.test/playoff-videos/", "https://qbk-calendars-suite.onrender.com/replay-link?target=signup"):
            query = urlencode({**self.context, "target": "replays", "destination": destination})
            self.assertEqual(self.request("GET", "/replay-link?" + query)[0], 400)
        self.assertEqual(self.report(), [])

    def test_thank_you_signup_redirect_and_legacy_records_work_together(self):
        query = urlencode({**self.context, "target": "signup"})
        status, headers, _ = self.request("GET", "/replay-link?" + query)
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "https://www.qbksports.com/volleyball-leagues")
        server.REPLAY_ANALYTICS.record({"calendar": "league_replay", "category": "28139", "action": "signup_click"}, {})
        rows = self.report()
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["counts"] == {"signup_click": 1} for row in rows))

    def test_playoff_page_api_loads_only_the_registered_campaign_snapshot(self):
        payload = {"event": {"title": "Demo playoffs"}, "clips": [{"id": "one", "court": "Right Court"}], "source_event_ids": ["28403", "28404", "28405"]}
        (server.PLAYOFF_CAMPAIGN_DIR / "112-42-2026-10-14.json").write_text(json.dumps(payload))
        path = "/api/playoff-videos?seasonId=112&leagueId=42&date=2026-10-14"
        status, _, body = self.request("GET", path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), payload)
        self.assertEqual(self.request("GET", path.replace("leagueId=42", "leagueId=43"))[0], 404)
        self.assertEqual(self.request("GET", path.replace("leagueId=42", "leagueId=..%2F42"))[0], 400)


if __name__ == "__main__":
    unittest.main()

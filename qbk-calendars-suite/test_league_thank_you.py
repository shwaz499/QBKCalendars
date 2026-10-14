import importlib
import importlib.util
from html.parser import HTMLParser
import unittest
from urllib.parse import parse_qs, urlsplit


class Links(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.urls = []
        self.feed(html)

    def handle_starttag(self, tag, attributes):
        if tag == "a":
            self.urls.append(dict(attributes).get("href", ""))


class ThankYouEmailTests(unittest.TestCase):
    def setUp(self):
        self.data = {"season_id": "112", "league_id": "42", "playoff_date_iso": "2026-10-14",
                     "league_name": "Wednesday 4s", "season_name": "Fall 2026", "playoff_date": "Oct 14, 2026",
                     "champion_name": "Example winners", "champion_photo_url": "https://example.com/champions.jpg",
                     "next_season_name": "Winter 2027", "playoff_replays_url": "https://qbk-calendars-suite.onrender.com/playoff-videos/?leagueId=42"}

    def build(self, **kwargs):
        self.assertIsNotNone(importlib.util.find_spec("league_thank_you"), "The thank-you email link builder is missing")
        return importlib.import_module("league_thank_you").build(self.data, **kwargs)

    def test_email_buttons_include_the_same_valid_campaign_context(self):
        result = self.build()
        links = [url for url in Links(result["html_content"]).urls if "/replay-link?" in url]
        self.assertEqual(len(links), 5)
        self.assertEqual({parse_qs(urlsplit(url).query)["target"][0] for url in links}, {"logo", "signup", "instagram", "replays"})
        for link in links:
            query = parse_qs(urlsplit(link).query)
            self.assertEqual(query["source"], ["league_thank_you_email"])
            self.assertEqual(query["seasonId"], ["112"])
            self.assertEqual(query["leagueId"], ["42"])
            self.assertEqual(query["date"], ["2026-10-14"])
        self.assertNotIn("{{", result["html_content"])

    def test_preview_links_never_use_production_click_tracking(self):
        html = self.build(preview=True)["html_content"]
        self.assertTrue(all("/replay-link?" not in url for url in Links(html).urls))
        replay = next(url for url in Links(html).urls if "/playoff-videos/" in url)
        self.assertEqual(parse_qs(urlsplit(replay).query)["preview"], ["1"])

    def test_unconfirmed_fields_cannot_produce_sendable_email(self):
        for field in ("season_id", "league_id", "champion_name", "champion_photo_url", "next_season_name"):
            original = self.data[field]
            self.data[field] = ""
            with self.assertRaises(ValueError, msg=field):
                self.build()
            self.data[field] = original

    def test_text_is_escaped_and_empty_optional_sections_are_removed(self):
        self.data["champion_name"] = '<Winners & friends>'
        html = self.build()["html_content"]
        self.assertIn("&lt;Winners &amp; friends&gt;", html)
        self.assertNotIn("OPTIONAL_CAPTION_START", html)
        self.assertNotIn("OPTIONAL_SEASON_DETAILS_START", html)


if __name__ == "__main__":
    unittest.main()

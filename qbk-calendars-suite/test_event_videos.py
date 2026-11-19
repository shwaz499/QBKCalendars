import unittest
from datetime import date, datetime, timezone
from unittest.mock import Mock, patch

import server


class EventVideoMultiCourtTests(unittest.TestCase):
    def setUp(self):
        self.client = server.DashClient.__new__(server.DashClient)
        self.client._request_json = Mock(return_value={
            "data": {
                "attributes": {
                    "start_gmt": "2026-10-10T00:00:00Z",
                    "end_gmt": "2026-10-10T02:00:00Z",
                    "resource_id": "left-resource",
                    "event_type_id": "C",
                }
            }
        })
        self.client._cached_lookup = Mock(side_effect=lambda lookup: {
            "resources": {"left-resource": "Left Court", "middle-resource": "Middle Court"},
            "resource_areas": {},
        }[lookup])
        self.client._fetch_pushit_clips = Mock(return_value=[])
        shared = {
            "title": "Volley Royale (10/9 8 PM)",
            "category": "Camp",
            "start_time": "2026-10-09T20:00:00-04:00",
            "end_time": "2026-10-09T22:00:00-04:00",
            "booking_url": "https://booking.example/teams/10126",
        }
        self.client.get_events_for_date = Mock(return_value=[
            {**shared, "id": "28442", "court_key": "left"},
            {**shared, "id": "28651", "court_key": "middle"},
            {
                **shared,
                "id": "28652",
                "court_key": "right",
                "booking_url": "https://booking.example/teams/99999",
            },
        ])

    def test_event_video_lookup_includes_only_courts_for_same_booking(self):
        payload = self.client.get_event_videos(
            "28442",
            title="Volley Royale (10/9 8 PM)",
            category="Camp",
        )

        self.assertEqual(payload["event"]["court"], "Left & Middle Courts")
        self.assertEqual(payload["event"]["court_keys"], ["left", "middle"])
        self.client._fetch_pushit_clips.assert_called_once()
        self.assertEqual(
            self.client._fetch_pushit_clips.call_args.kwargs["court_keys"],
            {"left", "middle"},
        )

    def test_pushit_filter_accepts_each_assigned_court_only(self):
        del self.client._fetch_pushit_clips

        def clip(clip_id, pitch_name):
            return {
                "id": clip_id,
                "clipCreationTime": "2026-10-10T01:00:00Z",
                "camera": {"pitch": {"name": pitch_name}},
                "session": {"name": "9 Oct 2026 9:00 PM-10:00 PM"},
                "fileName": f"{clip_id}-file",
                "duration": 24,
            }

        response = Mock()
        response.json.return_value = {
            "items": [
                clip("left", "Left Court"),
                clip("middle", "Middle Court"),
                clip("right", "Right Court"),
            ],
            "hasMore": False,
        }
        start = datetime(2026, 10, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 10, 10, 2, tzinfo=timezone.utc)

        with patch.object(server.httpx, "get", return_value=response):
            clips = self.client._fetch_pushit_clips(
                start,
                end,
                "left",
                "Left Court",
                court_keys={"left", "middle"},
            )

        self.assertEqual([item["id"] for item in clips], ["left", "middle"])
        self.assertEqual([item["court"] for item in clips], ["Left Court", "Middle Court"])

    def test_private_rental_includes_linked_court_but_not_unrelated_rental(self):
        events = self.client.get_events_for_date.return_value
        for event in events:
            event.update(title="Private Rental", category="Rental", booking_url=None)
        events[1]["parent_event_id"] = "28442"
        for event_id in ("28442", "28651"):
            with self.subTest(event_id=event_id):
                self.client._request_json.return_value["data"]["attributes"]["resource_id"] = (
                    "middle-resource" if event_id == "28651" else "left-resource"
                )
                result = self.client.get_event_videos(event_id, category="Rental")
                self.assertEqual(result["event"]["court_keys"], ["left", "middle"])

    def test_unlinked_private_rentals_stay_separate(self):
        for event in self.client.get_events_for_date.return_value:
            event.update(title="Private Rental", category="Rental", booking_url=None)
        result = self.client.get_event_videos("28442", category="Rental")
        self.assertEqual(result["event"]["court_keys"], ["left"])

    def test_match_play_uses_added_court_for_replay_and_icon(self):
        match, occupied, _ = self.client.get_events_for_date.return_value
        match.update(
            title="Intermediate 2s - Match Play",
            court_key="middle",
            register_capacity=16,
            clickable=True,
        )
        occupied.update(title="Private Event", court_key="left", booking_url=None, clickable=False)
        day_events = [match, occupied]
        self.client._assign_calendar_courts(day_events)
        self.client.get_events_for_date.return_value = day_events
        self.client._request_json.return_value["data"]["attributes"]["resource_id"] = "middle-resource"
        self.client._event_video_cache = {}
        self.client._fetch_pushit_clips_for_date = Mock(return_value=[{
            "session": {"pitchId": server.PUSHIT_PITCH_IDS["right"]},
            "clipCreationTime": "2026-10-10T01:00:00Z",
        }])

        self.assertEqual(match["calendar_court_keys"], ["middle", "right"])
        self.assertEqual(self.client.get_event_video_availability(date(2026, 10, 9)), ["28442"])
        result = self.client.get_event_videos("28442", title=match["title"])
        self.assertEqual(result["event"]["court"], "Middle & Right Courts")
        self.assertEqual(
            self.client._fetch_pushit_clips.call_args.kwargs["court_keys"],
            {"middle", "right"},
        )

    def test_40_spot_drop_in_needs_a_free_adjacent_court_for_the_entire_event(self):
        drop_in, occupied, _ = self.client.get_events_for_date.return_value
        drop_in.update(title="4s Drop-In", register_capacity=40, court_key="left", clickable=True)
        occupied.update(title="Private Event", booking_url=None, end_time="2026-10-09T20:30:00-04:00")

        self.client._assign_calendar_courts([drop_in, occupied])
        self.assertNotIn("calendar_court_keys", drop_in)

        occupied["end_time"] = drop_in["start_time"]
        occupied["start_time"] = "2026-10-09T18:00:00-04:00"
        self.client._assign_calendar_courts([drop_in, occupied])
        self.assertEqual(drop_in["calendar_court_keys"], ["left", "middle"])

    def test_volley_royale_uses_all_spare_courts_on_calendar_and_in_replays(self):
        match = self.client.get_events_for_date.return_value[0]
        match["clickable"] = True
        self.client.get_events_for_date.return_value = [match]
        self.client._assign_calendar_courts([match])
        self.assertEqual(match["calendar_court_keys"], ["left", "middle", "right"])
        payload = self.client.get_event_videos("28442", title=match["title"])
        self.assertEqual(payload["event"]["court"], "All Courts")


if __name__ == "__main__":
    unittest.main()

import unittest
from datetime import datetime, timezone
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
            "resources": {"left-resource": "Left Court"},
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


if __name__ == "__main__":
    unittest.main()

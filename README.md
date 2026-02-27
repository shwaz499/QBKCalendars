# League Scheduler Web App

This browser app lets you configure and generate weekly league schedules with editable results.

## Inputs supported
- Amount of teams
- Name of each team
- Amount of game weeks
- Weekly time range for one-hour matches
- Number of courts available for each hour
- Team-specific blocked times (for example: Team A cannot play at `18:00`)

## Scheduling rules
- Creates weekly schedules across the number of weeks entered.
- Uses fair rotation for odd-team doubleheaders:
  - Exactly one team gets a doubleheader each week.
  - Doubleheaders are randomized among teams with the lowest doubleheader count.
  - Doubleheader games are always scheduled in back-to-back hourly slots.
- Respects all team time restrictions.
- Enforces court capacity per hour.

## Editable schedule
After generation, every game row is editable:
- Week
- Lock Week
- Time
- Court
- Home team
- Away team

Use **Validate Edits** to check conflicts and rule violations before export.

## Lock Week mode
- Check **Lock Week** on any row in a week to lock that full week.
- Click **Regenerate Unlocked Weeks** to preserve locked weeks and rebuild only the rest.
- Locked weeks are validated before regeneration.

## Run locally
From `/Users/joshschwartz/Documents/New project`:

```bash
python3 -m http.server 8000
```

Open [http://localhost:8000/index.html](http://localhost:8000/index.html)

## Export
Use **Download CSV** to export the validated schedule.

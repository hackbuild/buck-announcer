# buck-announcer

Makes [BUCK](https://github.com/hackbuild/hackbuild-buck), the talking deer head on the wall at [HeatSync Labs](https://www.heatsynclabs.org), announce what is happening in the lab.

- An hour before each event on the HeatSync calendar, BUCK says its name, its start time, and the first sentences of its description, something like "Board Game Night starts in one hour, at seven P M." followed by the description.
- At 9:30 and 9:45 PM, Mesa time, it says "Lab closing in thirty minutes" and "Lab closing in fifteen minutes".

It runs as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) on two cron triggers, on the free plan. Status page: [buck-announcer.hackbuild.workers.dev](https://buck-announcer.hackbuild.workers.dev).

## How it works

```
Google Calendar ICS --(every 30 min)--> refresh: next 26 h of event times --> KV
                                                                             |
every 5 min: announce <------------------------------------------------------+
   decide what is due (plan.ts), say it (send.ts), remember it so it is said once
   |
   +--> CLASP over WebSocket to wss://relay.clasp.to    /hackbuild/buck/heatsync/say
   +--> MQTT to relay.clasp.chat:1883 if CLASP fails    hackbuild/buck/heatsync/say
```

The calendar is the public ICS feed behind the HeatSync website. It is about 1.7 MB and 2000 events, nearly all of them history, and a free Worker gets 10 ms of CPU per run. So `src/ics.ts` does not parse the file. It walks it once per property with forward-only cursors, compares each event's start date as a string, and fully parses only the few that can fall in the window. Recurring events go through `src/recur.ts`, which asks each day in the window whether the rule hits it instead of stepping through years of history; the [rrule](https://github.com/jkbrzt/rrule) library takes the shapes it does not cover. Exceptions (EXDATE), moved and cancelled instances (RECURRENCE-ID) and time zones are handled.

The heavy refresh runs on its own cron so the five minute announce run stays cheap: it reads the small cached list from KV, and only after it has spoken does it refresh a stale cache.

### Rules it follows

- Heads up: events with a start time (not all day) get one line about 60 minutes before. Events starting together share one line.
- Closing: 30 and 15 minutes before 10 PM `America/Phoenix`. Arizona has no daylight saving, so that is always 04:30 and 04:45 UTC.
- No closing warning when something on the calendar runs past 10 PM or starts right after it, or on a date listed in `SKIP_CLOSING_DATES`.
- Every line is said once. Each run is five minutes apart and a target counts as due from 5 minutes early to 1 minute late, so it falls in exactly one run, and a key in KV catches retries.
- Lines are written for SAM, BUCK's 1982 voice: times and small numbers as words ("seven thirty P M"), emoji, HTML, links and "Registration Required" removed, and the whole line kept under BUCK's 200 characters.

## Settings

All in `wrangler.toml` under `[vars]`. Change one and run `npm run deploy`.

| var | default | |
|---|---|---|
| `ENABLED` | `true` | off switch for everything |
| `ANNOUNCE_EVENTS` | `true` | the one hour heads up |
| `ANNOUNCE_CLOSING` | `true` | the closing warnings |
| `CLOSING_TIME` | `22:00` | in `TIMEZONE` |
| `CLOSING_WARNINGS` | `30,15` | minutes before closing |
| `SKIP_CLOSING_DATES` | empty | `YYYY-MM-DD,YYYY-MM-DD`, nights with no closing warning |
| `LEAD_MINUTES` | `60` | how early the heads up goes out; the wording says "one hour" |
| `TIMEZONE` | `America/Phoenix` | |
| `BUCK_ID` | `heatsync` | which BUCK |
| `ICS_URL` | HeatSync public calendar | |
| `CLASP_URL`, `MQTT_HOST`, `MQTT_PORT` | `wss://relay.clasp.to`, `relay.clasp.chat`, `1883` | the two ways to BUCK |

## Pages

- `/` status: settings, when the calendar was last read, what is coming up, the last lines sent and which way they went
- `/preview?at=2026-10-09T18:00:00-07:00` what would be said at that moment, from the cached calendar. Sends nothing.

There is no way to make it speak from the web. Anyone who wants BUCK to say something can already do that directly; see the BUCK repo.

## Run it yourself

```
npm install
npm test                     # 382 tests, includes every recurrence rule in the HeatSync feed checked against rrule
npm run typecheck
npx wrangler login
npx wrangler kv namespace create STATE    # put the id in wrangler.toml
npm run deploy
npm run tail                 # live logs
```

Pointing it at another BUCK or calendar is a matter of `BUCK_ID`, `ICS_URL`, `TIMEZONE` and `CLOSING_TIME`.

## License

MIT

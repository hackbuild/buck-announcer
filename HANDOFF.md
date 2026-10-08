# buck-announcer, handoff

## what it is

A Cloudflare Worker that reads the HeatSync Labs calendar and makes BUCK, the talking deer at HeatSync (github.com/hackbuild/hackbuild-buck), give a one hour heads up before each event and say "Lab closing in thirty / fifteen minutes" at 9:30 and 9:45 PM Mesa time.

Read `RULES.md` first. It is absolute and wins over this file.

## deployments

| what | where |
|---|---|
| worker | `buck-announcer` on the hackbuildvideo@gmail.com Cloudflare account, free plan |
| status page | https://buck-announcer.hackbuild.workers.dev |
| state | KV namespace `buck-announcer-state` (`ca56e9fe07fe41a1bbb832ba2a566f4f`): cached schedule, last 25 lines, one key per line said (2 day TTL) |
| crons | `7,37 * * * *` refresh, `*/5 * * * *` announce |
| calendar | the public Google ICS feed behind heatsynclabs.org, X-WR-TIMEZONE America/Phoenix |
| repo | https://github.com/hackbuild/buck-announcer |

The account also has two unrelated Workers, `testproxy` and `thistle-proxy`. They were left alone.

## where it stands, 2026-10-08

Deployed, running, and verified end to end on the deer:

- 2026-10-07 9:30 and 9:45 PM: the real closing warnings went out on time, over MQTT, because the CLASP path had a bug (binary WebSocket messages arrive as a Blob in Workers, not an ArrayBuffer). The deer was being power cycled around then, so they were probably not heard.
- 10:45 PM: after the fix, a test run to a test address (`BUCK_ID=announcer-test`) went out over CLASP and arrived at a subscriber.
- 10:55 PM: a test run aimed at the deer said "Lab closing in twenty five minutes." over CLASP, and the room heard it.

Both test lines (10:44 and 10:54 in the status page history) came from temporary settings, now back to normal. The first real event heads up is Thursday 2026-10-08 at 6 PM for the 7 PM events; the status page shows whether it went over CLASP or fell back to MQTT.

## testing without editing files

`wrangler deploy --var` overrides a setting for one deploy without touching `wrangler.toml`. To make a closing warning fire at the next five minute run: pick a closing time that many minutes after the run, and a warning count not used today (each warning key is per date and minutes, so a used one is skipped).

```
# at 10:50, for the 10:55 run: close 11:20, warn at 25 minutes
npx wrangler deploy --var CLOSING_TIME:23:20 --var CLOSING_WARNINGS:25
# add --var BUCK_ID:announcer-test to keep the deer quiet and watch
# /hackbuild/buck/announcer-test/say on wss://relay.clasp.to instead
npx wrangler deploy        # back to the real settings
```

382 tests pass: the scanner on a synthetic calendar (EXDATE, moved and cancelled instances, all day, UTC, Denver daylight saving, folded lines), the planner's timing rules, the speech cleanup, and the direct recurrence evaluator against rrule for all 352 recurrence rules in the real feed over two years.

## the CPU question

A free Worker gets a nominal 10 ms of CPU per run. Measured on Cloudflare:

| run | CPU |
|---|---|
| announce (every 5 min) | 0 to 6 ms |
| refresh, 26 hour window (what ships) | 15 to 16 ms |
| refresh, 48 hour window (tried, reverted) | 17 to 22 ms |

Every run so far completed; Cloudflare has not stopped one. The floor is reading the 1.7 MB feed itself (about 4 ms on an M-series Mac before any parsing). If Cloudflare starts enforcing 10 ms, refreshes fail and the status page warns after 3 hours; announcements keep going on the cached day. The fixes then are the Workers Paid plan ($5 a month, 30 s of CPU) or moving the refresh to a machine with no CPU cap and writing the schedule into KV.

## decisions and why

- ICS, not the Google Calendar API. The website's API key is referrer restricted to heatsynclabs.org; sending a fake Referer from a server would get around a restriction someone set on purpose.
- Own scanner and recurrence evaluator. Full parsers (ical.js, rrule from DTSTART) cost well over 10 ms on this feed. The evaluator handles DAILY, WEEKLY and MONTHLY with INTERVAL, UNTIL, WKST, BYDAY (with ordinals) and BYMONTHDAY; COUNT rules and anything else go to rrule, after fast forwarding DTSTART by whole periods.
- Mark before send. A line is marked said in KV before it is sent. If a run dies mid send, the line is skipped rather than repeated.
- Closing is held when an event runs past 10 PM or starts within the hour after, since the lab is clearly not closing then.
- Read only web. No route makes BUCK speak.

## credentials

Deployed with an API token given in chat on 2026-10-07, passed as environment variables per command and never written to disk or the repo. Rotate it: it sat in a chat transcript. R2 keys were also provided and were not used.

## running locally

```
npm install
npm test
npm run typecheck
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run tail
```

`wrangler dev` does not run on macOS 12; test with vitest and on Cloudflare.

## commits

Author is Moheeb Zara <hackbuildvideo@gmail.com>. No trailers, no AI attribution, imperative lowercase subjects under 60 characters.

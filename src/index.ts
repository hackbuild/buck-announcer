// buck-announcer: a Cloudflare Worker that reads the HeatSync Labs calendar and
// makes BUCK, the talking deer, announce what is coming up.
//
// Two cron triggers:
//   7,37 * * * *  refresh: fetch the ICS feed, keep the next 26 hours of event
//                 instances in KV. The heavy part, kept out of the 5 minute run.
//   */5 * * * *   announce: read that small list, decide what to say (plan.ts),
//                 send it, and remember it so nothing is said twice.
// GET / shows the status, the cached schedule and the last lines sent.

import { upcoming, type Instance } from "./ics";
import { type Config, type Line, plan } from "./plan";
import { say } from "./send";

export interface Env {
  STATE: KVNamespace;
  ICS_URL: string;
  BUCK_ID: string;
  CLASP_URL: string;
  MQTT_HOST: string;
  MQTT_PORT: string;
  TIMEZONE: string;
  LEAD_MINUTES: string;
  CLOSING_TIME: string; // "22:00"
  CLOSING_WARNINGS: string; // "30,15"
  ANNOUNCE_EVENTS: string;
  ANNOUNCE_CLOSING: string;
  SKIP_CLOSING_DATES: string; // "2026-12-24,2026-12-31"
  ENABLED: string;
}

const REFRESH_CRON = "7,37 * * * *";
// Refresh reads the whole 1.7 MB feed: measured at 15 to 16 ms of CPU on
// Cloudflare (17 to 22 ms with a 48 hour window), over the free plan's nominal
// 10 ms. Every run has completed. If Cloudflare ever stops them, the cache keeps
// announcements going for a day, and announce runs only refresh after speaking.
const HORIZON = 26 * 3600_000;
const STALE_AFTER = 3 * 3600_000; // refresh failing this long: an announce run tries one too
const DESCRIPTION_MAX = 600; // stored per event; speech uses far less

interface Cache {
  fetchedAt: number;
  from: number;
  to: number;
  bytes: number;
  events: Instance[];
}

interface LogEntry {
  at: number;
  text: string;
  via: string; // "clasp", "mqtt", or "failed: ..."
}

const on = (v: string | undefined) => (v ?? "").toLowerCase() === "true";

function config(env: Env): Config {
  const [h, m] = (env.CLOSING_TIME || "22:00").split(":").map(Number);
  return {
    tz: env.TIMEZONE || "America/Phoenix",
    leadMinutes: Number(env.LEAD_MINUTES || 60),
    closeHour: h,
    closeMinute: m || 0,
    closingWarnings: (env.CLOSING_WARNINGS || "30,15").split(",").map(Number).filter((n) => n > 0),
    announceEvents: on(env.ANNOUNCE_EVENTS),
    announceClosing: on(env.ANNOUNCE_CLOSING),
    skipClosingDates: (env.SKIP_CLOSING_DATES || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

async function refresh(env: Env): Promise<Cache> {
  const res = await fetch(env.ICS_URL, { headers: { "User-Agent": "buck-announcer (hackbuild)" } });
  if (!res.ok) throw new Error(`calendar fetch failed: HTTP ${res.status}`);
  const ics = await res.text();
  if (!ics.includes("BEGIN:VCALENDAR")) throw new Error("calendar fetch returned something that is not ICS");
  const now = Date.now();
  // A little history too, so an event that started minutes ago still shows in the status.
  const events = upcoming(ics, now - 3600_000, now + HORIZON).map((e) => ({
    ...e,
    description: e.description.slice(0, DESCRIPTION_MAX),
  }));
  const cache: Cache = { fetchedAt: now, from: now - 3600_000, to: now + HORIZON, bytes: ics.length, events };
  await env.STATE.put("cal", JSON.stringify(cache));
  console.log(`refresh: ${ics.length} bytes, ${events.length} instances in the next 26 h`);
  return cache;
}

async function readCache(env: Env): Promise<Cache | null> {
  return (await env.STATE.get<Cache>("cal", "json")) ?? null;
}

async function remember(env: Env, entry: LogEntry): Promise<void> {
  const log = (await env.STATE.get<LogEntry[]>("log", "json")) ?? [];
  log.unshift(entry);
  await env.STATE.put("log", JSON.stringify(log.slice(0, 25)));
}

async function announce(env: Env, now: number): Promise<void> {
  if (!on(env.ENABLED)) return;
  let cache = await readCache(env);
  if (!cache) {
    console.log("announce: no calendar cached yet, fetching it first");
    cache = await refresh(env);
  }
  const lines: Line[] = plan(now, cache.events, config(env));
  for (const line of lines) {
    const doneKey = `done:${line.key}`;
    if (await env.STATE.get(doneKey)) continue;
    // Mark first: if the send succeeds but the run dies before marking, a retry
    // would make BUCK repeat itself. A missed line is the better failure.
    await env.STATE.put(doneKey, String(now), { expirationTtl: 2 * 86_400 });
    let via: string;
    try {
      via = await say(
        { claspUrl: env.CLASP_URL, mqttHost: env.MQTT_HOST, mqttPort: Number(env.MQTT_PORT || 1883), buckId: env.BUCK_ID },
        line.text,
      );
    } catch (e) {
      via = `failed: ${(e as Error).message}`;
    }
    console.log(`announce via ${via}: ${line.text}`);
    await remember(env, { at: now, text: line.text, via });
  }
  // Only after speaking: if this refresh is stopped for CPU, nothing above is lost.
  if (now - cache.fetchedAt > STALE_AFTER) {
    console.log("announce: calendar cache is stale, refreshing after announcements");
    await refresh(env);
  }
}

function fmt(ms: number, tz: string): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
}

async function status(env: Env): Promise<Response> {
  const cfg = config(env);
  const cache = await readCache(env);
  const log = (await env.STATE.get<LogEntry[]>("log", "json")) ?? [];
  const now = Date.now();
  const out: string[] = [];
  out.push("buck-announcer: makes BUCK at HeatSync Labs announce the calendar");
  out.push(`enabled ${on(env.ENABLED)}, events ${cfg.announceEvents}, closing ${cfg.announceClosing}, buck ${env.BUCK_ID}`);
  out.push(`closing ${env.CLOSING_TIME} ${cfg.tz}, warnings at ${cfg.closingWarnings.join(" and ")} minutes, heads up ${cfg.leadMinutes} minutes before events`);
  out.push("");
  if (!cache) {
    out.push("calendar: not fetched yet");
  } else {
    out.push(`calendar: ${cache.bytes} bytes fetched ${Math.round((now - cache.fetchedAt) / 60_000)} min ago, ${cache.events.length} instances cached`);
    out.push("");
    out.push("coming up (heads up goes out about an hour before each):");
    const next = cache.events.filter((e) => e.start > now && !e.allDay).slice(0, 12);
    for (const e of next) out.push(`  ${fmt(e.start, cfg.tz).padEnd(16)} ${e.summary}`);
    if (!next.length) out.push("  nothing in the next 26 hours");
    if (now - cache.fetchedAt > STALE_AFTER) out.push("  WARNING: the calendar has not refreshed for over 3 hours");
  }
  out.push("");
  out.push("last lines sent:");
  for (const l of log.slice(0, 15)) out.push(`  ${fmt(l.at, cfg.tz).padEnd(16)} [${l.via}] ${l.text}`);
  if (!log.length) out.push("  none yet");
  return new Response(out.join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  // Awaited, not waitUntil: a failure then marks the run as failed in the logs.
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === REFRESH_CRON) await refresh(env);
    else await announce(env, event.scheduledTime);
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("read only\n", { status: 405 });
    if (url.pathname === "/") return status(env);
    if (url.pathname === "/preview") {
      // Dry run: what would be said at ?at=<ISO time>, from the cached calendar. Sends nothing.
      const at = Date.parse(url.searchParams.get("at") ?? "") || Date.now();
      const cache = await readCache(env);
      return Response.json({ at: new Date(at).toISOString(), lines: cache ? plan(at, cache.events, config(env)) : [] });
    }
    return new Response("not found\n", { status: 404 });
  },
};

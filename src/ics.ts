// A lean reader for the HeatSync Google Calendar ICS feed.
//
// The feed is about 1.7 MB and 2000 events, almost all of them history, and a
// free Cloudflare Worker gets 10 ms of CPU. So this does not parse the file: it
// walks it with indexOf, looks at each event's DTSTART or RRULE with a string
// comparison, and fully parses only the handful that can land in the window.
// Recurring events are expanded with rrule, then EXDATEs and moved or cancelled
// instances (RECURRENCE-ID) are applied.

import { rrulestr } from "rrule";
import { occurrences } from "./recur";
import { type Wall, zonedToUtc } from "./tz";

export interface Instance {
  uid: string;
  start: number; // UTC ms
  end: number;
  allDay: boolean;
  summary: string;
  description: string;
}

interface Stamp {
  ms: number; // UTC instant
  wall: Wall; // wall time in `tz`
  tz: string;
  allDay: boolean;
}

interface Event {
  uid: string;
  summary: string;
  description: string;
  status: string;
  start: Stamp;
  end?: Stamp;
  durationMs?: number;
  rrule?: string;
  exdates: number[];
  recurrenceId?: number;
}

const DAY = 86_400_000;

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseStamp(params: string, value: string, defaultTz: string): Stamp | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const wall: Wall = { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0 };
  const allDay = !m[4];
  const tzMatch = /TZID=([^;:]+)/i.exec(params);
  const tz = m[7] ? "UTC" : tzMatch ? tzMatch[1] : defaultTz;
  return { ms: zonedToUtc(wall, tz), wall, tz, allDay };
}

function parseDuration(v: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return undefined;
  const [, w, d, h, mi, s] = m.map((x) => (x ? +x : 0));
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

function parseEvent(block: string, defaultTz: string): Event | undefined {
  const lines = block.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const ev: Partial<Event> & { exdates: number[] } = { exdates: [], summary: "", description: "", status: "" };
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = head.indexOf(";");
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? "" : head.slice(semi + 1);
    switch (name) {
      case "UID": ev.uid = value.trim(); break;
      case "SUMMARY": ev.summary = unescapeText(value).trim(); break;
      case "DESCRIPTION": ev.description = unescapeText(value).trim(); break;
      case "STATUS": ev.status = value.trim().toUpperCase(); break;
      case "DTSTART": ev.start = parseStamp(params, value, defaultTz); break;
      case "DTEND": ev.end = parseStamp(params, value, defaultTz); break;
      case "DURATION": ev.durationMs = parseDuration(value); break;
      case "RRULE": ev.rrule = value.trim(); break;
      case "EXDATE":
        for (const v of value.split(",")) {
          const st = parseStamp(params, v, defaultTz);
          if (st) ev.exdates.push(st.ms);
        }
        break;
      case "RECURRENCE-ID": {
        const st = parseStamp(params, value, defaultTz);
        if (st) ev.recurrenceId = st.ms;
        break;
      }
    }
  }
  if (!ev.uid || !ev.start) return undefined;
  return ev as Event;
}

function lengthOf(ev: Event): number {
  if (ev.end) return Math.max(0, ev.end.ms - ev.start.ms);
  if (ev.durationMs !== undefined) return ev.durationMs;
  return ev.start.allDay ? DAY : 0;
}

/** YYYYMMDD of a UTC instant, for cheap string comparisons against DTSTART. */
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Finds a property line, block by block, without rescanning. Each call asks for
 * the property inside ics[b..e); blocks come in order, so the cursor only ever
 * moves forward and the whole file is read once per property name.
 */
class PropCursor {
  private pos = -2; // next real occurrence; -2 before the first search, -1 when there are no more
  constructor(private ics: string, private needle: string) {}

  /** First occurrence at or after `from` that is a whole property name. */
  private find(from: number): number {
    const { ics, needle } = this;
    let at = ics.indexOf(needle, from);
    while (at >= 0) {
      const c = ics.charCodeAt(at + needle.length);
      if (c === 58 || c === 59) return at; // followed by ':' or ';'
      at = ics.indexOf(needle, at + 1);
    }
    return -1;
  }

  value(b: number, e: number): string {
    if (this.pos === -1) return "";
    if (this.pos < b) this.pos = this.find(b);
    if (this.pos < 0 || this.pos >= e) return "";
    const colon = this.ics.indexOf(":", this.pos + 1);
    let eol = this.ics.indexOf("\n", colon);
    if (eol < 0 || eol > e) eol = e;
    return this.ics.slice(colon + 1, eol).trim();
  }
}

const PERIOD_DAYS: Record<string, number> = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 };

/** True when a COUNT-limited rule has certainly run out before `lo` (YYYYMMDD). */
function countExhausted(rule: string, dtstartDay: string, lo: string): boolean {
  const count = /COUNT=(\d+)/.exec(rule);
  const freq = /FREQ=([A-Z]+)/.exec(rule);
  if (!count || !freq || !PERIOD_DAYS[freq[1]] || dtstartDay.length !== 8) return false;
  const interval = +(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? 1);
  // Every period holds at least one occurrence, so COUNT periods is an upper bound.
  const start = Date.UTC(+dtstartDay.slice(0, 4), +dtstartDay.slice(4, 6) - 1, +dtstartDay.slice(6, 8));
  const lastPossible = start + (+count[1]) * interval * PERIOD_DAYS[freq[1]] * DAY;
  return ymd(lastPossible) < lo;
}

/**
 * Moves a rule's DTSTART forward by whole periods to just before `near`, so rrule
 * does not step through years of history. Only for rules without COUNT (which
 * counts from the original start) and without BYSETPOS or BYWEEKNO, where whole
 * periods keep the pattern identical.
 */
function fastForward(rule: string, dtstart: Date, near: number): Date {
  if (/COUNT=|BYSETPOS=|BYWEEKNO=|BYYEARDAY=/.test(rule)) return dtstart;
  const freq = /FREQ=([A-Z]+)/.exec(rule)?.[1];
  const interval = +(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? 1);
  const t = dtstart.getTime();
  if (near - t < 60 * DAY) return dtstart;
  if (freq === "DAILY" || freq === "WEEKLY") {
    const step = interval * (freq === "DAILY" ? 1 : 7) * DAY;
    const k = Math.floor((near - 45 * DAY - t) / step);
    return k > 0 ? new Date(t + k * step) : dtstart;
  }
  if (freq === "MONTHLY") {
    const months = (new Date(near).getUTCFullYear() - dtstart.getUTCFullYear()) * 12 + new Date(near).getUTCMonth() - dtstart.getUTCMonth() - 2;
    const k = Math.floor(months / interval) * interval;
    if (k <= 0) return dtstart;
    // With BYDAY or BYMONTHDAY the start day does not shape the pattern, so day 1
    // is safe and never overflows; without them the start day is the pattern.
    const keepDay = !/BYDAY=|BYMONTHDAY=/.test(rule);
    if (keepDay && dtstart.getUTCDate() > 28) return dtstart;
    const d = new Date(dtstart);
    d.setUTCDate(keepDay ? dtstart.getUTCDate() : 1);
    d.setUTCMonth(d.getUTCMonth() + k);
    return d;
  }
  return dtstart;
}

/** Every event instance that starts in [from, to). */
export function upcoming(ics: string, from: number, to: number): Instance[] {
  const tzm = /X-WR-TIMEZONE:([^\r\n]+)/.exec(ics.slice(0, 4000));
  const defaultTz = tzm ? tzm[1].trim() : "America/Phoenix";
  // A day of slack each side covers any zone offset and long events.
  const lo = ymd(from - DAY);
  const hi = ymd(to + DAY);

  const singles: Event[] = [];
  const masters: Event[] = [];
  const overrides = new Map<string, Event>(); // uid|recurrence ms

  const rruleAt = new PropCursor(ics, "\nRRULE");
  const recurAt = new PropCursor(ics, "\nRECURRENCE-ID");
  const startAt = new PropCursor(ics, "\nDTSTART");

  // Floating window for rule checks, with slack for zone offsets.
  const fromF = new Date(from - 2 * DAY);
  const toF = new Date(to + 2 * DAY);

  let next = ics.indexOf("BEGIN:VEVENT");
  while (next >= 0) {
    const b = next;
    next = ics.indexOf("BEGIN:VEVENT", b + 12);
    // The block ends at the last END:VEVENT before the next event: a short
    // backward search instead of another pass over the whole file.
    const e = ics.lastIndexOf("END:VEVENT", next < 0 ? ics.length : next);
    if (e < b) continue;

    const rule = rruleAt.value(b, e);
    const recur = recurAt.value(b, e);
    const dtstart = startAt.value(b, e);
    if (rule) {
      const until = /UNTIL=(\d{8})/.exec(rule);
      if (until && until[1] < lo) continue; // finished before the window
      if (countExhausted(rule, dtstart.slice(0, 8), lo)) continue;
      // Cheap pre-check on the raw start time: most weekly and monthly events
      // have no occurrence in a one day window, so they are never parsed.
      const w = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(dtstart);
      if (w) {
        const floating = new Date(Date.UTC(+w[1], +w[2] - 1, +w[3], w[4] ? +w[4] : 0, w[5] ? +w[5] : 0, w[6] ? +w[6] : 0));
        const hits = occurrences(rule, floating, fromF, toF);
        if (hits && hits.length === 0) continue;
      }
    } else {
      const start = dtstart.slice(0, 8);
      const recurDay = recur.slice(0, 8);
      const near = (d: string) => d >= lo && d <= hi;
      if (!near(start) && !(recur && near(recurDay))) continue;
    }

    const ev = parseEvent(ics.slice(b, e), defaultTz);
    if (!ev) continue;
    if (ev.recurrenceId !== undefined) overrides.set(`${ev.uid}|${ev.recurrenceId}`, ev);
    else if (ev.rrule) masters.push(ev);
    else singles.push(ev);
  }

  const out: Instance[] = [];
  const keep = (ev: Event, start: number) => {
    if (ev.status === "CANCELLED") return;
    if (start < from || start >= to) return;
    out.push({
      uid: ev.uid,
      start,
      end: start + lengthOf(ev),
      allDay: ev.start.allDay,
      summary: ev.summary,
      description: ev.description,
    });
  };

  for (const ev of singles) keep(ev, ev.start.ms);
  for (const ev of overrides.values()) keep(ev, ev.start.ms);

  for (const ev of masters) {
    // rrule works in floating time: hand it the wall clock as if it were UTC,
    // then turn each occurrence back into a real instant in the event's zone.
    const w = ev.start.wall;
    const floating = new Date(Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s));
    let span = occurrences(ev.rrule!, floating, fromF, toF);
    if (!span) {
      // A rule shape the direct evaluator does not cover: let rrule step it.
      try {
        const rule = rrulestr(`RRULE:${ev.rrule}`, { dtstart: fastForward(ev.rrule!, floating, from) });
        span = rule.between(fromF, toF, true);
      } catch {
        continue; // a rule rrule cannot read either; skip the event, not the run
      }
    }
    const exdates = new Set(ev.exdates);
    for (const occ of span) {
      const ms = ev.start.allDay
        ? zonedToUtc({ y: occ.getUTCFullYear(), m: occ.getUTCMonth() + 1, d: occ.getUTCDate(), h: 0, mi: 0, s: 0 }, ev.start.tz)
        : zonedToUtc(
            {
              y: occ.getUTCFullYear(),
              m: occ.getUTCMonth() + 1,
              d: occ.getUTCDate(),
              h: occ.getUTCHours(),
              mi: occ.getUTCMinutes(),
              s: occ.getUTCSeconds(),
            },
            ev.start.tz,
          );
      if (exdates.has(ms)) continue;
      if (overrides.has(`${ev.uid}|${ms}`)) continue; // moved or cancelled, handled above
      keep(ev, ms);
    }
  }

  out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
  return out;
}

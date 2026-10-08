// A direct evaluator for the plain recurrence rules a hackerspace calendar uses.
//
// rrule (the library) answers "what happens between A and B" by stepping from
// DTSTART through every period, which for a weekly event started in 2014 is
// hundreds of steps per rule, every run. For a window of a day or two it is far
// cheaper to ask each day in the window "does this rule hit today". This handles
// FREQ=DAILY, WEEKLY and MONTHLY with INTERVAL, UNTIL, WKST, BYDAY (with
// ordinals for MONTHLY) and BYMONTHDAY. Anything else, including COUNT, returns
// null and the caller falls back to rrule. test/recur.test.ts checks it against
// rrule on every live rule in the HeatSync feed.
//
// All Dates here are floating: wall clock values stored as if they were UTC.

const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface ByDay {
  wd: number; // 0 = Sunday
  nth: number; // 0 = every; 2 = second; -1 = last
}

function parseRule(rule: string): Map<string, string> | null {
  const m = new Map<string, string>();
  for (const part of rule.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    m.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1).toUpperCase());
  }
  return m;
}

function parseUntil(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!m) return null;
  // Like rrule given a floating DTSTART, UNTIL is compared as written. A date-only
  // UNTIL includes that whole day.
  return m[4]
    ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
    : Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
}

function parseByDay(v: string): ByDay[] | null {
  const out: ByDay[] = [];
  for (const tok of v.split(",")) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
    if (!m) return null;
    out.push({ wd: WEEKDAYS.indexOf(m[2]), nth: m[1] ? +m[1] : 0 });
  }
  return out;
}

const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const dayNumber = (ms: number) => Math.floor(ms / DAY);

/**
 * Occurrence start times (floating) in [from, to), or null if the rule uses
 * anything this evaluator does not handle.
 */
export function occurrences(rule: string, dtstart: Date, from: Date, to: Date): Date[] | null {
  const r = parseRule(rule);
  if (!r) return null;
  const allowed = new Set(["FREQ", "INTERVAL", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY"]);
  for (const k of r.keys()) if (!allowed.has(k)) return null;
  const freq = r.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return null;
  const interval = r.has("INTERVAL") ? +r.get("INTERVAL")! : 1;
  if (!(interval >= 1)) return null;
  const until = r.has("UNTIL") ? parseUntil(r.get("UNTIL")!) : null;
  if (r.has("UNTIL") && until === null) return null;
  const byday = r.has("BYDAY") ? parseByDay(r.get("BYDAY")!) : null;
  if (r.has("BYDAY") && !byday) return null;
  const bymonthday = r.has("BYMONTHDAY") ? r.get("BYMONTHDAY")!.split(",").map(Number) : null;
  if (bymonthday && bymonthday.some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > 31)) return null;
  if (freq !== "MONTHLY" && (bymonthday || byday?.some((b) => b.nth !== 0))) return null;
  const wkst = r.has("WKST") ? WEEKDAYS.indexOf(r.get("WKST")!) : 1;
  if (wkst < 0) return null;

  const start = dtstart.getTime();
  const timeOfDay = start - dayNumber(start) * DAY;
  const startDay = dayNumber(start);
  const sd = new Date(startDay * DAY);
  const weekIndex = (day: number) => Math.floor((day + 4 - wkst) / 7); // day 0 (1970-01-01) was a Thursday
  const out: Date[] = [];

  for (let day = dayNumber(from.getTime()) - 1; day <= dayNumber(to.getTime()); day++) {
    const t = day * DAY + timeOfDay;
    if (t < start || t < from.getTime() || t >= to.getTime()) continue;
    if (until !== null && t > until) continue;
    const date = new Date(day * DAY);
    const wd = date.getUTCDay();
    let hit = false;
    if (freq === "DAILY") {
      hit = (day - startDay) % interval === 0 && (!byday || byday.some((b) => b.wd === wd));
    } else if (freq === "WEEKLY") {
      const days = byday ? byday.map((b) => b.wd) : [sd.getUTCDay()];
      hit = days.includes(wd) && (weekIndex(day) - weekIndex(startDay)) % interval === 0;
    } else {
      const months = (date.getUTCFullYear() - sd.getUTCFullYear()) * 12 + date.getUTCMonth() - sd.getUTCMonth();
      if (months % interval !== 0) continue;
      const dom = date.getUTCDate();
      const dim = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
      const dayHit = bymonthday ? bymonthday.some((n) => (n > 0 ? n === dom : dim + n + 1 === dom)) : true;
      let wdHit = true;
      if (byday) {
        wdHit = byday.some((b) => {
          if (b.wd !== wd) return false;
          if (b.nth === 0) return true;
          return b.nth > 0 ? Math.ceil(dom / 7) === b.nth : Math.floor((dim - dom) / 7) === -b.nth - 1;
        });
      }
      hit = byday || bymonthday ? dayHit && wdHit : dom === sd.getUTCDate();
    }
    if (hit) out.push(new Date(t));
  }
  return out;
}

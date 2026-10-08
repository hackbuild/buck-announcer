// Wall clock time in a named zone <-> UTC, using the runtime's Intl data.

export interface Wall {
  y: number;
  m: number; // 1..12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock reading in `tz` at UTC instant `ms`. */
export function wallAt(ms: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
}

// Zones with one offset all year (America/Phoenix) are cached per year, so the
// hot path skips Intl entirely. Zones with daylight saving take the full route.
const fixedOffsets = new Map<string, number | null>();

function fixedOffset(tz: string, year: number): number | null {
  const key = `${tz}|${year}`;
  let v = fixedOffsets.get(key);
  if (v === undefined) {
    const jan = Date.UTC(year, 0, 1, 12);
    const jul = Date.UTC(year, 6, 1, 12);
    const oj = wallAsUtc(wallAt(jan, tz)) - jan;
    const ol = wallAsUtc(wallAt(jul, tz)) - jul;
    v = oj === ol ? oj : null;
    fixedOffsets.set(key, v);
  }
  return v;
}

/** The UTC instant at which `tz` reads wall time `w`. */
export function zonedToUtc(w: Wall, tz: string): number {
  if (tz === "UTC") return wallAsUtc(w);
  const fixed = fixedOffset(tz, w.y);
  if (fixed !== null) return wallAsUtc(w) - fixed;
  const guess = wallAsUtc(w);
  const offset = wallAsUtc(wallAt(guess, tz)) - guess;
  let ms = guess - offset;
  // One correction step covers instants near a DST change.
  const offset2 = wallAsUtc(wallAt(ms, tz)) - ms;
  if (offset2 !== offset) ms = guess - offset2;
  return ms;
}

// What BUCK should say at a given moment. Pure: no network, no storage, so the
// timing rules are unit tested. The Worker calls this every five minutes.

import type { Instance } from "./ics";
import { closingLine, eventLine } from "./speech";
import { wallAt, zonedToUtc } from "./tz";

export interface Config {
  tz: string;
  leadMinutes: number; // heads up this long before an event
  closeHour: number;
  closeMinute: number;
  closingWarnings: number[]; // minutes before closing
  announceEvents: boolean;
  announceClosing: boolean;
  skipClosingDates: string[]; // YYYY-MM-DD in `tz`
}

export interface Line {
  key: string; // stable id, so each line is said once
  text: string;
}

const MIN = 60_000;
// Runs are five minutes apart and fire a few seconds after the minute. A target
// counts as due when it is between 5 minutes early and 1 minute late, so each one
// lands in exactly one run.
const EARLY = 5 * MIN;
const LATE = 1 * MIN;

function due(msUntil: number, target: number): boolean {
  return msUntil > target - EARLY && msUntil <= target + LATE;
}

/** Today's closing instant in the lab's time zone. */
export function closingAt(now: number, cfg: Config): number {
  const w = wallAt(now, cfg.tz);
  return zonedToUtc({ y: w.y, m: w.m, d: w.d, h: cfg.closeHour, mi: cfg.closeMinute, s: 0 }, cfg.tz);
}

export function plan(now: number, events: Instance[], cfg: Config): Line[] {
  const lines: Line[] = [];

  if (cfg.announceEvents) {
    const soon = events.filter((e) => !e.allDay && due(e.start - now, cfg.leadMinutes * MIN));
    // Events that start together are announced together.
    const byStart = new Map<number, Instance[]>();
    for (const e of soon) byStart.set(e.start, [...(byStart.get(e.start) ?? []), e]);
    for (const [start, group] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push({
        key: `event:${start}:${group.map((e) => e.uid).sort().join(",")}`,
        text: eventLine(group, cfg.tz),
      });
    }
  }

  if (cfg.announceClosing) {
    const close = closingAt(now, cfg);
    const w = wallAt(now, cfg.tz);
    const date = `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
    // Something on the calendar running past closing (or starting right after)
    // means the lab is not closing at the usual time tonight.
    const lateEvent = events.some((e) => !e.allDay && e.end > close + 10 * MIN && e.start < close + 60 * MIN);
    if (!lateEvent && !cfg.skipClosingDates.includes(date)) {
      for (const m of cfg.closingWarnings) {
        if (due(close - now, m * MIN)) lines.push({ key: `closing:${date}:${m}`, text: closingLine(m) });
      }
    }
  }

  return lines;
}

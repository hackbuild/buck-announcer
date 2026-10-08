import { describe, expect, it } from "vitest";
import { upcoming } from "../src/ics";
import { zonedToUtc } from "../src/tz";

const phx = (y: number, m: number, d: number, h: number, mi = 0) => zonedToUtc({ y, m, d, h, mi, s: 0 }, "America/Phoenix");

const ics = [
  "BEGIN:VCALENDAR",
  "X-WR-TIMEZONE:America/Phoenix",
  // one-off
  "BEGIN:VEVENT",
  "UID:single@x",
  "DTSTART;TZID=America/Phoenix:20261010T180000",
  "DTEND;TZID=America/Phoenix:20261010T200000",
  "SUMMARY:Intro to Projection Mapping w/ Lumencanvas.Studio",
  "DESCRIPTION:Learn to map light onto\\, well\\, anything.\\nBring a laptop.",
  "END:VEVENT",
  // weekly, with one date skipped and one moved
  "BEGIN:VEVENT",
  "UID:weekly@x",
  "DTSTART;TZID=America/Phoenix:20240107T190000",
  "DTEND;TZID=America/Phoenix:20240107T220000",
  "RRULE:FREQ=WEEKLY;BYDAY=SU",
  "EXDATE;TZID=America/Phoenix:20261011T190000",
  "SUMMARY:Night Writers",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@x",
  "RECURRENCE-ID;TZID=America/Phoenix:20261018T190000",
  "DTSTART;TZID=America/Phoenix:20261018T200000",
  "DTEND;TZID=America/Phoenix:20261018T230000",
  "SUMMARY:Night Writers (late start)",
  "END:VEVENT",
  // monthly, one instance cancelled
  "BEGIN:VEVENT",
  "UID:monthly@x",
  "DTSTART;TZID=America/Phoenix:20250114T190000",
  "DTEND;TZID=America/Phoenix:20250114T210000",
  "RRULE:FREQ=MONTHLY;BYDAY=2TU",
  "SUMMARY:Board Meeting",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:monthly@x",
  "RECURRENCE-ID;TZID=America/Phoenix:20261110T190000",
  "DTSTART;TZID=America/Phoenix:20261110T190000",
  "STATUS:CANCELLED",
  "SUMMARY:Board Meeting",
  "END:VEVENT",
  // all day, UTC and Denver
  "BEGIN:VEVENT",
  "UID:allday@x",
  "DTSTART;VALUE=DATE:20261012",
  "DTEND;VALUE=DATE:20261013",
  "SUMMARY:Holiday",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:utc@x",
  "DTSTART:20261013T020000Z",
  "DTEND:20261013T030000Z",
  "SUMMARY:UTC event",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:denver@x",
  "DTSTART;TZID=America/Denver:20240702T190000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU",
  "SUMMARY:Denver weekly",
  "END:VEVENT",
  // long ago, never expanded
  "BEGIN:VEVENT",
  "UID:old@x",
  "DTSTART;TZID=America/Phoenix:20150101T190000",
  "RRULE:FREQ=WEEKLY;UNTIL=20160101T000000Z;BYDAY=TH",
  "SUMMARY:Old",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:folded@x",
  "DTSTART;TZID=America/Phoenix:20261014T090000",
  "SUMMARY:☕ Caffeine & Cowo",
  " rking",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const names = (from: number, to: number) => upcoming(ics, from, to).map((e) => e.summary);

describe("upcoming", () => {
  it("finds a one-off with its details", () => {
    const [e] = upcoming(ics, phx(2026, 10, 10, 0), phx(2026, 10, 11, 0));
    expect(e.summary).toBe("Intro to Projection Mapping w/ Lumencanvas.Studio");
    expect(e.start).toBe(phx(2026, 10, 10, 18));
    expect(e.end).toBe(phx(2026, 10, 10, 20));
    expect(e.description).toBe("Learn to map light onto, well, anything.\nBring a laptop.");
  });

  it("expands weekly events and honours EXDATE and moved instances", () => {
    expect(names(phx(2026, 10, 4, 0), phx(2026, 10, 5, 0))).toEqual(["Night Writers"]);
    expect(names(phx(2026, 10, 11, 0), phx(2026, 10, 12, 0))).toEqual([]); // skipped
    const moved = upcoming(ics, phx(2026, 10, 18, 0), phx(2026, 10, 19, 0));
    expect(moved.map((e) => [e.summary, e.start])).toEqual([["Night Writers (late start)", phx(2026, 10, 18, 20)]]);
  });

  it("expands monthly nth weekday and drops cancelled instances", () => {
    expect(names(phx(2026, 10, 13, 0), phx(2026, 10, 14, 0))).toContain("Board Meeting");
    expect(names(phx(2026, 11, 10, 0), phx(2026, 11, 11, 0))).not.toContain("Board Meeting");
  });

  it("handles all-day, UTC, Denver daylight saving, and folded lines", () => {
    const all = upcoming(ics, phx(2026, 10, 12, 0), phx(2026, 10, 15, 0));
    const allDay = all.find((e) => e.summary === "Holiday")!;
    expect(allDay.allDay).toBe(true);
    expect(allDay.start).toBe(phx(2026, 10, 12, 0));
    expect(all.find((e) => e.summary === "UTC event")!.start).toBe(Date.UTC(2026, 9, 13, 2));
    // 7 PM in Denver in October (MDT, UTC-6) is 6 PM in Phoenix.
    expect(all.find((e) => e.summary === "Denver weekly")!.start).toBe(phx(2026, 10, 13, 18));
    expect(all.find((e) => e.uid === "folded@x")!.summary).toBe("☕ Caffeine & Coworking");
  });

  it("never returns events outside the window", () => {
    const from = phx(2026, 10, 10, 12);
    const to = phx(2026, 10, 10, 13);
    expect(upcoming(ics, from, to)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Instance } from "../src/ics";
import { type Config, plan } from "../src/plan";
import { MAX_LINE, cleanDescription, cleanTitle, eventLine, numberWords, spokenTime } from "../src/speech";
import { zonedToUtc } from "../src/tz";

const TZ = "America/Phoenix";
const phx = (y: number, m: number, d: number, h: number, mi = 0, s = 0) => zonedToUtc({ y, m, d, h, mi, s }, TZ);

describe("speech", () => {
  it("says numbers and times as words", () => {
    expect(numberWords(7)).toBe("seven");
    expect(numberWords(42)).toBe("forty two");
    expect(numberWords(115)).toBe("one hundred fifteen");
    expect(numberWords(2026)).toBe("twenty twenty six");
    expect(numberWords(2005)).toBe("two thousand five");
    expect(spokenTime(phx(2026, 10, 9, 19), TZ)).toBe("seven P M");
    expect(spokenTime(phx(2026, 10, 9, 19, 30), TZ)).toBe("seven thirty P M");
    expect(spokenTime(phx(2026, 10, 9, 9, 5), TZ)).toBe("nine oh five A M");
    expect(spokenTime(phx(2026, 10, 9, 12), TZ)).toBe("noon");
    expect(spokenTime(phx(2026, 10, 9, 0), TZ)).toBe("midnight");
  });

  it("cleans titles the way the HeatSync site does", () => {
    expect(cleanTitle("Wire Skeleton (Registration Required)")).toBe("Wire Skeleton");
    expect(cleanTitle("Murder Mystery Night (Registration Full)")).toBe("Murder Mystery Night");
    expect(cleanTitle("☕ Caffeine & Coworking \u{1F469}‍\u{1F4BB}")).toBe("Caffeine and Coworking");
    expect(cleanTitle("Intro to Projection Mapping w/ Lumencanvas.Studio")).toBe("Intro to Projection Mapping with Lumencanvas.Studio");
    expect(cleanTitle("3d Printing - Resin Printing Certification Class")).toBe("three d Printing - Resin Printing Certification Class");
  });

  it("cleans descriptions: html, links, costs, registration", () => {
    const d = cleanDescription(
      'Bring a project!<br><br>Registration Required: https://guestli.st/abc123 <a href="https://x.y">link</a> Cost: $17&nbsp;per person. Email me@hsl.org',
    );
    expect(d).toBe("Bring a project! link Cost: seventeen dollars per person. Email");
  });

  it("keeps every line inside BUCK's 200 characters", () => {
    const long = "This is a long sentence about a class. ".repeat(20);
    const one = eventLine([{ start: phx(2026, 10, 9, 19), summary: "Laser Cutter Certification", description: long }], TZ);
    expect(one.length).toBeLessThanOrEqual(MAX_LINE);
    expect(one.startsWith("Laser Cutter Certification starts in one hour, at seven P M.")).toBe(true);
    expect(one.endsWith(".")).toBe(true);
    const many = eventLine(
      Array.from({ length: 9 }, (_, i) => ({ start: phx(2026, 10, 9, 19), summary: `A fairly long event title number ${i}`, description: "" })),
      TZ,
    );
    expect(many.length).toBeLessThanOrEqual(MAX_LINE);
    expect(many).toMatch(/^Coming up in one hour: .* more\.$/);
  });
});

const cfg: Config = {
  tz: TZ,
  leadMinutes: 60,
  closeHour: 22,
  closeMinute: 0,
  closingWarnings: [30, 15],
  announceEvents: true,
  announceClosing: true,
  skipClosingDates: [],
};

const ev = (uid: string, start: number, hours = 2, summary = uid): Instance => ({
  uid,
  start,
  end: start + hours * 3600_000,
  allDay: false,
  summary,
  description: "",
});

// Cron fires a few seconds after the minute.
const run = (h: number, mi: number) => phx(2026, 10, 9, h, mi, 4);

describe("plan", () => {
  it("announces an event in exactly one five minute run, about an hour ahead", () => {
    const events = [ev("board", phx(2026, 10, 9, 19))];
    const hits = [];
    for (let t = phx(2026, 10, 9, 17); t < phx(2026, 10, 9, 19); t += 5 * 60_000) {
      const lines = plan(t + 4000, events, cfg);
      if (lines.length) hits.push([t, lines]);
    }
    expect(hits.length).toBe(1);
    expect(hits[0][0]).toBe(phx(2026, 10, 9, 18));
  });

  it("covers starts that are not on a five minute mark", () => {
    const events = [ev("odd", phx(2026, 10, 9, 19, 7))];
    const hits = [];
    for (let t = phx(2026, 10, 9, 17); t < phx(2026, 10, 9, 19); t += 5 * 60_000) if (plan(t + 4000, events, cfg).length) hits.push(t);
    expect(hits).toEqual([phx(2026, 10, 9, 18, 10)]);
  });

  it("groups events that start together into one line", () => {
    const lines = plan(run(18, 0), [ev("a", phx(2026, 10, 9, 19), 2, "Open Hours"), ev("b", phx(2026, 10, 9, 19), 2, "Sewing Night")], cfg);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Coming up in one hour: Open Hours at seven P M and Sewing Night at seven P M.");
  });

  it("skips all-day events", () => {
    const allDay = { ...ev("holiday", phx(2026, 10, 9, 19)), allDay: true };
    expect(plan(run(18, 0), [allDay], cfg)).toEqual([]);
  });

  it("warns at 9:30 and 9:45 PM Mesa time, once each", () => {
    expect(plan(run(21, 25), [], cfg)).toEqual([]);
    expect(plan(run(21, 30), [], cfg)).toEqual([{ key: "closing:2026-10-09:30", text: "Lab closing in thirty minutes." }]);
    expect(plan(run(21, 35), [], cfg)).toEqual([]);
    expect(plan(run(21, 40), [], cfg)).toEqual([]);
    expect(plan(run(21, 45), [], cfg)).toEqual([{ key: "closing:2026-10-09:15", text: "Lab closing in fifteen minutes." }]);
    expect(plan(run(21, 50), [], cfg)).toEqual([]);
  });

  it("holds the closing warning when something runs past ten", () => {
    expect(plan(run(21, 30), [ev("late", phx(2026, 10, 9, 20), 3)], cfg)).toEqual([]);
    // An event that ends at ten does not hold it.
    expect(plan(run(21, 30), [ev("ontime", phx(2026, 10, 9, 19), 3)], cfg)).toHaveLength(1);
  });

  it("honours skip dates and switches", () => {
    expect(plan(run(21, 30), [], { ...cfg, skipClosingDates: ["2026-10-09"] })).toEqual([]);
    expect(plan(run(21, 30), [], { ...cfg, announceClosing: false })).toEqual([]);
    expect(plan(run(18, 0), [ev("e", phx(2026, 10, 9, 19))], { ...cfg, announceEvents: false })).toEqual([]);
  });

  it("uses Mesa time all year: Arizona has no daylight saving", () => {
    const jan = zonedToUtc({ y: 2027, m: 1, d: 15, h: 21, mi: 30, s: 4 }, TZ);
    const jul = zonedToUtc({ y: 2027, m: 7, d: 15, h: 21, mi: 30, s: 4 }, TZ);
    expect(new Date(jan).getUTCHours()).toBe(4);
    expect(new Date(jul).getUTCHours()).toBe(4);
    expect(plan(jan, [], cfg)).toHaveLength(1);
    expect(plan(jul, [], cfg)).toHaveLength(1);
  });
});

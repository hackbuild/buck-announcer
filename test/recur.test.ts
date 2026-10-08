import { rrulestr } from "rrule";
import { describe, expect, it } from "vitest";
import rules from "./fixtures/hsl-rules.json";
import { occurrences } from "../src/recur";

// Every recurrence rule in the HeatSync feed as of 2026-10-07 (rule and start
// time only), plus shapes the feed does not use yet.
const synthetic = [
  { rule: "FREQ=MONTHLY;BYDAY=-1FR", dtstart: "20240105T190000" },
  { rule: "FREQ=MONTHLY;BYDAY=2TU,4TU", dtstart: "20240109T190000" },
  { rule: "FREQ=MONTHLY;INTERVAL=2;BYDAY=1SA", dtstart: "20240106T120000" },
  { rule: "FREQ=MONTHLY;BYMONTHDAY=15,-1", dtstart: "20240115T180000" },
  { rule: "FREQ=MONTHLY", dtstart: "20240110T180000" },
  { rule: "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SA", dtstart: "20240106T100000" },
  { rule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH", dtstart: "20240101T190000" },
  { rule: "FREQ=WEEKLY", dtstart: "20240103T190000" },
  { rule: "FREQ=DAILY;INTERVAL=3", dtstart: "20240101T090000" },
  { rule: "FREQ=DAILY;BYDAY=MO,WE,FR", dtstart: "20240101T090000" },
  { rule: "FREQ=WEEKLY;UNTIL=20241231T235959Z;BYDAY=TU", dtstart: "20240102T190000" },
  { rule: "FREQ=WEEKLY;UNTIL=20240611;BYDAY=TU", dtstart: "20240102T000000" },
];

function floating(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(s)!;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
}

describe("direct rule evaluator matches rrule", () => {
  const cases = [...(rules as { rule: string; dtstart: string }[]), ...synthetic];
  const windows = [
    [Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
    [Date.UTC(2026, 9, 1), Date.UTC(2027, 9, 1)],
  ];

  it("covers the feed's rules", () => {
    const handled = cases.filter((c) => occurrences(c.rule, floating(c.dtstart), new Date(0), new Date(DAY)) !== null);
    // COUNT rules go to rrule on purpose; everything else should be handled here.
    const unhandled = cases.filter((c) => !c.rule.includes("COUNT=") && !handled.includes(c));
    expect(unhandled).toEqual([]);
  });

  for (const c of cases) {
    it(`${c.rule} from ${c.dtstart}`, () => {
      const dtstart = floating(c.dtstart);
      for (const [a, b] of windows) {
        const mine = occurrences(c.rule, dtstart, new Date(a), new Date(b));
        if (mine === null) return; // COUNT and other shapes: rrule handles them
        const theirs = rrulestr(`RRULE:${c.rule}`, { dtstart })
          .between(new Date(a), new Date(b), true)
          .filter((d) => d.getTime() < b);
        expect(mine.map((d) => d.toISOString())).toEqual(theirs.map((d) => d.toISOString()));
      }
    });
  }
});

const DAY = 86_400_000;

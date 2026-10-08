// Turning calendar entries into lines SAM can say.
//
// SAM reads digits one at a time ("10" is "one zero"), knows nothing of emoji,
// HTML or URLs, and BUCK cuts every line at 200 characters. So times become
// words, small numbers become words, and descriptions are cleaned and trimmed
// to whole sentences that fit.

import { wallAt } from "./tz";

export const MAX_LINE = 200;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 to 9999 in words. Years 1100 to 2099 read the way people say them. */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n >= 1100 && n < 2100 && n % 100 !== 0 && !(n >= 2000 && n < 2010)) {
    const lo = n % 100;
    return numberWords(Math.floor(n / 100)) + " " + (lo < 10 ? "oh " + ONES[lo] : numberWords(lo));
  }
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberWords(n % 100) : "");
  return numberWords(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + numberWords(n % 1000) : "");
}

/** "seven P M", "seven thirty P M", "nine oh five A M", "noon", "midnight". */
export function spokenTime(ms: number, tz: string): string {
  const { h, mi } = wallAt(ms, tz);
  if (mi === 0 && h === 12) return "noon";
  if (mi === 0 && h === 0) return "midnight";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const minutes = mi === 0 ? "" : mi < 10 ? ` oh ${ONES[mi]}` : ` ${numberWords(mi)}`;
  return `${numberWords(h12)}${minutes} ${h < 12 ? "A M" : "P M"}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

/** Words SAM can read: ASCII only, symbols spelled out, short numbers as words. */
function speakable(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ", ")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\n]/g, " ")              // emoji and anything else non-ASCII
    .replace(/\$(\d+)(?:\.(\d{2}))?/g, (_, d, c) => `${d} dollars${c && c !== "00" ? ` ${c} cents` : ""}`)
    .replace(/\bw\//gi, "with ")
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/#(\d)/g, "number $1")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")           // 3d, 7pm
    .replace(/\b\d{1,4}\b/g, (d) => numberWords(+d))
    .replace(/[*_~`|<>{}\[\]\\^=+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REGISTRATION = /[\s·•|,-]*\(?registration (?:required|full)\)?[\s·•|,-]*/gi;

/** Event title as BUCK should say it. */
export function cleanTitle(title: string): string {
  return speakable(title.replace(REGISTRATION, " ").replace(/\(\s*\)/g, "")).replace(/[.\s]+$/, "") || "an event";
}

/** Event description reduced to plain sentences. */
export function cleanDescription(desc: string): string {
  return speakable(
    decodeEntities(
      desc
        .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, ". ")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
      .replace(/\S+@\S+\.\S+/g, " ")
      .replace(/\(?registration\s*(?:required|full)\)?:?/gi, " ")
      .replace(/\n+/g, ". "),
  )
    .replace(/(\s*\.\s*){2,}/g, ". ")
    .replace(/([!?,:;])\s*\./g, "$1")
    .replace(/\s+([.!?,])/g, "$1")
    .replace(/^[\s.,:;-]+/, "")
    .trim();
}

/** Whole sentences from `text` that fit in `budget` characters, or "". */
export function fitSentences(text: string, budget: number): string {
  if (budget < 20 || !text) return "";
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
  let out = "";
  for (const s of sentences) {
    const next = (out + " " + s.trim()).trim();
    if (next.length > budget) break;
    out = next;
  }
  if (!out) {
    // First sentence alone is too long: cut it at a word and close it.
    const cut = text.slice(0, budget - 1).replace(/\s+\S*$/, "");
    out = cut.length > 20 ? cut + "." : "";
  }
  return out && !/[.!?]$/.test(out) ? out + "." : out;
}

export interface Upcoming {
  start: number;
  summary: string;
  description: string;
}

/** The one hour heads up for one or more events starting together. */
export function eventLine(events: Upcoming[], tz: string): string {
  if (events.length === 1) {
    const e = events[0];
    const head = `${cleanTitle(e.summary)} starts in one hour, at ${spokenTime(e.start, tz)}.`;
    const desc = fitSentences(cleanDescription(e.description), MAX_LINE - head.length - 1);
    return (desc ? `${head} ${desc}` : head).slice(0, MAX_LINE);
  }
  const items = events.map((e) => `${cleanTitle(e.summary)} at ${spokenTime(e.start, tz)}`);
  for (let n = items.length; n > 0; n--) {
    const shown = items.slice(0, n);
    const rest = items.length - n;
    const list =
      shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")}${rest ? ", " : " and "}${shown[shown.length - 1]}`;
    const line = `Coming up in one hour: ${list}${rest ? `, and ${numberWords(rest)} more` : ""}.`;
    if (line.length <= MAX_LINE) return line;
  }
  return `${numberWords(events.length)} events start in one hour.`;
}

export function closingLine(minutes: number): string {
  return `Lab closing in ${numberWords(minutes)} minutes.`;
}

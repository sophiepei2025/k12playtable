/** What to put in a break: goal → subjects, program picks for a break, and the "big companies" wall. */
import type { Activity } from "./schema.js";
import type { Break } from "./calendar.js";
import { tierOf, TIER_RANK } from "./signals.js";

export const GOALS = {
  cs: { label: "Computer Science", subjects: ["Software Development", "All Programming", "Machine Learning/AI", "Cybersecurity", "Competitive Programming"] },
  math_science: { label: "Math & Science", subjects: ["Mathematics", "Physics", "Chemistry", "Biology", "Astronomy", "Environmental Science", "All STEM", "All Math + Science"] },
  engineering: { label: "Engineering", subjects: ["All Engineering", "Mechanical Engineering", "Electrical Engineering", "Aerospace Engineering"] },
  health: { label: "Medicine & Health", subjects: ["Medicine", "Biology", "Chemistry"] },
  business: { label: "Business & Economics", subjects: ["Business", "Economics", "Entrepreneurship", "Marketing"] },
  writing: { label: "Writing & Humanities", subjects: ["Writing", "Literature and Language", "History", "Philosophy", "Debate", "Politics", "Law", "Global Government"] },
  arts: { label: "Arts", subjects: ["Art/Design", "Film and Video Production", "Music", "Photography", "Theatre and Drama"] },
  undecided: { label: "Not sure yet", subjects: [] as string[] },
} as const;
export type Goal = keyof typeof GOALS;

export type Fit = "during_break" | "anytime_online" | "check_dates";

export interface BreakPick {
  activity: Activity;
  matched: number; // subjects in common with the goal
  fit: Fit;
  fitLabel: string;
}

const overlaps = (a: Activity, b: Break) =>
  !!a.dates.start && !!a.dates.end && a.dates.start <= b.end && a.dates.end >= b.start;

/**
 * Programs for one break. Deterministic: eligibility first, then fit, then signal tier.
 * - Hard: active, high-school audience, grade (if the program lists grades), not residential unless the break is >= 5 days.
 * - Goal: subject overlap; "undecided" → open, low-commitment programs only (exploration, SKILL S4).
 */
export function picksForBreak(list: Activity[], opts: { brk: Break; grade?: number; goal: Goal; limit?: number }): BreakPick[] {
  const { brk, grade, goal } = opts;
  const subjects = new Set<string>(GOALS[goal].subjects);
  const out: BreakPick[] = [];
  for (const a of list) {
    if (a.status !== "active" || !a.audience.includes("high_school")) continue;
    if (grade && a.grades.length && !a.grades.includes(grade)) continue;
    if (a.residential && brk.days < 5) continue;
    const seasonal = `${a.name} ${a.timing_text ?? ""}`;
    if (brk.name !== "Summer" && /\bsummer\b/i.test(seasonal)) continue; // a summer program is not a winter-break plan
    if (goal === "undecided") {
      if (a.selectivity && a.selectivity !== "open") continue;
      if (a.commitment === "long_term") continue;
    } else if (!a.subjects.some((s) => subjects.has(s))) continue;

    let fit: Fit;
    if (overlaps(a, brk)) fit = "during_break";
    else if (a.dates.start && a.dates.end) continue; // runs at a known other time
    else if (a.environment === "online") fit = "anytime_online";
    else fit = "check_dates";
    out.push({
      activity: a,
      matched: a.subjects.filter((s) => subjects.has(s)).length,
      fit,
      fitLabel: fit === "during_break" ? "Runs during this break" : fit === "anytime_online" ? "Online — dates not confirmed" : "Dates not confirmed",
    });
  }
  const fitRank: Record<Fit, number> = { during_break: 0, anytime_online: 1, check_dates: 2 };
  out.sort(
    (x, y) =>
      fitRank[x.fit] - fitRank[y.fit] ||
      y.matched - x.matched ||
      TIER_RANK[tierOf(x.activity)] - TIER_RANK[tierOf(y.activity)] ||
      x.activity.name.localeCompare(y.activity.name),
  );
  return out.slice(0, opts.limit ?? 8);
}

/** Company names shown on the home page. Only names with >= 1 active high-school program. Text only, no logos. */
const COMPANIES = [
  "Google", "Microsoft", "Amazon", "Apple", "Meta", "IBM", "Intel", "Cisco", "Samsung", "Bloomberg",
  "Boeing", "Lockheed Martin", "Northrop Grumman", "Shopify", "RBC", "TD", "Bank of America", "Jane Street",
  "Snap", "Roblox", "Ford", "Sony", "National Geographic", "The New York Times", "Shell", "Prudential",
] as const;

export function bigCompanyWall(list: Activity[]): Array<{ company: string; count: number }> {
  const hs = list.filter((a) => a.status === "active" && a.audience.includes("high_school"));
  return COMPANIES.map((company) => {
    const re = new RegExp(`(^|[^A-Za-z])${company.replace(/ /g, "\\s+")}([^A-Za-z]|$)`);
    return { company, count: hs.filter((a) => re.test(a.name)).length };
  }).filter((x) => x.count > 0);
}
